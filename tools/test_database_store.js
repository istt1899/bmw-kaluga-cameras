'use strict';
var assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
var api = require('../native/marku-kaluga-cameras/files/database-store');
var root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-database-store-'));
var baseline = { schema: 1, region: 'RU-KLU', version: '2026.11.06.1', generatedAt: '2026-11-06T00:00:00Z', sourceTimestamp: '2026-11-05T00:06:20Z',
  source: 'OpenStreetMap', licence: 'ODbL-1.0', osmCount: 1, reportedCount: 0, relationCount: 0, pbfMd5: 'bd360458900c604d889f78d73ef66f64',
  records: [{ id: 'osm:node:3199757952', type: 'speed', controls: ['speed'], position: { lat: 54.4932235, lon: 36.2283816 }, limitKmh: null,
    captureSide: 'unknown', sourceUrl: 'https://www.openstreetmap.org/relation/10391645', rawLimit: 'RU:urban' }], zones: [] };
var clone = function (x) { return JSON.parse(JSON.stringify(x)); };
function version(n) { var b = clone(baseline); b.version = '2026.11.06.' + n; return b; }
function payload(bundle) {
  var bytes = Buffer.from(JSON.stringify(bundle)), manifest = { schema: 1, region: 'RU-KLU', version: bundle.version, generatedAt: bundle.generatedAt,
    artifact: { url: 'https://raw.githubusercontent.com/istt1899/bmw-kaluga-cameras/' + new Array(41).join('a') + '/data/camera-database-' + bundle.version + '.json',
      size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
  return { bytes: bytes, manifest: manifest };
}
var stores = [], dirs = [];
function directory(name) { var d = path.join(root, name); fs.mkdirSync(d); dirs.push(d); return d; }
function make(dir, remote, options) {
  var calls = [], opts = Object.assign({ dataDir: dir, initial: clone(baseline), _test: { explicit: true,
    now: function () { return Date.parse('2026-11-06T19:00:00Z'); }, transport: function (url, max) {
      calls.push({ url: url, max: max });
      if (url === api.SOURCE_URL) return Promise.resolve(Buffer.from(JSON.stringify(remote.manifest)));
      return Promise.resolve(remote.bytes);
    } } }, options || {});
  var s = api.createStore(opts); stores.push(s); s.calls = calls; return s;
}
async function main() {
  assert.deepStrictEqual(api.validateBundle(baseline), baseline);
  var copied = api.validateBundle(baseline); copied.records[0].position.lat = 0; assert.strictEqual(baseline.records[0].position.lat, 54.4932235);
  function bad(change) { var b = clone(baseline); change(b); assert.throws(function () { api.validateBundle(b); }); }
  bad(function (b) { b.region = 'RU-MOW'; }); bad(function (b) { b.records.push(clone(b.records[0])); });
  bad(function (b) { b.records[0].position.lat = 0; }); bad(function (b) { b.records[0].controls.push('imagined-lane'); });
  bad(function (b) { b.records[0].limitKmh = 250; }); bad(function (b) { b.records[0].captureSide = 'rear'; });
  bad(function (b) { b.records[0].sourceUrl = 'http://example.com/'; }); bad(function (b) { b.zones = null; });
  bad(function (b) { b.records[0].provenance = 'owner-report'; }); bad(function (b) { b.generatedAt = 'yesterday'; });
  bad(function (b) { b.generatedAt = '2026-02-30T00:00:00Z'; });
  bad(function (b) { b.records[0].description = new Array(260).join('a'); });
  function zoned() {
    var b = clone(baseline), pos = b.records[0].position;
    b.zones = [{ id: b.records[0].id, lat: pos.lat, lon: pos.lon, limit: null, travel: [90],
      roads: [{ id: 123, dir: 0, cam: 1, pts: [[-50, 0], [0, 0], [50, 0]] }, { id: 124, dir: 1, cam: -1, pts: [[40, -20], [40, 20]] }] }];
    return b;
  }
  var z = zoned(); assert.deepStrictEqual(api.validateBundle(z), z);
  function badZone(change, code) { var b = zoned(); change(b); assert.throws(function () { api.validateBundle(b); }, function (e) { return e.code === code; }); }
  badZone(function (b) { b.zones[0].lat += 0.1; }, 'DATA_ZONE_POSITION');
  badZone(function (b) { b.zones[0].lon += 0.0000001; }, 'DATA_ZONE_POSITION');
  badZone(function (b) { b.zones[0].roads[0].cam = 2; }, 'DATA_ROAD_CAMERA_ANCHOR');
  badZone(function (b) { b.zones[0].roads[0].pts[1] = [2, 1]; }, 'DATA_ROAD_CAMERA_ANCHOR');
  badZone(function (b) { b.zones[0].roads[0].cam = -1; }, 'DATA_ZONE_CAMERA_ANCHOR');
  badZone(function (b) { b.records[0].limitKmh = 60; b.zones[0].limit = 40; }, 'DATA_ZONE_LIMIT_CONFLICT');
  var quantized = zoned(); quantized.zones[0].roads[0].pts[1] = [1, 1]; api.validateBundle(quantized);
  var production = require('./build-camera-database').bundle(); api.validateBundle(production);
  assert.strictEqual(production.zones.length, 19, 'All existing road zones must remain valid');
  var polluted = JSON.parse(JSON.stringify(baseline).replace('"source":"OpenStreetMap"', '"source":"OpenStreetMap","__proto__":{"polluted":true}'));
  assert.throws(function () { api.validateBundle(polluted); }); assert.strictEqual({}.polluted, undefined);
  assert.throws(function () { api.createStore({ dataDir: root, initial: baseline, sourceUrl: 'https://example.com/manifest.json' }); });
  console.log('PASS bundle validation: region, coordinates, IDs, controls, limits, capture-side evidence, source URLs, zones and prototype keys');

  var phases = [], changed = [], d = directory('success'), remote = payload(version(2));
  var s = make(d, remote, { onStatus: function (st) { phases.push(st.phase); }, onChange: function (b) { changed.push(b.version); } });
  var one = s.check(), same = s.check(); assert.strictEqual(one, same, 'Concurrent presses share one bounded transaction');
  var result = await one;
  assert.strictEqual(result.phase, 'updated'); assert.strictEqual(result.currentVersion, '2026.11.06.2');
  if (process.platform === 'win32') {
    assert.strictEqual(result.durability.mode, 'file-fsync-only');
    assert.strictEqual(result.durability.reasonCode, 'DIRECTORY_FSYNC_UNSUPPORTED_WINDOWS');
    assert.strictEqual(result.durability.directorySynced, false);
  }
  assert.deepStrictEqual(changed, ['2026.11.06.2']); assert.deepStrictEqual(phases, ['checking', 'checking', 'downloading', 'installing', 'updated']);
  assert.strictEqual(s.calls.length, 2); assert.strictEqual(s.calls[0].url, api.SOURCE_URL);
  assert(s.calls[1].url.indexOf('/' + new Array(41).join('a') + '/data/camera-database-') > 0);
  assert.strictEqual(s.calls[1].max, remote.bytes.length);
  assert.strictEqual(api.loadActive({ dataDir: d, initial: baseline }).version, '2026.11.06.2');
  assert(fs.readdirSync(d).every(function (n) { return n.indexOf('.tmp-') < 0; }));
  result = await s.check(); assert.strictEqual(result.phase, 'current'); assert.strictEqual(s.calls.length, 3, 'No data archive for an already-current manifest');
  result = await s.rollback(); assert.strictEqual(result.phase, 'rolled-back'); assert.strictEqual(s.current().version, baseline.version);
  assert.strictEqual(api.loadActive({ dataDir: d, initial: version(9) }).version, baseline.version);
  console.log('PASS explicit update, one concurrent transaction, immutable data path, exact SHA/size, persistent activation, current result and rollback');

  var attacks = [
    function (r) { r.manifest.region = 'RU-MOW'; },
    function (r) { r.manifest.artifact.url = 'http://raw.githubusercontent.com/istt1899/bmw-kaluga-cameras/main/data/x.json'; },
    function (r) { r.manifest.artifact.url = r.manifest.artifact.url.replace('istt1899', 'attacker'); },
    function (r) { r.manifest.artifact.url = r.manifest.artifact.url.replace(new Array(41).join('a'), 'main'); },
    function (r) { r.manifest.artifact.url += '?credential=never'; },
    function (r) { r.manifest.artifact.size = 9 * 1024 * 1024; },
    function (r) { r.manifest.artifact.sha256 = new Array(65).join('0'); },
    function (r) { r.bytes = Buffer.from('broken'); },
    function (r) { var b = version(3); b.records[0].position.lon = 0; var altered = payload(b); r.bytes = altered.bytes; r.manifest = altered.manifest; },
    function (r) { var b = version(3); b.version = '2026.11.06.4'; var altered = payload(b); r.bytes = altered.bytes; r.manifest.artifact = altered.manifest.artifact; }
  ];
  for (var i = 0; i < attacks.length; i++) {
    var a = payload(version(3)); attacks[i](a); var dir = directory('attack-' + i), applied = 0;
    var st = make(dir, a, { onChange: function () { applied++; } }); var failed = await st.check();
    assert.strictEqual(failed.phase, 'error'); assert.strictEqual(st.current().version, baseline.version);
    assert.strictEqual(applied, 0); assert.strictEqual(fs.existsSync(path.join(dir, 'camera-database-active.json')), false);
  }
  console.log('PASS untrusted owner/branch/protocol/query, oversize, tampering, invalid data and version mismatch never replace the last good database');

  var rejectDir = directory('consumer-reject'), reject = make(rejectDir, payload(version(2)), { onChange: function () { throw Error('guidance rejected'); } });
  result = await reject.check(); assert.strictEqual(result.phase, 'error'); assert.strictEqual(reject.current().version, baseline.version);
  assert.strictEqual(fs.existsSync(path.join(rejectDir, 'camera-database-active.json')), false);
  var unavailable = path.join(root, 'does-not-exist', 'data'), restored = [];
  var disk = make(unavailable, payload(version(2)), { onChange: function (b) { restored.push(b.version); } });
  result = await disk.check(); assert.strictEqual(result.phase, 'error'); assert.strictEqual(result.persistent, false);
  assert.deepStrictEqual(restored, ['2026.11.06.2', baseline.version]); assert.strictEqual(disk.current().version, baseline.version);
  var pendingResolve, stopDir = directory('closed'), stopped = make(stopDir, payload(version(2)), { _test: { explicit: true, transport: function () { return new Promise(function (resolve) { pendingResolve = resolve; }); } } });
  var transaction = stopped.check(); await Promise.resolve(); stopped.close(); pendingResolve(Buffer.from(JSON.stringify(payload(version(2)).manifest)));
  result = await transaction; assert.strictEqual(result.phase, 'closed'); assert.strictEqual(stopped.current().version, baseline.version);
  console.log('PASS consumer failure, unavailable storage and shutdown cannot leave a partially active replacement');

  var rollbackDir = directory('close-before-rollback'), rollbackChanges = 0;
  fs.writeFileSync(path.join(rollbackDir, 'camera-database-previous.json'), JSON.stringify(version(2)));
  var closingRollback = make(rollbackDir, payload(version(3)), { onChange: function () { rollbackChanges++; } });
  var beforeClose = closingRollback.current(), queuedRollback = closingRollback.rollback(); closingRollback.close();
  result = await queuedRollback;
  assert.strictEqual(result.phase, 'closed'); assert.strictEqual(result.errorCode, 'UPDATE_CLOSED');
  assert.strictEqual(result.canCheck, false); assert.strictEqual(result.canRollback, false);
  assert.strictEqual(rollbackChanges, 0, 'A queued rollback must not call its consumer after close');
  assert.deepStrictEqual(closingRollback.current(), beforeClose);
  assert.strictEqual(fs.existsSync(path.join(rollbackDir, 'camera-database-active.json')), false);
  assert.strictEqual((await closingRollback.rollback()).phase, 'closed');
  var immediateDir = directory('close-before-check'), immediate = make(immediateDir, payload(version(2)));
  var queuedCheck = immediate.check(); immediate.close(); result = await queuedCheck;
  assert.strictEqual(result.phase, 'closed'); assert.strictEqual(immediate.calls.length, 0, 'Immediate close must prevent even the first network request');
  var duringStatusDir = directory('close-during-status'), duringStatusChanges = 0, duringStatus;
  duringStatus = make(duringStatusDir, payload(version(2)), { onStatus: function (st) { if (st.phase === 'installing') duringStatus.close(); },
    onChange: function () { duringStatusChanges++; } });
  result = await duringStatus.check(); assert.strictEqual(result.phase, 'closed'); assert.strictEqual(duringStatusChanges, 0);
  assert.strictEqual(fs.existsSync(path.join(duringStatusDir, 'camera-database-active.json')), false);
  var duringConsumerDir = directory('close-in-consumer'), consumerChanges = 0, consumerStore;
  consumerStore = make(duringConsumerDir, payload(version(2)), { onChange: function () { consumerChanges++; consumerStore.close(); } });
  result = await consumerStore.check(); assert.strictEqual(result.phase, 'closed'); assert.strictEqual(consumerChanges, 1);
  assert.strictEqual(consumerStore.current().version, baseline.version);
  assert.strictEqual(fs.existsSync(path.join(duringConsumerDir, 'camera-database-active.json')), false);
  console.log('PASS close races: queued rollback/check, status callback and consumer callback cannot activate files or issue callbacks after close');

  var recovery = directory('recovery'); fs.writeFileSync(path.join(recovery, 'camera-database-active.json'), '{invalid');
  fs.writeFileSync(path.join(recovery, 'camera-database-previous.json'), JSON.stringify(version(2)));
  assert.strictEqual(api.loadActive({ dataDir: recovery, initial: baseline }).version, '2026.11.06.2');
  var recovered = make(recovery, payload(version(3))).status();
  assert.strictEqual(recovered.phase, 'recovered-from-previous'); assert.strictEqual(recovered.errorCode, 'LOCAL_DATA_JSON');
  assert.strictEqual(recovered.recovery.originalVersion, null); assert.strictEqual(recovered.recovery.recoveredVersion, '2026.11.06.2');
  fs.writeFileSync(path.join(recovery, 'camera-database-previous.json'), 'broken');
  assert.strictEqual(api.loadActive({ dataDir: recovery, initial: baseline }).version, baseline.version);
  recovered = make(recovery, payload(version(3))).status();
  assert.strictEqual(recovered.phase, 'recovered-from-packaged'); assert.strictEqual(recovered.recovery.previousErrorCode, 'LOCAL_DATA_JSON');
  var invalidActive = version(7); invalidActive.region = 'invalid';
  fs.writeFileSync(path.join(recovery, 'camera-database-active.json'), JSON.stringify(invalidActive));
  recovered = make(recovery, payload(version(3))).status();
  assert.strictEqual(recovered.errorCode, 'DATA_SCHEMA'); assert.strictEqual(recovered.recovery.originalVersion, '2026.11.06.7');
  var fresh = make(directory('first-boot'), payload(version(2))).status();
  assert.strictEqual(fresh.phase, 'idle'); assert.strictEqual(fresh.errorCode, null); assert.strictEqual(fresh.recovery, null);
  assert.strictEqual(stores[stores.length - 1].calls.length, 0, 'Startup recovery must never download');
  console.log('PASS startup recovery reports previous/packaged fallback, invalid source version and reason; first boot remains idle without a download');

  // Observe production file operations while emulating Linux directory handles
  // on Windows. Injected syscall failures are not a physical power-loss test.
  var vm = require('vm'), EventEmitter = require('events');
  function diskBoundary(name, options) {
    options = options || {};
    var dir = directory(name), calls = [], directoryFd = 900001, flushes = 0, fakeFs = Object.assign({}, fs), module = { exports: {} };
    var consumer = [];
    fakeFs.openSync = function (file, flags, mode) {
      if (file === dir && flags === 'r') { calls.push('directory-open'); return directoryFd; }
      calls.push('file-open'); return fs.openSync(file, flags, mode);
    };
    fakeFs.fsyncSync = function (fd) {
      if (fd !== directoryFd) { calls.push('file-fsync'); return fs.fsyncSync(fd); }
      calls.push('directory-fsync'); flushes++;
      if (options.failFlush === flushes || options.unsupported) { var e = Error('injected directory fsync failure'); e.code = options.unsupported ? 'EINVAL' : 'EIO'; throw e; }
    };
    fakeFs.closeSync = function (fd) { if (fd === directoryFd) calls.push('directory-close'); else { calls.push('file-close'); fs.closeSync(fd); } };
    fakeFs.renameSync = function (from, to) { calls.push('rename-' + (to.indexOf('previous') >= 0 ? 'previous' : 'active')); return fs.renameSync(from, to); };
    function load(n) { return n === 'fs' ? fakeFs : require(n[0] === '.' ? path.join(__dirname,'../native/marku-kaluga-cameras/files',n) : n); }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native/marku-kaluga-cameras/files/database-store.js'), 'utf8'),
      { module: module, exports: module.exports, require: load, Buffer: Buffer, process: { platform: 'linux', pid: process.pid }, setTimeout: setTimeout, clearTimeout: clearTimeout });
    var remote = payload(version(2));
    var store = module.exports.createStore({ dataDir: dir, initial: baseline, onChange: function (b) { consumer.push(b.version); },
      _test: { explicit: true, transport: function (url) { return Promise.resolve(url === api.SOURCE_URL ? Buffer.from(JSON.stringify(remote.manifest)) : remote.bytes); } } });
    stores.push(store); return { store: store, calls: calls, consumer: consumer, dir: dir };
  }
  var durable = diskBoundary('directory-sync'); result = await durable.store.check();
  assert.strictEqual(result.phase, 'updated'); assert.strictEqual(result.durability.directorySynced, true);
  ['previous', 'active'].forEach(function (name) {
    var at = durable.calls.indexOf('rename-' + name);
    assert.deepStrictEqual(durable.calls.slice(at - 2, at + 4), ['file-fsync', 'file-close', 'rename-' + name, 'directory-open', 'directory-fsync', 'directory-close']);
  });
  var flushFailure = diskBoundary('directory-sync-failure', { failFlush: 2 }); result = await flushFailure.store.check();
  assert.strictEqual(result.phase, 'error'); assert.strictEqual(result.errorCode, 'UPDATE_DIRECTORY_SYNC');
  assert.deepStrictEqual(flushFailure.consumer, ['2026.11.06.2', baseline.version]);
  assert.strictEqual(flushFailure.store.current().version, baseline.version);
  assert.strictEqual(api.loadActive({ dataDir: flushFailure.dir, initial: version(9) }).version, baseline.version, 'Failed post-rename flush restores old active bytes');
  assert.strictEqual(flushFailure.calls.filter(function (call) { return call === 'directory-fsync'; }).length, 3, 'Restored active name is flushed too');
  assert(fs.readdirSync(flushFailure.dir).every(function (n) { return n.indexOf('.tmp-') < 0; }));
  var previousFailure = diskBoundary('previous-sync-failure', { failFlush: 1 }); result = await previousFailure.store.check();
  assert.strictEqual(result.errorCode, 'UPDATE_DIRECTORY_SYNC'); assert.strictEqual(previousFailure.calls.indexOf('rename-active'), -1);
  assert.strictEqual(previousFailure.store.current().version, baseline.version);
  assert.deepStrictEqual(previousFailure.consumer, ['2026.11.06.2', baseline.version]);
  var unsupportedSync = diskBoundary('directory-sync-unsupported', { unsupported: true }); result = await unsupportedSync.store.check();
  assert.strictEqual(result.phase, 'updated'); assert.strictEqual(result.durability.directorySynced, false);
  assert.strictEqual(result.durability.reasonCode, 'DIRECTORY_FSYNC_UNSUPPORTED');
  console.log('PASS directory fsync follows both renames; injected flush failure restores disk and consumer; unsupported filesystems report file-only durability');

  // Exercise the production HTTPS reader with an in-memory socket boundary.
  // This is not the _test transport and makes no external connection.
  function httpBoundary(name, replies) {
    var calls = [], deadlines = [], module = { exports: {} };
    var fakeHttps = { get: function (options, callback) {
      assert.strictEqual(arguments.length,2,'MGU Node 8 requires the options/callback HTTPS overload');
      var req = new EventEmitter(), reply = replies.shift(); calls.push({ url: options.protocol+'//'+options.hostname+options.path, headers: options.headers });
      req.destroy = function (err) { setImmediate(function () { req.emit('error', err || Error('destroyed')); }); };
      if (!reply.hang) setImmediate(function () {
        var res = new EventEmitter(); res.statusCode = reply.status || 200; res.headers = reply.headers || {}; res.resume = res.destroy = function () {};
        callback(res); if (res.statusCode === 200) setImmediate(function () { if (reply.body) res.emit('data', reply.body); res.emit('end'); });
      });
      return req;
    } };
    function load(n) { return n === 'https' ? fakeHttps : require(n[0] === '.' ? path.join(__dirname,'../native/marku-kaluga-cameras/files',n) : n); }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native/marku-kaluga-cameras/files/database-store.js'), 'utf8'),
      { module: module, exports: module.exports, require: load, Buffer: Buffer, process: process,
        setTimeout: function (fn, ms) { var t = { fn: fn, ms: ms, cleared: false }; deadlines.push(t); return t; },
        clearTimeout: function (t) { if (t) t.cleared = true; } });
    var store = module.exports.createStore({ dataDir: directory(name), initial: baseline }); stores.push(store);
    return { store: store, calls: calls, deadlines: deadlines };
  }
  var productionRemote = payload(version(2));
  var okHttp = httpBoundary('http-valid', [{ body: Buffer.from(JSON.stringify(productionRemote.manifest)) }, { body: productionRemote.bytes }]);
  result = await okHttp.store.check(); assert.strictEqual(result.phase, 'updated');
  assert.strictEqual(okHttp.calls.length, 2); assert.strictEqual(okHttp.calls[0].headers.Authorization, undefined);
  assert(okHttp.deadlines.every(function (t) { return t.ms === 15000 && t.cleared; }));
  var wrongRedirect = httpBoundary('http-hostile-redirect', [{ status: 302, headers: { location: 'https://attacker.example/manifest.json' } }]);
  result = await wrongRedirect.store.check(); assert.strictEqual(result.errorCode, 'UPDATE_URL'); assert.strictEqual(wrongRedirect.calls.length, 1);
  var redirectLoop = httpBoundary('http-loop', [0, 1, 2].map(function () { return { status: 302, headers: { location: api.SOURCE_URL } }; }));
  result = await redirectLoop.store.check(); assert.strictEqual(result.errorCode, 'UPDATE_REDIRECT'); assert.strictEqual(redirectLoop.calls.length, 3);
  var oversized = httpBoundary('http-size', [{ headers: { 'content-length': '65537' } }]);
  result = await oversized.store.check(); assert.strictEqual(result.errorCode, 'UPDATE_SIZE');
  var status404 = httpBoundary('http-unavailable', [{ status: 404 }]);
  result = await status404.store.check(); assert.strictEqual(result.errorCode, 'UPDATE_HTTP_404');
  var timeout = httpBoundary('http-timeout', [{ hang: true }]), waiting = timeout.store.check();
  await new Promise(function (resolve) { setImmediate(resolve); }); timeout.deadlines[0].fn();
  result = await waiting; assert.strictEqual(result.errorCode, 'UPDATE_TIMEOUT');
  console.log('PASS production HTTPS boundary: owner-only URLs, no credentials, redirect allowlist/count, Content-Length bound, HTTP refusal and total-time timeout');
}
main().then(function () { stores.forEach(function (s) { s.close(); }); dirs.forEach(function (d) { fs.readdirSync(d).forEach(function (n) { fs.unlinkSync(path.join(d, n)); }); fs.rmdirSync(d); }); fs.rmdirSync(root); }, function (e) { stores.forEach(function (s) { s.close(); }); console.error(e.stack); process.exitCode = 1; });
