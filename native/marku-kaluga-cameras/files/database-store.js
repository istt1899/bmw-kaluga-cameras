'use strict';
// Local, explicit camera-data updates. Code/firmware is never downloaded or run.
var fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');
var URL = require('url').URL;
var SOURCE = 'https://raw.githubusercontent.com/istt1899/bmw-kaluga-cameras/main/data/manifest.json';
var MAX_BUNDLE = 8 * 1024 * 1024, MAX_MANIFEST = 64 * 1024, MAX_RECORDS = 20000, TIMEOUT = 15000;
var CONTROLS = ['speed', 'redlight', 'average', 'stopline', 'belt', 'phone', 'lane', 'pedestrian'];
var TYPES = ['speed', 'average', 'redlight', 'camera'];
function fail(code, message) { var e = new Error(message || code); e.code = code; throw e; }
function object(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function number(n) { return typeof n === 'number' && isFinite(n); }
function date(s) { return typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s) && isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 19) === s.slice(0, 19); }
function version(s) { return typeof s === 'string' && /^\d{1,4}(?:\.\d{1,3}){2,3}$/.test(s); }
function compare(a, b) {
  var x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (var i = 0; i < Math.max(x.length, y.length); i++) { var d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function text(s, max) { return typeof s === 'string' && s.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s); }
function position(p) { return object(p) && number(p.lat) && number(p.lon) && p.lat >= 53 && p.lat <= 56 && p.lon >= 33 && p.lon <= 38; }
function sourceUrl(s) { return typeof s === 'string' && /^https:\/\/(?:www\.)?openstreetmap\.org\/(?:node|way|relation)\/\d+$/.test(s); }
function inspect(o, depth, budget) {
  if (++budget.count > 350000 || depth > 24) fail('DATA_COMPLEXITY', 'Database is too complex');
  if (typeof o === 'string' && !text(o, 4096)) fail('DATA_TEXT', 'Invalid database text');
  if (typeof o === 'number' && !isFinite(o)) fail('DATA_NUMBER');
  if (!o || typeof o !== 'object') return;
  Object.keys(o).forEach(function (k) {
    if (['__proto__', 'prototype', 'constructor'].indexOf(k) >= 0 || !text(k, 100)) fail('DATA_KEY');
    inspect(o[k], depth + 1, budget);
  });
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function record(r, ids) {
  if (!object(r) || !text(r.id, 128) || !/^(?:osm:(?:node|way|relation):\d+|reported:[a-z0-9][a-z0-9:-]{0,90})$/.test(r.id) || ids[r.id]) fail('DATA_ID');
  ids[r.id] = true;
  if (TYPES.indexOf(r.type) < 0 || !position(r.position)) fail('DATA_POSITION');
  if (!Array.isArray(r.controls) || r.controls.length > CONTROLS.length || r.controls.some(function (c, i) { return CONTROLS.indexOf(c) < 0 || r.controls.indexOf(c) !== i; })) fail('DATA_CONTROLS');
  if (r.limitKmh !== null && r.limitKmh !== undefined && (!Number.isInteger(r.limitKmh) || r.limitKmh < 5 || r.limitKmh > 180 || r.controls.indexOf('speed') < 0)) fail('DATA_LIMIT');
  if (r.description !== null && r.description !== undefined && !text(r.description, 250)) fail('DATA_DESCRIPTION');
  ['sourceUrl', 'positionSourceUrl'].forEach(function (key) { if (r[key] != null && !sourceUrl(r[key])) fail('DATA_SOURCE'); });
  if (r.sourceUrls !== undefined && (!Array.isArray(r.sourceUrls) || r.sourceUrls.length > 32 || r.sourceUrls.some(function (u) { return !sourceUrl(u); }))) fail('DATA_SOURCE');
  if (r.captureSide !== undefined && ['front', 'rear', 'both', 'unknown'].indexOf(r.captureSide) < 0) fail('DATA_CAPTURE_SIDE');
  if (r.captureSide && r.captureSide !== 'unknown' && (!sourceUrl(r.captureSideSourceUrl) || !date(r.captureSideVerifiedAt))) fail('DATA_CAPTURE_EVIDENCE');
  if (r.provenance === 'owner-report' && (r.reportStatus !== 'unverified' || r.controls.length || r.type !== 'camera' || r.limitKmh != null || r.positionKind !== 'intersection')) fail('DATA_REPORT_CLAIM');
  if (r.enforcementRelations !== undefined) {
    if (!Array.isArray(r.enforcementRelations) || r.enforcementRelations.length > 32) fail('DATA_RELATIONS');
    r.enforcementRelations.forEach(validateRelation);
  }
}
function validateRelation(r) {
  if (!object(r) || !Number.isSafeInteger(r.id) || r.id <= 0 || !object(r.tags) || r.tags.type !== 'enforcement' || !Array.isArray(r.members) || r.members.length > 2000 || !sourceUrl(r.sourceUrl)) fail('DATA_RELATION');
  if (r.sourceUrl !== 'https://www.openstreetmap.org/relation/' + r.id) fail('DATA_RELATION_SOURCE');
  r.members.forEach(function (m) {
    if (!object(m) || ['node', 'way', 'relation'].indexOf(m.type) < 0 || !Number.isSafeInteger(m.ref) || m.ref <= 0 || !text(m.role, 64)) fail('DATA_MEMBER');
    if (m.position !== undefined && !position(m.position)) fail('DATA_MEMBER_POSITION');
    if (m.positions !== undefined && (!Array.isArray(m.positions) || m.positions.length > 10000 || m.positions.some(function (p) { return !position(p); }))) fail('DATA_MEMBER_POSITION');
  });
}
function validateZones(zones, records) {
  if (!Array.isArray(zones) || zones.length > MAX_RECORDS) fail('DATA_ZONES');
  var ids = Object.create(null), camera = Object.create(null); records.forEach(function (r) { camera[r.id] = true; });
  zones.forEach(function (z) {
    if (!object(z) || !camera[z.id] || ids[z.id] || !position(z) || !Array.isArray(z.roads) || z.roads.length > 5000 || !Array.isArray(z.travel) || !z.travel.length || z.travel.length > 32 || z.travel.some(function (d) { return !number(d) || d < 0 || d >= 360; })) fail('DATA_ZONE');
    ids[z.id] = true;
    if (z.limit != null && (!Number.isInteger(z.limit) || z.limit < 5 || z.limit > 180)) fail('DATA_ZONE_LIMIT');
    z.roads.forEach(function (r) {
      if (!object(r) || !Number.isSafeInteger(r.id) || !Array.isArray(r.pts) || r.pts.length < 2 || r.pts.length > 20000 || [-1, 0, 1].indexOf(r.dir) < 0 || !Number.isInteger(r.cam) || r.cam < -1 || r.cam >= r.pts.length || r.pts.some(function (p) { return !Array.isArray(p) || p.length !== 2 || p.some(function (n) { return !number(n) || Math.abs(n) > 5000; }); })) fail('DATA_ROAD');
    });
  });
}
function validateBundle(bundle) {
  if (!object(bundle)) fail('DATA_SCHEMA');
  var bytes = Buffer.from(JSON.stringify(bundle), 'utf8'); if (bytes.length > MAX_BUNDLE) fail('DATA_SIZE');
  inspect(bundle, 0, { count: 0 });
  if (bundle.schema !== 1 || bundle.region !== 'RU-KLU' || !version(bundle.version) || !date(bundle.generatedAt) || !date(bundle.sourceTimestamp) || !text(bundle.source, 150)) fail('DATA_SCHEMA');
  if (!Array.isArray(bundle.records) || !bundle.records.length || bundle.records.length > MAX_RECORDS) fail('DATA_RECORDS');
  var ids = Object.create(null); bundle.records.forEach(function (r) { record(r, ids); });
  validateZones(bundle.zones, bundle.records);
  if (bundle.pbfMd5 !== undefined && !/^[a-f0-9]{32}$/.test(bundle.pbfMd5)) fail('DATA_BASE_HASH');
  if (bundle.licence !== undefined && !text(bundle.licence, 200)) fail('DATA_LICENCE');
  ['osmCount', 'reportedCount', 'relationCount'].forEach(function (k) { if (bundle[k] !== undefined && (!Number.isInteger(bundle[k]) || bundle[k] < 0 || bundle[k] > bundle.records.length)) fail('DATA_COUNTS'); });
  return clone(bundle);
}
function mergeRelations(database, supplement) {
  if (!object(database) || database.region !== 'RU-KLU' || !Array.isArray(database.records) || !object(supplement) || supplement.schema !== 1 || supplement.region !== database.region || supplement.source !== 'OpenStreetMap' || !date(supplement.sourceTimestamp) || !Array.isArray(supplement.records) || supplement.records.length > MAX_RECORDS) fail('RELATION_SCHEMA');
  inspect(supplement, 0, { count: 0 });
  var incoming = Object.create(null); supplement.records.forEach(function (r) { record(r, incoming); });
  var result = clone(database), lookup = Object.create(null), added = 0, enhanced = 0;
  result.records.forEach(function (r, i) { lookup[r.id] = i; });
  supplement.records.forEach(function (r) {
    var index = lookup[r.id];
    if (index === undefined) { lookup[r.id] = result.records.length; result.records.push(clone(r)); added++; return; }
    var old = result.records[index], merged = Object.assign({}, old);
    // Never count a device twice. An older base point is preserved, and explicit
    // relation facts are attached to that same device with their own provenance.
    merged.controls = (old.controls || []).concat(r.controls).filter(function (c, i, list) { return list.indexOf(c) === i; });
    if (merged.controls.indexOf('redlight') >= 0) merged.type = 'redlight';
    else if (merged.controls.indexOf('speed') >= 0) merged.type = 'speed';
    if (old.limitKmh == null && r.limitKmh != null) merged.limitKmh = r.limitKmh;
    else if (old.limitKmh != null && r.limitKmh != null && old.limitKmh !== r.limitKmh) { merged.limitKmh = null; merged.limitConflict = true; }
    merged.enforcementRelations = clone(r.enforcementRelations || []);
    merged.sourceUrls = (old.sourceUrls || (old.sourceUrl ? [old.sourceUrl] : [])).concat(r.sourceUrls || []).filter(function (u, i, a) { return a.indexOf(u) === i; });
    merged.relationSourceTimestamp = supplement.sourceTimestamp;
    result.records[index] = merged; enhanced++;
  });
  result.relationCount = supplement.records.length;
  result.relationAddedCount = added; result.relationEnhancedCount = enhanced;
  result.enforcementSourceTimestamp = supplement.sourceTimestamp;
  result.enforcementAudit = clone(supplement.audit || {});
  result.displaySource = (database.displaySource || database.source) + ' + enforcement relations';
  return result;
}
function filesAt(dataDir) { return { active: path.join(dataDir, 'camera-database-active.json'), previous: path.join(dataDir, 'camera-database-previous.json') }; }
function read(file) {
  var stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BUNDLE) fail('LOCAL_DATA_FILE');
  return validateBundle(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function loadActive(options) {
  var initial = validateBundle(options.initial), names = filesAt(options.dataDir);
  try { return read(names.active); } catch (e) {
    try { return read(names.previous); } catch (ignored) { return initial; }
  }
}
function allowed(url, manifest) {
  var u; try { u = new URL(url); } catch (e) { fail('UPDATE_URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'raw.githubusercontent.com' || u.port || u.username || u.password || u.hash || u.search) fail('UPDATE_URL');
  if (manifest ? url !== SOURCE : !/^\/istt1899\/bmw-kaluga-cameras\/[a-f0-9]{40}\/data\/camera-database-[A-Za-z0-9._-]+\.json$/.test(u.pathname)) fail('UPDATE_URL');
  return u;
}
function fetchBounded(url, max, requests, redirects) {
  return new Promise(function (resolve, reject) {
    var done = false, req, deadline;
    function finish(err, value) { if (done) return; done = true; clearTimeout(deadline); if (req) { var at = requests.indexOf(req); if (at >= 0) requests.splice(at, 1); } if (err) reject(err); else resolve(value); }
    req = https.get(url, { headers: { 'User-Agent': 'Waze-Strelka-Camera-Data', 'Accept': 'application/json' } }, function (res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0) {
        res.resume(); var target;
        try { target = new URL(res.headers.location, url).toString(); allowed(target, url === SOURCE); if ((redirects || 0) >= 2) fail('UPDATE_REDIRECT'); }
        catch (e) { finish(e); return; }
        fetchBounded(target, max, requests, (redirects || 0) + 1).then(function (bytes) { finish(null, bytes); }, finish); return;
      }
      if (res.statusCode !== 200) { res.resume(); finish(Object.assign(new Error('HTTP ' + res.statusCode), { code: 'UPDATE_HTTP_' + res.statusCode })); return; }
      if (Number(res.headers['content-length']) > max) { res.destroy(); finish(Object.assign(new Error('Download too large'), { code: 'UPDATE_SIZE' })); return; }
      var chunks = [], size = 0;
      res.on('data', function (chunk) { size += chunk.length; if (size > max) { res.destroy(); finish(Object.assign(new Error('Download too large'), { code: 'UPDATE_SIZE' })); } else chunks.push(chunk); });
      res.on('end', function () { finish(null, Buffer.concat(chunks)); }); res.on('error', finish);
    });
    requests.push(req); req.on('error', finish);
    deadline = setTimeout(function () { var error = Object.assign(new Error('Download timed out'), { code: 'UPDATE_TIMEOUT' }); req.destroy(error); finish(error); }, TIMEOUT);
  });
}
function parse(bytes, max) {
  if (!Buffer.isBuffer(bytes) || bytes.length > max) fail('UPDATE_SIZE');
  var s = bytes.toString('utf8'); if (!Buffer.from(s, 'utf8').equals(bytes)) fail('UPDATE_ENCODING');
  try { return JSON.parse(s); } catch (e) { fail('UPDATE_JSON'); }
}
function manifest(m) {
  if (!object(m) || m.schema !== 1 || m.region !== 'RU-KLU' || !version(m.version) || !date(m.generatedAt) || !object(m.artifact) || !Number.isInteger(m.artifact.size) || m.artifact.size < 2 || m.artifact.size > MAX_BUNDLE || !/^[a-f0-9]{64}$/.test(m.artifact.sha256)) fail('UPDATE_MANIFEST');
  allowed(m.artifact.url, false); return m;
}
function writeAtomic(file, bytes) {
  var temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'), fd;
  try { fd = fs.openSync(temp, 'wx', 384); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = null; fs.renameSync(temp, file); }
  finally { if (fd !== undefined && fd !== null) try { fs.closeSync(fd); } catch (e) {} try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function createStore(options) {
  options = options || {}; if (!text(options.dataDir, 1024) || !options.dataDir) fail('STORE_DIRECTORY');
  if (options.sourceUrl !== undefined) allowed(options.sourceUrl, true);
  var initial = validateBundle(options.initial), active = loadActive({ dataDir: options.dataDir, initial: initial });
  var names = filesAt(options.dataDir), closed = false, pending = null, requests = [];
  var test = options._test && options._test.explicit === true ? options._test : null;
  var transport = test && test.transport || function (url, limit) { return fetchBounded(url, limit, requests); };
  var now = test && test.now || Date.now;
  var writable = true; try { fs.accessSync(options.dataDir, fs.constants.W_OK); } catch (e) { writable = false; }
  var state = { phase: 'idle', currentVersion: active.version, availableVersion: null, lastCheckedAt: null, errorCode: null, persistent: writable, canCheck: true, canRollback: fs.existsSync(names.previous) };
  function status() { return clone(state); }
  function ensureOpen() { if (closed) fail('UPDATE_CLOSED', 'Store is closed'); }
  function update(change) { if (closed) return; Object.assign(state, change); if (typeof options.onStatus === 'function') try { options.onStatus(status()); } catch (e) {} }
  function activate(next) {
    ensureOpen();
    var before = active, saved = Buffer.from(JSON.stringify(before));
    // The consumer prepares/replaces its guidance transactionally. A thrown
    // callback prevents disk activation; disk errors ask it to restore old data.
    if (typeof options.onChange === 'function') options.onChange(clone(next));
    ensureOpen(); // A consumer may close the store synchronously in its callback.
    try {
      writeAtomic(names.previous, saved);
      ensureOpen();
      writeAtomic(names.active, Buffer.from(JSON.stringify(next)));
    } catch (e) {
      if (!closed && typeof options.onChange === 'function') try { options.onChange(clone(before)); } catch (ignored) {}
      throw e;
    }
    active = next; state.currentVersion = active.version;
  }
  function check() {
    if (closed) return Promise.reject(Object.assign(new Error('Store is closed'), { code: 'UPDATE_CLOSED' }));
    if (pending) return pending;
    update({ phase: 'checking', errorCode: null, availableVersion: null, canCheck: false, lastCheckedAt: new Date(now()).toISOString() });
    pending = Promise.resolve().then(function () { ensureOpen(); return transport(SOURCE, MAX_MANIFEST); }).then(function (bytes) {
      ensureOpen();
      var m = manifest(parse(bytes, MAX_MANIFEST));
      update({ availableVersion: m.version });
      ensureOpen();
      if (compare(m.version, active.version) <= 0) return { unchanged: true };
      update({ phase: 'downloading' });
      ensureOpen();
      return transport(m.artifact.url, Math.min(m.artifact.size, MAX_BUNDLE)).then(function (payload) {
        ensureOpen();
        if (!Buffer.isBuffer(payload) || payload.length !== m.artifact.size || crypto.createHash('sha256').update(payload).digest('hex') !== m.artifact.sha256) fail('UPDATE_CHECKSUM');
        var next = validateBundle(parse(payload, MAX_BUNDLE));
        if (next.version !== m.version || next.generatedAt !== m.generatedAt) fail('UPDATE_VERSION');
        update({ phase: 'installing' }); activate(next); return { unchanged: false };
      });
    }).then(function (result) {
      update({ phase: result.unchanged ? 'current' : 'updated', currentVersion: active.version, canCheck: true, canRollback: fs.existsSync(names.previous), persistent: true }); return status();
    }, function (e) {
      update({ phase: 'error', errorCode: /^[A-Z0-9_]{1,64}$/.test(e.code || '') ? e.code : 'UPDATE_FAILED', canCheck: !closed }); return status();
    }).then(function (result) { pending = null; return result; });
    return pending;
  }
  function rollback() {
    if (closed || pending) return Promise.resolve(status());
    pending = Promise.resolve().then(function () {
      ensureOpen(); var next = read(names.previous); activate(next);
      update({ phase: 'rolled-back', currentVersion: active.version, errorCode: null, canRollback: true }); return status();
    }).catch(function (e) { update({ phase: 'error', errorCode: e.code || 'ROLLBACK_FAILED' }); return status();
    }).then(function (result) { pending = null; return result; });
    return pending;
  }
  return { current: function () { return clone(active); }, status: status, check: check, rollback: rollback,
    close: function () { if (closed) return; closed = true; Object.assign(state, { phase: 'closed', errorCode: 'UPDATE_CLOSED', canCheck: false, canRollback: false }); requests.slice().forEach(function (r) { r.destroy(Object.assign(new Error('Store closed'), { code: 'UPDATE_CLOSED' })); }); } };
}
module.exports = { validateBundle: validateBundle, loadActive: loadActive, createStore: createStore, mergeRelations: mergeRelations, SOURCE_URL: SOURCE };
