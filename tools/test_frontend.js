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
    assert(view.text.cameraDatabase.includes('ожидание ответа'));
    assert(!view.text.cameraDatabase.includes('0 объектов'));
    assert.strictEqual(view.enabled.cameraDiagnostics, true);
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
    const names = Object.keys(ui.containers['3'].components).map((k) => ui.containers['3'].components[k].name);
    ['cameraCluster', 'cameraHud', 'cameraUpdate', 'cameraDiagnostics', 'cameraAlert'].forEach((n) => assert(names.indexOf(n) >= 0));
    assert.strictEqual(p.mguLocalOnly, true);
});
check('settings use non-focusable iDrive section headers', () => {
    const m = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
    const ui = JSON.parse(fs.readFileSync(path.join(APP, m.tree, 'rhmiData', 'uiDescriptions', 'ID7', 'uiDescription.json'), 'utf8'));
    const xml = fs.readFileSync(path.join(APP, m.tree, 'rhmiData', 'uiDescriptions', 'ID7', 'application.xml'), 'utf8');
    ['90', '91', '92'].forEach((id) => {
        assert.strictEqual(ui.containers['3'].components[id].properties.Focusable.value, 0);
        assert(xml.includes('<component id="' + id + '" type="label" widget="LT_Label_Header_1Row">'));
    });
});
check('full Waze controls retained with separate camera child and confirmed opacity slider', () => {
    const m = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
    const rhmi = path.join(APP, m.tree, 'rhmiData');
    const desc = JSON.parse(fs.readFileSync(path.join(rhmi, 'application.json'), 'utf8')).application;
    const texts = JSON.parse(fs.readFileSync(path.join(rhmi, 'variantGroups', 'Common', 'texts', 'en_GB.json'), 'utf8'));
    const ui = JSON.parse(fs.readFileSync(path.join(rhmi, 'uiDescriptions', 'ID7', 'uiDescription.json'), 'utf8'));
    assert.strictEqual(texts.SID_WOC_TITLE, 'Waze Стрелка');
    assert.strictEqual(desc.uuid, 'd6f38d91-828f-47a0-8bb4-305b8f7e9a42');
    assert.strictEqual(desc.entryPoints[0].uuid, '3de1f32c-d4f4-4574-ae8f-0f37e83dabf3');
    const names = Object.values(ui.containers['1'].components).map((c) => c.name);
    ['wocShowOn', 'wocHudSize', 'wocHudOpacity', 'wocEnable', 'wocDisable', 'wocAaEnable', 'wocAaDisable',
        'wocAaZoomIn', 'wocAaCard', 'wocLogs', 'wocRestart', 'wocCameras'].forEach((name) => assert(names.includes(name), name));
    assert.strictEqual(ui.containers['3'].properties.ParentState.value, 1);
    assert.strictEqual(ui.containers['1'].components['64'].rows[0].NumberOfSteps.value, 18);
});
console.log('PASS: ' + count + ' frontend checks');
