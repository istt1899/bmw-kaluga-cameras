'use strict';
var fs = require('fs'), net = require('net'), path = require('path');
var GpsProvider = require('./gps-source').GpsProvider;
var cameraInfo = require('./camera-info');
var actionPolicy = require('./action-policy'), dataModule = require('./database-store');
var cardLayout = require('./card-layout');
var alertPreferences = require('./alert-preferences');
var warningPolicy = require('./warning-policy');
var databaseCoverage = require('./database-coverage');
var officialData = require('./official-camera-data'), databaseVersion = require('./database-version.json');
var crypto = require('crypto');
function clockSnapshot(now, input) {
  var c = input && typeof input === 'object' ? input : {}, wall = Number.isFinite(now) ? now : null;
  function num(key) { return Number.isFinite(c[key]) ? c[key] : null; }
  function str(key) { return typeof c[key] === 'string' ? c[key].slice(0, 300) : null; }
  return { serviceWallMs: wall, serviceWallUtc: wall !== null && isFinite(new Date(wall).getTime()) ? new Date(wall).toISOString() : null,
    sourceUtcMs: num('sourceUtcMs'), sourceUtc: str('sourceUtc'), sourceDeltaMs: num('sourceDeltaMs'),
    lastPacketAgeMs: num('lastPacketAgeMs'), packetReceiptDeltaMs: num('packetReceiptDeltaMs'),
    receiptClockDiscontinuity: typeof c.receiptClockDiscontinuity === 'boolean' ? c.receiptClockDiscontinuity : null,
    admissionAfterUtcMs: num('admissionAfterUtcMs'), admissionAfterUtc: str('admissionAfterUtc'),
    issue: str('issue') || 'SOURCE_UTC_UNKNOWN', reason: str('reason') || 'Данные часов источника GPS недоступны' };
}
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
  var settings = { enabled: true, outputs: { cluster: false, hud: false }, hudOpacityPct: 100, cardLayout: cardLayout.defaultLayouts(), alertPreferences: alertPreferences.normalize(), overspeedPreferences: warningPolicy.normalize() };
  try {
    var p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof p.enabled === 'boolean') settings.enabled = p.enabled;
    if (p.outputs) ['cluster', 'hud'].forEach(function (key) { if (typeof p.outputs[key] === 'boolean') settings.outputs[key] = p.outputs[key]; });
    if (Number.isInteger(p.hudOpacityPct) && p.hudOpacityPct >= 10 && p.hudOpacityPct <= 100) settings.hudOpacityPct = p.hudOpacityPct;
    settings.cardLayout = cardLayout.normalizeLayouts(p.cardLayout);
    settings.alertPreferences = alertPreferences.normalize(p.alertPreferences);
    settings.overspeedPreferences = warningPolicy.normalize(p.overspeedPreferences);
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
function nearest(records, fix, describeCamera) {
  if (!fix) return null;
  var best = null, rad = Math.PI / 180;
  records.forEach(function (r) {
    var x = (r.position.lon - fix.lon) * Math.cos((r.position.lat + fix.lat) * rad / 2), y = r.position.lat - fix.lat;
    var d = Math.sqrt(x * x + y * y) * rad * 6371008.8;
    if (d <= 2000 && (!best || d < best.distanceM)) best = Object.assign({}, (describeCamera || cameraInfo.describe)(r), { id: r.id, distanceM: Math.round(d), limitKmh: r.limitKmh, confidence: 'unconfirmed' });
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
  catch (e) { storageError = e.message; settings = { enabled: true, outputs: { cluster: false, hud: false }, hudOpacityPct: 100, cardLayout: cardLayout.defaultLayouts(), alertPreferences: alertPreferences.normalize(), overspeedPreferences: warningPolicy.normalize() }; }
  var state = { serviceVersion: '0.8.0', enabled: settings.enabled, outputs: settings.outputs, hudOpacityPct: settings.hudOpacityPct,
    cardLayout: settings.cardLayout,
    alertPreferences: settings.alertPreferences,
    overspeedPreferences: settings.overspeedPreferences,
    speedWarning: warningPolicy.evaluate(null,null,Date.now(),settings.overspeedPreferences),
    gpsReset: { phase:'idle', generation:0, afterUtc:null },
    street: { name: null, source: 'BMW', state: 'unavailable', reason: 'Название улицы BMW ещё не получено', observedAtMs: null },
    audio: { available: false, reason: 'Безопасный звуковой канал BMW не подтверждён' },
    commandResult: null, actions: {}, databaseUpdate: { phase: 'idle', busy: false }, nearestCandidates: [],
    hudDimming: 'unavailable', capabilities: { outputs: false, update: false, hudOpacity: false, displayTest: false, alertPreferences: true, overspeedPreferences: true, gpsReset: false },
    rendererDetails: {}, displayTest: { active: false, pinned: false, target: null, calibration: false, untilMs: 0 },
    gps: 'Ожидание моста GPS BMW', gpsFix: null, clock: clockSnapshot(Date.now(), null),
    gpsBridge: { state: 'stopped', errorCode: null, ageMs: null },
    gpsInput: { source: 'bmw-nmea', packets: 0, badPackets: 0, checksumErrors: 0, sentences: { RMC: 0, GGA: 0, GST: 0 }, lastPacketAgeMs: null, fixUtcAgeMs: null },
    database: { state: 'error', source: 'OpenStreetMap', count: 0, error: null },
    sourceAssembly: { state: 'loading', wantedVersion: databaseVersion.version, selectedVersion: null, activeVersion: null, errorCode: null, reason: null },
    renderer: 'off', alert: null, nearest: null, error: null, diagnostic: 'No confirmed road; nearby points are diagnostic only',
    storage: { persistent: !storageError, settingsSaved: false, error: storageError } };
  var database = null, guidance = null, display = null, dimmer = null, store = null, audio = null, commandCounter = 0, clients = [], lastStatus = '', closed = false, ownsSocket = false, server;
  var describeCamera = cameraInfo.describe;
  var selectedVersion = databaseVersion;
  try {
    // Assemble independently; a failed optional source must never acquire the
    // latest version stamp or replace a complete stored database.
    var candidate = loadDatabase(options.database || path.join(__dirname, 'kaluga-speed.json'));
    cameraInfo.enrich(candidate, options.cameraDetails || path.join(__dirname, 'camera-details.json'));
    cameraInfo.supplement(candidate, options.reportedCameras || path.join(__dirname, 'reported-cameras.json'));
    candidate = dataModule.mergeRelations(candidate, JSON.parse(fs.readFileSync(options.enforcementRelations || path.join(__dirname, 'enforcement-relations.json'), 'utf8')));
    try {
      database = officialData.augment(candidate,
        JSON.parse(fs.readFileSync(options.officialCatalog || path.join(__dirname, 'gibdd-kaluga.json'), 'utf8')),
        JSON.parse(fs.readFileSync(options.officialQuality || path.join(__dirname, 'official-camera-quality.json'), 'utf8')));
      database = require('./speed-limits').augment(database,JSON.parse(fs.readFileSync(options.speedLimitData || path.join(__dirname,'speed-limit-data.json'),'utf8')));
      state.sourceAssembly.state = 'complete';
    } catch (sourceError) {
      database = candidate; selectedVersion = databaseVersion.legacy;
      if (!selectedVersion) throw sourceError;
      state.sourceAssembly.state = 'legacy-fallback';
      state.sourceAssembly.errorCode = 'OFFICIAL_SOURCE_ASSEMBLY_FAILED';
      state.sourceAssembly.reason = String(sourceError.code || sourceError.message).slice(0,300);
    }
    state.sourceAssembly.selectedVersion = selectedVersion.version;
  } catch (e) {
    database = null; state.database.error = e.message;
    state.sourceAssembly.state = 'unavailable'; state.sourceAssembly.errorCode = 'BUNDLED_SOURCE_ASSEMBLY_FAILED';
    state.sourceAssembly.reason = String(e.code || e.message).slice(0,300);
  }
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
  state.capabilities.gpsReset = typeof gps.resetEpoch === 'function';
  function requestToken(msg) {
    return msg && typeof msg.requestId === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(msg.requestId) ? msg.requestId : null;
  }
  function commandResult(commandName, phase, message, id, requestId) {
    if (id && state.commandResult && state.commandResult.id === id) requestId = state.commandResult.requestId;
    state.commandResult = { id: id || ++commandCounter, requestId: requestId || null,
      command: commandName, phase: phase, message: String(message).slice(0,300), timeMs: Date.now() };
  }
  function describeDatabase(bundle) {
    var describer=cameraInfo.createDescriber(bundle.records),known=0;
    bundle.records.forEach(function(r){var d=describer(r);if(Number.isFinite(d.cameraLimitKmh)||d.limitReference&&d.limitReference.state==='known'&&Number.isFinite(d.limitReference.valueKmh))known++;});
    return { state: 'ready', source: bundle.displaySource || bundle.source, baseSource: bundle.source,
      osmCount: bundle.osmCount, reportedCount: bundle.reportedCount, relationCount: bundle.relationCount || 0, officialCount: bundle.officialCount || 0,
      speedLimitCoverage: {known:known,unknown:bundle.records.length-known,total:bundle.records.length}, sourceMetadata: bundle.sourceMetadata || null, speedLimitMetadata: bundle.speedLimitMetadata || null, countUnit: 'source-position-records',
      updated: bundle.sourceTimestamp, generatedAt: bundle.generatedAt, count: bundle.records.length, version: bundle.version,
      sha256: crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex'), digestKind: 'canonical-json',
      licence: bundle.licence, region: bundle.region, coverage: databaseCoverage.summarize(bundle.records,bundle.zones||[]),
      skippedCount: bundle.enforcementAudit && Array.isArray(bundle.enforcementAudit.unsupported) ? bundle.enforcementAudit.unsupported.length : null,
      coverageReason: bundle.enforcementAudit && bundle.enforcementAudit.coverage || 'Неполный набор открытых источников', error: null };
  }
  function activateDatabase(bundle) {
    var nextGuidance = options.guidance || require('./vehicle-guidance').createGuidance({ zones: bundle.zones, records: bundle.records });
    database = bundle; guidance = nextGuidance; describeCamera = cameraInfo.createDescriber(bundle.records); state.database = describeDatabase(bundle);
    state.sourceAssembly.activeVersion = bundle.version;
  }
  function updateStatus(value) {
    state.databaseUpdate = Object.assign({}, value, { source: dataModule.SOURCE_URL, busy: ['checking','downloading','installing'].indexOf(value.phase) >= 0 });
    var messages = { idle: 'База готова к проверке', checking: 'Проверяю опубликованный источник базы', downloading: 'Загружаю новую базу',
      installing: 'Проверяю и сохраняю новую базу', current: 'База актуальна', updated: 'База обновлена', 'rolled-back': 'Предыдущая база восстановлена',
      'recovered-from-previous': 'Повреждение активной базы: загружена предыдущая версия',
      'recovered-from-packaged': 'Локальная база недоступна: загружена база из пакета',
      'bundled-upgraded': 'База из нового пакета применена; предыдущая сохранена',
      'bundled-upgrade-error': 'Не удалось применить базу нового пакета; проверьте хранилище',
      'rollback-pinned': 'Выбранный откат сохранён; проверка обновлений снимет закрепление',
      error: 'Не удалось обновить базу; рабочие данные сохранены' };
    state.databaseUpdate.message = messages[value.phase] || value.phase;
    if (value.errorCode === 'UPDATE_RESTORE_FAILED') state.databaseUpdate.message = 'Ошибка носителя: восстановление базы на диске не подтверждено';
    if (value.errorCode === 'ROLLBACK_PIN_RESTORE_FAILED') state.databaseUpdate.message = 'Восстановление отметки отката не подтверждено; проверьте диагностику базы';
    if (value.errorCode) state.databaseUpdate.message += ' (' + value.errorCode + ')';
  }
  try {
    if (database) {
      var initialBundle = Object.assign({}, database, { schema: 1, version: selectedVersion.version, generatedAt: selectedVersion.generatedAt,
        source: database.displaySource || database.source, zones: zones && zones.zones || [] });
      initialBundle.records = initialBundle.records.map(function (record) { return Object.assign({}, record, { controls: cameraInfo.controls(Object.assign({},record,{officialSiteContext:null})) }); });
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
      fs.renameSync(tmp, settingsPath); state.storage = { persistent: true, settingsSaved: true, error: null };
    } catch (e) {
      state.storage = { persistent: false, settingsSaved: false, error: e.code || e.message };
      try { fs.unlinkSync(tmp); } catch (ignored) {}
    }
    settings = next; state.enabled = settings.enabled; state.outputs = settings.outputs; state.hudOpacityPct = settings.hudOpacityPct; state.cardLayout = settings.cardLayout; state.alertPreferences = settings.alertPreferences; state.overspeedPreferences = settings.overspeedPreferences;
  }
  function nextSettings() { return { enabled: settings.enabled, outputs: Object.assign({}, settings.outputs), hudOpacityPct: settings.hudOpacityPct, cardLayout: cardLayout.normalizeLayouts(settings.cardLayout), alertPreferences: alertPreferences.normalize(settings.alertPreferences), overspeedPreferences: warningPolicy.normalize(settings.overspeedPreferences) }; }
  function testTargetEnabled(target) { return target === 'hud' ? settings.outputs.hud : target === 'map' ? settings.outputs.cluster : settings.outputs.hud || settings.outputs.cluster; }
  function stopDisplayTest(reason) {
    state.displayTest.active = false; state.displayTest.pinned = false; state.displayTest.untilMs = 0;
    state.displayTest.stoppedReason = reason;
  }
  function movedProfile(target, direction) {
    if (['up', 'down', 'left', 'right'].indexOf(direction) < 0) throw new Error('Выберите направление перемещения карточки');
    // Read the current renderer session before moving; the periodic snapshot
    // may predate a socket disconnect or a changed runtime canvas.
    tick();
    var policy = actionPolicy.policies(state, gps.current(Date.now()), Date.now()).cardMove;
    if (!policy.allowed) throw new Error(policy.reason);
    if (state.displayTest.target && state.displayTest.target !== target) throw new Error('Включите тест того экрана, который перемещаете');
    var detail = state.rendererDetails[target], layout = detail && detail.layout, canvas = layout && layout.canvas, card = layout && layout.card;
    var range = layout && layout.positionRange;
    if (!layout || layout.withinBounds !== true || !canvas || !card || !range || ![canvas.width, canvas.height, card.x, card.y, card.width, card.height, range.minX, range.maxX, range.minY, range.maxY].every(Number.isFinite) ||
      canvas.width <= 0 || canvas.height <= 0 || card.width <= 0 || card.height <= 0 || range.minX < 0 || range.minY < 0 || range.maxX < range.minX || range.maxY < range.minY ||
      range.maxX + card.width > canvas.width || range.maxY + card.height > canvas.height) throw new Error('Размеры и границы вывода ещё не получены: включите тест выбранного экрана');
    if (JSON.stringify(cardLayout.validateProfile(layout.settings)) !== JSON.stringify(cardLayout.validateProfile(settings.cardLayout[target]))) throw new Error('Дождитесь подтверждения текущих настроек карточки');
    var horizontal = direction === 'left' || direction === 'right', min = horizontal ? range.minX : range.minY, max = horizontal ? range.maxX : range.maxY;
    if (max <= min) throw new Error('Для перемещения карточки нет свободного места');
    var pixel = horizontal ? card.x : card.y;
    if (pixel < min || pixel > max) throw new Error('Положение карточки вне подтверждённых границ');
    pixel = Math.max(min, Math.min(max, pixel + (direction === 'left' || direction === 'up' ? -10 : 10)));
    var next = Object.assign({}, settings.cardLayout[target]);
    next[horizontal ? 'x' : 'y'] = Math.round((pixel - min) * 1000 / (max - min));
    return cardLayout.validateProfile(next);
  }
  function tick() {
    if(closed)return;
    var now = Date.now(), fix = null;
    try { fix = gps.current(now); } catch (e) { state.error = 'GPS provider: ' + e.message; }
    var valid = fix && typeof fix.accuracyM === 'number' && fix.accuracyM > 0 && fix.accuracyM <= 15 &&
      typeof fix.speedKmh === 'number' && isFinite(fix.speedKmh) && fix.speedKmh >= 0 && typeof fix.headingDeg === 'number' && isFinite(fix.headingDeg);
    state.gpsFix = fix || null;
    if(state.gpsReset.phase==='waiting-new-fix'&&validPosition(fix,now)&&fix.timeMs>state.gpsReset.afterUtc)state.gpsReset.phase='receiving';
    if (state.street.observedAtMs !== null && now - state.street.observedAtMs > 15000) state.street = { name: null, source: 'BMW', state: 'stale', reason: 'Название улицы BMW устарело', observedAtMs: null };
    state.actions = actionPolicy.policies(state, fix, now);
    state.clock = clockSnapshot(now, null);
    if (typeof gps.diagnostics === 'function') {
      var gpsDiagnostics = gps.diagnostics(now); state.gpsBridge = gpsDiagnostics.gpsBridge; state.gpsInput = gpsDiagnostics.gpsInput;
      state.clock = clockSnapshot(now, gpsDiagnostics.clock);
    }
    state.gps = typeof gps.description === 'function' ? gps.description(fix, now) : !fix ? 'Нет свежих подтверждённых координат UTC (максимум 3 с)' :
      !valid ? 'Координаты есть; точность, скорость или курс не подтверждены' : 'Свежие координаты, скорость, курс и точность получены';
    state.nearestCandidates = database && fix ? database.records.map(function(r) {
      var item = nearest([r],fix,describeCamera);
      if (item) item.filterMatched = alertPreferences.matches(r,settings.alertPreferences);
      return item;
    }).filter(Boolean).sort(function(a,b){return a.distanceM-b.distanceM;}).slice(0,3) : [];
    state.nearest = state.nearestCandidates[0] || null;
    var alert = null;
    // Guidance validates the source itself and needs the rejected measurement
    // to explain accuracy/UTC failures. The native output gate below remains.
    try { if (guidance) alert = guidance.evaluate(database ? fix : null, now, settings.enabled, settings.alertPreferences); }
    catch (e) { state.error = 'Guidance: ' + e.message; }
    if (!settings.enabled || !validPosition(fix, now) || !database) alert = null;
    if (alert && (!alertPreferences.matches(alert, settings.alertPreferences) || !Number.isFinite(alert.distanceM) || alert.distanceM < 0 || alert.distanceM > settings.alertPreferences.warningDistanceM + 0.000001)) alert = null;
    state.guidance = guidance && typeof guidance.diagnostic === 'function' ? guidance.diagnostic() : null;
    state.nearestCandidates = state.nearestCandidates.map(function(item){
      var detail=state.guidance && state.guidance.candidates && state.guidance.candidates.find(function(c){return c.id===item.id;});
      return Object.assign({},item,{reason:!validPosition(fix,now)?'GPS_INVALID':detail?detail.reason:'NO_ROAD_ZONE',way:detail&&detail.way||null});
    });
    state.observedAtMs = now;
    state.alert = alert ? Object.assign({}, alert, { filterMatched: true, limit: alert.limitKmh, distance: Math.round(alert.distanceM), stage: alert.stage || (alert.roadConfirmed ? 'approach' : 'nearby') }) : null;
    state.speedWarning = warningPolicy.evaluate(state.alert,fix,now,settings.overspeedPreferences);
    if(!settings.enabled)state.speedWarning.reason='DISABLED';
    else if(!validPosition(fix,now))state.speedWarning.reason=fix?'GPS_INVALID':'GPS_MISSING';
    else if(!state.alert&&state.nearest&&state.nearest.filterMatched===false)state.speedWarning.reason='TYPE_DISABLED';
    if (state.alert) { state.alert.speedKmh = fix.speedKmh; state.alert.overspeed = state.speedWarning.overspeed; state.alert.speedWarning = state.speedWarning; }
    if (state.displayTest.active && (!state.actions.displayTest.allowed || !testTargetEnabled(state.displayTest.target))) stopDisplayTest(!state.actions.displayTest.allowed ? state.actions.displayTest.code : 'OUTPUTS_OFF');
    var displayAlert = state.displayTest.active ? { id: '__display_test__', test: true, title: 'ТЕСТ УВЕДОМЛЕНИЯ',
      description: 'Проверка приборов и HUD', controls: ['redlight','speed'], distanceM: 150, roadConfirmed: true, limitKmh: 60, speedKmh: fix && fix.speedKmh, confidence: 'test', calibration: !!state.displayTest.calibration } : state.alert;
    if (display) {
      var displayOutputs = state.displayTest.active && state.displayTest.target ? {
        cluster: state.displayTest.target === 'map' && settings.outputs.cluster, hud: state.displayTest.target === 'hud' && settings.outputs.hud
      } : settings.outputs;
      try { display.update(displayAlert, displayOutputs, settings.cardLayout); state.renderer = display.status();
        state.rendererDetails = typeof display.diagnostics === 'function' ? display.diagnostics() : {}; }
      catch (e) { state.renderer = 'error: ' + e.message; state.error = 'Display: ' + e.message; }
    }
    if (state.commandResult && ['display-test','calibration-test'].indexOf(state.commandResult.command) >= 0 && state.commandResult.phase === 'requested') {
      var details = state.rendererDetails || {}, results = [], completed = true, failed = false;
      [['map',settings.outputs.cluster],['hud',settings.outputs.hud]].forEach(function(pair) {
        if(state.displayTest.target && pair[0] !== state.displayTest.target)return;
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
    if (audio) { audio.configure(settings.overspeedPreferences.soundEnabled,settings.overspeedPreferences.soundOffsetKmh); audio.update(state.alert, fix, now); var audioState = audio.status();
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
    if (msg.cmd === 'gps-reset') {
      if(Object.keys(msg).some(function(key){return ['cmd','requestId'].indexOf(key)<0;}))throw new Error('Неизвестное поле перезапуска GPS');
      if(!state.capabilities.gpsReset)throw new Error('Источник GPS не поддерживает явный сброс сеанса');
      var resetAt=Date.now(),resetState=gps.resetEpoch(resetAt);
      if(guidance&&typeof guidance.reset==='function')guidance.reset();
      if(audio&&typeof audio.resetEpoch==='function')audio.resetEpoch(resetAt);
      state.gpsReset=Object.assign({phase:'waiting-new-fix',generation:state.gpsReset.generation+1,afterUtc:resetAt+500},resetState||{});
      state.alert=null;stopDisplayTest('GPS_RESET');tick();
      commandResult(msg.cmd,'finished','История GPS очищена; ожидание новых координат UTC',state.commandResult.id);return;
    }
    if (msg.cmd === 'display-test-stop') {
      stopDisplayTest('USER_STOP'); save(nextSettings()); tick();
      commandResult(msg.cmd, 'finished', state.storage.settingsSaved ? 'Тест скрыт; настройки сохранены' : 'Тест скрыт; настройки действуют временно: хранилище недоступно', state.commandResult.id);
      return;
    }
    if (msg.cmd === 'display-test' || msg.cmd === 'calibration-test') {
      state.actions = actionPolicy.policies(state, gps.current(Date.now()), Date.now());
      var policy = state.actions[msg.cmd === 'display-test' ? 'displayTest' : 'calibrationTest'];
      if(!policy.allowed)throw new Error(policy.reason);
      var target = msg.target === undefined ? null : cardLayout.validateTarget(msg.target);
      if(!testTargetEnabled(target))throw new Error('Для теста включите выбранный экран');
      state.displayTest.calibration = msg.cmd === 'calibration-test';
      state.displayTest.active = true; state.displayTest.pinned = true; state.displayTest.target = target; state.displayTest.stoppedReason = null;
      state.displayTest.untilMs = 0; tick(); return;
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
    var next = nextSettings();
    if (msg.cmd === 'enable' || msg.cmd === 'disable') next.enabled = msg.cmd === 'enable';
    else if (msg.cmd === 'alert-preferences') {
      if (Object.keys(msg).some(function(key) { return ['cmd','requestId','warningDistanceM','cameraTypes'].indexOf(key) < 0; })) throw new Error('Неизвестное поле настроек предупреждений');
      var preferencePatch = {};
      ['warningDistanceM','cameraTypes'].forEach(function(key) { if (Object.prototype.hasOwnProperty.call(msg,key)) preferencePatch[key] = msg[key]; });
      next.alertPreferences = alertPreferences.patch(settings.alertPreferences, preferencePatch);
    }
    else if (msg.cmd === 'overspeed-preferences') {
      var warningKeys=['visualFlash','visualOffsetKmh','soundEnabled','soundOffsetKmh'];
      if(Object.keys(msg).some(function(key){return ['cmd','requestId'].concat(warningKeys).indexOf(key)<0;}))throw new Error('Неизвестное поле настроек превышения');
      var warningPatch={};warningKeys.forEach(function(key){if(Object.prototype.hasOwnProperty.call(msg,key))warningPatch[key]=msg[key];});
      next.overspeedPreferences=warningPolicy.patch(settings.overspeedPreferences,warningPatch);
    }
    else if (msg.cmd === 'outputs') {
      if (!state.capabilities.outputs) throw new Error('Display unavailable');
      if (typeof msg.cluster !== 'boolean' || typeof msg.hud !== 'boolean') throw new Error('outputs requires cluster and hud booleans');
      if (state.displayTest.active && ((!msg.cluster && settings.outputs.cluster && state.displayTest.target !== 'hud') || (!msg.hud && settings.outputs.hud && state.displayTest.target !== 'map'))) stopDisplayTest('OUTPUTS_OFF');
      next.outputs = { cluster: msg.cluster, hud: msg.hud };
    } else if (msg.cmd === 'hud-opacity') {
      if (!state.capabilities.hudOpacity) throw new Error('HUD opacity unavailable');
      if (!Number.isInteger(msg.percent) || msg.percent < 10 || msg.percent > 100) throw new Error('HUD opacity requires an integer from 10 to 100');
      next.hudOpacityPct = msg.percent;
    } else if (['card-layout','card-layout-reset','card-move'].indexOf(msg.cmd) >= 0) {
      var cardPolicy = actionPolicy.policies(state, gps.current(Date.now()), Date.now()).cardLayout;
      if(!cardPolicy.allowed)throw new Error(cardPolicy.reason);
      var cardTarget = cardLayout.validateTarget(msg.target);
      if (msg.cmd === 'card-layout-reset') next.cardLayout[cardTarget] = cardLayout.defaultLayouts()[cardTarget];
      else if (msg.cmd === 'card-move') next.cardLayout[cardTarget] = movedProfile(cardTarget, msg.direction);
      else {
        var partial = {};
        ['x','y','scalePct','brightnessPct','opacityPct'].forEach(function (key) { if (Object.prototype.hasOwnProperty.call(msg, key)) partial[key] = msg[key]; });
        partial = cardLayout.validateProfile(partial, true);
        next.cardLayout[cardTarget] = cardLayout.validateProfile(Object.assign({}, next.cardLayout[cardTarget], partial));
      }
    } else if (msg.cmd === 'update') throw new Error('Используйте команду database-check для независимого обновления базы');
    else throw new Error('Unsupported command');
    save(next); state.error = null; tick();
  }
  function command(msg) {
    if (msg && msg.requestId !== undefined && !requestToken(msg)) throw new Error('Invalid requestId');
    var userCommand = msg && typeof msg.cmd === 'string' && ['status','vehicle-nmea','gps-bridge','vehicle-context'].indexOf(msg.cmd)<0;
    if(userCommand) { commandResult(msg.cmd,'requested','Выполняется: ' + msg.cmd, null, requestToken(msg)); broadcast(true); }
    try {
      var answer=execute(msg);
      if(userCommand && state.commandResult.phase==='requested' && ['display-test','calibration-test','database-check','database-rollback','audio-test'].indexOf(msg.cmd)<0)
        commandResult(msg.cmd,'finished',state.storage.settingsSaved === false && ['card-layout','card-layout-reset','card-move','alert-preferences','overspeed-preferences'].indexOf(msg.cmd) >= 0 ? 'Настройка действует временно: хранилище недоступно' : 'Настройка применена',state.commandResult.id);
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
        var message = null;
        try { message = JSON.parse(line); command(message); }
        catch (e) { sock.write(JSON.stringify({ ev: 'error', error: e.message, requestId: requestToken(message) }) + '\n'); }
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
    if (closed) return; stopDisplayTest('SERVICE_CLOSED'); closed = true; clearInterval(timer); gps.close(); if (display) display.close(); if (dimmer) dimmer.close(); if(store)store.close(); if(audio)audio.close();
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
