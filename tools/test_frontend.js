// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { model, outputCommand, date, diagnostics } = require('../apps/marku_kaluga_cameras/src/view_model');
const APP = path.join(__dirname, '..', 'apps', 'marku_kaluga_cameras');
let count = 0;
function check(name, fn) { fn(); count++; console.log('ok ' + count + ' - ' + name); }
check('offline service cannot issue control commands', () => {
    const view = model(null);
    assert.strictEqual(view.enabled.cameraEnable, false);
    assert.strictEqual(view.enabled.cameraCluster, false);
    assert.strictEqual(outputCommand(null, 'hud'), null);
});
check('outputs default off and require explicit capability', () => {
    const s = { enabled: false };
    assert.strictEqual(model(s).text.cameraHud, 'Проекция HUD: выкл');
    assert.strictEqual(outputCommand(s, 'hud'), null);
});
check('output command preserves other display and waits for server state', () => {
    const s = { outputs: { cluster: true, hud: false }, capabilities: { outputs: true } };
    assert.deepStrictEqual(outputCommand(s, 'hud'), { cmd: 'outputs', cluster: true, hud: true });
    assert.deepStrictEqual(s.outputs, { cluster: true, hud: false });
});
check('database attribution/date/count and active warning are rendered', () => {
    const s = { database: { source: 'OpenStreetMap', updated: '2026-11-05T09:00:00Z', count: 27 },
        alert: { type: 'speed', limit: 60, distance: 417 } };
    const t = model(s).text;
    assert(t.cameraDatabase.indexOf('OpenStreetMap') >= 0 && t.cameraDatabase.indexOf('27') >= 0);
    assert(t.cameraDate.indexOf('05.11.2026') >= 0);
    assert(t.cameraAlert.indexOf('420 м') >= 0 && t.cameraAlert.indexOf('60') >= 0);
    assert.strictEqual(date('broken'), 'дата не указана');
});
check('service diagnostics never imply successful output', () => {
    assert(diagnostics({ renderer: 'awaiting GPS' }).indexOf('awaiting GPS') >= 0);
});
check('RHMI identity and action components match implementation', () => {
    const m = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
    const p = JSON.parse(fs.readFileSync(path.join(APP, m.tree, 'package.json'), 'utf8'));
    const ui = JSON.parse(fs.readFileSync(path.join(APP, m.tree, 'rhmiData', 'uiDescriptions', 'ID7', 'uiDescription.json'), 'utf8'));
    assert.strictEqual(m.id, 'marku_kaluga_cameras');
    assert.strictEqual(p.name, m.id); assert.strictEqual(p.version, m.version);
    const names = Object.keys(ui.containers['1'].components).map((k) => ui.containers['1'].components[k].name);
    ['cameraCluster', 'cameraHud', 'cameraUpdate', 'cameraDiagnostics', 'cameraAlert'].forEach((n) => assert(names.indexOf(n) >= 0));
    assert.strictEqual(p.mguLocalOnly, true);
});
console.log('PASS: ' + count + ' frontend checks');
