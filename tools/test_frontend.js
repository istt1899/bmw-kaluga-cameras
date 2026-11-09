// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { model, outputCommand, date, diagnostics } = require('../apps/marku_kaluga_cameras/src/view_model');
const APP = path.join(__dirname, '..', 'apps', 'marku_kaluga_cameras');
let count = 0;
function check(name, fn) { fn(); count++; console.log('ok ' + count + ' - ' + name); }
check('GPS diagnostic distinguishes no packets from valid sentence counters without exposing position', () => {
    const s = { enabled: true, gpsInput: { sentences: { RMC: 2, GGA: 3 }, lastPacketAgeMs: 1800, checksumErrors: 1 },
        gpsBridge: { state: 'subscribed' }, gpsFix: { lat: 55.987654, lon: 37.123456 } };
    const text = model(s).text.cameraInfo;
    assert(text.includes('RMC 2') && text.includes('GGA 3') && text.includes('GST 0') && text.includes('1 с назад'));
    assert(!text.includes('55.987654') && !diagnostics(s).includes('37.123456'));
    s.gpsInput.lastPacketAgeMs = null;
    assert(model(s).text.cameraInfo.includes('ещё нет'));
    assert(diagnostics(s).includes('subscribed') && diagnostics(s).includes('checksum: 1'));
});
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
    assert.strictEqual(model(s).text.cameraHud, 'Проекция HUD: вывод недоступен');
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
    ['cameraDiagnostics','cameraAlertsLink','cameraTypesLink','cameraHudSetup','cameraMapSetup','cameraDatabaseLink'].forEach((n) => assert(names.indexOf(n) >= 0));
    assert.strictEqual(p.mguLocalOnly, true);
});
check('camera hub contains only six native child links and one unfocusable status', () => {
    const m=JSON.parse(fs.readFileSync(path.join(APP,'mgu-app.json'),'utf8'));
    const ui=JSON.parse(fs.readFileSync(path.join(APP,m.tree,'rhmiData/uiDescriptions/ID7/uiDescription.json'),'utf8'));
    const root=Object.values(ui.containers['3'].components);
    assert.strictEqual(root.filter(c=>c.type==='button').length,6);
    assert.strictEqual(root.find(c=>c.name==='cameraStatus').properties.Focusable.value,0);
    assert(!root.some(c=>c.type==='slider'||c.type==='checkBox'||c.type==='dropDownMenu'));
    ['4','5','6','7','9'].forEach(id=>assert.strictEqual(ui.containers[id].properties.ParentState.value,3));
    assert.strictEqual(ui.containers['8'].properties.ParentState.value,7);
    assert.strictEqual(ui.containers['11'].properties.ParentState.value,5);
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
