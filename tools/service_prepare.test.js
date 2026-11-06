'use strict';
var fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), assert = require('assert');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-migrate-')), data = path.join(dir, 'data');
fs.mkdirSync(data); var settings = path.join(data, 'settings.json'), neighbor = path.join(dir, 'unrelated.json');
fs.writeFileSync(settings, '{"enabled":false}'); fs.writeFileSync(neighbor, 'keep');
var changed = [], symlink = null, m = { exports: {} };
var fake = Object.assign({}, fs, {
  chownSync: function (p, uid, gid) { changed.push([p, uid, gid]); },
  lstatSync: function (p) {
    if (p === symlink) return { isDirectory: function () { return true; }, isFile: function () { return true; }, isSymbolicLink: function () { return true; } };
    return fs.lstatSync(p);
  }
});
var source = fs.readFileSync(path.join(__dirname, '../native/marku-kaluga-cameras/files/prepare.js'), 'utf8');
function load(name) { return name === 'fs' ? fake : require(name); }
vm.runInNewContext(source, { require: load, module: m, exports: m.exports, console: console });
try {
  m.exports.prepare({ dir: data, uid: 5000, gid: 3915 });
  assert.deepStrictEqual(changed.map(function (x) { return x[0]; }), [data, settings]);
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{"enabled":false}'); assert.strictEqual(fs.readFileSync(neighbor, 'utf8'), 'keep');
  changed = []; symlink = settings;
  assert.throws(function () { m.exports.prepare({ dir: data, uid: 5000, gid: 3915 }); }, /regular file/);
  assert.deepStrictEqual(changed.map(function (x) { return x[0]; }), [data]);
  changed = []; symlink = data;
  assert.throws(function () { m.exports.prepare({ dir: data, uid: 5000, gid: 3915 }); }, /real directory/);
  assert.strictEqual(changed.length, 0);
  console.log('PASS data ownership migration: only known directory/settings; symlinks rejected; contents preserved');
} finally { fs.unlinkSync(settings); fs.unlinkSync(neighbor); fs.rmdirSync(data); fs.rmdirSync(dir); }
