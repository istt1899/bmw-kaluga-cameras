'use strict';
// Exercise the production server's descriptor and stale-path branches. This
// is a boundary stand-in, not a substitute for Linux/systemd integration.
var assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), EventEmitter = require('events');
var base = path.resolve(__dirname, '../native/marku-kaluga-cameras/files');
var code = fs.readFileSync(path.join(base, 'marku-kaluga-cameras.js'), 'utf8');
var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-fd-test-'));
var socket = '/dev/shm/camera-activation-boundary/ctl.sock';
function run(mode) {
  var unlinks = [], listenAt = [], failed = [], accepted, server = new EventEmitter();
  server.listen = function (at, cb) { listenAt.push(at); cb(); }; server.close = function () {};
  var fakeFs = Object.assign({}, fs, {
    statSync: function (p) { return p.indexOf('/dev/shm/') === 0 ? { isDirectory: function () { return true; } } : fs.statSync(p); },
    lstatSync: function (p) {
      if (p !== socket) return fs.lstatSync(p);
      if (mode === 'inherited') throw new Error('inherited listener path must not be inspected');
      return { isSocket: function () { return true; } };
    },
    unlinkSync: function (p) { if (p === socket) unlinks.push(p); else fs.unlinkSync(p); },
    chmodSync: function (p, m) { if (p !== socket) fs.chmodSync(p, m); }
  });
  var fakeNet = {
    createServer: function (cb) { accepted = cb; return server; },
    connect: function () {
      var peer = new EventEmitter(); peer.destroy = peer.setTimeout = function () {};
      setImmediate(function () { if (mode === 'stale') peer.emit('error', Object.assign(new Error('stale'), { code: 'ECONNREFUSED' })); else peer.emit('connect'); });
      return peer;
    }
  };
  var module = { exports: {} };
  function load(name) { if (name === 'fs') return fakeFs; if (name === 'net') return fakeNet; return require(name[0] === '.' ? path.join(base, name) : name); }
  var processStub = { env: mode === 'inherited' ? { LISTEN_PID: '123', LISTEN_FDS: '1' } : {}, pid: 123 };
  vm.runInNewContext(code, { require: load, module: module, exports: module.exports, __dirname: base, process: processStub,
    setInterval: function () { return 1; }, clearInterval: function () {}, Buffer: Buffer, console: console });
  var gps = new EventEmitter(); gps.start = gps.close = function () {}; gps.current = function () { return null; };
  var display = { update: function () {}, status: function () { return 'off'; }, close: function () {} };
  var dimmer = { update: function () {}, status: function () { return 'off'; }, close: function () {} };
  var app = module.exports.start({ dataDir: temp, socket: socket, gps: gps, display: display, dimmer: dimmer,
    onError: function (err) { failed.push(err.code); } });
  return new Promise(function (resolve) { setImmediate(function () {
    if (mode === 'inherited') {
      assert.strictEqual(listenAt[0].fd, 3); assert.strictEqual(unlinks.length, 0);
      var frames = [], client = new EventEmitter(); client.setEncoding = client.destroy = function () {}; client.write = function (line) { frames.push(JSON.parse(line)); };
      accepted(client); assert.strictEqual(frames[0].state.database.count, 308);
      assert.strictEqual(frames[0].state.database.osmCount, 150);
      assert.strictEqual(frames[0].state.database.reportedCount, 1);
    } else if (mode === 'stale') { assert.strictEqual(unlinks.length, 1); assert.strictEqual(listenAt[0], socket); }
    else { assert.strictEqual(unlinks.length, 0); assert.strictEqual(listenAt.length, 0); assert.strictEqual(failed[0], 'EADDRINUSE'); }
    var count = unlinks.length; app.close();
    if (mode !== 'stale') assert.strictEqual(unlinks.length, count, 'close must preserve unowned listener');
    console.log('PASS activation boundary: ' + mode); resolve();
  }); });
}
run('inherited').then(function () { return run('stale'); }).then(function () { return run('active'); }).then(function () {
  fs.rmdirSync(temp); console.log('PASS descriptor/stale ownership logic (systemd itself not executed)');
}, function (err) { console.error(err); process.exitCode = 1; try { fs.rmdirSync(temp); } catch (ignored) {} });
