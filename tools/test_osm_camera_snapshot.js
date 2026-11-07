'use strict';
// Host-only independent source fixtures; no network, PBF download or vehicle.
const assert=require('assert'),path=require('path');
const {pathToFileURL}=require('url');
async function main(){
 const api=await import(pathToFileURL(path.join(__dirname,'build-osm-camera-snapshot.mjs')).href);
 assert.deepStrictEqual(api.parseFacingDirection('NNE').bearingsDeg,[22.5]);
 assert.deepStrictEqual(api.parseFacingDirection('0;360;270.5').bearingsDeg,[0,270.5]);
 for(const value of ['-97','553','632','NaN','eastward'])assert.strictEqual(api.parseFacingDirection(value).state,'unsupported');
 assert.strictEqual(api.parseFacingDirection('forward').state,'relative-to-way');
 assert.strictEqual(api.parseFacingDirection('90').captureSide,'unknown','orientation alone is never proof of photographing front/rear');
 const node=(id,lon,lat,tags={})=>({type:'node',id,lon,lat,tags,info:{version:2,timestamp:Date.UTC(2026,10,7),changeset:30,visible:false,uid:900,user:'fixture-mapper'}});
 const elements=[node(1,0,0),node(2,10,0),node(3,10,10),node(4,0,10),node(5,4,4),node(6,6,4),node(7,6,6),node(8,4,6),
  {type:'way',id:11,refs:[1,2,3]},{type:'way',id:12,refs:[1,4,3]}, // backwards segment must join correctly
  {type:'way',id:13,refs:[5,6,7,8,5]},
  {type:'relation',id:81995,tags:{type:'boundary',boundary:'administrative'},members:[{type:'way',ref:11,role:'outer'},{type:'way',ref:12,role:'outer'},{type:'way',ref:13,role:'inner'}]},
  node(100,1,1,{highway:'speed_camera',maxspeed:'60',direction:'NNE',description:'Источник описывает модель',ref:'ID-7'}),
  node(101,15,15,{highway:'speed_camera'}),node(102,5,5,{highway:'speed_camera'}),
  node(103,2,2,{man_made:'surveillance','surveillance:type':'ALPR','surveillance:zone':'traffic'}),
  node(104,3,3,{'disused:highway':'speed_camera'}),node(105,2.5,2.5),
  node(106,3.5,3.5,{'proposed:highway':'speed_camera'}),node(107,7,7,{enforcement:'mobile_phone',maxspeed:'60'}),
  node(108,8,8,{enforcement:'unknown_kind'}),
  {type:'relation',id:200,info:{version:3,timestamp:Date.UTC(2026,9,1)},tags:{type:'enforcement',enforcement:'maxspeed',maxspeed:'RU:urban'},members:[{type:'node',ref:105,role:'device'},{type:'node',ref:100,role:'from'}]}];
 const boundary=api.boundaryFromElements(elements);
 assert(api.insideBoundary([1,1],boundary));assert(!api.insideBoundary([5,5],boundary));assert(api.insideBoundary([0,5],boundary));assert(!api.insideBoundary([15,15],boundary));
 assert.throws(()=>api.boundaryFromElements(elements.filter(e=>e.id!==12)),/missing\/incomplete/);
 assert.throws(()=>api.boundaryFromElements(elements.filter(e=>e.id!==4)),/node missing/);
 const frozen=JSON.stringify(elements),snapshot=api.buildSnapshot(elements,{sourceTimestamp:'2026-11-07T00:07:21.000Z',boundary});
 assert.strictEqual(JSON.stringify(elements),frozen,'normalisation does not mutate source evidence');
 assert.strictEqual(snapshot.counts.mappedSpeedCameraPoints,1);
 assert.strictEqual(snapshot.counts.relationDeviceOnlyPoints,1);
 assert.strictEqual(snapshot.counts.mappedEnforcementPoints,3);
 assert.strictEqual(snapshot.excluded.length,2,'complete-way and boundary hole points never inflate regional count');
 assert.strictEqual(snapshot.inactiveRecords.length,2);
 assert(snapshot.reviewCandidates.some(r=>r.reviewReason==='SURVEILLANCE_IS_NOT_ENFORCEMENT'));
 assert(snapshot.reviewCandidates.some(r=>r.reviewReason==='UNSUPPORTED_ENFORCEMENT_KIND'));
 const camera=snapshot.records.find(r=>r.id==='osm:node:100');
 assert.strictEqual(camera.operatingStatus,'not-verified');assert.strictEqual(camera.lifecycle,'mapped','PBF default visible:false does not prove a deleted object');
 assert.strictEqual(camera.rawTags.direction,'NNE');assert.strictEqual(camera.osmVersion,2);assert.strictEqual(camera.osmTimestamp,'2026-11-07T00:00:00.000Z');
 assert.strictEqual(camera.ref,'ID-7');assert.strictEqual(camera.captureSide,'unknown');
 assert(!Object.hasOwn(camera,'uid')&&!Object.hasOwn(camera,'user'),'mapper account identifiers are unnecessary for source evidence');
 assert.strictEqual(snapshot.records.find(r=>r.id==='osm:node:105').limitKmh,null,'RU:urban is retained raw, not guessed as 60');
 assert.strictEqual(snapshot.records.find(r=>r.id==='osm:node:107').limitKmh,null,'phone control does not become a speed camera');
 const conflict=JSON.parse(JSON.stringify(elements));conflict.push({type:'relation',id:201,tags:{type:'enforcement',enforcement:'maxspeed',maxspeed:'70'},members:[{type:'node',ref:100,role:'device'}]});
 const mixed=api.buildSnapshot(conflict,{boundary}).records.find(r=>r.id==='osm:node:100');assert.strictEqual(mixed.limitKmh,null);assert.strictEqual(mixed.limitConflict,true);
 console.log('PASS OSM boundary topology/holes/filtering, lifecycle quarantine, raw per-field evidence, numeric/compass facing, independent capture side and typed enforcement controls');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
