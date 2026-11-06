'use strict';
var assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
var base = path.join(__dirname, '../native/marku-kaluga-cameras/files');
var GpsProvider = require(path.join(base, 'gps-source')).GpsProvider;
var service = require(path.join(base, 'marku-kaluga-cameras'));
function sentence(body) { var c = 0; for (var i = 0; i < body.length; i++) c ^= body.charCodeAt(i); return '$' + body + '*' + ('0' + c.toString(16)).slice(-2); }
function epoch(ms) {
  var d = new Date(ms), pad = function (n, len) { return (new Array((len || 2) + 1).join('0') + n).slice(-(len || 2)); };
  return { tod: pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3),
    date: pad(d.getUTCDate()) + pad(d.getUTCMonth() + 1) + String(d.getUTCFullYear()).slice(-2) };
}
function packet(ms, kinds, mode, quality) {
  var e = epoch(ms), lines = {
    RMC: sentence('GNRMC,' + e.tod + ',A,5430.831174,N,03612.503424,E,20,125,' + e.date + ',,,' + (mode || 'A')),
    GGA: sentence('GNGGA,' + e.tod + ',5430.831174,N,03612.503424,E,' + (quality === undefined ? 1 : quality) + ',10,0.8,150,M,0,M,,'),
    GST: sentence('GNGST,' + e.tod + ',1,1,1,0,3,4,6')
  };
  return kinds.map(function (k) { return lines[k]; }).join('\r\n');
}
var now = Date.UTC(2026, 10, 6, 12, 0, 0), p;
function provider() { return new GpsProvider({ now: function () { return now; }, nmeaPort: 0 }); }
p = provider(); p.setBridgeStatus('subscribed');
assert(/ожидание NMEA/.test(p.description(null, now)));
p.inputNmea(packet(now, ['GGA', 'GST'])); assert.strictEqual(p.current(now), null); assert(/не получено RMC/.test(p.description(null, now)));
p = provider(); p.inputNmea(packet(now, ['RMC'])); assert(/не получено GGA/.test(p.description(null, now)));
p.inputNmea(packet(now, ['GGA'])); var fix = p.current(now);
assert.strictEqual(fix.source, 'bmw-nmea'); assert.strictEqual(fix.accuracyM, null); assert.strictEqual(fix.hdop, 0.8); assert.strictEqual(fix.satellites, 10);
assert(/нет GST/.test(p.description(fix, now)));
p.inputNmea(packet(now, ['GST'])); assert.strictEqual(p.current(now).accuracyM, 10);
var diag = p.diagnostics(now); assert.deepStrictEqual(diag.gpsInput.sentences, { RMC: 1, GGA: 1, GST: 1 });
assert.strictEqual(diag.gpsInput.fixUtcAgeMs, 0); assert.strictEqual(diag.gpsBridge.state, 'subscribed');
assert(!/5430|03612|54\.513|36\.208/.test(JSON.stringify(diag)), 'diagnostics must contain no raw coordinates');
console.log('PASS BMW bridge: separate source, strict RMC/GGA/GST, Russian missing-kind messages, satellites and safe diagnostics');

p = provider(); p.decoder.line(packet(now, ['RMC'])); p.inputNmea(packet(now, ['GGA', 'GST']));
assert.strictEqual(p.current(now), null, 'external RMC must not complete BMW GGA/GST');
p.inputNmea(packet(now, ['RMC'])); assert.strictEqual(p.current(now).source, 'bmw-nmea');
p.setBridgeStatus('stopped'); assert.strictEqual(p.current(now), null);
console.log('PASS source isolation and stopped-bridge withdrawal');

p = provider(); var original = now; p.inputNmea(packet(now, ['RMC', 'GGA', 'GST']));
now += 3500; p.inputNmea(packet(original, ['GGA']));
assert.strictEqual(p.current(now), null); assert.strictEqual(p.bmwDecoder.rmc, null);
assert.strictEqual(p.diagnostics(now).gpsInput.fixUtcAgeMs, 3500);
p.inputNmea(packet(now, ['RMC', 'GGA'])); assert.strictEqual(p.current(now).accuracyM, null, 'new GGA must not revive expired GST');
p = provider(); p.inputNmea(packet(now, ['RMC', 'GGA', 'GST']));
var prior = now; now += 1000; p.inputNmea(packet(now, ['RMC', 'GGA']));
assert.strictEqual(p.current(now).timeMs, prior, 'keep a complete measurement with its original UTC while a new epoch is incomplete');
assert.strictEqual(p.bmwDecoder.last['bmw-nmea'].accuracyM, null, 'GST must not attach to newer coordinates');
p.inputNmea(packet(prior, ['RMC'])); assert.strictEqual(p.bmwDecoder.last['bmw-nmea'].timeMs, now, 'replayed RMC must not replace latest partial fix');
p.inputNmea(packet(now, ['RMC'], 'S')); assert.strictEqual(p.current(now), null, 'simulated RMC must withdraw fix');
p.inputNmea(packet(now, ['RMC', 'GGA', 'GST'], 'A', 6)); assert.strictEqual(p.current(now), null, 'estimated GGA is not satellite fix');
console.log('PASS source UTC: stale RMC/GST cannot revive; replay, simulated and estimated input rejected');

p = provider(); p.inputNmea(packet(now + 501, ['RMC', 'GGA', 'GST']));
assert.strictEqual(p.current(now), null); assert.strictEqual(p.diagnostics(now).gpsInput.sourceUtcAgeMs, -501);
assert(/отличается от часов/.test(p.description(null, now)));
p = provider(); p.inputNmea(packet(now + 500, ['RMC', 'GGA', 'GST']));
assert(p.current(now), '500 ms future bound must match guidance');
assert(/хуже 15 м/.test(p.description(Object.assign({}, p.current(now), { accuracyM: 16 }), now)));
console.log('PASS accuracy and future UTC boundaries match guidance: 15 m and 500 ms');

p = provider(); var good = packet(now, ['RMC']); p.inputNmea(good.slice(0, -2) + (good.slice(-2) === '00' ? 'ff' : '00'));
assert.strictEqual(p.diagnostics(now).gpsInput.sentences.RMC, 0); assert.strictEqual(p.diagnostics(now).gpsInput.checksumErrors, 1);
p.inputNmea(sentence('GPGSA,A,3,,,,,,,,,,,,,1.0,1.0,1.0'));
assert.strictEqual(p.diagnostics(now).gpsInput.sentences.GSA, 1);
assert.throws(function () { p.inputNmea(new Array(4098).join('x')); }, /GPS_PACKET_INVALID/);
assert.throws(function () { p.inputNmea({}); }, /GPS_PACKET_INVALID/);
assert.throws(function () { p.inputNmea('\r\n'); }, /GPS_PACKET_INVALID/);
p.setBridgeStatus('error', 'private\n54.123PRIVATE'); assert.strictEqual(p.diagnostics(now).gpsBridge.errorCode, 'GPS_BRIDGE_ERROR');
assert.throws(function () { p.setBridgeStatus('arbitrary'); }, /GPS_BRIDGE_STATE_INVALID/);
console.log('PASS bounded input and valid-checksum kind counters; unsafe error text sanitized');

function until(fn) { return new Promise(function (resolve, reject) { var begin = Date.now(), timer = setInterval(function () {
  if (fn()) { clearInterval(timer); resolve(); } else if (Date.now() - begin > 3000) { clearInterval(timer); reject(new Error('bridge transport timeout')); }
}, 10); }); }
async function transport() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-gps-bridge-')), file = path.join(dir, 'settings.json');
  var settings = '{"enabled":false,"outputs":{"cluster":false,"hud":false},"hudOpacityPct":100}'; fs.writeFileSync(file, settings);
  var socket = process.platform === 'win32' ? '\\\\.\\pipe\\bmw-gps-bridge-' + process.pid : path.join(dir, 'ctl.sock');
  now = Date.now(); p = provider(); p.start = function () {};
  var app, client, frames = [], buffer = '';
  try {
    await new Promise(function (resolve, reject) {
      app = service.start({ dataDir: dir, socket: socket, gps: p, onListening: resolve, onError: reject,
        guidance: { evaluate: function () { return null; } },
        display: { update: function () {}, status: function () { return 'off'; }, close: function () {} },
        dimmer: { update: function () {}, status: function () { return 'off'; }, close: function () {} } });
    });
    app.state().error = 'KEEP_EXISTING_ERROR';
    client = net.connect(socket); client.setEncoding('utf8'); client.on('error', function () {});
    client.on('data', function (chunk) { buffer += chunk; var nl; while ((nl = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, nl))); buffer = buffer.slice(nl + 1);
    } });
    await new Promise(function (resolve) { client.on('connect', resolve); });
    client.write(JSON.stringify({ cmd: 'gps-bridge', state: 'subscribed' }) + '\n');
    var full = new Array(65).join(sentence('GPGSA,' + new Array(54).join('1')) + '\n');
    assert.strictEqual(Buffer.byteLength(full, 'utf8'), 4096);
    client.cork();
    client.write(JSON.stringify({ cmd: 'vehicle-nmea', data: full }) + '\n');
    client.write(JSON.stringify({ cmd: 'vehicle-nmea', data: full }) + '\n');
    client.uncork();
    await until(function () { return app.state().gpsInput.packets === 2; });
    assert.strictEqual(app.state().gpsInput.sentences.GSA, 128);
    console.log('PASS coalesced transport: two full 4096-byte legal packets survive one corked JSONL write batch');
    client.write(JSON.stringify({ cmd: 'vehicle-nmea', data: packet(now, ['RMC', 'GGA', 'GST']) }) + '\n');
    await until(function () { return app.state().gpsFix && app.state().gpsFix.source === 'bmw-nmea'; });
    assert.strictEqual(app.state().gpsInput.packets, 3); assert.strictEqual(app.state().gpsFix.accuracyM, 10);
    assert.strictEqual(app.state().error, 'KEEP_EXISTING_ERROR'); assert.strictEqual(fs.readFileSync(file, 'utf8'), settings);
    client.write(JSON.stringify({ cmd: 'gps-bridge', state: 'error', errorCode: 'raw\n54.123PRIVATE' }) + '\n');
    await until(function () { return app.state().gpsBridge.state === 'error'; });
    assert.strictEqual(app.state().gpsFix, null); assert.strictEqual(app.state().gpsBridge.errorCode, 'GPS_BRIDGE_ERROR');
    assert.strictEqual(app.state().error, 'KEEP_EXISTING_ERROR'); assert.strictEqual(fs.readFileSync(file, 'utf8'), settings);
    assert(!JSON.stringify(frames).includes('54.123PRIVATE'));
    console.log('PASS real control JSONL: BMW input/status forwarded; no settings writes, unrelated errors retained, unsafe data absent from status');
  } finally { if (client) client.destroy(); if (app) app.close(); p.close(); fs.unlinkSync(file); fs.rmdirSync(dir); }
}
transport().catch(function (e) { console.error(e.stack || e); process.exitCode = 1; });
