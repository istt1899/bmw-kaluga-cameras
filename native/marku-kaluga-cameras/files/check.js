'use strict';
// Node 8: installation succeeds only after the app's channel returns a
// usable database. A GNSS fix is deliberately not required for installation.
var fs = require('fs'), net = require('net'), path = require('path');
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
    var socket = options.socket || CONTROL, sock, timer, buffer = '', done = false;
    function finish(err, state) {
      if (done) return; done = true; clearTimeout(timer); if (sock) sock.destroy();
      if (err) reject(err); else resolve(state);
    }
    try { if (options.checkPermissions !== false) permissions(socket); }
    catch (e) { finish(e); return; }
    timer = setTimeout(function () { finish(new Error('No service status within 5 seconds')); }, 5000);
    sock = net.connect(socket);
    sock.setEncoding('utf8');
    sock.on('connect', function () { sock.write('{"cmd":"status"}\n'); });
    sock.on('error', function (e) { finish(new Error('Control socket: ' + (e.code || e.message))); });
    sock.on('close', function () { if (!done) finish(new Error('Service closed before status')); });
    sock.on('data', function (chunk) {
      buffer += chunk; if (buffer.length > 131072) { finish(new Error('Status too large')); return; }
      var nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, nl), msg; buffer = buffer.slice(nl + 1);
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.ev !== 'status' || !msg.state) continue;
        var state = msg.state, db = state.database;
        if (!db || db.state !== 'ready' || !(db.count > 0)) { finish(new Error('Database not ready: ' + (db && db.error || 'empty'))); return; }
        if (options.version && state.serviceVersion !== options.version) { finish(new Error('Wrong running service version')); return; }
        finish(null, state); return;
      }
    });
  });
}
module.exports = { probe: probe };
if (require.main === module) {
  var expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'component.json'), 'utf8')).version;
  probe({ version: expected }).then(function (state) {
    console.log('Kaluga Cameras ' + state.serviceVersion + ': app socket OK; database ' + state.database.count + ' objects; GPS checked separately');
  }, function (err) { console.error('Kaluga Cameras check: ' + err.message); process.exitCode = 1; });
}
