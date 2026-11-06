'use strict';
var fs = require('fs'), net = require('net'), path = require('path');
var GpsProvider = require('./gps-source').GpsProvider;
function mkdirp(dir) {
  try { if (fs.statSync(dir).isDirectory()) return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  var parent = path.dirname(dir); if (parent !== dir) mkdirp(parent);
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST' || !fs.statSync(dir).isDirectory()) throw e; }
}
function readSettings(file) {
  var settings = { enabled: true, outputs: { cluster: false, hud: false }, hudOpacityPct: 100 };
  try {
    var p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof p.enabled === 'boolean') settings.enabled = p.enabled;
    if (p.outputs) ['cluster', 'hud'].forEach(function (key) { if (typeof p.outputs[key] === 'boolean') settings.outputs[key] = p.outputs[key]; });
    if (Number.isInteger(p.hudOpacityPct) && p.hudOpacityPct >= 10 && p.hudOpacityPct <= 100) settings.hudOpacityPct = p.hudOpacityPct;
  } catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read settings: ' + e.message); }
  return settings;
}
function loadDatabase(file) {
  var p = JSON.parse(fs.readFileSync(file, 'utf8')), ids = Object.create(null);
  if (p.schemaVersion !== 1 || p.source !== 'OpenStreetMap' || !Array.isArray(p.records) || !p.records.length || p.records.length > 100000 || !isFinite(Date.parse(p.sourceTimestamp))) throw new Error('Unsupported snapshot');
  p.records.forEach(function (r) {
    if (!r || typeof r.id !== 'string' || ids[r.id] || ['speed', 'average', 'redlight'].indexOf(r.type) < 0 || !r.position ||
        typeof r.position.lat !== 'number' || typeof r.position.lon !== 'number' || !isFinite(r.position.lat) || !isFinite(r.position.lon) ||
        r.position.lat < 53 || r.position.lat > 56 || r.position.lon < 33 || r.position.lon > 38) throw new Error('Invalid Kaluga record');
    ids[r.id] = true;
  });
  return p;
}
function nearest(records, fix) {
  if (!fix) return null;
  var best = null, rad = Math.PI / 180;
  records.forEach(function (r) {
    var x = (r.position.lon - fix.lon) * Math.cos((r.position.lat + fix.lat) * rad / 2), y = r.position.lat - fix.lat;
    var d = Math.sqrt(x * x + y * y) * rad * 6371008.8;
    if (d <= 2000 && (!best || d < best.distanceM)) best = { id: r.id, type: r.type, distanceM: Math.round(d), limitKmh: r.limitKmh, confidence: 'unconfirmed' };
  });
  return best;
}
function start(options) {
  options = options || {};
  var dataDir = options.dataDir || process.env.KALUGA_DATA_DIR || '/var/opt/marku-kaluga-cameras/data';
  var socketPath = options.socket || process.env.KALUGA_CONTROL_SOCKET || '/dev/shm/marku-kaluga-cameras/ctl.sock';
  var storageError = null;
  try { mkdirp(dataDir); } catch (e) { storageError = e.code || e.message; }
  var inherited = Number(process.env.LISTEN_PID) === process.pid && Number(process.env.LISTEN_FDS) === 1;
  if (!inherited && socketPath.indexOf('\\\\.\\pipe\\') !== 0) mkdirp(path.dirname(socketPath));
  var settingsPath = path.join(dataDir, 'settings.json'), settings;
  try { settings = readSettings(settingsPath); }
  catch (e) { storageError = e.message; settings = { enabled: true, outputs: { cluster: false, hud: false }, hudOpacityPct: 100 }; }
  var state = { serviceVersion: '0.2.0', enabled: settings.enabled, outputs: settings.outputs, hudOpacityPct: settings.hudOpacityPct,
    hudDimming: 'unavailable', capabilities: { outputs: false, update: false, hudOpacity: false },
    gps: 'Waiting for GPSD/NMEA', gpsFix: null, database: { state: 'error', source: 'OpenStreetMap', count: 0, error: null },
    renderer: 'off', alert: null, nearest: null, error: null, diagnostic: 'No confirmed road; nearby points are diagnostic only',
    storage: { persistent: !storageError, error: storageError } };
  var database = null, guidance = null, display = null, dimmer = null, clients = [], lastStatus = '', closed = false, ownsSocket = false, server;
  try {
    database = loadDatabase(options.database || path.join(__dirname, 'kaluga-speed.json'));
    state.database = { state: 'ready', source: database.source, updated: database.sourceTimestamp, count: database.records.length,
      version: database.version, error: null, licence: database.licence };
  } catch (e) { state.database.error = e.message; }
  try {
    if (!options.guidance) {
      var zones = JSON.parse(fs.readFileSync(path.join(__dirname, 'road-zones.json'), 'utf8'));
      if (!database || zones.sourceTimestamp !== database.sourceTimestamp || zones.pbfMd5 !== database.pbfMd5 || zones.region !== database.region) throw new Error('Road zones and camera snapshot do not match');
    }
    guidance = options.guidance || require('./vehicle-guidance').createGuidance();
  }
  catch (e) { state.error = 'Guidance unavailable: ' + e.message; }
  try { display = options.display || require('./camera-layers').createDisplay(); state.capabilities.outputs = true; }
  catch (e) { state.renderer = 'unavailable'; state.error = state.error || 'Display unavailable: ' + e.message; }
  try { dimmer = options.dimmer || require('./hud-dimmer').createDimmer(); state.capabilities.hudOpacity = true; }
  catch (e) { state.hudDimming = 'unavailable'; }
  var gps = options.gps || new GpsProvider({ host: process.env.KALUGA_GPSD_HOST || '127.0.0.1',
    port: Number(process.env.KALUGA_GPSD_PORT) || 2947, nmeaHost: process.env.KALUGA_NMEA_HOST || '127.0.0.1',
    nmeaPort: process.env.KALUGA_NMEA_PORT === '0' ? 0 : Number(process.env.KALUGA_NMEA_PORT) || 5001 });
  function publicState() { return state; }
  function send(sock) {
    var pending = typeof sock.writableLength === 'number' ? sock.writableLength : sock.bufferSize;
    if (typeof pending !== 'number') pending = 0;
    if (!sock.destroyed && pending < 65536) sock.write(JSON.stringify({ ev: 'status', state: publicState() }) + '\n');
  }
  function broadcast(force) {
    var signature = JSON.stringify(state);
    if (!force && signature === lastStatus) return;
    lastStatus = signature; clients.forEach(send);
  }
  function save(next) {
    var tmp = settingsPath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, settingsPath); state.storage = { persistent: true, error: null };
    } catch (e) {
      state.storage = { persistent: false, error: e.code || e.message };
      try { fs.unlinkSync(tmp); } catch (ignored) {}
    }
    settings = next; state.enabled = settings.enabled; state.outputs = settings.outputs; state.hudOpacityPct = settings.hudOpacityPct;
  }
  function tick() {
    var now = Date.now(), fix = null;
    try { fix = gps.current(now); } catch (e) { state.error = 'GPS provider: ' + e.message; }
    var valid = fix && typeof fix.accuracyM === 'number' && fix.accuracyM > 0 && fix.accuracyM <= 50 &&
      typeof fix.speedKmh === 'number' && isFinite(fix.speedKmh) && fix.speedKmh >= 0 && typeof fix.headingDeg === 'number' && isFinite(fix.headingDeg);
    state.gpsFix = fix || null;
    state.gps = !fix ? 'No fresh source UTC (max 3 s)' : !valid ? fix.source.toUpperCase() + ' fresh; metre accuracy/course unavailable' : fix.source.toUpperCase() + ' live';
    state.nearest = database && fix ? nearest(database.records, fix) : null;
    var alert = null;
    try { if (guidance) alert = guidance.evaluate(database && valid ? fix : null, now, settings.enabled); }
    catch (e) { state.error = 'Guidance: ' + e.message; }
    if (!settings.enabled || !valid || !database) alert = null;
    state.alert = alert ? Object.assign({}, alert, { limit: alert.limitKmh, distance: Math.round(alert.distanceM), stage: alert.stage || 'approach' }) : null;
    if (display) {
      try { display.update(alert, settings.outputs); state.renderer = display.status(); }
      catch (e) { state.renderer = 'error: ' + e.message; state.error = 'Display: ' + e.message; }
    }
    if (dimmer) {
      try { dimmer.update(settings.hudOpacityPct); state.hudDimming = dimmer.status(); }
      catch (e) { state.hudDimming = 'error: ' + e.message; }
    }
    broadcast(false);
  }
  function command(msg) {
    if (!msg || typeof msg.cmd !== 'string') throw new Error('Invalid command');
    if (msg.cmd === 'status') return;
    var next = { enabled: settings.enabled, outputs: Object.assign({}, settings.outputs), hudOpacityPct: settings.hudOpacityPct };
    if (msg.cmd === 'enable' || msg.cmd === 'disable') next.enabled = msg.cmd === 'enable';
    else if (msg.cmd === 'outputs') {
      if (!state.capabilities.outputs) throw new Error('Display unavailable');
      if (typeof msg.cluster !== 'boolean' || typeof msg.hud !== 'boolean') throw new Error('outputs requires cluster and hud booleans');
      next.outputs = { cluster: msg.cluster, hud: msg.hud };
    } else if (msg.cmd === 'hud-opacity') {
      if (!state.capabilities.hudOpacity) throw new Error('HUD opacity unavailable');
      if (!Number.isInteger(msg.percent) || msg.percent < 10 || msg.percent > 100) throw new Error('HUD opacity requires an integer from 10 to 100');
      next.hudOpacityPct = msg.percent;
    } else if (msg.cmd === 'update') throw new Error('Offline snapshot: rebuild on PC and install the updated Store package');
    else throw new Error('Unsupported command');
    save(next); state.error = null; tick();
  }
  server = net.createServer(function (sock) {
    if (clients.length >= 16) { sock.destroy(); return; }
    clients.push(sock); sock.setEncoding('utf8');
    function drop() { clients = clients.filter(function (c) { return c !== sock; }); }
    sock.on('error', drop); sock.on('close', drop); send(sock);
    var buffer = '';
    sock.on('data', function (chunk) {
      buffer += chunk; if (buffer.length > 8192) { sock.destroy(); return; }
      var nl; while ((nl = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (!line.trim()) continue;
        try { command(JSON.parse(line)); }
        catch (e) { sock.write(JSON.stringify({ ev: 'error', error: e.message }) + '\n'); }
        send(sock);
      }
    });
  });
  server.on('error', function (e) { state.error = 'Control: ' + e.message; broadcast(true); if (options.onError) options.onError(e); });
  function listening() {
    ownsSocket = !inherited;
    if (!inherited) { try { fs.chmodSync(socketPath, 0o660); } catch (e) {} }
    if (options.onListening) options.onListening();
  }
  if (inherited) server.listen({ fd: 3 }, listening);
  else {
    var oldSocket = null;
    try { oldSocket = fs.lstatSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (oldSocket && !oldSocket.isSocket()) throw new Error('Control path is not a socket');
    if (!oldSocket) server.listen(socketPath, listening);
    else {
      var existing = net.connect(socketPath), settled = false;
      function existingError(err) {
        if (settled) return; settled = true; existing.destroy();
        if (err.code !== 'ECONNREFUSED' && err.code !== 'ENOENT') { server.emit('error', err); return; }
        try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); }
        catch (e) { if (e.code !== 'ENOENT') { server.emit('error', e); return; } }
        if (!closed) server.listen(socketPath, listening);
      }
      existing.setTimeout(1000, function () { existingError(Object.assign(new Error('Existing socket did not answer'), { code: 'ETIMEDOUT' })); });
      existing.on('error', existingError);
      existing.on('connect', function () {
        if (settled) return; settled = true; existing.destroy();
        server.emit('error', Object.assign(new Error('Control socket is already served'), { code: 'EADDRINUSE' }));
      });
    }
  }
  gps.on('status', function (text) { state.diagnostic = text; });
  gps.on('fix', tick);
  try { gps.start(); } catch (e) { state.error = 'GPS start: ' + e.message; }
  var timer = setInterval(tick, 500); tick();
  function close() {
    if (closed) return; closed = true; clearInterval(timer); gps.close(); if (display) display.close(); if (dimmer) dimmer.close();
    clients.forEach(function (c) { c.destroy(); }); try { server.close(); } catch (e) {}
    if (ownsSocket) { try { fs.unlinkSync(socketPath); } catch (e) {} }
  }
  return { close: close, tick: tick, state: publicState, command: command };
}
module.exports = { start: start, loadDatabase: loadDatabase, nearest: nearest };
if (require.main === module) {
  var app;
  try { app = start({ onError: function (e) {
    process.stderr.write('Camera control startup: ' + (e.code || e.message) + '\n');
    if (app) app.close(); process.exitCode = 1;
  } }); }
  catch (e) { process.stderr.write('marku-kaluga-cameras: ' + e.message + '\n'); process.exitCode = 1; }
  function stop() { if (app) app.close(); }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
