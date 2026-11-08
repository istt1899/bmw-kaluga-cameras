'use strict';
// Actual BMW control JSONL, external NMEA UDP and GPSD TCP. No vehicle writes.
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),dgram=require('dgram');
var base=path.resolve(__dirname,'../native/marku-kaluga-cameras/files');
var service=require(path.join(base,'marku-kaluga-cameras')),GpsProvider=require(path.join(base,'gps-source')).GpsProvider;
var createGuidance=require(path.join(base,'vehicle-guidance')).createGuidance;
var dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'strelka-gps-reset-')),originalNow=Date.now,clock=Date.UTC(2026,10,8,12,0,10),seq=0;
var app,gps,server,client,sender,reserved,peers=[],states=[],buffer='';
Date.now=function(){return clock;};
function sleep(){return new Promise(function(resolve){setTimeout(resolve,10);});}
async function until(fn){for(var i=0;i<300;i++){if(fn())return;await sleep();}throw Error('GPS reset IPC timeout');}
function pos(x){return{lat:54,lon:36+x/(111320*Math.cos(54*Math.PI/180))};}
function sentence(body){var crc=0;for(var i=0;i<body.length;i++)crc^=body.charCodeAt(i);return'$'+body+'*'+('0'+crc.toString(16)).slice(-2);}
function coord(v,lon){var d=Math.floor(Math.abs(v));return('000'+d).slice(lon?-3:-2)+('0'+((Math.abs(v)-d)*60).toFixed(7)).slice(-10);}
function packet(x,time){var d=new Date(time),p=pos(x),pad=function(n){return('0'+n).slice(-2);},t=pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+'.'+('00'+d.getUTCMilliseconds()).slice(-3),day=pad(d.getUTCDate())+pad(d.getUTCMonth()+1)+String(d.getUTCFullYear()).slice(-2),lat=coord(p.lat,false),lon=coord(p.lon,true);
 return[sentence('GNRMC,'+t+',A,'+lat+',N,'+lon+',E,38.8768898488,90,'+day+',,,A'),sentence('GNGGA,'+t+','+lat+',N,'+lon+',E,1,10,0.8,150,M,0,M,,'),sentence('GNGST,'+t+',1,1,1,0,3,4,6')];}
async function command(msg){var id='reset-'+(++seq);client.write(JSON.stringify(Object.assign({requestId:id},msg))+'\n');await until(function(){return states.some(function(s){var r=s.commandResult;return r&&r.requestId===id&&r.phase!=='requested';});});var state=states.filter(function(s){return s.commandResult&&s.commandResult.requestId===id;}).pop();assert.notStrictEqual(state.commandResult.phase,'error',state.commandResult.message);return state;}
async function sendNmea(data){var count=gps.input.packets;client.write(JSON.stringify({cmd:'vehicle-nmea',data:data})+'\n');await until(function(){return gps.input.packets>count;});}
async function feed(kind,x){var data=packet(x,clock);if(kind==='bmw')await sendNmea(data.join('\r\n'));else if(kind==='udp'){sender.send(Buffer.from(data.join('\r\n')),gps.udp.address().port,'127.0.0.1');await until(function(){var f=gps.current(clock);return f&&f.source==='nmea'&&f.timeMs===clock;});}else{var p=pos(x);peers[peers.length-1].write(JSON.stringify({class:'TPV',mode:3,time:new Date(clock).toISOString(),lat:p.lat,lon:p.lon,epx:3,epy:4,speed:20,track:90})+'\n');await until(function(){var f=gps.current(clock);return f&&f.source==='gpsd'&&f.timeMs===clock;});}app.tick();}
async function main(){
 server=net.createServer(function(s){peers.push(s);s.on('error',function(){});s.on('data',function(){});});await new Promise(function(resolve){server.listen(0,'127.0.0.1',resolve);});
 reserved=dgram.createSocket('udp4');await new Promise(function(resolve){reserved.bind(0,'127.0.0.1',resolve);});var port=reserved.address().port;await new Promise(function(resolve){reserved.close(resolve);});reserved=null;
 gps=new GpsProvider({now:function(){return clock;},host:'127.0.0.1',port:server.address().port,nmeaHost:'127.0.0.1',nmeaPort:port,retryMs:25});
 var record={id:'epoch-camera',type:'speed',controls:['speed'],limitKmh:60,position:pos(0)},zone={id:record.id,lat:54,lon:36,limit:60,travel:[90],roads:[{id:1,dir:0,cam:1,pts:[[-1500,0],[0,0],[200,0]]}]};
 var socket=process.platform==='win32'?'\\\\.\\pipe\\strelka-epoch-'+process.pid:path.join(dir,'ctl.sock');
 await new Promise(function(resolve,reject){app=service.start({dataDir:dir,socket:socket,gps:gps,guidance:createGuidance({records:[record],zones:[zone],nearby:false}),
  display:{update:function(){},status:function(){return'ready';},diagnostics:function(){return{connection:'ready'};},close:function(){}},dimmer:{update:function(){},status:function(){return'off';},close:function(){}},onListening:resolve,onError:reject});});
 client=net.connect(socket);client.setEncoding('utf8');client.on('error',function(){});client.on('data',function(chunk){buffer+=chunk;var at;while((at=buffer.indexOf('\n'))>=0){var value=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(value.state)states.push(value.state);}});
 sender=dgram.createSocket('udp4');await until(function(){try{return peers.length&&states.length&&gps.udp.address().port;}catch(e){return false;}});
 await command({cmd:'outputs',cluster:true,hud:true});var settings=fs.readFileSync(path.join(dir,'settings.json'),'utf8');
 for(var k=0;k<3;k++){
  var kind=['bmw','gpsd','udp'][k];clock+=10000;await feed(kind,-200);clock+=1000;await feed(kind,-180);assert(app.state().alert&&app.state().alert.roadConfirmed,kind+' establishes normal approach');
  clock-=10000;
  if(kind==='bmw')await sendNmea(packet(-179,clock).join('\r\n'));
  else if(kind==='gpsd')gps.decoder.json({class:'TPV',mode:3,time:new Date(clock).toISOString(),lat:54,lon:pos(-179).lon,epx:3,epy:4,speed:20,track:90});
  else packet(-179,clock).forEach(function(line){gps.decoder.line(line);});
  app.tick();assert.strictEqual(app.state().alert,null,'Rollback cannot silently create a new approach');
  var oldData=gps.sock.listeners('data')[0],oldUdp=gps.udpMessageHandler,oldPeerCount=peers.length,resetTime=clock;
  await command({cmd:'gps-reset'});assert.strictEqual(app.state().gpsReset.phase,'waiting-new-fix');assert.strictEqual(gps.current(clock),null);assert.strictEqual(app.state().alert,null);
  assert.strictEqual(gps.decoder.rmc,null);assert.strictEqual(gps.bmwDecoder.rmc,null);assert.strictEqual(gps.decoder.lastRmcUtc,null);assert.strictEqual(gps.bmwDecoder.lastRmcUtc,null);
  assert.strictEqual(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),settings,'Reset does not write settings');
  await until(function(){return peers.length>oldPeerCount;});
  clock=resetTime+1000;
  oldData(JSON.stringify({class:'TPV',mode:3,time:new Date(clock).toISOString(),lat:54,lon:pos(-180).lon,epx:3,epy:4,speed:20,track:90})+'\n');oldUdp(Buffer.from(packet(-180,clock).join('\r\n')));
  assert.strictEqual(gps.current(clock),null,'Retired callback generations are inert');
  packet(-180,resetTime+400).forEach(function(line){gps.bmwDecoder.line(line);gps.decoder.line(line);});assert.strictEqual(gps.current(clock),null,'Previously legal future-window samples cannot enter the new epoch');
  var one=packet(-180,clock);
  if(kind==='bmw'){
   await sendNmea(one[0]);assert.strictEqual(gps.current(clock),null,'Old GGA/GST cannot pair with new RMC');
   await sendNmea(one.slice(1).join('\r\n'));app.tick();
  }else await feed(kind,-180);
  assert(!app.state().alert,'One new source timestamp is not a confirmed road');
  clock+=1000;await feed(kind,-160);assert(app.state().alert&&app.state().alert.roadConfirmed,kind+' recovers only from new validated measurements');
  assert.strictEqual(app.state().gpsReset.phase,'receiving');
 }
 console.log('PASS manual GPS reset: actual BMW JSONL, GPSD TCP and external NMEA UDP; rollback remains rejected without action, all decoder/guidance histories clear, source cutoff and retired callbacks block old data, fresh source pairs re-establish approach; settings unchanged');
}
function remove(dirPath){assert(dirPath.indexOf(dir)===0);fs.readdirSync(dirPath).forEach(function(name){var p=path.join(dirPath,name),s=fs.lstatSync(p);if(s.isDirectory()&&!s.isSymbolicLink())remove(p);else fs.unlinkSync(p);});fs.rmdirSync(dirPath);}
main().catch(function(error){console.error(error.stack);process.exitCode=1;}).then(async function(){if(client)client.destroy();if(app)app.close();if(sender)sender.close();if(reserved)reserved.close();peers.forEach(function(s){s.destroy();});if(server)await new Promise(function(resolve){server.close(resolve);});Date.now=originalNow;remove(dir);});
