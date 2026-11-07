'use strict';
// Normalized input API examples. Synthetic facts test publication semantics;
// they are not camera observations and are never appended to a runtime DB.
const assert = require('assert');
const policy = require('./camera-source-policy');
const registry = require('../data/source-registry.json');
const nowMs = Date.UTC(2026, 10, 7, 12, 0, 0), stamp = value => new Date(value).toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const evidence = (sourceId, extra) => Object.assign({ sourceId, observedAt: stamp(nowMs - 60000) }, extra || {});
function assess(facts, extra, sourceRegistry) {
    return policy.assessObservation(Object.assign({ id: 'synthetic:policy-test', facts }, extra || {}), sourceRegistry || registry, { nowMs });
}
function explicit(value, sourceId) { return { value, basis: 'explicit', evidence: [evidence(sourceId || 'osm')] }; }
assert.strictEqual(policy.validateRegistry(registry).sources.length, 13);
assert.throws(() => policy.validateRegistry(Object.assign({}, registry, { schema: 2 })), /SOURCE_REGISTRY_INVALID/);
const duplicate = clone(registry); duplicate.sources.push(clone(duplicate.sources[0])); assert.throws(() => policy.validateRegistry(duplicate), /SOURCE_ENTRY_INVALID/);
const badUrl = clone(registry); badUrl.sources[0].urls[0] = 'https://secret@example.com/'; assert.throws(() => policy.validateRegistry(badUrl), /SOURCE_ENTRY_INVALID/);
const invalidDate = clone(registry); invalidDate.checkedAt = '2026-02-31T00:00:00Z'; assert.throws(() => policy.validateRegistry(invalidDate), /SOURCE_REGISTRY_INVALID/);

// A normal fact retains its per-field source record, URL and date.
let result = assess({ position: { value: { lat: 54.5, lon: 36.2 }, evidence: [evidence('osm', { sourceRecordId: 'synthetic-node', sourceUrl: 'https://www.openstreetmap.org/node/1' })] },
    controls: explicit(['speed']), limitKmh: explicit(60), captureSide: explicit('rear'),
    approachBearing: { value: 90, semantics: 'vehicle-travel', evidence: [evidence('osm')] } });
assert(result.eligibleForPublication); assert.strictEqual(result.acceptedFacts.limitKmh.value, 60);
assert.strictEqual(result.verification, 'not-assessed', 'publication permission does not assert factual truth');
assert.strictEqual(result.independentFamilyCount, 1); assert.strictEqual(result.acceptedFacts.position.evidence[0].sourceRecordId, 'synthetic-node');

for (const id of ['yandex', 'mapcam', 'radarbase', 'hud-speed', 'gps-antiradar', 'radarbot', 'speedcamonline', 'strelka', 'estrelka', 'cbdd-official']) {
    result = assess({ position: explicit({ lat: 54.5, lon: 36.2 }, id) });
    assert(!result.eligibleForPublication && result.rejectedFacts.position.includes('SOURCE_NOT_APPROVED'), id);
    assert.strictEqual(result.independentFamilyCount, 0);
}
assert.strictEqual(registry.sources.find(source => source.id === 'speedcamonline').redistribution, 'not-established', 'unknown permission is not mislabeled as a universal ban');
result = assess({ controls: explicit(['speed'], 'gibdd-official') }); assert(result.eligibleForPublication, 'source-specific official reuse permission is registered');
result = assess({ position: explicit({ lat: 54.5, lon: 36.2 }, 'owner-report') }); assert(result.rejectedFacts.position.includes('OWNER_CONSENT_REQUIRED'));
result = assess({ position: { value: { lat: 54.5, lon: 36.2 }, evidence: [evidence('owner-report', { consentToRedistribute: true })] } }); assert(result.eligibleForPublication);
result = assess({ position: { value: { lat: 54.5, lon: 36.2 }, evidence: [evidence('osm', { sourceUrl: 'https://example.com/copied-data' })] } }); assert(result.rejectedFacts.position.includes('SOURCE_URL_UNREGISTERED'));
result = assess({ position: { value: {}, evidence: [evidence('osm'), evidence('mapcam')] } }); assert(!result.eligibleForPublication, 'unlicensed provenance cannot be laundered through an extra OSM citation');

// Mirrors/apps of one family never count as independent corroboration.
const mirrors = clone(registry), mirror = clone(mirrors.sources[0]); mirror.id = 'synthetic-osm-mirror'; mirrors.sources.push(mirror);
result = assess({ controls: { value: ['speed'], basis: 'explicit', evidence: [evidence('osm'), evidence('synthetic-osm-mirror'), evidence('osm')] } }, null, mirrors);
assert.strictEqual(result.factEvidence.controls.independentFamilyCount, 1); assert.strictEqual(result.independentFamilyCount, 1);
result = assess({ controls: { value: ['speed'], basis: 'explicit', evidence: [evidence('osm'), evidence('gibdd-official')] } }); assert.strictEqual(result.factEvidence.controls.independentFamilyCount, 2);
result = assess({ controls: explicit(['speed']), model: explicit('synthetic-model', 'gibdd-official') });
assert.strictEqual(result.independentFamilyCount, 2); assert.strictEqual(result.factEvidence.controls.independentFamilyCount, 1, 'An unrelated fact from another source does not corroborate this field');

// A travel bearing is not a camera-facing bearing and never creates rear/front.
result = assess({ approachBearing: { value: 90, semantics: 'camera-facing', evidence: [evidence('osm')] } }); assert(result.rejectedFacts.approachBearing.includes('DIRECTION_SEMANTICS_MISMATCH'));
result = assess({ cameraFacingBearing: { value: 270, semantics: 'camera-facing', evidence: [evidence('osm')] } }); assert(result.eligibleForPublication); assert(!result.acceptedFacts.captureSide);
result = assess({ approachBearing: { value: 90, semantics: 'unknown', evidence: [evidence('osm')] }, captureSide: { value: 'rear', basis: 'derived-from-bearing', evidence: [evidence('osm')] } });
assert(result.rejectedFacts.captureSide.includes('CAPTURE_SIDE_NOT_EXPLICIT'));
for (const basis of ['fallback', 'unknown', 'urban-default']) {
    result = assess({ limitKmh: { value: 60, basis, evidence: [evidence('osm')] } }); assert(result.rejectedFacts.limitKmh.includes('LIMIT_NOT_EXPLICIT'));
}
result = assess({ limitKmh: { value: null, basis: 'unknown', evidence: [evidence('osm')] } }); assert(result.eligibleForPublication); assert.strictEqual(result.acceptedFacts.limitKmh.value, null);
result = assess({ controls: { value: ['belt', 'phone'], basis: 'model-capability', evidence: [evidence('osm')] } }); assert(result.rejectedFacts.controls.includes('CONTROLS_NOT_EXPLICIT'));
result = assess({ controls: { value: ['speed'], evidence: [evidence('osm')] } }); assert(result.rejectedFacts.controls.includes('CONTROLS_NOT_EXPLICIT'));
result = assess({ controls: { value: [], basis: 'unknown', evidence: [evidence('osm')] } }); assert(result.eligibleForPublication);
result = assess({ position: explicit({ lat: 91, lon: 36.2 }) }); assert(result.rejectedFacts.position.includes('POSITION_VALUE_INVALID'));

// Mobile claims need bounded observation age and expiry; a historical possible
// installation site must not be relabeled a current mobile camera by a caller.
result = assess({ controls: explicit(['speed']) }, { mobility: 'mobile' }); assert(result.rejectedFacts.controls.includes('MOBILE_FRESHNESS_REQUIRED'));
result = assess({ controls: explicit(['speed']) }, { mobility: 'mobile', expiresAt: stamp(nowMs + 300000) }); assert(result.eligibleForPublication);
result = assess({ controls: explicit(['speed']) }, { mobility: 'mobile', expiresAt: stamp(nowMs - 1) }); assert(result.rejectedFacts.controls.includes('EVIDENCE_EXPIRED'));
result = assess({ controls: explicit(['speed']) }, { mobility: 'mobile', expiresAt: stamp(nowMs + policy.MAX_MOBILE_TTL_MS) }); assert(result.rejectedFacts.controls.includes('MOBILE_FRESHNESS_REQUIRED'));
result = assess({ model: { value: 'test', evidence: [evidence('osm', { observedAt: stamp(nowMs + 300001) })] } }); assert(result.rejectedFacts.model.includes('EVIDENCE_TIME_INVALID'));
assert.throws(() => assess({ model: { value: 'x'.repeat(4097), evidence: [evidence('osm')] } }), /POLICY_INPUT_VALUE/);
const oversized = {}; for (let i = 0; i < 64; i++) oversized['key' + i] = 'x'.repeat(4096);
assert.throws(() => assess({ model: { value: oversized, evidence: [evidence('osm')] } }), /POLICY_INPUT_SIZE/);
assert.throws(() => policy.assessObservation(JSON.parse('{"id":"synthetic:x","facts":{"__proto__":{"value":1}}}'), registry, { nowMs }), /POLICY_INPUT_KEYS/);
const hugeKey = {}; hugeKey['x'.repeat(129)] = explicit('x'); assert.throws(() => assess(hugeKey), /POLICY_INPUT_KEYS/);
console.log('PASS host-only camera source registry, per-field permission gates, explicit official/owner attribution, source-family independence, bearing/capture semantics, unknown-limit rejection and bounded mobile expiry');
