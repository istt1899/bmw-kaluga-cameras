'use strict';
var assert=require('assert'),api=require('../native/marku-kaluga-cameras/files/camera-orientation'),info=require('../native/marku-kaluga-cameras/files/camera-info');
function record(raw){return{id:'osm:node:42',sourceUrl:'https://www.openstreetmap.org/node/42',rawDirection:raw,controls:['speed']};}
assert.deepStrictEqual(api.describe(record('N; NE;E;S;W;NNW;360;0')).bearingsDeg,[0,45,90,180,270,337.5]);
assert.deepStrictEqual(api.describe(record('330;150')).bearingsDeg,[330,150]);
assert.deepStrictEqual(api.describe(record('22.5;22.5')).bearingsDeg,[22.5]);
['-97','632','553','361','forward','backward','NaN','Infinity','0x20','1e2','20;',';20','20;;30',';','N;bad','20deg'].forEach(function(raw){var d=api.describe(record(raw));assert.strictEqual(d.state,'unknown',raw);assert.deepStrictEqual(d.bearingsDeg,[]);});
[null,undefined,'','  ',310].forEach(function(raw){assert.strictEqual(api.describe(record(raw)).state,'unknown');});
var fake=record('310');fake.sourceUrl='https://www.openstreetmap.org/node/43';assert.strictEqual(api.describe(fake).state,'unknown');
fake.sourceUrl='https://www.openstreetmap.org/relation/42';assert.strictEqual(api.describe(fake).state,'unknown');
fake=record('310');fake.id='gibdd:ru-klu:42';assert.strictEqual(api.describe(fake).state,'unknown');
var r=record('310'),before=JSON.stringify(r),detail=info.describe(r);assert.strictEqual(JSON.stringify(r),before);assert.strictEqual(detail.cameraFacing.interpretation,'camera-facing');assert.strictEqual(detail.captureDirectionVerified,false);assert.strictEqual(detail.captureDirection,null);
var db=require('../data/camera-database-2026.11.7.2.json');assert.strictEqual(db.records.filter(function(r){return info.describe(r).cameraFacing.state==='mapped';}).length,20);
assert.strictEqual(db.records.filter(function(r){return info.describe(r).captureDirectionVerified;}).length,0);
console.log('PASS camera-facing source identity, cardinal/numeric/semicolon parsing, invalid inputs and 20 real orientations; no capture-side inference');
