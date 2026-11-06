'use strict';
// Root-only install/start preparation. Never recurse through user data, and
// never follow a data-directory or settings-file symlink during migration.
var fs = require('fs'), path = require('path');
var DATA = '/var/opt/marku-kaluga-cameras/data';
function record(file, name) {
  var line = fs.readFileSync(file, 'utf8').split('\n').find(function (s) { return s.indexOf(name + ':') === 0; });
  if (!line) throw new Error('Required system account missing: ' + name);
  var id = Number(line.split(':')[2]);
  if (!(id >= 0) || Math.floor(id) !== id) throw new Error('Invalid system account id');
  return id;
}
function prepare(options) {
  options = options || {};
  var dir = options.dir || DATA;
  var uid = options.uid === undefined ? record('/etc/passwd', 'hmi_5000') : options.uid;
  var gid = options.gid === undefined ? record('/etc/group', 'tm_oap_app') : options.gid;
  try { fs.mkdirSync(dir, 0o750); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  var st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Data path must be a real directory');
  fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750);
  var settings = path.join(dir, 'settings.json');
  try { st = fs.lstatSync(settings); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('Settings must be a regular file');
  fs.chownSync(settings, uid, gid); fs.chmodSync(settings, 0o600);
}
module.exports = { prepare: prepare };
if (require.main === module) {
  try { prepare(); }
  catch (e) { console.error('Camera settings preparation: ' + (e.code || e.message)); process.exitCode = 1; }
}
