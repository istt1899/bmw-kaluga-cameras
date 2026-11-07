'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), EventEmitter = require('events');
const base = path.join(__dirname, '../native/marku-kaluga-cameras/files');
const info = require(path.join(base, 'camera-info'));
const service = require(path.join(base, 'marku-kaluga-cameras'));
const { createGuidance } = require(path.join(base, 'vehicle-guidance'));
const source = JSON.parse(fs.readFileSync(path.join(base, 'reported-cameras.json'), 'utf8'));
const intersection = { lat: 54.5083662, lon: 36.2864984 };
function database() {
    return info.enrich(service.loadDatabase(path.join(base, 'kaluga-speed.json')), path.join(base, 'camera-details.json'));
}
const db = database(), closest = service.nearest(db.records, intersection);
assert.strictEqual(db.records.length, 150);
assert.strictEqual(closest.id, 'osm:node:7044973016');
assert(closest.distanceM > 700 && closest.distanceM < 740, 'Original database has a coverage gap at the reported intersection');
info.supplement(db, path.join(base, 'reported-cameras.json'));
assert.strictEqual(db.records.length, 151); assert.strictEqual(db.osmCount, 150); assert.strictEqual(db.reportedCount, 1);
assert.strictEqual(db.source, 'OpenStreetMap', 'The original snapshot source/hash must remain untouched');
assert(db.displaySource.includes('сообщения владельца'));
const report = db.records.find(r => r.provenance === 'owner-report'), nearest = service.nearest(db.records, intersection);
assert.strictEqual(nearest.id, report.id); assert.strictEqual(nearest.distanceM, 0);
assert.strictEqual(nearest.type, 'camera'); assert.deepStrictEqual(nearest.controls, []); assert.strictEqual(nearest.limitKmh, null);
assert.strictEqual(nearest.provenance, 'owner-report'); assert.strictEqual(nearest.positionKind, 'intersection');
assert.strictEqual(nearest.reportStatus, 'unverified'); assert.strictEqual(nearest.sourceUrl, null);
assert.strictEqual(nearest.positionSourceUrl, 'https://www.openstreetmap.org/node/277492125');
assert(nearest.title.includes('тип не подтверждён')); assert(nearest.description.includes('сообщение владельца'));
const g = createGuidance({ zones: [], records: db.records });
const fix = { lat: intersection.lat + .00025, lon: intersection.lon, timeMs: 1000, speedKmh: 0, headingDeg: null, accuracyM: 5 };
const notice = g.evaluate(fix, 1000, true);
assert(notice && notice.id === report.id && notice.confidence === 'nearby' && notice.roadConfirmed === false);
assert.strictEqual(notice.limitKmh, null); assert.deepStrictEqual(notice.controls, []);
assert.strictEqual(notice.positionKind, 'intersection');
const view = require('../apps/marku_kaluga_cameras/src/view_model');
const display = view.model({ enabled: true, alert: Object.assign({}, notice, { distance: notice.distanceM }) });
assert(display.text.cameraAlert.includes('до перекрёстка'), 'Reference-point distance must not pretend to measure the device location');
assert(display.text.cameraAlert.includes('тип не подтверждён'));
assert.throws(() => info.supplement(db, path.join(base, 'reported-cameras.json')), /Invalid reported/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reported-camera-'));
const file = path.join(dir, 'reported.json');
function bad(change) {
    const d = JSON.parse(JSON.stringify(source)); change(d); fs.writeFileSync(file, JSON.stringify(d));
    const fresh = database(), before = JSON.stringify(fresh);
    assert.throws(() => info.supplement(fresh, file), /reported|Reported/);
    assert.strictEqual(JSON.stringify(fresh), before, 'Invalid supplement must not partially mutate the database');
}
bad(d => { d.region = 'OTHER'; }); bad(d => { d.source = 'OpenStreetMap'; });
bad(d => { d.records[0].type = 'speed'; }); bad(d => { d.records[0].controls = ['redlight']; });
bad(d => { d.records[0].limitKmh = 60; }); bad(d => { d.records[0].position.lat = 10; });
bad(d => { d.records[0].sourceUrl = d.records[0].positionSourceUrl; });
bad(d => { d.records.push(d.records[0]); }); bad(d => { d.records = new Array(101).fill(d.records[0]); });
console.log('PASS reported BolDina/Nikitina intersection: original 719m coverage gap, separate 150+1 provenance, generic nearby notice with no invented type/limit, atomic validation');

async function main() {
    let app;
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\reported-camera-' + process.pid : path.join(dir, 'ctl.sock');
    const gps = new EventEmitter(); gps.start = gps.close = () => {}; gps.current = () => null;
    try {
        await new Promise((resolve, reject) => { app = service.start({ dataDir: dir, socket, gps,
            onListening: resolve, onError: reject, guidance: { evaluate: () => null },
            display: { update: () => {}, status: () => 'off', close: () => {} },
            dimmer: { update: () => {}, status: () => 'off', close: () => {} } }); });
        const publicDb = app.state().database;
        assert.strictEqual(publicDb.state, 'ready'); assert.strictEqual(publicDb.count, 308);
        assert.strictEqual(publicDb.osmCount, 150); assert.strictEqual(publicDb.reportedCount, 1);
        assert.strictEqual(publicDb.source, 'Mixed OSM + Госавтоинспекция + сообщения владельца');
        assert.strictEqual(publicDb.officialCount,152);
        console.log('PASS real daemon startup advertises mixed-source database and separate OSM/reported counts');
    } finally {
        if (app) app.close();
        fs.readdirSync(dir).forEach(name => fs.unlinkSync(path.join(dir, name))); fs.rmdirSync(dir);
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
