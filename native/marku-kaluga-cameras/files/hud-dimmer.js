// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Dim only the custom HUD map scene. The black alpha layer is above the
// video (content) and below camera warnings (alert); stock HUD is separate.
// Read Waze's status file: its control socket accepts ONE owner, the UI.
var fs = require('fs');
var ClusterRender = require('./cluster_render_client').ClusterRender;
var STATUS = '/run/waze-on-cluster/status.json';
function createDimmer(options) {
  options = options || {};
  var client = null, ref = null, percent = 100, status = 'Прозрачность HUD: 0 %', closed = false, shown = false;
  function release() {
    if (client) client.close(); client = null; ref = null; shown = false;
  }
  function active() {
    try {
      var file = options.statusFile || STATUS, st = fs.statSync(file), now = (options.now || Date.now)();
      if (!st.isFile() || st.size > 65536 || now - st.mtime.getTime() > 4000 || st.mtime.getTime() > now + 1000) return false;
      var s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (s.hud === 1 || s.hud === true || s.hud === '1') && s.hud_state === 'showing';
    } catch (e) { return false; }
  }
  return {
    update: function (value) {
      if (closed) return;
      percent = Number.isInteger(value) && value >= 10 && value <= 100 ? value : 100;
      if (percent === 100 || !active()) {
        release(); status = percent === 100 ? 'Прозрачность HUD: 0 %' : 'Ожидание карты на HUD'; return;
      }
      if (client) {
        client.set(ref, { opacity: 1 - percent / 100 });
        if (shown) status = 'Прозрачность HUD: ' + (100 - percent) + ' %';
        return;
      }
      client = new ClusterRender('waze-strelka-hud-opacity', options.socket);
      var session = client;
      ref = client.image({ target: 'hud', klass: 'overlay', z: -1000, x: 0, y: 0, w: 800, h: 480,
        iw: 1, ih: 1, visible: false, opacity: 1 - percent / 100, exclusive: false, contend: false, fps: 2 });
      status = 'Ожидание renderer HUD';
      client.on('ready', function () {
        if (client !== session) return;
        client.pixels(ref, null, Buffer.from([0, 0, 0, 255]));
        client.set(ref, { opacity: 1 - percent / 100, visible: true });
      });
      client.on('layer', function (id, state, reason) {
        if (client !== session || id !== ref) return;
        shown = state === 'shown';
        status = state === 'shown' ? 'Прозрачность HUD: ' + (100 - percent) + ' %' :
          'HUD: ' + state + (reason ? ' (' + String(reason).slice(0, 100) + ')' : '');
      });
      client.on('disconnected', function () { if (client === session) { shown = false; status = 'Нет связи с renderer HUD'; } });
      client.on('refused', function () { if (client === session) status = 'Renderer отклонил слой HUD'; });
      client.connect();
    },
    status: function () { return status; },
    close: function () { closed = true; release(); status = 'Выключено'; }
  };
}
module.exports = { createDimmer: createDimmer, STATUS: STATUS };
