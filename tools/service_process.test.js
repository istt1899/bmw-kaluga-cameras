'use strict';
// Real child process, real control IPC and the production bootstrap. Set
// STRELKA_TEST_RUNTIME to the target Node 8 binary for the daemon process.
var assert = require('assert'), cp = require('child_process'), fs = require('fs'), net = require('net'), os = require('os'), path = require('path');
var files = path.resolve(__dirname, '../native/marku-kaluga-cameras/files');
var VERSION = JSON.parse(fs.readFileSync(path.join(files, '../component.json'), 'utf8')).version;
var probe = require(path.join(files, 'check')).probe;
var runtime = process.env.STRELKA_TEST_RUNTIME || process.execPath;
var root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-process-'));
var index = 0, children = [];
function socketPath() { index++; return process.platform === 'win32' ? '\\\\.\\pipe\\camera-process-' + process.pid + '-' + index : path.join(root, 'ctl-' + index + '.sock'); }
function launch(socket, data) {
  var child = cp.spawn(runtime, [path.join(files, 'marku-kaluga-cameras.js')], {
    cwd: files, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: Object.assign({}, process.env, { KALUGA_CONTROL_SOCKET: socket, KALUGA_DATA_DIR: data, KALUGA_NMEA_PORT: '0', LISTEN_PID: '', LISTEN_FDS: '' })
  });
  child.output = ''; child.stdout.on('data', function (b) { child.output += b; }); child.stderr.on('data', function (b) { child.output += b; });
  child.finished = new Promise(function (resolve, reject) { child.on('error', reject); child.on('close', resolve); });
  children.push(child); return child;
}
async function stop(child) { if (child.exitCode === null) child.kill(); await child.finished; }
function cleanup(dir) {
  fs.readdirSync(dir).forEach(function (name) { var p = path.join(dir, name); if (fs.lstatSync(p).isDirectory()) { cleanup(p); fs.rmdirSync(p); } else fs.unlinkSync(p); });
}
async function delayedStartup() {
  var socket = socketPath(), child;
  var pending = probe({ socket: socket, checkPermissions: false, version: VERSION, timeoutMs: 5000, retryMs: 30 });
  var start = setTimeout(function () { child = launch(socket, path.join(root, 'normal')); }, 150);
  try {
    var state = await pending;
    assert.strictEqual(state.database.count, 308);
    assert.strictEqual(state.database.osmCount, 150); assert.strictEqual(state.database.reportedCount, 1);
    assert.strictEqual(state.gpsFix, null);
    assert.strictEqual(state.hudOpacityPct, 100);
    console.log('PASS real child startup: probe waits for activation; database delivered without GPS');
  } finally { clearTimeout(start); if (child) await stop(child); }
}
async function badStorage() {
  var obstacle = path.join(root, 'blocked-data'); fs.writeFileSync(obstacle, 'file');
  var socket = socketPath(), child = launch(socket, obstacle);
  try {
    var state = await probe({ socket: socket, checkPermissions: false, version: VERSION, timeoutMs: 5000, retryMs: 30 });
    assert.strictEqual(state.database.count, 308);
    assert.strictEqual(state.database.osmCount, 150); assert.strictEqual(state.database.reportedCount, 1);
    assert.strictEqual(state.storage.persistent, false);
    console.log('PASS real child unavailable storage: status and database remain reachable');
  } finally { await stop(child); }
}
async function activeSocket() {
  var socket = socketPath(), server = net.createServer(function (sock) {
    sock.on('error', function () {}); sock.on('data', function () {});
    sock.end(JSON.stringify({ ev: 'status', state: { serviceVersion: VERSION, database: { state: 'ready', count: 150 } } }) + '\n');
  });
  await new Promise(function (resolve, reject) { server.on('error', reject); server.listen(socket, resolve); });
  var child = launch(socket, path.join(root, 'duplicate'));
  try {
    var deadline;
    var code = await Promise.race([child.finished, new Promise(function (_, reject) { deadline = setTimeout(function () { reject(new Error('duplicate process did not exit')); }, 3000); })]);
    clearTimeout(deadline);
    assert.strictEqual(code, 1); assert(/EADDRINUSE|Control path is not a socket/.test(child.output), child.output);
    var state = await probe({ socket: socket, checkPermissions: false, timeoutMs: 1000 });
    assert.strictEqual(state.database.count, 150);
    console.log('PASS active socket: duplicate daemon fails visibly without removing the existing listener');
  } finally { await stop(child); await new Promise(function (resolve) { server.close(resolve); }); }
}
async function staleSocket() {
  if (process.platform === 'win32') { console.log('SKIP real stale Unix socket on Windows (covered on Linux by this test)'); return; }
  var socket = socketPath();
  cp.execFileSync('python3', ['-c', 'import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.close()', socket]);
  var child = launch(socket, path.join(root, 'stale'));
  try {
    var state = await probe({ socket: socket, checkPermissions: false, version: VERSION, timeoutMs: 5000, retryMs: 30 });
    assert.strictEqual(state.database.count, 308);
    assert.strictEqual(state.database.osmCount, 150); assert.strictEqual(state.database.reportedCount, 1);
    console.log('PASS stale Unix socket is replaced after a refused connection');
  } finally { await stop(child); }
}
delayedStartup().then(badStorage).then(activeSocket).then(staleSocket).then(function () {
  cleanup(root); fs.rmdirSync(root);
  console.log('PASS process bootstrap checks; systemd and BMW account policy require an on-car check');
}, async function (err) {
  console.error(err.stack || err); process.exitCode = 1;
  for (var i = 0; i < children.length; i++) { try { await stop(children[i]); } catch (ignored) {} }
  try { cleanup(root); fs.rmdirSync(root); } catch (ignored) {}
});
