'use strict';
var assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), dgram = require('dgram');
var base = path.join(__dirname, '../native/marku-kaluga-cameras/files');
var VERSION = JSON.parse(fs.readFileSync(path.join(base, '../component.json'), 'utf8')).version;
var GpsDecoder = require(path.join(base, 'gps-source')).GpsDecoder;
var GpsProvider = require(path.join(base, 'gps-source')).GpsProvider;
var service = require(path.join(base, 'marku-kaluga-cameras'));
var probe = require(path.join(base, 'check')).probe;
var count = 0;
function test(name, fn) { fn(); count++; process.stdout.write('PASS ' + name + '\n'); }
function sentence(body) { var c = 0; for (var i = 0; i < body.length; i++) c ^= body.charCodeAt(i); return '$' + body + '*' + ('0' + c.toString(16)).slice(-2); }
var now = Date.UTC(2026, 10, 5, 12, 0, 0), decoder;
function tpv(changes) { return Object.assign({ class: 'TPV', mode: 3, time: new Date(now).toISOString(), lat: 54.5138529, lon: 36.2083904, speed: 20, track: 125, epx: 3, epy: 4 }, changes || {}); }
test('GPSD converts speed and keeps source UTC plus horizontal metre estimate', function () {
  decoder = new GpsDecoder(function () { return now; }); decoder.json(tpv());
  var f = decoder.current(now); assert.strictEqual(f.speedKmh, 72); assert.strictEqual(f.timeMs, now); assert.strictEqual(f.accuracyM, 5);
});
test('GPSD stale UTC cannot become fresh when packets are received again', function () {
  var d = new GpsDecoder(function () { return now; }); d.json(tpv({ time: new Date(now - 4000).toISOString() })); assert.strictEqual(d.current(now), null);
  decoder.json(tpv({ mode: 1 })); assert.strictEqual(decoder.current(now), null);
});
test('GPSD partial TPV fields accumulate only within the same UTC epoch', function () {
  var d = new GpsDecoder(function () { return now; }); d.json(tpv());
  d.json({ class: 'TPV', mode: 3, time: new Date(now + 500).toISOString(), lat: 54.5, lon: 36.2 });
  assert.strictEqual(d.current(now).accuracyM, null); assert.strictEqual(d.current(now).speedKmh, null);
  d.json({ class: 'TPV', mode: 3, time: new Date(now + 500).toISOString(), speed: 10, track: 20, eph: 6 });
  assert.strictEqual(d.current(now).accuracyM, 6); assert.strictEqual(d.current(now).speedKmh, 36);
});
test('NMEA requires checksum, valid quality and RMC date; HDOP is not metres', function () {
  var d = new GpsDecoder(function () { return now; });
  var rmc = sentence('GNRMC,120000.000,A,5430.831174,N,03612.503424,E,20,125,051126,,,A');
  var gga = sentence('GNGGA,120000.000,5430.831174,N,03612.503424,E,1,10,0.8,150,M,0,M,,');
  d.line(rmc.slice(0, -2) + '00'); d.line(gga); assert.strictEqual(d.current(now), null);
  d.line(rmc); var f = d.current(now); assert.strictEqual(f.hdop, 0.8); assert.strictEqual(f.accuracyM, null);
  d.line(sentence('GNGST,120000.000,1,1,1,0,3,4,6')); assert.strictEqual(d.current(now).accuracyM, 10);
  d.line(sentence('GNGGA,120000.000,5430.831174,N,03612.503424,E,0,00,99,150,M,0,M,,')); assert.strictEqual(d.current(now), null);
});
test('NMEA stale RMC date and mismatched GGA UTC do not produce a fix', function () {
  var d = new GpsDecoder(function () { return now; });
  d.line(sentence('GNRMC,120000.000,A,5430.831174,N,03612.503424,E,20,125,041126,,,A'));
  d.line(sentence('GNGGA,120000.000,5430.831174,N,03612.503424,E,1,10,0.8,150,M,0,M,,')); assert.strictEqual(d.current(now), null);
  d.line(sentence('GNRMC,120002.000,A,5430.831174,N,03612.503424,E,20,125,051126,,,A')); assert.strictEqual(d.current(now), null);
});
test('real Kaluga snapshot loads and nearest is explicitly diagnostic', function () {
  var db = service.loadDatabase(path.join(base, 'kaluga-speed.json')); assert.strictEqual(db.records.length, 150);
  var n = service.nearest(db.records, { lat: 54.5138529, lon: 36.2083904 });
  assert.strictEqual(n.id, 'osm:node:1012784497'); assert.strictEqual(n.confidence, 'unconfirmed'); assert.strictEqual(n.distanceM, 0);
});

async function integration() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaluga-service-test-'));
  var socket = process.platform === 'win32' ? '\\\\.\\pipe\\kaluga-service-test-' + process.pid : path.join(dir, 'ctl.sock');
  var gpsd, peer, app, provider, udp, client;
  try {
    gpsd = net.createServer(function (s) { peer = s; s.on('error', function () {}); s.on('data', function () {}); });
    await new Promise(function (resolve) { gpsd.listen(0, '127.0.0.1', resolve); });
    udp = dgram.createSocket('udp4'); await new Promise(function (resolve) { udp.bind(0, '127.0.0.1', resolve); });
    var udpPort = udp.address().port; udp.close(); udp = null;
    provider = new GpsProvider({ host: '127.0.0.1', port: gpsd.address().port, nmeaHost: '127.0.0.1', nmeaPort: udpPort, retryMs: 50 });
    var called = 0, shown = null, opacity = null;
    await new Promise(function (resolve, reject) {
      app = service.start({ dataDir: dir, socket: socket, gps: provider, onListening: resolve, onError: reject,
        guidance: { evaluate: function (fix) { called++; assert.ok(!fix || fix.accuracyM > 0); return null; } },
        display: { update: function (alert) { shown = alert; }, status: function () { return 'off'; }, close: function () {} },
        dimmer: { update: function (percent) { opacity = percent; }, status: function () { return 'test overlay'; }, close: function () {} } });
    });
    var lines = [], buf = '';
    client = net.connect(socket); client.setEncoding('utf8'); client.on('error', function () {});
    client.on('data', function (chunk) { buf += chunk; var nl; while ((nl = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
    await until(function () { return peer && lines.length > 0; });
    var health = await probe({ socket: socket, checkPermissions: false, version: VERSION });
    assert.strictEqual(health.database.count, 308);
    assert.strictEqual(health.database.osmCount, 150);
    assert.strictEqual(health.database.reportedCount, 1);
    assert.strictEqual(lines[0].state.outputs.cluster, false); assert.strictEqual(lines[0].state.outputs.hud, false);
    assert.strictEqual(app.state().hudOpacityPct, 100); assert.strictEqual(opacity, 100);
    client.write(JSON.stringify({cmd:'unsupported-test',requestId:'ipc-rejected-1'})+'\n');
    await until(function () { return lines.some(function (line) { return line.ev === 'error' && line.requestId === 'ipc-rejected-1'; }); });
    assert.strictEqual(app.state().commandResult.requestId,'ipc-rejected-1');
    assert.strictEqual(app.state().commandResult.phase,'error');
    client.write(JSON.stringify({cmd:'hud-opacity',percent:40,requestId:'ipc-setting-2'})+'\n');
    await until(function () { return app.state().commandResult.requestId === 'ipc-setting-2' && app.state().commandResult.phase === 'finished'; });
    client.write('{"cmd":"hud-opacity","percent":40}\n');
    await until(function () { return app.state().hudOpacityPct === 40; });
    assert.strictEqual(opacity, 40); assert.strictEqual(app.state().gpsFix, null);
    assert.throws(function () { app.command({ cmd: 'hud-opacity', percent: 9 }); }, /integer from 10 to 100/);
    assert.throws(function () { app.command({ cmd: 'hud-opacity', percent: 50.5 }); }, /integer from 10 to 100/);
    peer.write(JSON.stringify(tpv({ time: new Date().toISOString() })) + '\n');
    await until(function () { return app.state().gpsFix !== null; });
    assert.strictEqual(app.state().gpsFix.speedKmh, 72); assert.ok(app.state().nearest); assert.strictEqual(app.state().alert, null); assert.strictEqual(shown, null);
    client.write('{"cmd":"disable"}\n{"cmd":"outputs","cluster":true,"hud":false}\n');
    await until(function () { return !app.state().enabled && app.state().outputs.cluster; });
    var saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); assert.strictEqual(saved.enabled, false); assert.strictEqual(saved.outputs.cluster, true);
    assert.strictEqual(saved.hudOpacityPct, 40); assert.strictEqual(app.state().hudOpacityPct, 40);
    client.write('{"cmd":"update"}\n');
    await until(function () { return lines.some(function (l) { return l.ev === 'error' && /database-check/.test(l.error); }); });
    peer.write(JSON.stringify(tpv({ time: new Date(Date.now() - 10000).toISOString() })) + '\n');
    await until(function () { return app.state().gpsFix === null; }); assert.strictEqual(app.state().alert, null);
    // Exercise real UDP input with a current RMC/GGA/GST triplet.
    var t = new Date(), time = ('0' + t.getUTCHours()).slice(-2) + ('0' + t.getUTCMinutes()).slice(-2) + ('0' + t.getUTCSeconds()).slice(-2) + '.000';
    var date = ('0' + t.getUTCDate()).slice(-2) + ('0' + (t.getUTCMonth() + 1)).slice(-2) + String(t.getUTCFullYear()).slice(-2);
    udp = dgram.createSocket('udp4');
    var payload = sentence('GNRMC,' + time + ',A,5430.831174,N,03612.503424,E,20,125,' + date + ',,,A') + '\n' +
      sentence('GNGGA,' + time + ',5430.831174,N,03612.503424,E,1,10,0.8,150,M,0,M,,') + '\n' +
      sentence('GNGST,' + time + ',1,1,1,0,3,4,6') + '\n';
    await new Promise(function (resolve, reject) { udp.send(Buffer.from(payload), udpPort, '127.0.0.1', function (e) { if (e) reject(e); else resolve(); }); });
    await until(function () { return app.state().gpsFix && app.state().gpsFix.source === 'nmea' && app.state().gpsFix.accuracyM === 10; });
    assert.ok(called > 0); process.stdout.write('PASS integration: GPSD TCP, real NMEA UDP, control JSONL, persisted settings, unsupported update, stale input withdrawal\n');
  } finally {
    if (client) client.destroy(); if (app) app.close(); if (provider) provider.close(); if (peer) peer.destroy(); if (udp) udp.close();
    if (gpsd) await new Promise(function (resolve) { gpsd.close(resolve); });
    fs.readdirSync(dir).forEach(function (name) { fs.unlinkSync(path.join(dir, name)); }); fs.rmdirSync(dir);
  }
}
function until(predicate) {
  return new Promise(function (resolve, reject) {
    var started = Date.now(), timer = setInterval(function () {
      try { if (predicate()) { clearInterval(timer); resolve(); } else if (Date.now() - started > 4000) { clearInterval(timer); reject(new Error('integration timed out')); } }
      catch (e) { clearInterval(timer); reject(e); }
    }, 10);
  });
}
async function storageFailure() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaluga-unwritable-'));
  var obstacle = path.join(dir, 'data'); fs.writeFileSync(obstacle, 'not a directory');
  var socket = process.platform === 'win32' ? '\\\\.\\pipe\\kaluga-unwritable-' + process.pid : path.join(dir, 'ctl.sock');
  var app, EventEmitter = require('events'), gps = new EventEmitter();
  gps.start = gps.close = function () {}; gps.current = function () { return null; };
  try {
    await new Promise(function (resolve, reject) {
      app = service.start({ dataDir: obstacle, socket: socket, gps: gps, onListening: resolve, onError: reject,
        display: { update: function () {}, status: function () { return 'off'; }, close: function () {} } });
    });
    var health = await probe({ socket: socket, checkPermissions: false, version: VERSION });
    assert.strictEqual(health.database.count, 308);
    assert.strictEqual(health.database.osmCount, 150);
    assert.strictEqual(health.database.reportedCount, 1);
    assert.strictEqual(health.storage.persistent, false);
    app.command({ cmd: 'disable' });
    assert.strictEqual(app.state().enabled, false);
    assert.strictEqual(app.state().storage.persistent, false);
    await probe({ socket: socket, checkPermissions: false, version: 'wrong', timeoutMs: 100, retryMs: 10 }).then(function () { throw new Error('wrong version accepted'); }, function (err) {
      assert(/Wrong running service version/.test(err.message));
    });
    console.log('PASS unavailable storage: database and app socket stay available; settings explicitly temporary; old service rejected');
  } finally {
    if (app) app.close(); fs.unlinkSync(obstacle); fs.rmdirSync(dir);
  }
}
integration().then(storageFailure).then(function () { process.stdout.write(count + ' decoder/database tests plus transport/storage/check integration passed.\n'); }, function (e) { process.stderr.write(e.stack + '\n'); process.exitCode = 1; });
