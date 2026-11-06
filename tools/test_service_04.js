'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),EventEmitter=require('events');
const service=require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'strelka04-actions-'));
const gps=new EventEmitter();gps.start=gps.close=()=>{};
let fix={lat:54.4932,lon:36.2282,timeMs:Date.now(),motionTimeMs:Date.now(),accuracyM:19.4,speedKmh:0,headingDeg:0,source:'bmw-nmea'};
gps.current=()=>fix;
let displayAlert=null,resolveAudio,resolveCheck,storeOptions;
async function main(){let app;
 try{
  await new Promise((resolve,reject)=>{app=service.start({dataDir:dir,socket:process.platform==='win32'?'\\\\.\\pipe\\strelka04-'+process.pid:path.join(dir,'ctl.sock'),gps,
   storeFactory:o=>{storeOptions=o;return {current:()=>o.initial,status:()=>({phase:'idle',canCheck:true,canRollback:false}),check:()=>{o.onStatus({phase:'checking'});return new Promise(r=>{resolveCheck=r;});},close:()=>{}};},
   audio:{play:()=>new Promise(r=>{resolveAudio=r;})},guidance:{evaluate:()=>null},
   display:{update:a=>{displayAlert=a;},status:()=>'ready',diagnostics:()=>({map:{state:'shown'},hud:{state:'shown'}}),close:()=>{}},
   dimmer:{update:()=>{},status:()=>'off',close:()=>{}},onListening:resolve,onError:reject});});
  app.command({cmd:'outputs',cluster:true,hud:true});
  assert.strictEqual(app.state().gpsFix.accuracyM,19.4);assert(app.state().actions.displayTest.allowed);
  app.command({cmd:'display-test',requestId:'test-display-1'});assert(app.state().displayTest.active&&displayAlert.test);
  assert.strictEqual(app.state().commandResult.requestId,'test-display-1','renderer completion preserves exact client request ID');
  assert.strictEqual(app.state().commandResult.phase,'shown');assert.strictEqual(app.state().alert,null);
  app.command({cmd:'calibration-test'});assert(displayAlert.calibration);assert.strictEqual(app.state().commandResult.command,'calibration-test');
  fix=Object.assign({},fix,{speedKmh:10});app.tick();assert(!app.state().displayTest.active);
  assert.throws(()=>app.command({cmd:'display-test'}),/остановитесь/);assert.strictEqual(app.state().commandResult.phase,'error');
  fix=Object.assign({},fix,{speedKmh:0,timeMs:Date.now(),motionTimeMs:Date.now()});
  app.command({cmd:'audio-test',requestId:'test-audio-2'});await new Promise(r=>setImmediate(r));
  assert.strictEqual(app.state().commandResult.requestId,'test-audio-2');
  app.command({cmd:'disable',requestId:'test-disable-3'});const newer=app.state().commandResult.id;
  resolveAudio({played:true});await new Promise(r=>setImmediate(r));
  assert.strictEqual(app.state().commandResult.id,newer,'old audio completion must not replace a newer command result');
  assert.strictEqual(app.state().commandResult.requestId,'test-disable-3');
  assert.throws(()=>app.command({cmd:'enable',requestId:'bad\nrequest'}),/Invalid requestId/);
  assert.strictEqual(app.state().commandResult.requestId,'test-disable-3','invalid token cannot overwrite a valid command');
  app.command({cmd:'database-check'});assert(app.state().databaseUpdate.busy);
  app.command({cmd:'enable'});const newest=app.state().commandResult.id;
  resolveCheck({phase:'current',currentVersion:'2026.11.6.1'});await new Promise(r=>setImmediate(r));
  assert.strictEqual(app.state().commandResult.id,newest,'old database completion must not replace a newer command result');
  const stamp=Date.now();app.command({cmd:'vehicle-context',street:{name:'Тульское шоссе',source:'BMW',state:'ready',observedAtMs:stamp},audio:{state:'detected',available:true}});
  assert.strictEqual(app.state().street.name,'Тульское шоссе');
  app.command({cmd:'vehicle-context',street:{name:'old',source:'BMW',state:'ready',observedAtMs:stamp-16000}});assert.strictEqual(app.state().street.name,null);
  app.command({cmd:'vehicle-context',street:{name:'not ready',source:'BMW',state:'unavailable',observedAtMs:stamp}});assert.strictEqual(app.state().street.name,null);
  assert.throws(()=>app.command({cmd:'vehicle-context',street:{name:'bad\nname',source:'BMW',state:'ready',observedAtMs:stamp}}),/STREET_PAYLOAD_INVALID/);
  app.close();displayAlert='closed-marker';gps.emit('fix',fix);app.tick();assert.strictEqual(displayAlert,'closed-marker');
  assert.throws(()=>app.command({cmd:'enable'}),/завершает работу/);
  console.log('PASS real service 0.4: stationary 19.4m test, shared policy, renderer acknowledgement, calibration, moving withdrawal, live error, command-ID isolation and bounded native street');
 }finally{if(app)app.close();fs.readdirSync(dir).forEach(n=>fs.unlinkSync(path.join(dir,n)));fs.rmdirSync(dir);}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
