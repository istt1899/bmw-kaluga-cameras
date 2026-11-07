'use strict';
// Synthetic source-fix replays against the real engine, without an SDK stub,
// head unit, network service, or claims about coverage of the shipped map.
const assert = require('assert');
const engine = require('../native/marku-kaluga-cameras/files/vehicle-guidance');
const preferences = require('../native/marku-kaluga-cameras/files/alert-preferences');
const cos = Math.cos(54 * Math.PI / 180);
function position(x, y) { return {lat: 54 + (y || 0) / 111320, lon: 36 + x / (111320 * cos)}; }
function fix(x, t, extra) { return Object.assign(position(x, 0), {timeMs: t, accuracyM: 5, speedKmh: 72, headingDeg: 90}, extra); }
function record(id, x, y, controls) { return {id, position: position(x || 0, y || 0), type: 'speed', controls: controls || ['speed'], limitKmh: 60}; }
function zone(id, x, roads) { return Object.assign({id, travel: [90], limit: 60}, position(x || 0, 0), {roads: roads || [{id: 'road-' + id, dir: 0, cam: 1, pts: [[-1600, 0], [0, 0], [300, 0]]}]}); }
function create(options) { return engine.createGuidance(Object.assign({zones: [zone('a')], records: [record('a')], nearby: false}, options)); }
function step(g, x, t, prefs, extra) { return g.evaluate(fix(x, t, extra), t, true, prefs); }
function admitted(options) { const g = create(options); assert.strictEqual(step(g, -520, 1000), null); assert(step(g, -500, 2000)); return g; }
function checkId(value, id, message) { assert(value && value.id === id, message || 'Expected camera ' + id); return value; }

// Every selectable distance really reaches the engine, independently of speed.
for (let range = 50; range <= 1000; range += 50) {
    const g = create(), prefs = {warningDistanceM: range};
    assert.strictEqual(step(g, -range - 10, 1000, prefs, {speedKmh: 36}), null);
    assert.strictEqual(step(g, -range, 2000, prefs, {speedKmh: 36}), null);
    const alert = step(g, -range + 10, 3000, prefs, {speedKmh: 36});
    assert(alert && alert.distanceM <= range && alert.roadConfirmed, 'Selected range ' + range + ' m was not applied');
}
const longRange = create(); step(longRange, -1000, 1000, null, {speedKmh: 36});
assert(step(longRange, -990, 2000, null, {speedKmh: 36}).distanceM > 600, 'Default is 1000 m, without the old speed-dependent 600 m ceiling');

// Source-valid 1000 -> 0 highway approach, including a frozen distance and
// small GNSS recession. Confirmation is an entry condition, not a per-fix gate.
const highway = create(); assert.strictEqual(step(highway, -1000, 1000), null);
let clock = 1000;
for (let metres = 980; metres >= 0; metres -= 20) {
    clock += 1000; checkId(step(highway, -metres, clock), 'a', 'Highway warning disappeared at ' + metres + ' m');
    if (metres === 500) {
        clock += 1000; checkId(step(highway, -501, clock), 'a', 'One-metre distance recession must not remove a verified approach');
        clock += 1000; checkId(step(highway, -501, clock), 'a', 'A fresh constant-distance fix must retain a verified approach');
    }
}
assert.strictEqual(highway.diagnostic().reason, 'TRACKING_APPROACH');
clock += 1000; assert.strictEqual(step(highway, 5, clock), null, 'The warning must end immediately after passing');
assert.strictEqual(highway.diagnostic().lastClear.reason, 'CAMERA_PASSED');
const passedTransition = highway.diagnostic().transition;
clock += 1000; step(highway, 20, clock);
assert.deepStrictEqual(highway.diagnostic().transition, passedTransition, 'WAITING ticks must preserve the reason for withdrawal');

// Cumulative recession has a fixed bound relative to the closest source fix.
const recoil = admitted(); checkId(step(recoil, -491, 3000), 'a'); checkId(step(recoil, -496, 4000), 'a');
assert.strictEqual(step(recoil, -503, 5000), null); assert.strictEqual(recoil.diagnostic().lastClear.reason, 'APPROACH_LOST');
const jump = admitted(); assert.strictEqual(step(jump, -200, 3000), null, 'An impossible position jump cannot be retained');
assert.strictEqual(jump.diagnostic().lastClear.reason, 'POSITION_JUMP');

// Slow traffic uses current valid heading for tracking only; new admission
// still requires >=8 km/h. Fresh stopped fixes use the bounded prior anchor.
const slow = create(); step(slow, -200, 1000, null, {speedKmh: 36}); checkId(step(slow, -175, 2000, null, {speedKmh: 36}), 'a');
checkId(step(slow, -174, 3000, null, {speedKmh: 5}), 'a');
checkId(step(slow, -173, 4000, null, {speedKmh: 3}), 'a');
assert(checkId(step(slow, -173, 5000, null, {speedKmh: 0, headingDeg: null}), 'a').stopped);
assert.strictEqual(step(slow, -172, 6000, null, {speedKmh: 5, headingDeg: 270}), null, 'A turn must end road tracking even while creeping');
const notAdmittedSlow = create(); step(notAdmittedSlow, -200, 1000, null, {speedKmh: 5});
assert.strictEqual(step(notAdmittedSlow, -199, 2000, null, {speedKmh: 5}), null);

// Strict safety gates are not part of hysteresis.
const offRoad = admitted(); assert.strictEqual(step(offRoad, -480, 3000, null, {lat: position(0, 7).lat}), null); assert.strictEqual(offRoad.diagnostic().lastClear.reason, 'OFF_ROAD');
const turn = admitted(); assert.strictEqual(step(turn, -480, 3000, null, {headingDeg: 135}), null); assert.strictEqual(turn.diagnostic().lastClear.reason, 'HEADING_MISMATCH');
const roads = [{id: 1, dir: 0, cam: 1, pts: [[-1600, 0], [0, 0], [300, 0]]}, {id: 2, dir: 0, cam: -1, pts: [[-1600, 25], [300, 25]]}];
const ambiguous = create({zones: [zone('a', 0, roads)]}); step(ambiguous, -200, 1000, null, {accuracyM: 10});
assert(step(ambiguous, -180, 2000, null, {accuracyM: 10}));
assert.strictEqual(step(ambiguous, -170, 3000, null, {accuracyM: 10, lat: position(0, 9).lat}), null); assert.strictEqual(ambiguous.diagnostic().lastClear.reason, 'AMBIGUOUS_ROAD');
const wrongWayRoads = [roads[0], {id: 2, dir: 0, cam: -1, pts: [[-1600, 40], [300, 40]]}];
const wrongRoad = admitted({zones: [zone('a', 0, wrongWayRoads)]});
assert.strictEqual(step(wrongRoad, -480, 3000, null, {lat: position(0, 40).lat}), null); assert.strictEqual(wrongRoad.diagnostic().lastClear.reason, 'CAMERA_WAY_MISSING');

const accuracy = admitted(); assert.strictEqual(step(accuracy, -480, 3000, null, {accuracyM: 15.001}), null);
assert.strictEqual(accuracy.diagnostic().lastClear.gpsReason, 'ACCURACY_EXCEEDS_15M');
accuracy.evaluate(null, 4000, true); assert.strictEqual(accuracy.diagnostic().lastClear.gpsReason, 'ACCURACY_EXCEEDS_15M', 'Later missing fixes cannot erase the original quality failure');
const expiry = admitted(), valid = fix(-500, 2000); assert.strictEqual(expiry.evaluate(valid, 5001, true), null);
assert.strictEqual(expiry.diagnostic().lastClear.gpsReason, 'UTC_EXPIRED');
assert.strictEqual(expiry.evaluate(valid, 5500, true), null);
const future = admitted(); assert.strictEqual(future.evaluate(fix(-480, 4000), 3499, true), null); assert.strictEqual(future.diagnostic().lastClear.gpsReason, 'UTC_FUTURE');
const replay = admitted(); assert.strictEqual(replay.evaluate(fix(-510, 1000), 2100, true), null);
assert.strictEqual(replay.evaluate(fix(-509, 1000), 2200, true), null, 'A rejected replay cannot reset the source UTC high-water mark');

// Repeated UTC never confirms an approach. Small position/quality refreshes
// are allowed against the immutable first position, not a moving baseline.
const duplicate = create(), first = fix(-200, 1000); duplicate.evaluate(first, 1000, true);
for (let now = 1100; now <= 2900; now += 100) assert.strictEqual(duplicate.evaluate(first, now, true), null);
const source = create(); step(source, -200, 1000, null, {speedKmh: 36}); checkId(step(source, -175, 2000, null, {speedKmh: 36}), 'a');
for (const x of [-172, -169, -166]) checkId(source.evaluate(fix(x, 2000, {speedKmh: 36, accuracyM: 5}), 2100, true), 'a');
assert.strictEqual(source.evaluate(fix(-163, 2000, {speedKmh: 36}), 2200, true), null);
assert.strictEqual(source.diagnostic().lastClear.gpsReason, 'SOURCE_CHANGED');
const hugeSameTime = admitted(); assert.strictEqual(hugeSameTime.evaluate(fix(-5, 2000), 2100, true), null);

// Settings are always rechecked, including on the same source timestamp.
const settings = admitted(); assert.strictEqual(settings.evaluate(fix(-500, 2000), 2100, true, {warningDistanceM: 450}), null);
assert.strictEqual(settings.diagnostic().lastClear.reason, 'OUT_OF_RANGE');
assert.strictEqual(settings.evaluate(fix(-500, 2000), 2200, true), null, 'Enlarging range cannot manufacture another approach sample');
assert.strictEqual(step(settings, -480, 3000), null); assert(step(settings, -460, 4000));
assert.strictEqual(settings.evaluate(fix(-460, 4000), 4100, false), null); assert.strictEqual(settings.diagnostic().lastClear.reason, 'DISABLED');
const filterKeys = Object.keys(preferences.DEFAULTS.cameraTypes);
filterKeys.forEach(type => {
    const r = record('a'); if (type === 'other') { r.type = 'generic'; r.controls = []; } else { r.type = type; r.controls = [type]; }
    const g = admitted({records: [r]}), types = {}; types[type] = false;
    assert.strictEqual(g.evaluate(fix(-500, 2000), 2100, true, {cameraTypes: types}), null, type + ' filter must withdraw immediately');
    assert.strictEqual(g.diagnostic().lastClear.reason, 'TYPE_DISABLED');
});

// Independent road candidates allow direct hand-off to the next camera,
// without an empty frame or carrying the old way/sign into the new record.
const nextCamera = create({zones: [zone('a'), zone('b', 20)], records: [record('a'), record('b', 20, 0, ['redlight'])]});
step(nextCamera, -60, 1000); checkId(step(nextCamera, -40, 2000), 'a'); checkId(step(nextCamera, -20, 3000), 'a'); checkId(step(nextCamera, 0, 4000), 'a');
const handed = checkId(step(nextCamera, 5, 5000), 'b'); assert.strictEqual(handed.way, 'road-b'); assert.strictEqual(nextCamera.diagnostic().transition.reason, 'SWITCHED');
const passFallback = admitted({nearby: true}); step(passFallback, -480, 3000);
// Use plausible, continuous approach fixes rather than a jump to the camera.
for (let x = -460, t = 4000; x <= 0; x += 20, t += 1000) step(passFallback, x, t);
assert.strictEqual(step(passFallback, 5, 28000), null); assert.strictEqual(step(passFallback, 6, 29000, null, {speedKmh: 0, headingDeg: null}), null, 'Proximity fallback must not resurrect a passed camera at a stop');

// Nearby-only entry/exit margins are bounded. They never become road proof.
const vicinity = create({zones: [], nearby: true}); step(vicinity, -520, 1000, null, {lat: position(0, 16).lat});
assert.strictEqual(checkId(step(vicinity, -500, 2000, null, {lat: position(0, 16).lat}), 'a').roadConfirmed, false);
checkId(step(vicinity, -480, 3000, null, {lat: position(0, 19).lat}), 'a', 'Nearby lateral jitter inside the exit margin must not flicker');
assert.strictEqual(vicinity.diagnostic().reason, 'NEARBY_TRACKING');
assert.strictEqual(step(vicinity, -460, 4000, null, {lat: position(0, 24).lat}), null, 'Nearby exit margin is bounded');
assert.strictEqual(vicinity.diagnostic().lastClear.reason, 'BEARING_CHANGED');
const angular = create({zones: [], nearby: true}); step(angular, -220, 1000, null, {headingDeg: 86}); checkId(step(angular, -200, 2000, null, {headingDeg: 86}), 'a');
checkId(step(angular, -180, 3000, null, {headingDeg: 84}), 'a');
assert.strictEqual(step(angular, -160, 4000, null, {headingDeg: 80}), null, 'Nearby heading-derived lateral hysteresis must not retain a turn away');

// Stable nearby identity applies only to the same control set. A closer
// record with different controls must retain its original metadata and win.
function nearbyPair(controls) { return create({zones: [], nearby: true, records: [record('a', 0, -10), record('b', 0, 10, controls)]}); }
const pair = nearbyPair(); step(pair, -520, 1000, null, {lat: position(0, -4).lat}); checkId(step(pair, -500, 2000, null, {lat: position(0, -4).lat}), 'a');
checkId(step(pair, -480, 3000, null, {lat: position(0, 4).lat}), 'a');
const different = nearbyPair(['redlight']); step(different, -520, 1000, null, {lat: position(0, -4).lat}); checkId(step(different, -500, 2000, null, {lat: position(0, -4).lat}), 'a');
assert.deepStrictEqual(checkId(step(different, -480, 3000, null, {lat: position(0, 4).lat}), 'b').controls, ['redlight']);
console.log('PASS warning continuity: 20 distances/default 1000, 1000-to-pass replay, distance/nearby jitter and bounded exit, slow traffic, independent cameras/control sets, filters/same-UTC settings, immutable source baseline, strict road/heading/15m/3s gates, replay and persistent withdrawal diagnostics; synthetic tests only');
