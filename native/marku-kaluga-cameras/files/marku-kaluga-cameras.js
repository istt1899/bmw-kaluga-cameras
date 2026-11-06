'use strict';
var fs = require('fs'), net = require('net'), path = require('path');
var GpsProvider = require('./gps-source').GpsProvider;
var cameraInfo = require('./camera-info');
var actionPolicy = require('./action-policy'), dataModule = require('./database-store');
var crypto = require('crypto');
function validPosition(f, now) {
  return f && [f.timeMs, f.lat, f.lon, f.accuracyM, now].every(Number.isFinite) && Math.abs(f.lat) <= 90 &&
    Math.abs(f.lon) <= 180 && f.accuracyM > 0 && f.accuracyM <= 15 && now - f.timeMs <= 3000 && f.timeMs <= now + 500;
}
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
    if (d <= 2000 && (!best || d < best.distanceM)) best = Object.assign({}, cameraInfo.describe(r), { id: r.id, distanceM: Math.round(d), limitKmh: r.limitKmh, confidence: 'unconfirmed' });
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
  var state = { serviceVersion: '0.4.0', enabled: settings.enabled, outputs: settings.outputs, hudOpacityPct: settings.hudOpacityPct,
    street: { name: null, source: 'BMW', state: 'unavailable', reason: 'Название улицы BMW ещё не получено', observedAtMs: null },
    audio: { available: false, reason: 'Безопасный звуковой канал BMW не подтверждён' },
    commandResult: null, actions: {}, databaseUpdate: { phase: 'idle', busy: false }, nearestCandidates: [],
    hudDimming: 'unavailable', capabilities: { outputs: false, update: false, hudOpacity: false, displayTest: false },
    rendererDetails: {}, displayTest: { active: false, untilMs: 0 },
    gps: 'Ожидание моста GPS BMW', gpsFix: null,
    gpsBridge: { state: 'stopped', errorCode: null, ageMs: null },
    gpsInput: { source: 'bmw-nmea', packets: 0, badPackets: 0, checksumErrors: 0, sentences: { RMC: 0, GGA: 0, GST: 0 }, lastPacketAgeMs: null, fixUtcAgeMs: null },
    database: { state: 'error', source: 'OpenStreetMap', count: 0, error: null },
    renderer: 'off', alert: null, nearest: null, error: null, diagnostic: 'No confirmed road; nearby points are diagnostic only',
    storage: { persistent: !storageError, error: storageError } };
  var database = null, guidance = null, display = null, dimmer = null, store = null, audio = null, commandCounter = 0, clients = [], lastStatus = '', closed = false, ownsSocket = false, server;
  try {
    database = loadDatabase(options.database || path.join(__dirname, 'kaluga-speed.json'));
    cameraInfo.enrich(database, options.cameraDetails || path.join(__dirname, 'camera-details.json'));
    cameraInfo.supplement(database, options.reportedCameras || path.join(__dirname, 'reported-cameras.json'));
    database = dataModule.mergeRelations(database, JSON.parse(fs.readFileSync(options.enforcementRelations || path.join(__dirname, 'enforcement-relations.json'), 'utf8')));
    state.database = { state: 'ready', source: database.displaySource || database.source, baseSource: database.source,
      osmCount: database.osmCount, reportedCount: database.reportedCount, updated: database.sourceTimestamp, count: database.records.length,
      version: database.version, error: null, licence: database.licence, metadataRetrievedAt: database.metadataRetrievedAt };
  } catch (e) { state.database.error = e.message; }
  try {
    if (!options.guidance) {
      var zones = JSON.parse(fs.readFileSync(path.join(__dirname, 'road-zones.json'), 'utf8'));
      if (!database || zones.sourceTimestamp !== database.sourceTimestamp || zones.pbfMd5 !== database.pbfMd5 || zones.region !== database.region) throw new Error('Road zones and camera snapshot do not match');
    }
    guidance = options.guidance || require('./vehicle-guidance').createGuidance({ zones: zones.zones, records: database.records });
  }
  catch (e) { state.error = 'Guidance unavailable: ' + e.message; }
  try { display = options.display || require('./camera-layers').createDisplay(); state.capabilities.outputs = true; state.capabilities.displayTest = true; }
  catch (e) { state.renderer = 'unavailable'; state.error = state.error || 'Display unavailable: ' + e.message; }
  try { dimmer = options.dimmer || require('./hud-dimmer').createDimmer(); state.capabilities.hudOpacity = true; }
  catch (e) { state.hudDimming = 'unavailable'; }
  var gps = options.gps || new GpsProvider({ host: process.env.KALUGA_GPSD_HOST || '127.0.0.1',
    port: Number(process.env.KALUGA_GPSD_PORT) || 2947, nmeaHost: process.env.KALUGA_NMEA_HOST || '127.0.0.1',
    nmeaPort: process.env.KALUGA_NMEA_PORT === '0' ? 0 : Number(process.env.KALUGA_NMEA_PORT) || 5001 });
  function commandResult(commandName, phase, message, id) {
    state.commandResult = { id: id || ++commandCounter, command: commandName, phase: phase, message: String(message).slice(0,300), timeMs: Date.now() };
  }
  function describeDatabase(bundle) {
    return { state: 'ready', source: bundle.displaySource || bundle.source, baseSource: bundle.source,
      osmCount: bundle.osmCount, reportedCount: bundle.reportedCount, relationCount: bundle.relationCount || 0,
      updated: bundle.sourceTimestamp, generatedAt: bundle.generatedAt, count: bundle.records.length, version: bundle.version,
      sha256: crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex'), digestKind: 'canonical-json',
      licence: bundle.licence, region: bundle.region, coverage: 'Неполное покрытие открытых источников',
      skippedCount: bundle.enforcementAudit && Array.isArray(bundle.enforcementAudit.unsupported) ? bundle.enforcementAudit.unsupported.length : null,
      coverageReason: bundle.enforcementAudit && bundle.enforcementAudit.coverage || 'Неполный набор открытых источников', error: null };
  }
  function activateDatabase(bundle) {
    var nextGuidance = options.guidance || require('./vehicle-guidance').createGuidance({ zones: bundle.zones, records: bundle.records });
    database = bundle; guidance = nextGuidance; state.database = describeDatabase(bundle);
  }
  function updateStatus(value) {
    state.databaseUpdate = Object.assign({}, value, { source: dataModule.SOURCE_URL, busy: ['checking','downloading','installing'].indexOf(value.phase) >= 0 });
    var messages = { idle: 'База готова к проверке', checking: 'Проверяю опубликованный источник базы', downloading: 'Загружаю новую базу',
      installing: 'Проверяю и сохраняю новую базу', current: 'База актуальна', updated: 'База обновлена', 'rolled-back': 'Предыдущая база восстановлена',
      error: 'Не удалось обновить базу; рабочие данные сохранены' };
    state.databaseUpdate.message = messages[value.phase] || value.phase;
    if (value.errorCode) state.databaseUpdate.message += ' (' + value.errorCode + ')';
  }
  try {
    if (database) {
      var initialBundle = Object.assign({}, database, { schema: 1, version: '2026.11.6.1', generatedAt: '2026-11-06T00:00:00.000Z',
        source: database.displaySource || database.source, zones: zones && zones.zones || [] });
      initialBundle.records = initialBundle.records.map(function (record) { return Object.assign({}, record, { controls: cameraInfo.controls(record) }); });
      store = (options.storeFactory || dataModule.createStore)({ dataDir: dataDir, initial: initialBundle, onChange: activateDatabase, onStatus: updateStatus });
      activateDatabase(store.current()); updateStatus(store.status()); state.capabilities.update = true;
    }
  } catch (e) { state.databaseUpdate = { phase: 'error', busy: false, errorCode: 'DATA_STORE_UNAVAILABLE', message: 'Обновление базы недоступно: ' + e.message }; }
  try { audio = require('./warning-audio').createAudio(options.audio); state.audio = audio.status(); } catch (ignored) {}
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
    if(closed)return;
    var now = Date.now(), fix = null;
    try { fix = gps.current(now); } catch (e) { state.error = 'GPS provider: ' + e.message; }
    var valid = fix && typeof fix.accuracyM === 'number' && fix.accuracyM > 0 && fix.accuracyM <= 15 &&
      typeof fix.speedKmh === 'number' && isFinite(fix.speedKmh) && fix.speedKmh >= 0 && typeof fix.headingDeg === 'number' && isFinite(fix.headingDeg);
    state.gpsFix = fix || null;
    if (state.street.observedAtMs !== null && now - state.street.observedAtMs > 15000) state.street = { name: null, source: 'BMW', state: 'stale', reason: 'Название улицы BMW устарело', observedAtMs: null };
    state.actions = actionPolicy.policies(state, fix, now);
    if (typeof gps.diagnostics === 'function') {
      var gpsDiagnostics = gps.diagnostics(now); state.gpsBridge = gpsDiagnostics.gpsBridge; state.gpsInput = gpsDiagnostics.gpsInput;
    }
    state.gps = typeof gps.description === 'function' ? gps.description(fix, now) : !fix ? 'Нет свежих подтверждённых координат UTC (максимум 3 с)' :
      !valid ? 'Координаты есть; точность, скорость или курс не подтверждены' : 'Свежие координаты, скорость, курс и точность получены';
    state.nearestCandidates = database && fix ? database.records.map(function(r) { return nearest([r],fix); }).filter(Boolean).sort(function(a,b){return a.distanceM-b.distanceM;}).slice(0,3) : [];
    state.nearest = state.nearestCandidates[0] || null;
    var alert = null;
    try { if (guidance) alert = guidance.evaluate(database && validPosition(fix, now) ? fix : null, now, settings.enabled); }
    catch (e) { state.error = 'Guidance: ' + e.message; }
    if (!settings.enabled || !validPosition(fix, now) || !database) alert = null;
    state.guidance = guidance && typeof guidance.diagnostic === 'function' ? guidance.diagnostic() : null;
    state.nearestCandidates = state.nearestCandidates.map(function(item){
      var detail=state.guidance && state.guidance.candidates && state.guidance.candidates.find(function(c){return c.id===item.id;});
      return Object.assign({},item,{reason:!validPosition(fix,now)?'GPS_INVALID':detail?detail.reason:'NO_ROAD_ZONE',way:detail&&detail.way||null});
    });
    state.observedAtMs = now;
    state.alert = alert ? Object.assign({}, alert, { limit: alert.limitKmh, distance: Math.round(alert.distanceM), stage: alert.stage || (alert.roadConfirmed ? 'approach' : 'nearby') }) : null;
    if (state.alert) { state.alert.speedKmh = fix.speedKmh; state.alert.overspeed = !!state.alert.roadConfirmed && Number.isFinite(state.alert.limitKmh) && fix.speedKmh > state.alert.limitKmh; }
    state.displayTest.active = state.displayTest.untilMs > now && state.actions.displayTest.allowed;
    if (!state.displayTest.active) state.displayTest.untilMs = 0;
    var displayAlert = state.displayTest.active ? { id: '__display_test__', test: true, title: 'ТЕСТ УВЕДОМЛЕНИЯ',
      description: 'Проверка приборов и HUD', controls: ['redlight','speed'], distanceM: 150, roadConfirmed: true, limitKmh: 60, speedKmh: fix && fix.speedKmh, confidence: 'test', calibration: !!state.displayTest.calibration } : state.alert;
    if (display) {
      try { display.update(displayAlert, settings.outputs); state.renderer = display.status();
        state.rendererDetails = typeof display.diagnostics === 'function' ? display.diagnostics() : {}; }
      catch (e) { state.renderer = 'error: ' + e.message; state.error = 'Display: ' + e.message; }
    }
    if (state.commandResult && ['display-test','calibration-test'].indexOf(state.commandResult.command) >= 0 && state.commandResult.phase === 'requested') {
      var details = state.rendererDetails || {}, results = [], completed = true, failed = false;
      [['map',settings.outputs.cluster],['hud',settings.outputs.hud]].forEach(function(pair) {
        if(!pair[1])return;
        var item = details[pair[0]], label = pair[0] === 'map' ? 'Приборы' : 'HUD';
        var shown = item && item.state === 'shown';
        var refused = item && (item.state === 'отказ' || item.state === 'error' || item.reason === 'CANVAS_UNKNOWN' || item.disabled);
        if(!shown && !refused)completed=false;
        if(refused)failed=true;
        results.push(label + ': ' + (shown ? 'renderer подтвердил показ' : refused ? 'отказ ' + (item.reason || item.targetReason || 'вывод недоступен') : 'ожидание подтверждения'));
      });
      if(completed || !state.displayTest.active) commandResult(state.commandResult.command, failed ? 'error' : completed ? 'shown' : 'unconfirmed',
        results.join('; ') + (!state.displayTest.active && !completed ? '; тест завершён без подтверждения показа' : ''), state.commandResult.id);
    }
    if (audio) { audio.update(state.alert, fix, now); var audioState = audio.status();
      if(state.audio && state.audio.probeState)audioState.probeState=state.audio.probeState;
      state.audio=audioState;
    }
    state.actions = actionPolicy.policies(state, fix, now);
    if (dimmer) {
      try { dimmer.update(settings.hudOpacityPct); state.hudDimming = dimmer.status(); }
      catch (e) { state.hudDimming = 'error: ' + e.message; }
    }
    broadcast(false);
  }
  function execute(msg) {
    if(closed)throw new Error('Сервис завершает работу');
    if (!msg || typeof msg.cmd !== 'string') throw new Error('Invalid command');
    if (msg.cmd === 'status') return;
    if (msg.cmd === 'display-test' || msg.cmd === 'calibration-test') {
      state.actions = actionPolicy.policies(state, gps.current(Date.now()), Date.now());
      var policy = state.actions[msg.cmd === 'display-test' ? 'displayTest' : 'calibrationTest'];
      if(!policy.allowed)throw new Error(policy.reason);
      state.displayTest.calibration = msg.cmd === 'calibration-test';
      state.displayTest.untilMs = Date.now() + 5000; tick(); return;
    }
    if (msg.cmd === 'database-check' || msg.cmd === 'database-rollback') {
      tick(); var dataPolicy = state.actions[msg.cmd === 'database-check' ? 'databaseCheck' : 'databaseRollback'];
      if(!dataPolicy.allowed)throw new Error(dataPolicy.reason);
      var requestId=state.commandResult.id;
      (msg.cmd === 'database-check' ? store.check() : store.rollback()).then(function(status) {
        if(closed)return;updateStatus(status);
        if(state.commandResult && state.commandResult.id===requestId)commandResult(msg.cmd,status.phase==='error'?'error':'finished',state.databaseUpdate.message,requestId);tick();
      },function(error){if(!closed){if(state.commandResult && state.commandResult.id===requestId)commandResult(msg.cmd,'error',error.message,requestId);tick();}});return;
    }
    if (msg.cmd === 'audio-test') {
      tick();if(!state.actions.audioTest.allowed)throw new Error(state.actions.audioTest.reason);
      var audioRequestId=state.commandResult.id;
      audio.test(Date.now()).then(function(){if(!closed){if(state.commandResult && state.commandResult.id===audioRequestId)commandResult(msg.cmd,'played','Воспроизведение сигнала подтверждено',audioRequestId);tick();}},
        function(error){if(!closed){if(state.commandResult && state.commandResult.id===audioRequestId)commandResult(msg.cmd,'error',error.message,audioRequestId);tick();}});return;
    }
    if (msg.cmd === 'vehicle-context') {
      var street=msg.street, audioProbe=msg.audio, observed=street && street.observedAtMs, nowContext=Date.now();
      if(street && street.source==='BMW' && ['ready','unavailable','stale'].indexOf(street.state)>=0) {
        var name=street.name;
        if(name!==null && (typeof name!=='string'||name.length>96||Buffer.byteLength(name,'utf8')>240||/[\x00-\x1f\x7f]/.test(name)))throw new Error('STREET_PAYLOAD_INVALID');
        if(typeof name==='string')name=name.trim();
        var freshName=street.state==='ready' && typeof name==='string' && name.length>0 && Number.isFinite(observed) && nowContext-observed<=15000 && observed<=nowContext+500;
        state.street={name:freshName?name:null,source:'BMW',state:freshName?'ready':'unavailable',observedAtMs:freshName?observed:null,
          reason:freshName?null:'BMW не передала свежее название текущей улицы'};
      }
      if(audioProbe && ['detected','unavailable','unverified'].indexOf(audioProbe.state)>=0 && state.audio)state.audio.probeState=audioProbe.state;
      tick();return;
    }
    if (msg.cmd === 'vehicle-nmea') {
      if (typeof msg.data !== 'string' || !msg.data.length || Buffer.byteLength(msg.data, 'utf8') > 4096) throw new Error('GPS_PACKET_INVALID');
      if (typeof gps.inputNmea !== 'function') throw new Error('GPS_BRIDGE_UNAVAILABLE');
      gps.inputNmea(msg.data); tick(); return;
    }
    if (msg.cmd === 'gps-bridge') {
      if (typeof gps.setBridgeStatus !== 'function') throw new Error('GPS_BRIDGE_UNAVAILABLE');
      gps.setBridgeStatus(msg.state, msg.errorCode); tick(); return;
    }
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
    } else if (msg.cmd === 'update') throw new Error('Используйте команду database-check для независимого обновления базы');
    else throw new Error('Unsupported command');
    save(next); state.error = null; tick();
  }
  function command(msg) {
    var userCommand = msg && typeof msg.cmd === 'string' && ['status','vehicle-nmea','gps-bridge','vehicle-context'].indexOf(msg.cmd)<0;
    if(userCommand) { commandResult(msg.cmd,'requested','Выполняется: ' + msg.cmd); broadcast(true); }
    try {
      var answer=execute(msg);
      if(userCommand && state.commandResult.phase==='requested' && ['display-test','calibration-test','database-check','database-rollback','audio-test'].indexOf(msg.cmd)<0)
        commandResult(msg.cmd,'finished','Настройка применена',state.commandResult.id);
      if(userCommand)broadcast(true);return answer;
    } catch(error) { if(userCommand){commandResult(msg.cmd,'error',error.message,state.commandResult.id);broadcast(true);}throw error; }
  }
  server = net.createServer(function (sock) {
    if (clients.length >= 16) { sock.destroy(); return; }
    clients.push(sock); sock.setEncoding('utf8');
    function drop() { clients = clients.filter(function (c) { return c !== sock; }); }
    sock.on('error', drop); sock.on('close', drop); send(sock);
    var buffer = '';
    sock.on('data', function (chunk) {
      buffer += chunk;
      // One transport chunk can contain several legal JSONL commands.
      // Limit each complete/partial line, not the chunk's aggregate length.
      if (Buffer.byteLength(buffer, 'utf8') > 131072) { sock.destroy(); return; }
      var nl; while ((nl = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (Buffer.byteLength(line, 'utf8') > 8192) { sock.destroy(); return; }
        if (!line.trim()) continue;
        try { command(JSON.parse(line)); }
        catch (e) { sock.write(JSON.stringify({ ev: 'error', error: e.message }) + '\n'); }
        send(sock);
      }
      if (Buffer.byteLength(buffer, 'utf8') > 8192) sock.destroy();
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
  function onGpsStatus(text) { if(!closed)state.diagnostic=text; }
  gps.on('status', onGpsStatus);
  gps.on('fix', tick);
  try { gps.start(); } catch (e) { state.error = 'GPS start: ' + e.message; }
  var timer = setInterval(tick, 500); tick();
  function close() {
    if (closed) return; closed = true; clearInterval(timer); gps.close(); if (display) display.close(); if (dimmer) dimmer.close(); if(store)store.close(); if(audio)audio.close();
    if(typeof gps.removeListener==='function'){gps.removeListener('fix',tick);gps.removeListener('status',onGpsStatus);}
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
