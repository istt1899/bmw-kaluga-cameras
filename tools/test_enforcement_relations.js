'use strict';
var assert = require('assert'), fs = require('fs'), path = require('path');
var api = require('../native/marku-kaluga-cameras/files/database-store');
var dir = path.join(__dirname, '../native/marku-kaluga-cameras/files');
var base = JSON.parse(fs.readFileSync(path.join(dir, 'kaluga-speed.json'), 'utf8'));
var supplement = JSON.parse(fs.readFileSync(path.join(dir, 'enforcement-relations.json'), 'utf8'));
var zones = JSON.parse(fs.readFileSync(path.join(dir, 'road-zones.json'), 'utf8')).zones;
var before = JSON.stringify(base), merged = api.mergeRelations(base, supplement);
assert.strictEqual(JSON.stringify(base), before, 'The original 150-point snapshot must remain unchanged');
assert.strictEqual(supplement.sourcePbfMd5, base.pbfMd5);
assert.strictEqual(supplement.sourceTimestamp, base.sourceTimestamp);
assert.strictEqual(supplement.audit.scannedRelations, 5);
assert.strictEqual(supplement.audit.eligibleRelations, 5);
assert.strictEqual(supplement.audit.uniqueDevices, 5);
assert.strictEqual(supplement.records.length, 5); assert.strictEqual(merged.records.length, 155);
assert.strictEqual(merged.relationAddedCount, 5); assert.strictEqual(merged.relationEnhancedCount, 0);
var popova = merged.records.filter(function (r) { return r.id === 'osm:node:3199757952'; })[0];
assert(popova, 'The omitted Tulskoye/Generala Popova enforcement device must be represented');
assert.strictEqual(popova.position.lat, 54.4932235); assert.strictEqual(popova.position.lon, 36.2283816);
assert.deepStrictEqual(popova.controls, ['speed']); assert.strictEqual(popova.limitKmh, null);
assert.deepStrictEqual(popova.rawLimits, ['RU:urban']); assert.strictEqual(popova.captureSide, 'unknown');
assert.strictEqual(popova.enforcementRelations[0].id, 10391645);
assert.strictEqual(popova.enforcementRelations[0].members.filter(function (m) { return m.role === 'from' && m.position; }).length, 4);
assert(popova.enforcementRelations[0].members.some(function (m) { return m.role === 'to' && m.ref === 259878959 && m.position; }));
assert.strictEqual(popova.deviceTags.highway, 'traffic_signals', 'The import must not require highway=speed_camera on a device');
supplement.records.forEach(function (r) {
  assert.strictEqual(r.limitKmh, null); assert.strictEqual(r.captureSide, 'unknown');
  assert.strictEqual(r.sourceUrl, 'https://www.openstreetmap.org/relation/' + r.enforcementRelations[0].id);
  assert.strictEqual(r.positionSourceUrl, 'https://www.openstreetmap.org/node/' + r.id.split(':').pop());
  assert(r.enforcementRelations[0].timestamp && r.enforcementRelations[0].version);
});
api.validateBundle(Object.assign({}, merged, { schema: 1, version: '2026.11.06.1', generatedAt: '2026-11-06T00:00:00Z', zones: zones }));
var twice = api.mergeRelations(merged, supplement);
assert.strictEqual(twice.records.length, merged.records.length); assert.strictEqual(twice.relationAddedCount, 0);
var bad = JSON.parse(JSON.stringify(supplement)); bad.records[0].position.lat = 0;
assert.throws(function () { api.mergeRelations(base, bad); }); assert.strictEqual(JSON.stringify(base), before);
console.log('PASS all 5 regional enforcement relations, Popova device/4 approaches, original source dates/hash, no invented numeric limit/capture side, transactional deduplication');

async function hostImporter() {
  if (+process.versions.node.split('.')[0] < 18) { console.log('SKIP host-only ESM importer tests on vehicle Node; all generated-data/runtime checks passed'); return; }
  var url = require('url').pathToFileURL(path.join(__dirname, 'build-enforcement-relations.mjs')).href;
  // Keep import() out of the Node 8 parser while testing the actual host importer.
  var builder = await new Function('u', 'return import(u)')(url);
  var node = { type: 'node', id: 100, lat: 54.5, lon: 36.2, tags: { highway: 'traffic_signals' } };
  function relation(id, enforcement, maxspeed) { return { type: 'relation', id: id, version: 1, timestamp: '2026-11-05T00:00:00Z', tags: { type: 'enforcement', enforcement: enforcement, maxspeed: maxspeed }, members: [{ type: 'node', ref: 100, role: 'device' }] }; }
  var fixture = [node, relation(200, 'maxspeed;traffic_signals;seatbelt', '60'), relation(201, 'maxspeed', '70'),
    relation(202, 'maxweight', null), { type: 'relation', id: 203, tags: { type: 'enforcement', enforcement: 'maxspeed' }, members: [] },
    { type: 'relation', id: 204, tags: { type: 'enforcement', enforcement: 'maxspeed' }, members: [{ type: 'node', ref: 999, role: 'device' }] }];
  var built = builder.buildRelations(fixture, { sourceTimestamp: '2026-11-05T00:00:00Z' });
  assert.strictEqual(built.records.length, 1); assert.strictEqual(built.audit.scannedRelations, 5);
  assert.strictEqual(built.audit.eligibleRelations, 2); assert.strictEqual(built.audit.duplicateDevicesMerged, 1);
  assert.deepStrictEqual(built.records[0].controls, ['speed', 'redlight', 'belt']);
  assert.strictEqual(built.records[0].limitKmh, null, 'Conflicting source limits must remain unknown');
  assert.strictEqual(built.records[0].captureSide, 'unknown');
  assert.deepStrictEqual(built.audit.unsupported.map(function (r) { return r.reason; }), ['UNSUPPORTED_ENFORCEMENT_KIND', 'NO_DEVICE_MEMBER', 'DEVICE_COORDINATES_UNAVAILABLE']);
  assert.strictEqual(built.relations.length, 5, 'Unsupported raw relations stay in the audit');
  console.log('PASS actual importer: multi-control records, shared-device deduplication, limit conflict, unsupported kind and missing member/coordinate audit');
}
hostImporter().catch(function (e) { console.error(e.stack); process.exitCode = 1; });
