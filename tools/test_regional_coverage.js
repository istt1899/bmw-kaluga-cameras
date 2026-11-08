'use strict';
var assert=require('assert'),path=require('path'),fs=require('fs'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
var builder=require('./build-regional-coverage'),coverage=require('../native/marku-kaluga-cameras/files/database-coverage');
var root=path.resolve(__dirname,'..'),file=path.join(root,'data/camera-database-2026.11.7.2.json');
function hash(){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
var before=hash(),report=builder.build(root),saved=JSON.parse(fs.readFileSync(path.join(root,'data/quality/regional-coverage-2026-11-08.json'),'utf8'));
assert.deepStrictEqual(report,saved);assert.strictEqual(builder.serialize(report),fs.readFileSync(path.join(root,'data/quality/regional-coverage-2026-11-08.json'),'utf8'));
assert.deepStrictEqual(report.summary,{complete:false,sourceRecords:308,directLimit:106,referenceLimit:97,unknownLimit:105,roadZones:19,numericRoadZones:18,recordsWithoutRoadZone:289,facingKnown:20,captureSideKnown:0});
assert.strictEqual(report.records.length,308);assert.strictEqual(new Set(report.records.map(function(r){return r.id;})).size,308);
['direct','reference','unknown'].forEach(function(state,i){assert.strictEqual(report.records.filter(function(r){return r.limit.state===state;}).length,[106,97,105][i]);});
report.records.forEach(function(r){assert.strictEqual(r.road.runtimeConfirmed,false);if(r.road.state==='no-zone'){assert.strictEqual(r.road.evidence,null);assert.strictEqual(r.road.limitKmh,null);}if(r.limit.state==='unknown')assert(r.limit.unknownReason);});
assert.strictEqual(report.reviewQueue.officialUnparseableCoordinates.length,2);assert.strictEqual(report.reviewQueue.officialGeographicExclusions.length,3);assert.strictEqual(report.reviewQueue.officialMobileRoutes.records.length,184);assert.strictEqual(report.reviewQueue.osmReviewCandidates.length,55);assert.strictEqual(report.reviewQueue.osmExcludedOutsideBoundary.length,5);
report.reviewQueue.officialUnparseableCoordinates.forEach(function(r){assert(!r.position);assert(r.coordinatesRaw);});
assert.strictEqual(report.sourceChecks[0].publishedAt,'2026-10-01');assert.strictEqual(report.sourceChecks[1].sourceTimestamp,'2026-11-07T00:07:21.000Z');
assert(!/"[A-Z]:[\\/]|Users[\\/]|private[_-]?key|ssh-rsa/i.test(builder.serialize(report)));
var tmp=path.join(os.tmpdir(),'bmw-coverage-'+process.pid+'-'+Date.now()+'.json');
try{cp.execFileSync(process.execPath,[path.join(__dirname,'build-regional-coverage.js'),'--output',tmp]);assert.strictEqual(fs.readFileSync(tmp,'utf8'),builder.serialize(report));var refused=cp.spawnSync(process.execPath,[path.join(__dirname,'build-regional-coverage.js'),'--output',tmp]);assert.notStrictEqual(refused.status,0);assert.strictEqual(fs.readFileSync(tmp,'utf8'),builder.serialize(report));}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
assert.strictEqual(hash(),before);assert.deepStrictEqual(coverage.summarize([],[]),{complete:false,sourceRecords:0,directLimit:0,referenceLimit:0,unknownLimit:0,roadZones:0,numericRoadZones:0,recordsWithoutRoadZone:0,facingKnown:0,captureSideKnown:0});
console.log('PASS reproducible per-record coverage, exact evidence pointers and review queues; immutable camera bundle and create-only output');
