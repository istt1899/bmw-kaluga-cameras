'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),EventEmitter=require('events');
const service=require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');
const view=require('../apps/marku_kaluga_cameras/src/diagnostics_view');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'camera-diagnostic-'));
const socket=process.platform==='win32'?'\\\\.\\pipe\\camera-diagnostic-'+process.pid:path.join(dir,'ctl.sock');
const gps=new EventEmitter();gps.start=gps.close=()=>{};
let fix=null,shown=null;gps.current=()=>fix;
async function main(){
 let app;
 try{
  await new Promise((resolve,reject)=>{app=service.start({dataDir:dir,socket,gps,onListening:resolve,onError:reject,
   guidance:{evaluate:()=>null},display:{update:a=>{shown=a;},status:()=>'map visible, hud blocked',
    diagnostics:()=>({map:{state:'visible',target:'mapped'},hud:{state:'blocked',reason:'HUD_GUARD'}}),close:()=>{}},
   dimmer:{update:()=>{},status:()=>'off',close:()=>{}}});});
  assert.throws(()=>app.command({cmd:'display-test'}),/остановитесь/);
  fix={lat:54.51758,lon:36.24867,timeMs:Date.now(),accuracyM:5,speedKmh:20,headingDeg:15};
  assert.throws(()=>app.command({cmd:'display-test'}),/остановитесь/);
  fix.speedKmh=0;fix.timeMs=Date.now()-4000;
  assert.throws(()=>app.command({cmd:'display-test'}),/остановитесь/);
  fix.timeMs=Date.now();assert.throws(()=>app.command({cmd:'display-test'}),/включите приборы/);
  app.command({cmd:'outputs',cluster:true,hud:true});
  const saved=fs.readFileSync(path.join(dir,'settings.json'),'utf8');
  app.command({cmd:'display-test'});assert(app.state().displayTest.active&&shown&&shown.test&&shown.title.includes('ТЕСТ'));
  assert.strictEqual(app.state().alert,null,'test must not pretend to be a real camera detection');
  assert.strictEqual(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),saved,'test does not alter persisted configuration');
  let rows=view.values(app.state(),'0.3.1',true);
  assert(rows.stamp.includes('Снимок зафиксирован'));assert(rows.position.includes('54.517580'));assert(rows.hud.includes('HUD_GUARD'));
  assert(view.KEYS.every(k=>typeof rows[k]==='string'));
  assert.strictEqual(app.state().displayTest.pinned,true);
  assert(rows.test.includes('закреплён'),'diagnostics describes the pinned preview rather than an expiry time');
  app.command({cmd:'display-test-stop'});assert.strictEqual(app.state().displayTest.active,false);assert.strictEqual(shown,null);
  app.command({cmd:'display-test'});fix.speedKmh=2;app.tick();assert.strictEqual(app.state().displayTest.active,false);
  rows=view.values(null,'0.3.1',false);assert(rows.service.includes('нет связи'));
  console.log('PASS diagnostic rows, exact GPS, renderer refusal; parked-only pinned TEST, no fake detection/settings change, explicit stop and movement cancellation');
 }finally{if(app)app.close();fs.readdirSync(dir).forEach(n=>fs.unlinkSync(path.join(dir,n)));fs.rmdirSync(dir);}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
