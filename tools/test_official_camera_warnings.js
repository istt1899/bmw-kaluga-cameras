'use strict';
// Synthetic GPS replays against the shipped source observations and geometry.
// These are protocol/data regression tests, not proof of visibility, camera
// operation, road coverage or successful warnings in a vehicle.
var assert = require('assert'), path = require('path');
var files = path.join(__dirname, '../native/marku-kaluga-cameras/files');
var service = require(path.join(files, 'marku-kaluga-cameras'));
var info = require(path.join(files, 'camera-info'));
var store = require(path.join(files, 'database-store'));
var createGuidance = require(path.join(files, 'vehicle-guidance')).createGuidance;
var renderer = require(path.join(files, 'alert-card'));
var bundle = require('./build-camera-database').bundle();
var fixture = require('./fixtures/plehanova-suvorova.json');
var originalZones = require(path.join(files, 'road-zones.json')).zones;
var quality = require(path.join(files, 'official-camera-quality.json'));
var captured = require('../data/references/gibdd-kaluga-2026-10-01.json');
var publication = '2026-10-01';
var richControls = ['speed', 'belt', 'redlight', 'stopline', 'signs_marking'];
var startTime = Date.UTC(2026, 10, 7, 10);

function distance(a, b) {
    var dx = (b.lon - a.lon) * 111320 * Math.cos((a.lat + b.lat) * Math.PI / 360);
    return Math.hypot(dx, (b.lat - a.lat) * 111320);
}
function routeSample(route, metres, timeMs, speed) {
    var total = 0;
    for (var i = 1; i < route.outward.length; i++) {
        var a = route.outward[i - 1], b = route.outward[i];
        var dx = (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
        var dy = (b[0] - a[0]) * 111320, length = Math.hypot(dx, dy);
        if (total + length >= metres) {
            var k = (metres - total) / length;
            return { lat: a[0] + (b[0] - a[0]) * k, lon: a[1] + (b[1] - a[1]) * k,
                headingDeg: (Math.atan2(-dx, -dy) * 180 / Math.PI + 360) % 360,
                speedKmh: speed === undefined ? 36 : speed, accuracyM: 10, timeMs: timeMs };
        }
        total += length;
    }
    throw new Error('Synthetic replay exceeds the captured route fixture');
}
function hasAll(actual, expected, message) {
    expected.forEach(function (control) { assert(actual.indexOf(control) >= 0, message + ': ' + control); });
}
function assertOfficialContext(description, expectedId) {
    hasAll(description.controls, richControls, 'Full location-level control set survives describe/guidance');
    assert.strictEqual(description.controlScope, 'enforcement-location');
    assert.strictEqual(description.sourcePublishedAt, publication);
    assert.strictEqual(description.officialSourceRecordId, expectedId);
    assert.strictEqual(description.officialSourceUrl, captured.sourceUrl);
    assert.strictEqual(description.captureDirection, null, 'Traffic flow is not front/rear capture evidence');
    assert.strictEqual(description.captureDirectionVerified, false);
    richControls.forEach(function (control) {
        var index = description.controls.indexOf(control);
        assert(description.controlLabels[index] && description.title.indexOf(description.controlLabels[index]) >= 0,
            'Full Russian description must include ' + control);
    });
    var card = renderer.presentation(description);
    assert.deepStrictEqual(card.controls, description.controls.slice(0, 3));
    assert.strictEqual(card.extraControls, description.controls.length - 3,
        'Compact card acknowledges further types; complete labels remain in the description');
    assert.strictEqual(card.direction, 'unknown');
    if(description.roadConfirmed===true)assert.strictEqual(card.mode,'Рубеж','Compact card identifies location-scoped controls');
}

assert.strictEqual(bundle.records.length, 308, 'Source positions are not a deduplicated count of physical cameras');
assert.strictEqual(bundle.officialCount, 152);
assert.deepStrictEqual(bundle.zones, originalZones, 'Official location observations must not invent or modify road corridors');
assert.strictEqual(bundle.zones.length, 19);

// Compare source facts before official augmentation, including imported OSM
// enforcement relations. Rich official site context must stay separate.
var previous = service.loadDatabase(path.join(files, 'kaluga-speed.json'));
previous = info.enrich(previous, path.join(files, 'camera-details.json'));
previous = info.supplement(previous, path.join(files, 'reported-cameras.json'));
previous = store.mergeRelations(previous, require(path.join(files, 'enforcement-relations.json')));
assert.strictEqual(previous.records.length, 156);
var originalById = Object.create(null);
previous.records.forEach(function (r) { originalById[r.id] = r; });
bundle.records.filter(function (r) { return /^osm:/.test(r.id); }).forEach(function (r) {
    assert(originalById[r.id]);
    assert.deepStrictEqual(r.controls, info.controls(originalById[r.id]), 'Original OSM controls changed: ' + r.id);
    assert.deepStrictEqual(r.position, originalById[r.id].position);
    if(originalById[r.id].limitKmh===null&&r.limitKmh!==null){assert(r.speedLimitEvidence&&['camera-tag','enforcement-relation'].indexOf(r.speedLimitEvidence.kind)>=0);assert.strictEqual(r.limitKmh,r.speedLimitEvidence.valueKmh);}else assert.strictEqual(r.limitKmh, originalById[r.id].limitKmh);
});
var bundleBytes = JSON.stringify(bundle);
quality.links.forEach(function (link) {
    var r = bundle.records.find(function (record) { return record.id === link.osmId; });
    assert(r && r.officialSiteContext);
    assertOfficialContext(info.describe(r), link.officialId);
});

var routes = fixture.routes.filter(function (r) { return r.approachAllowed; });
assert.strictEqual(routes.length, 3);
var totalRoadApproaches = 0;
routes.forEach(function (route, routeIndex) {
    var guidance = createGuidance(bundle), current = null, notices = 0, road = 0;
    var first = startTime + routeIndex * 100000;
    for (var i = 0; i <= 38; i++) {
        var now = first + i * 500;
        current = guidance.evaluate(routeSample(route, 220 - i * 5, now), now, true);
        if (current) {
            notices++;
            if (current.roadConfirmed) {
                road++;
                assert(fixture.cameraIds.indexOf(current.id) >= 0, 'A known corridor must retain its original camera ID');
            }
        }
    }
    assert(notices > 0 && current, 'No notice on synthetic legal approach ' + route.firstWay);
    // Proximity tracking may retain the exact separately reviewed official
    // source at this junction; confirmed road membership still uses original IDs.
    assert(fixture.cameraIds.indexOf(current.id) >= 0 || !current.roadConfirmed && current.id === 'gibdd:ru-klu:fc2bb7199a68c7be');
    assertOfficialContext(current, 'gibdd:ru-klu:fc2bb7199a68c7be');
    if (route.firstWay !== 399324587) assert(road > 0, 'Previously verified corridor must still produce road guidance');
    if (road > 0) totalRoadApproaches++;
    var stoppedAt = first + 20000;
    var stopped = guidance.evaluate(routeSample(route, 30, stoppedAt, 0), stoppedAt, true);
    assert(stopped && (stopped.roadConfirmed || stopped.confidence === 'nearby'));
    assert.strictEqual(guidance.evaluate(routeSample(route, 30, stoppedAt, 0), stoppedAt + 3500, true), null,
        'Synthetic stale coordinates must remove the notice');
});
assert(totalRoadApproaches >= 2, 'Both previously road-verified legal approaches remain usable');

// Source row 74 describes an enforcement location. It contains no numeric
// speed limit, device model, bearing or front/rear capture-side evidence.
var popova = bundle.records.find(function (r) { return r.providerId === 'gibdd-official' && r.sourceRow === 74; });
assert(popova && /Попова/.test(popova.address) && /Тульского/.test(popova.address));
assert.strictEqual(popova.limitKmh, null);
assert.strictEqual(popova.captureSide, 'unknown');
assert.strictEqual(popova.bearingDeg, null);
assert.strictEqual(popova.hardwareModel, null);
var popovaFix = { lat: popova.position.lat, lon: popova.position.lon, timeMs: startTime + 400000,
    speedKmh: 0, headingDeg: null, accuracyM: 5 };
var popovaAlert = createGuidance(bundle).evaluate(popovaFix, popovaFix.timeMs, true);
assert(popovaAlert && popovaAlert.id === popova.id);
assertOfficialContext(popovaAlert, popova.id);
assert.strictEqual(popovaAlert.provenance, 'Госавтоинспекция');
assert.strictEqual(popovaAlert.confidence, 'nearby');
assert.strictEqual(popovaAlert.roadConfirmed, false);
assert.strictEqual(popovaAlert.limitKmh, null);
assert.strictEqual(renderer.presentation(popovaAlert).limit, 60, 'OSM relation explicitly maps RU:urban; numeric reference is independently decoded, not assigned by the official list');
assert.strictEqual(renderer.presentation(popovaAlert).mode, 'Рядом');

// Select a real imported source position beyond the old database's reach and
// sufficiently isolated to make full-bundle nearest-record assertions useful.
var candidates = bundle.records.filter(function (r) { return r.providerId === 'gibdd-official'; }).map(function (r) {
    var previousDistance = Math.min.apply(null, previous.records.map(function (p) { return distance(r.position, p.position); }));
    var otherDistance = Math.min.apply(null, bundle.records.filter(function (p) { return p.id !== r.id; }).map(function (p) {
        return distance(r.position, p.position);
    }));
    return { record: r, previousDistance: previousDistance, otherDistance: otherDistance };
}).filter(function (c) { return c.previousDistance > 1000 && c.otherDistance > 250; });
candidates.sort(function (a, b) { return b.previousDistance - a.previousDistance; });
assert(candidates.length > 0, 'Real official import must extend geographic coverage beyond old source positions');
var added = candidates[0].record, addedGuidance = createGuidance(bundle);
[110, 80, 50].forEach(function (metres, i) {
    var timeMs = startTime + 500000 + i * 3000;
    var fix = { lat: added.position.lat - metres / 111320, lon: added.position.lon,
        timeMs: timeMs, speedKmh: 36, headingDeg: 0, accuracyM: 5 };
    var alert = addedGuidance.evaluate(fix, timeMs, true);
    assert(alert && alert.id === added.id, 'New official observation produces a notice within 120 m');
    assert.strictEqual(alert.confidence, 'nearby');
    assert.strictEqual(alert.roadConfirmed, false, 'An official coordinate cannot create a road-matched corridor');
    assert.strictEqual(alert.limitKmh, null);
    assert.strictEqual(alert.cameraLimitKmh, null);
    assert.strictEqual(alert.provenance, 'Госавтоинспекция');
    assert.strictEqual(alert.sourcePublishedAt, publication);
    assert.strictEqual(alert.controlScope, 'enforcement-location');
    assert.strictEqual(alert.sourceUrl, captured.sourceUrl);
    assert.strictEqual(alert.officialSourceRecordId, added.id);
    assert.strictEqual(renderer.presentation(alert).mode, 'Рядом');
    assert.strictEqual(renderer.presentation(alert).direction, 'unknown');
    assert(Math.abs(alert.distanceM - metres) < 0.1);
});

var exclusions = ['gibdd:ru-klu:b66b02d12f089fad', 'gibdd:ru-klu:c4db9268f4dea2a9', 'gibdd:ru-klu:14519163cb406f36'];
assert.deepStrictEqual(quality.excluded.map(function (r) { return r.id; }).sort(), exclusions.slice().sort());
exclusions.forEach(function (id) {
    assert(captured.records.some(function (r) { return r.id === id; }), 'Rejected observation remains in public source evidence');
    assert(!bundle.records.some(function (r) { return r.id === id; }), 'Quality-rejected observation must never enter guidance');
});
var provider = bundle.sourceMetadata.providers.find(function (p) { return p.id === 'gibdd-official'; });
assert.strictEqual(provider.mobileRoutesExcluded, 184);
assert.strictEqual(provider.acceptedPositionRecords, 152);
assert.strictEqual(provider.qualityExclusions.length, 3);
var fixedIds = Object.create(null);
captured.records.forEach(function (r) { fixedIds[r.id] = true; });
bundle.records.filter(function (r) { return r.providerId === 'gibdd-official'; }).forEach(function (r) {
    assert(fixedIds[r.id], 'Only captured fixed location observations become official guidance records');
    assert.strictEqual(r.mobile, undefined);
    assert.strictEqual(r.positionKind, 'official-location');
});
assert(!bundle.records.some(function (r) { return /mobile|parking-route/.test(r.id); }), 'Mobile routes are not fixed warnings');
assert.strictEqual(JSON.stringify(bundle), bundleBytes, 'Guidance/description/rendering must leave source records and road geometry unchanged');
console.log('PASS synthetic official-data guidance: 308 source positions, 152 accepted official observations, 3 legal Plehanova approaches, preserved OSM controls/corridors, location-scoped 5-type descriptions (+2 compact-card overflow), honest Popova/new-point nearby notices, 3 quality exclusions and 184 mobile-route exclusions; not an on-car validation');
