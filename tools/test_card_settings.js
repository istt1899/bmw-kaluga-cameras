'use strict';
// Host-only service/IPC regression; all writes are confined to this test's temp directory.
var assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), cp = require('child_process'), EventEmitter = require('events');
var base = path.resolve(__dirname, '../native/marku-kaluga-cameras/files');
var cards = require(path.join(base, 'card-layout')), service = require(path.join(base, 'marku-kaluga-cameras'));
var renderer = require(path.join(base, 'camera-layers')), policy = require(path.join(base, 'action-policy'));
var tempBase = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'strelka-card-settings-'));
var apps = [], children = [], sequence = 0, originalNow = Date.now;
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function directory(name) { var dir = path.join(root, name); fs.mkdirSync(dir); return dir; }
function socket(dir) { return process.platform === 'win32' ? '\\\\.\\pipe\\strelka-card-' + process.pid + '-' + (++sequence) : path.join(dir, 'ctl.sock'); }
function immediate() { return new Promise(function (resolve) { setImmediate(resolve); }); }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
async function until(fn) { for (var i = 0; i < 300; i++) { if (fn()) return; await sleep(10); } throw Error('Timed out waiting for card settings'); }
function fakeGps(clock) {
  var gps = new EventEmitter(); gps.start = gps.close = function () {};
  gps.fix = { lat: 54.4932, lon: 36.2282, speedKmh: 0, headingDeg: 90, accuracyM: 19.4, timeMs: clock(), motionTimeMs: clock(), source: 'bmw-nmea' };
  gps.current = function () { return gps.fix; }; return gps;
}
async function start(dir, gps, options) {
  var latest = { alert: null, outputs: null, layouts: null }, details = { connection: 'ready' }, closed = 0, actual = null;
  var display = { update: function (alert, outputs, layouts) {
    latest = { alert: clone(alert), outputs: clone(outputs), layouts: clone(layouts) };
    if (alert) ['map','hud'].forEach(function (target) {
      if (!(target === 'map' ? outputs.cluster : outputs.hud)) return;
      details[target] = { state: 'shown', layout: renderer.layoutFor(target, target === 'map' ? { width: 1088, height: 480 } : { width: 800, height: 400 }, 'test', layouts[target]) };
    });
  }, diagnostics: function () { return clone(details); }, status: function () { return 'ready'; }, close: function () { closed++; } };
  var app;
  await new Promise(function (resolve, reject) {
    app = service.start(Object.assign({ dataDir: dir, socket: socket(dir), gps: gps, guidance: { evaluate: function () { return actual; } },
      display: display, dimmer: { update: function () {}, status: function () { return 'test'; }, close: function () {} },
      storeFactory: function (opts) { return { current: function () { return opts.initial; }, status: function () { return { phase: 'idle' }; }, close: function () {} }; },
      onListening: resolve, onError: reject }, options || {}));
  });
  apps.push(app);
  return { app: app, latest: function () { return latest; }, details: details, closed: function () { return closed; },
    actual: function (value) { actual = value; }, refresh: function () { gps.fix.timeMs = Date.now(); gps.fix.motionTimeMs = Date.now(); app.tick(); } };
}
function removeOwned(dir) {
  fs.readdirSync(dir).forEach(function (name) { var p = path.join(dir, name), stat = fs.lstatSync(p); if (stat.isDirectory() && !stat.isSymbolicLink()) removeOwned(p); else fs.unlinkSync(p); }); fs.rmdirSync(dir);
}
function connect(control) {
  var sock = net.connect(control), replies = [], buffer = '';
  sock.setEncoding('utf8'); sock.on('error', function () {});
  sock.on('data', function (chunk) { buffer += chunk; var nl; while ((nl = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, nl))); buffer = buffer.slice(nl + 1); } });
  return { sock: sock, replies: replies, command: async function (message) {
    var id = 'card-test-' + (++sequence); sock.write(JSON.stringify(Object.assign({ requestId: id }, message)) + '\n');
    await until(function () { return replies.some(function (reply) { return reply.state && reply.state.commandResult && reply.state.commandResult.requestId === id && reply.state.commandResult.phase !== 'requested'; }); });
    return replies.filter(function (reply) { return reply.state && reply.state.commandResult && reply.state.commandResult.requestId === id; }).pop().state;
  } };
}
async function processStart(dir) {
  var control = socket(dir), ready = false, stderr = '';
  // A real separate service process and control socket, with explicit local
  // GPS/display adapters. It neither discovers nor connects to a head unit.
  var code = "var E=require('events'),s=require(process.argv[1]),g=new E();g.start=g.close=function(){};g.current=function(){return {lat:54.4932,lon:36.2282,timeMs:Date.now(),motionTimeMs:Date.now(),speedKmh:0,headingDeg:0,accuracyM:19.4};};" +
    "var a=s.start({dataDir:process.argv[2],socket:process.argv[3],gps:g,guidance:{evaluate:function(){return null;}},display:{update:function(){},status:function(){return 'ready';},diagnostics:function(){return {connection:'ready',map:{state:'shown'},hud:{state:'shown'}};},close:function(){}},dimmer:{update:function(){},status:function(){return 'off';},close:function(){}},onListening:function(){process.stdout.write('READY\\n');},onError:function(e){process.stderr.write(e.message);process.exit(1);}});process.stdin.on('data',function(){a.close();process.exit(0);});";
  var child = cp.spawn(process.execPath, ['-e', code, path.join(base, 'marku-kaluga-cameras.js'), dir, control], { windowsHide: true, stdio: ['pipe','pipe','pipe'] }); children.push(child);
  child.stdout.on('data', function (bytes) { if (String(bytes).indexOf('READY') >= 0) ready = true; }); child.stderr.on('data', function (bytes) { stderr += bytes; });
  await until(function () { if (child.exitCode !== null) throw Error('Service process failed: ' + stderr); return ready; });
  var client = connect(control); await until(function () { return client.replies.length > 0; });
  return { client: client, close: async function () { client.sock.destroy(); child.stdin.write('stop\n'); await until(function () { return child.exitCode !== null; }); assert.strictEqual(child.exitCode, 0, stderr); } };
}
async function main() {
  var defaults = cards.defaultLayouts(), independent = cards.defaultLayouts(); independent.map.x = 0; assert.strictEqual(defaults.map.x, 500);
  assert.strictEqual(cards.normalizeLayouts({ map: { x: 250, y: 1001, scalePct: 101, brightnessPct: 10 } }).map.y, 880);
  assert.strictEqual(cards.normalizeLayouts({ map: { scalePct: 101 } }).map.scalePct, 100);
  [NaN, Infinity, '50', null, 9, 101].forEach(function (value) { assert.throws(function () { cards.validateProfile({ brightnessPct: value }, true); }); });
  assert.throws(function () { cards.validateProfile({ scalePct: 76 }, true); }); assert.throws(function () { cards.validateProfile({ x: -1 }, true); });
  assert.throws(function () { cards.validateProfile({}, true); }); assert.throws(function () { cards.validateProfile({ invalid: 100 }, true); });
  assert.throws(function () { cards.validateTarget('cluster'); }); assert.strictEqual(cards.validateProfile({ opacityPct: 10 }, true).opacityPct, 10);
  assert.strictEqual(policy.policies({}, null, Date.now()).displayTestStop.allowed, true);
  assert.strictEqual(policy.policies({}, null, Date.now()).cardLayout.allowed, false);

  var time = originalNow(), gps = fakeGps(function () { return time; }); Date.now = function () { return time; };
  var dir = directory('legacy'), legacy = { enabled: false, outputs: { cluster: true, hud: true }, hudOpacityPct: 55 };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(legacy));
  var run = await start(dir, gps), app = run.app;
  assert.deepStrictEqual(app.state().cardLayout, defaults); assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))), legacy, 'Reading old settings must not rewrite the file');
  app.command({ cmd: 'display-test', target: 'hud', requestId: 'pinned-hud' });
  assert(app.state().displayTest.active && app.state().displayTest.pinned); assert.strictEqual(app.state().displayTest.untilMs, 0);
  assert.deepStrictEqual(run.latest().outputs, { cluster: false, hud: true }); assert.strictEqual(app.state().commandResult.phase, 'shown');
  time += 6500; run.refresh(); assert(app.state().displayTest.active, 'Pinned test survives the former five-second timeout');
  app.command({ cmd: 'card-layout', target: 'hud', x: 0, y: 1000, scalePct: 125, brightnessPct: 10, opacityPct: 10 });
  assert.deepStrictEqual(app.state().cardLayout.map, defaults.map); assert.strictEqual(run.latest().layouts.hud.brightnessPct, 10);
  var before = app.state().rendererDetails.hud.layout.card.x;
  app.command({ cmd: 'card-move', target: 'hud', direction: 'right' });
  assert(Math.abs(app.state().rendererDetails.hud.layout.card.x - before - 10) <= 1, 'A move is ten actual pixels within normalized rounding');
  app.command({ cmd: 'card-layout', target: 'hud', x: 1000 });
  for (var i = 0; i < 4; i++) app.command({ cmd: 'card-move', target: 'hud', direction: 'right' });
  assert.strictEqual(app.state().cardLayout.hud.x, 1000);
  before = app.state().rendererDetails.hud.layout.card.x; app.command({ cmd: 'card-move', target: 'hud', direction: 'left' });
  assert(Math.abs(app.state().rendererDetails.hud.layout.card.x - before + 10) <= 1, 'Boundary clamping creates no hidden movement backlog');
  assert.throws(function () { app.command({ cmd: 'card-move', target: 'map', direction: 'left' }); }, /экран/);
  // The live renderer disconnects between periodic ticks. A move must refresh
  // diagnostics itself rather than trust the previously ready snapshot.
  run.details.connection = 'disconnected'; assert.throws(function () { app.command({ cmd: 'card-move', target: 'hud', direction: 'left' }); }, /подключения/);
  run.details.connection = 'ready'; app.tick();
  var saved = clone(app.state().cardLayout);
  app.command({ cmd: 'enable' }); app.command({ cmd: 'hud-opacity', percent: 25 });
  assert.deepStrictEqual(app.state().cardLayout, saved, 'Other settings commands preserve both card profiles');
  app.command({ cmd: 'display-test-stop' }); assert(!app.state().displayTest.active); assert(app.state().storage.settingsSaved);
  assert(/настройки сохранены/.test(app.state().commandResult.message));
  assert.throws(function () { app.command({ cmd: 'card-move', target: 'hud', direction: 'up' }); }, /включите тест/);
  app.command({ cmd: 'card-layout', target: 'map', scalePct: 150 }); assert.strictEqual(app.state().cardLayout.map.scalePct, 150, 'Size is stored without preview');
  var persisted = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))); assert.deepStrictEqual(persisted.cardLayout, app.state().cardLayout); assert.strictEqual(persisted.displayTest, undefined);
  app.command({ cmd: 'display-test', target: 'hud' }); gps.fix.speedKmh = 5; gps.fix.accuracyM = 5;
  run.actual({ id: 'real-camera', roadConfirmed: true, limitKmh: 60, distanceM: 150 }); run.refresh();
  assert(!app.state().displayTest.active && !app.state().displayTest.pinned); assert.strictEqual(run.latest().alert.id, 'real-camera', 'A moving real warning is never replaced by a pinned test');
  assert.throws(function () { app.command({ cmd: 'card-layout', target: 'hud', x: 0 }); }, /остановитесь/);
  app.command({ cmd: 'display-test-stop' }); // Stop remains available while moving.
  gps.fix.speedKmh = 0; run.refresh(); app.command({ cmd: 'calibration-test', target: 'map' });
  assert.deepStrictEqual(run.latest().outputs, { cluster: true, hud: false }); assert(run.latest().alert.calibration);
  gps.fix.motionTimeMs = time - 3001; app.tick(); assert(!app.state().displayTest.active, 'Stale motion timestamp withdraws preview');
  run.refresh(); app.command({ cmd: 'display-test' }); app.command({ cmd: 'outputs', cluster: true, hud: false }); assert(!app.state().displayTest.active);
  assert.throws(function () { app.command({ cmd: 'display-test', target: 'hud' }); }, /включите выбранный/);
  assert.throws(function () { app.command({ cmd: 'display-test', target: 'bad' }); }, /приборы или HUD/);
  app.command({ cmd: 'outputs', cluster: false, hud: false }); app.command({ cmd: 'card-layout-reset', target: 'hud' });
  assert.deepStrictEqual(app.state().cardLayout.hud, defaults.hud); assert.strictEqual(app.state().cardLayout.map.scalePct, 150);
  app.command({ cmd: 'outputs', cluster: true, hud: true }); app.command({ cmd: 'display-test' }); app.close(); assert(!app.state().displayTest.active); assert.strictEqual(run.closed(), 1);
  await immediate(); var restarted = await start(dir, gps); assert.deepStrictEqual(restarted.app.state().cardLayout, JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))).cardLayout); assert(!restarted.app.state().displayTest.active); restarted.app.close();
  console.log('PASS per-target migration/validation/autosave, pinned selected-target preview, exact pixel moves without clamp creep, motion/stale/off/close withdrawal');

  var failureDir = directory('write-failure'); fs.mkdirSync(path.join(failureDir, 'settings.json'));
  var failure = await start(failureDir, gps); failure.app.command({ cmd: 'card-layout', target: 'hud', opacityPct: 40 });
  assert.strictEqual(failure.app.state().storage.settingsSaved, false); assert(/временно/.test(failure.app.state().commandResult.message));
  failure.app.command({ cmd: 'display-test-stop' }); assert(/временно/.test(failure.app.state().commandResult.message)); failure.app.close();
  var freshDir = directory('stop-defaults'), fresh = await start(freshDir, gps); assert(!fs.existsSync(path.join(freshDir, 'settings.json')));
  fresh.app.command({ cmd: 'display-test-stop' }); assert(fresh.app.state().storage.settingsSaved); assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(freshDir, 'settings.json'))).cardLayout, defaults); fresh.app.close();
  console.log('PASS explicit Done persists even defaults; failed writes are marked temporary and never reported saved');

  Date.now = originalNow;
  var processDir = directory('process-restart'), child = await processStart(processDir);
  await child.client.command({ cmd: 'card-layout', target: 'map', x: 850, scalePct: 120, brightnessPct: 35, opacityPct: 25 });
  await child.client.command({ cmd: 'outputs', cluster: true, hud: true });
  var childState = await child.client.command({ cmd: 'display-test', target: 'map' }); assert(childState.displayTest.active && childState.displayTest.pinned);
  await child.client.command({ cmd: 'display-test-stop' }); await child.close();
  child = await processStart(processDir);
  childState = child.client.replies[0].state; assert.strictEqual(childState.cardLayout.map.x, 850); assert.strictEqual(childState.cardLayout.map.opacityPct, 25); assert(!childState.displayTest.active);
  await child.close();
  console.log('PASS real process/socket commands and restart preserve profiles while preview remains session-only');
}
main().then(function () { cleanup(); }, function (error) { cleanup(); console.error(error.stack); process.exitCode = 1; });
function cleanup() {
  Date.now = originalNow; apps.forEach(function (app) { app.close(); }); children.forEach(function (child) { if (child.exitCode === null) child.kill(); });
  // Verify the exact absolute disposable path before recursive deletion.
  assert.strictEqual(path.dirname(path.resolve(root)), tempBase); assert(/^strelka-card-settings-/.test(path.basename(root)));
  if (fs.existsSync(root)) removeOwned(root);
}
