'use strict';
// Reproduce the photographed 70 m / nearby warning with real source records.
var assert=require('assert'),crypto=require('crypto'),fs=require('fs');
var bundle=require('./build-camera-database').bundle(),info=require('../native/marku-kaluga-cameras/files/camera-info');
var guidance=require('../native/marku-kaluga-cameras/files/vehicle-guidance'),card=require('../native/marku-kaluga-cameras/files/alert-card');
var view=require('../apps/marku_kaluga_cameras/src/view_model'),diag=require('../apps/marku_kaluga_cameras/src/diagnostics_view');
var official=bundle.records.find(function(r){return r.id==='gibdd:ru-klu:fc2bb7199a68c7be';}),describe=info.createDescriber(bundle.records);
var before=JSON.stringify(bundle),d=describe(official);
assert.strictEqual(official.limitKmh,null,'No numeric limit is added to official source data');
assert.strictEqual(d.cameraLimitKmh,null);assert.strictEqual(d.limitReference.valueKmh,60);assert.strictEqual(d.limitReference.kind,'reviewed-location-links');
assert.strictEqual(d.limitReference.records.length,3);assert(d.limitReference.records.every(function(e){return e.valueKmh===60&&/openstreetmap\.org/.test(e.url);}));
var ids=require('./fixtures/plehanova-suvorova.json').cameraIds;
ids.concat([official.id]).forEach(function(id,index){
 var r=bundle.records.find(function(x){return x.id===id;}),g=guidance.createGuidance({zones:[],records:bundle.records});
 var time=Date.UTC(2026,10,7,12)+index*10000;
 // At each exact source position that record must be the nearest candidate.
 var alert=g.evaluate({lat:r.position.lat,lon:r.position.lon,timeMs:time,speedKmh:19,headingDeg:90,accuracyM:5},time,true);
 assert(alert&&alert.id===id);assert.strictEqual(alert.roadConfirmed,false);assert.strictEqual(alert.limitKmh,null);
 var display=card.presentation(Object.assign({},alert,{speedKmh:95,overspeed:true}));
 assert.strictEqual(display.limit,60,id);assert.strictEqual(display.limitScope,'reference');assert.strictEqual(display.overspeed,false);
 var text=view.model({alert:alert}).text.cameraLimit;assert(text.indexOf('60')>=0&&text.indexOf('по базе')>=0&&text.indexOf('не подтверждена')>=0);
});
var t=Date.UTC(2026,10,7,13),g=guidance.createGuidance(bundle);
var alert=g.evaluate({lat:official.position.lat,lon:official.position.lon-70/(111320*Math.cos(official.position.lat*Math.PI/180)),timeMs:t,speedKmh:19,headingDeg:90,accuracyM:10},t,true);
assert(alert&&alert.confidence==='nearby');assert.strictEqual(card.presentation(alert).limit,60,'Full 308-record database at the photographed west approach must retain the source limit');
assert.strictEqual(card.presentation(alert).limitScope,'reference');
var unrelated=JSON.parse(JSON.stringify(bundle.records));unrelated.forEach(function(r){delete r.officialSiteContext;});
assert.strictEqual(info.createDescriber(unrelated)(official).limitReference,null,'Proximity alone never transfers a limit');
var conflict=JSON.parse(JSON.stringify(bundle.records));conflict.find(function(r){return r.id==='osm:node:11980400006';}).limitKmh=40;
var conflictReference=info.createDescriber(conflict)(official).limitReference;
assert.strictEqual(conflictReference.state,'conflict');assert.strictEqual(conflictReference.valueKmh,null);
assert.strictEqual(card.presentation({roadConfirmed:false,limitReference:conflictReference}).limit,null);
assert.strictEqual(card.presentation({roadConfirmed:false,limitKmh:60}).limit,null,'An unconfirmed effective road field is not a source record');
assert.strictEqual(card.presentation({roadConfirmed:true,limitKmh:40,cameraLimitKmh:60}).limit,40,'Confirmed applicable limit takes precedence over reference');
assert.strictEqual(card.presentation({roadConfirmed:true,limitKmh:40,speedKmh:42,overspeed:true}).overspeed,true);
var unknown=bundle.records.find(function(r){return r.providerId==='gibdd-official'&&!describe(r).limitReference;});
assert(unknown);assert.strictEqual(card.presentation(describe(unknown)).limit,null,'No universal city-60 fallback');
assert.strictEqual(JSON.stringify(bundle),before,'References cannot rewrite the database');
assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(require('path').join(__dirname,'../data/camera-database-2026.11.7.1.json'))).digest('hex'),'d094c399802c2952332bbedbb5db6b22a0de87e3450205579cb541edba9a1e67');
console.log('PASS photographed Plehanova/Suvorova nearby-limit regression: all four OSM objects and official point show reference 60; reviewed-link provenance, 70m west approach, conflicts/unknowns, no proximity merge or overspeed until road confirmation; published data bytes unchanged');
var EventEmitter=require('events'),os=require('os'),path=require('path');
async function daemonRegression(){
 var service=require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'strelka-nearby-limit-'));
 var gps=new EventEmitter(),app,shown=null;gps.start=gps.close=function(){};gps.current=function(){return{lat:official.position.lat,lon:official.position.lon-70/(111320*Math.cos(official.position.lat*Math.PI/180)),timeMs:Date.now(),speedKmh:19,headingDeg:90,accuracyM:10};};
 try{
  await new Promise(function(resolve,reject){app=service.start({dataDir:dir,socket:process.platform==='win32'?'\\\\.\\pipe\\strelka-limit-'+process.pid:path.join(dir,'ctl.sock'),gps:gps,onListening:resolve,onError:reject,
   display:{update:function(a){shown=a;},status:function(){return'off';},close:function(){}},dimmer:{update:function(){},status:function(){return'off';},close:function(){}}});});
  var s=app.state();assert(s.alert&&shown);assert.strictEqual(card.presentation(shown).limit,60);assert.strictEqual(s.alert.roadConfirmed,false);assert.strictEqual(s.alert.overspeed,false);
  assert.strictEqual(card.presentation(s.nearest).limit,60,'Public nearest diagnostics also retain the reference');
  var frozen=diag.capture(s,'0.5.1',Date.now()),page=diag.reportPage(frozen,s,'0.5.1',2,0),lines=[];
  for(var i=0;i<page.blocks;i++){var block=diag.reportPage(frozen,s,'0.5.1',2,i);for(var j=1;j<=10;j++)lines.push(block.rows['row'+j]);}
  var text=lines.join(' ');assert(text.indexOf('Справочный лимит: 60')>=0);assert(text.indexOf('Источники справочного лимита')>=0);
  s.alert.limitReference.records.forEach(function(e){assert(text.replace(/\s/g,'').indexOf(e.url)>=0);});
  console.log('PASS real daemon to display adapter/public state/frozen six-page diagnostics retains reference 60 and complete source links');
 }finally{if(app)app.close();fs.readdirSync(dir).forEach(function(name){fs.unlinkSync(path.join(dir,name));});fs.rmdirSync(dir);}
}
daemonRegression().catch(function(e){console.error(e.stack);process.exitCode=1;});
