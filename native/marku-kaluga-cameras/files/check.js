'use strict';
// Node 8: connect first so systemd can activate the service. Wait through
// bounded startup retries, then require a loaded database and the new version.
// GPS reception is a separate runtime condition, not an installation check.
var fs = require('fs'), net = require('net'), path = require('path'), cp = require('child_process');
var CONTROL = '/dev/shm/marku-kaluga-cameras/ctl.sock';
function permissions(socket) {
  var group = fs.readFileSync('/etc/group', 'utf8').split('\n').find(function (l) { return l.indexOf('tm_oap_app:') === 0; });
  if (!group) throw new Error('tm_oap_app group missing');
  var gid = Number(group.split(':')[2]), st = fs.statSync(socket);
  if (!st.isSocket() || st.gid !== gid || (st.mode & 0o060) !== 0o060) throw new Error('App cannot read/write the control socket');
  var dir = path.dirname(socket);
  while (dir !== '/') {
    st = fs.statSync(dir);
    if (!(st.mode & 0o001) && !(st.gid === gid && st.mode & 0o010)) throw new Error('App cannot traverse ' + dir);
    dir = path.dirname(dir);
  }
}
function probe(options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var socket = options.socket || CONTROL, sock, retry, deadline, buffer = '', done = false;
    var timeoutMs = options.timeoutMs || 8000, lastError = new Error('No service status');
    function finish(err, state) {
      if (done) return; done = true; clearTimeout(deadline); clearTimeout(retry); if (sock) sock.destroy();
      if (err) reject(err); else resolve(state);
    }
    function again(err) {
      if (done) return;
      lastError = err;
      var current = sock; sock = null; if (current) current.destroy();
      clearTimeout(retry); retry = setTimeout(connect, options.retryMs || 150);
    }
    function connect() {
      if (done) return;
      var current = net.connect(socket); sock = current; buffer = '';
      current.setEncoding('utf8'); current.setTimeout(Math.min(timeoutMs, 1500));
      current.on('connect', function () {
        if (done || sock !== current) return;
        try { if (options.checkPermissions !== false) permissions(socket); }
        catch (e) { finish(e); return; }
        current.write('{"cmd":"status"}\n');
      });
      current.on('timeout', function () { if (sock === current) again(new Error('Connected but service sent no status')); });
      current.on('error', function (e) { if (sock === current) again(new Error('Control socket: ' + (e.code || e.message))); });
      current.on('close', function () { if (!done && sock === current) again(new Error('Service closed before status')); });
      current.on('data', function (chunk) {
        if (done || sock !== current) return;
        buffer += chunk; if (buffer.length > 131072) { finish(new Error('Status too large')); return; }
        var nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          var line = buffer.slice(0, nl), msg; buffer = buffer.slice(nl + 1);
          try { msg = JSON.parse(line); } catch (e) { continue; }
          if (msg.ev !== 'status' || !msg.state) continue;
          var state = msg.state, db = state.database;
          if (!db || db.state !== 'ready' || !(db.count > 0)) { finish(new Error('Database not ready: ' + (db && db.error || 'empty'))); return; }
          if (options.version && state.serviceVersion !== options.version) { again(new Error('Wrong running service version')); return; }
          finish(null, state); return;
        }
      });
    }
    deadline = setTimeout(function () { finish(lastError); }, timeoutMs);
    connect();
  });
}
function systemdDiagnostics() {
  return ['marku-kaluga-cameras.service', 'marku-kaluga-cameras.socket'].map(function (unit) {
    var r = cp.spawnSync('systemctl', ['show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'Result', '-p', 'ExecMainStatus'],
      { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
    // Only machine-state words/numbers: never journal text, environment,
    // coordinates, settings contents or vehicle identities.
    var facts = String(r.stdout || '').split('\n').filter(function (l) {
      return /^(ActiveState|SubState|Result|ExecMainStatus)=[A-Za-z0-9_-]*$/.test(l);
    });
    return unit + ': ' + (facts.length ? facts.join(' ') : 'systemd status unavailable');
  });
}
module.exports = { probe: probe, systemdDiagnostics: systemdDiagnostics };
if (require.main === module) {
  var expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'component.json'), 'utf8')).version;
  probe({ version: expected }).then(function (state) {
    console.log('Waze Strelka camera service ' + state.serviceVersion + ': app socket OK; database ' + state.database.count + ' objects; GPS checked separately');
  }, function (err) {
    console.error('Camera service check: ' + err.message);
    systemdDiagnostics().forEach(function (line) { console.error(line); });
    process.exitCode = 1;
  });
}
