'use strict';
const assert=require('assert');
const db=require('./build-camera-database').bundle();
const {createGuidance}=require('../native/marku-kaluga-cameras/files/vehicle-guidance');
const record=db.records.find(r=>(r.enforcementRelations||[]).some(x=>x.id===10391645));
assert(record);const relation=record.enforcementRelations.find(x=>x.id===10391645);
const to=relation.members.find(m=>m.role==='to').position;
const approaches=relation.members.filter(m=>m.role==='from'&&m.position);
for(const from of approaches){
 const dx=(from.position.lon-to.lon)*111320*Math.cos(to.lat*Math.PI/180),dy=(from.position.lat-to.lat)*111320,length=Math.hypot(dx,dy);
 const bearing=(Math.atan2(-dx,-dy)*180/Math.PI+360)%360;
 const guidance=createGuidance({records:[record],zones:[]});let shown=null;
 for(let i=0;i<5;i++){
  const d=200-i*30,t=Date.now()+i*1000;
  const fix={lat:to.lat+dy/length*d/111320,lon:to.lon+dx/length*d/(111320*Math.cos(to.lat*Math.PI/180)),timeMs:t,speedKmh:54,headingDeg:bearing,accuracyM:5};
  const notice=guidance.evaluate(fix,t,true);if(notice)shown=notice;
 }
 assert(shown,'Known mapped device should produce a clearly unconfirmed nearby notice from each reported approach');
 assert.strictEqual(shown.id,record.id);assert.strictEqual(shown.confidence,'nearby');assert.strictEqual(shown.roadConfirmed,false);
 assert.strictEqual(shown.limitKmh,null);assert.strictEqual(shown.captureDirectionVerified,false);
 assert(shown.controls.includes('speed'));
}
console.log('PASS Tulskoye/Popova: 4 source approaches detect the imported device as nearby; no invented road confirmation, numeric limit or capture side');
