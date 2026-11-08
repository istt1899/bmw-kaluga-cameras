'use strict';
// Service commands and persistence, using explicit test GPS/audio/display adapters.
var assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),EventEmitter=require('events');
var base=path.resolve(__dirname,'../native/marku-kaluga-cameras/files'),service=require(path.join(base,'marku-kaluga-cameras')),card=require(path.join(base,'alert-card')),defaults=require(path.join(base,'warning-policy')).DEFAULTS;
var root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'strelka-warning-service-')),clock=Date.UTC(2026,10,8,12),originalNow=Date.now,apps=[],clients=[],seq=0;
Date.now=function(){return clock;};
function turn(){return new Promise(function(resolve){setImmediate(resolve);});}
async function until(fn){for(var i=0;i<300;i++){if(fn())return;await new Promise(function(resolve){setTimeout(resolve,10);});}throw Error('Overspeed service IPC timeout');}
async function start(dir,withAudio){
 var gps=new EventEmitter(),calls=[],current={id:'A',type:'speed',controls:['speed'],roadConfirmed:true,limitKmh:60,distanceM:70},shown=null;
 gps.fix={lat:54,lon:36,timeMs:clock,motionTimeMs:clock,accuracyM:5,speedKmh:0,headingDeg:90};gps.current=function(){return gps.fix;};gps.start=gps.close=function(){};
 var socket=process.platform==='win32'?'\\\\.\\pipe\\strelka-warning-service-'+process.pid+'-'+(++seq):path.join(dir,'ctl.sock'),app;
 await new Promise(function(resolve,reject){app=service.start({dataDir:dir,socket:socket,gps:gps,guidance:{evaluate:function(){return current;}},
  audio:withAudio?{play:function(request){calls.push(request);return Promise.resolve({played:true});}}:undefined,
  display:{update:function(alert){shown=alert;},status:function(){return'ready';},diagnostics:function(){return{connection:'ready'};},close:function(){}},
  dimmer:{update:function(){},status:function(){return'off';},close:function(){}},
  storeFactory:function(options){options.initial.zones=JSON.parse(fs.readFileSync(path.join(base,'road-zones.json'),'utf8')).zones;return{current:function(){return options.initial;},status:function(){return{phase:'idle'};},close:function(){}};},onListening:resolve,onError:reject});});apps.push(app);
 var client=net.connect(socket),states=[],buf='';clients.push(client);client.setEncoding('utf8');client.on('error',function(){});client.on('data',function(bytes){buf+=bytes;var i;while((i=buf.indexOf('\n'))>=0){var r=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(r.state)states.push(r.state);}});await until(function(){return states.length;});
 return{app:app,calls:calls,gps:gps,shown:function(){return shown;},id:function(id){current=Object.assign({},current,{id:id});},step:async function(speed,dt){clock+=dt===undefined?500:dt;gps.fix.speedKmh=speed;gps.fix.timeMs=gps.fix.motionTimeMs=clock;app.tick();await turn();app.tick();},command:async function(patch){var id='warning-'+(++seq);client.write(JSON.stringify(Object.assign({requestId:id},patch))+'\n');await until(function(){return states.some(function(s){return s.commandResult&&s.commandResult.requestId===id&&s.commandResult.phase!=='requested';});});return states.filter(function(s){return s.commandResult&&s.commandResult.requestId===id;}).pop();}};
}
async function main(){
 var dir=path.join(root,'configured');fs.mkdirSync(dir);var run=await start(dir,true),app=run.app;
 assert.deepStrictEqual(app.state().overspeedPreferences,defaults);assert.strictEqual(app.state().database.coverage.sourceRecords,308);assert.strictEqual(app.state().database.coverage.numericRoadZones,18);
 await run.command({cmd:'alert-preferences',warningDistanceM:900,cameraTypes:{belt:false}});await run.command({cmd:'hud-opacity',percent:55});
 var originalLayouts=JSON.stringify(app.state().cardLayout);
 var reply=await run.command({cmd:'overspeed-preferences',soundEnabled:true,soundOffsetKmh:20});assert.strictEqual(reply.commandResult.phase,'finished');
 await run.step(80);assert.strictEqual(run.calls.length,0);assert.strictEqual(app.state().speedWarning.soundExceeded,false);
 await run.step(80.1);assert.strictEqual(run.calls.length,1);assert.strictEqual(app.state().audio.phase,'played');assert.strictEqual(card.presentation(run.shown()).speedText,'>80');assert.strictEqual(run.shown().limitKmh,60);
 await run.step(82);assert.strictEqual(run.calls.length,1,'Successful same approach cannot repeat');
 run.id('B');await run.step(90,13000);assert.strictEqual(run.calls.length,2);run.id('A');await run.step(90,13000);assert.strictEqual(run.calls.length,2,'A-B-A does not repeat A');
 await run.command({cmd:'overspeed-preferences',soundEnabled:false,visualFlash:false});run.id('C');await run.step(90,13000);assert.strictEqual(run.calls.length,2);assert.strictEqual(card.presentation(run.shown()).flashActive,false);assert.strictEqual(card.presentation(run.shown()).overspeed,true);
 app.command({cmd:'alert-preferences',cameraTypes:{speed:false}});assert.strictEqual(app.state().alert,null);assert.strictEqual(app.state().speedWarning.eligible,false);app.command({cmd:'alert-preferences',cameraTypes:{speed:true}});
 var before=JSON.stringify(app.state().overspeedPreferences),bytes=fs.readFileSync(path.join(dir,'settings.json'),'utf8');
 [{soundOffsetKmh:31},{visualOffsetKmh:1.5},{soundEnabled:'true'},{visualFlash:null},{extra:1}].forEach(function(p){assert.throws(function(){app.command(Object.assign({cmd:'overspeed-preferences'},p));});assert.strictEqual(JSON.stringify(app.state().overspeedPreferences),before);assert.strictEqual(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),bytes);});
 assert.strictEqual(app.state().alertPreferences.warningDistanceM,900);assert.strictEqual(app.state().alertPreferences.cameraTypes.belt,false);assert.strictEqual(JSON.stringify(app.state().cardLayout),originalLayouts);assert.strictEqual(app.state().hudOpacityPct,55);
 run.gps.fix.timeMs=clock-3001;app.tick();assert.strictEqual(app.state().alert,null);assert.strictEqual(app.state().speedWarning.reason,'GPS_INVALID');
 fs.mkdirSync(path.join(dir,'settings.json.tmp'));app.command({cmd:'overspeed-preferences',visualOffsetKmh:5});assert.strictEqual(app.state().overspeedPreferences.visualOffsetKmh,5);assert.strictEqual(app.state().storage.settingsSaved,false);assert(/временно/.test(app.state().commandResult.message));fs.rmdirSync(path.join(dir,'settings.json.tmp'));
 app.close();var restarted=await start(dir,false);assert.strictEqual(restarted.app.state().overspeedPreferences.visualOffsetKmh,0);assert.strictEqual(restarted.app.state().overspeedPreferences.visualFlash,false);assert.strictEqual(restarted.app.state().alertPreferences.warningDistanceM,900);assert.strictEqual(restarted.app.state().hudOpacityPct,55);
 reply=await restarted.command({cmd:'overspeed-preferences',soundEnabled:true});assert(reply.overspeedPreferences.soundEnabled);assert.strictEqual(reply.audio.available,false);assert.notStrictEqual(reply.audio.phase,'played');assert(/не подтверждён/.test(reply.audio.reason));
 assert.throws(function(){restarted.app.command({cmd:'audio-test'});},/подтверждён/);assert.notStrictEqual(restarted.app.state().commandResult.phase,'played');
 console.log('PASS actual overspeed service IPC: 60/80/80.1 boundary, fractional raster, adapter success/dedup, independent toggles, strict patches, old-setting migration, unrelated calibration/filter/range persistence, stale withdrawal, temporary storage and honest production-unavailable audio');
}
function remove(dir){assert(dir.indexOf(root)===0);fs.readdirSync(dir).forEach(function(n){var p=path.join(dir,n),s=fs.lstatSync(p);if(s.isDirectory()&&!s.isSymbolicLink())remove(p);else fs.unlinkSync(p);});fs.rmdirSync(dir);}
main().catch(function(error){console.error(error.stack);process.exitCode=1;}).then(function(){clients.forEach(function(c){c.destroy();});apps.forEach(function(a){a.close();});Date.now=originalNow;remove(root);});
