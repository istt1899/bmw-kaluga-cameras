'use strict';
// Actual daemon + guidance + JSONL socket. No connection to a head unit.
var assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),EventEmitter=require('events');
var base=path.resolve(__dirname,'../native/marku-kaluga-cameras/files');
var service=require(path.join(base,'marku-kaluga-cameras')),engine=require(path.join(base,'vehicle-guidance')),prefs=require(path.join(base,'alert-preferences'));
var root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'strelka-preferences-')),sequence=0,apps=[],sockets=[],originalNow=Date.now;
var clock=originalNow(),lastOutput=null;
Date.now=function(){return clock;};
function fix(x){return{lat:54,lon:36+x/(111320*Math.cos(54*Math.PI/180)),timeMs:clock,motionTimeMs:clock,accuracyM:5,speedKmh:90,headingDeg:90};}
var record={id:'prefs-camera',position:{lat:54,lon:36},type:'speed',controls:['speed','belt'],limitKmh:60};
var zone={id:record.id,lat:54,lon:36,travel:[90],limit:60,roads:[{id:1,dir:0,cam:1,pts:[[-1500,0],[0,0],[200,0]]}]};
function pause(){return new Promise(function(resolve){setTimeout(resolve,10);});}
async function until(fn){for(var i=0;i<300;i++){if(fn())return;await pause();}throw Error('Timed out waiting for preferences IPC');}
async function start(dir){
 var gps=new EventEmitter();gps.fix=fix(-1100);gps.current=function(){return gps.fix;};gps.start=gps.close=function(){};
 var guidance=engine.createGuidance({zones:[zone],records:[record],nearby:false}),seen;
 var endpoint=process.platform==='win32'?'\\\\.\\pipe\\strelka-prefs-'+process.pid+'-'+(++sequence):path.join(dir,'ctl.sock');
 var app;await new Promise(function(resolve,reject){app=service.start({dataDir:dir,socket:endpoint,gps:gps,
  guidance:{evaluate:function(f,now,enabled,preferences){seen=preferences;return guidance.evaluate(f,now,enabled,preferences);},diagnostic:function(){return guidance.diagnostic();}},
  display:{update:function(a){lastOutput=a;},status:function(){return'ready';},diagnostics:function(){return{connection:'ready'};},close:function(){}},
  dimmer:{update:function(){},status:function(){return'off';},close:function(){}},
  storeFactory:function(options){return{current:function(){return options.initial;},status:function(){return{phase:'idle'};},close:function(){}};},
  onListening:resolve,onError:reject});});apps.push(app);
 return{app:app,endpoint:endpoint,seen:function(){return seen;},step:function(x){clock+=1000;gps.fix=fix(x);app.tick();return app.state().alert;}};
}
function cleanup(dir){assert(dir.indexOf(root)===0);fs.readdirSync(dir).forEach(function(name){var f=path.join(dir,name),s=fs.lstatSync(f);if(s.isDirectory()&&!s.isSymbolicLink())cleanup(f);else fs.unlinkSync(f);});fs.rmdirSync(dir);}
async function main(){
 var dir=path.join(root,'legacy');fs.mkdirSync(dir);
 var customLayouts=require(path.join(base,'card-layout')).defaultLayouts();customLayouts.hud.x=250;customLayouts.hud.brightnessPct=80;customLayouts.hud.opacityPct=60;customLayouts.map.scalePct=125;customLayouts.map.y=700;
 var legacy={enabled:true,outputs:{cluster:true,hud:true},hudOpacityPct:55,cardLayout:customLayouts};
 fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify(legacy));
 var run=await start(dir),app=run.app;
 assert(app.state().capabilities.alertPreferences);assert.deepStrictEqual(app.state().alertPreferences,prefs.normalize());
 assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'))),legacy,'Migration must not write until a setting changes');
 assert.strictEqual(run.step(-1100),null);run.step(-990);assert(run.step(-965),'Default 1000 m is actually passed to guidance');
 app.command({cmd:'alert-preferences',warningDistanceM:900});assert.strictEqual(app.state().alert,null,'Reduced distance applies on the same source timestamp');
 assert.strictEqual(lastOutput,null);assert.strictEqual(run.seen().warningDistanceM,900);
 run.step(-850);assert(run.step(-825));
 app.command({cmd:'alert-preferences',cameraTypes:{speed:false}});assert(app.state().alert,'A mixed complex stays visible while belt is enabled');
 app.command({cmd:'alert-preferences',cameraTypes:{belt:false}});assert.strictEqual(app.state().alert,null,'No matching selected type withdraws the alert immediately');
 app.command({cmd:'alert-preferences',cameraTypes:{speed:true}});run.step(-800);assert(run.step(-775));
 var before=JSON.stringify(app.state().alertPreferences);
 [{warningDistanceM:1025},{warningDistanceM:'500'},{warningDistanceM:null},{cameraTypes:{belt:'false'}},{cameraTypes:{unknown:true}},{warningDistanceM:500,unknown:1}].forEach(function(patch){
  assert.throws(function(){app.command(Object.assign({cmd:'alert-preferences'},patch));});assert.strictEqual(JSON.stringify(app.state().alertPreferences),before);
 });
 app.command({cmd:'hud-opacity',percent:25});app.command({cmd:'outputs',cluster:true,hud:true});
 assert.deepStrictEqual(app.state().cardLayout,customLayouts,'Preferences and unrelated commands preserve both customized output profiles');
 assert.strictEqual(app.state().alertPreferences.cameraTypes.belt,false);assert.strictEqual(app.state().alertPreferences.warningDistanceM,900);
 app.command({cmd:'alert-preferences',warningDistanceM:50});assert.strictEqual(app.state().alert,null);
 assert.strictEqual(run.step(-75),null);run.step(-40);assert(run.step(-20));assert.strictEqual(run.step(20),null,'The camera is removed after passing');
 var client=net.connect(run.endpoint),buffer='',replies=[];sockets.push(client);client.setEncoding('utf8');client.on('error',function(){});
 client.on('data',function(bytes){buffer+=bytes;var at;while((at=buffer.indexOf('\n'))>=0){replies.push(JSON.parse(buffer.slice(0,at)));buffer=buffer.slice(at+1);}});
 await until(function(){return replies.length>0;});
 client.write(JSON.stringify({cmd:'alert-preferences',requestId:'prefs-real-ipc',warningDistanceM:950,cameraTypes:{phone:false}})+'\n');
 await until(function(){return replies.some(function(r){var c=r.state&&r.state.commandResult;return c&&c.requestId==='prefs-real-ipc'&&c.phase==='finished';});});
 assert.strictEqual(app.state().alertPreferences.warningDistanceM,950);assert.strictEqual(app.state().alertPreferences.cameraTypes.phone,false);
 var stored=fs.readFileSync(path.join(dir,'settings.json'),'utf8');
 fs.mkdirSync(path.join(dir,'settings.json.tmp'));
 app.command({cmd:'alert-preferences',warningDistanceM:500});assert.strictEqual(app.state().alertPreferences.warningDistanceM,500);
 assert.strictEqual(app.state().storage.settingsSaved,false);assert(/временно/.test(app.state().commandResult.message));
 assert.strictEqual(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),stored,'Write failure retains the persisted settings');
 fs.rmdirSync(path.join(dir,'settings.json.tmp'));
 client.destroy();app.close();
 var restarted=await start(dir),restored=restarted.app.state();
 assert.strictEqual(restored.alertPreferences.warningDistanceM,950);assert.strictEqual(restored.alertPreferences.cameraTypes.belt,false);assert.strictEqual(restored.alertPreferences.cameraTypes.phone,false);
 assert.strictEqual(restored.hudOpacityPct,25);assert.deepStrictEqual(restored.outputs,{cluster:true,hud:true});
 assert.deepStrictEqual(restored.cardLayout,customLayouts);
 console.log('PASS real preferences IPC, old-settings migration, exact ACK, distance/type application on same GPS timestamp, mixed controls, pass withdrawal, invalid atomic patches, unrelated settings, temporary-write feedback and restart persistence');
}
main().catch(function(error){console.error(error.stack);process.exitCode=1;}).then(function(){sockets.forEach(function(s){s.destroy();});apps.forEach(function(a){a.close();});Date.now=originalNow;cleanup(root);});
