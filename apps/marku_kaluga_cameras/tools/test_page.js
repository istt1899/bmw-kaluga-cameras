// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Runs the app's source modules (mgu-app.json, the entry first) against
 * a fake SDK and HMI built from the shipped uiDescription.json, with its two
 * sockets pointed at tools/fakes.js.
 *
 *   node tools/build.js && node tools/test_page.js
 *
 * Covers: the main page's four sections in order (General, HUD, CarPlay,
 * Android Auto), each under an unfocusable header row, the same in
 * application.xml; no log rows on it; its labels; every row stays on the
 * page through every state (CarPlay showing and waiting, patched and not,
 * Android Auto on, off and not supported, a patch pending), greyed where it
 * cannot act, with the only rows shown and hidden CarPlay Wi-Fi and its
 * line, CarPlay's last, and the restart's two rows, the page's last;
 * CarPlay Wi-Fi: 5 GHz, and 2.4 GHz with the line to turn the iPhone's Wi-Fi
 * off and on, neither while patchd does not know the band; CarPlay's
 * Patch button
 * enabled only while unpatched and CarPlay's Remove patch button only while patched;
 * pressing every button sends the render nothing; Android Auto's Status,
 * Zoom and the Hide phone's turn card checkbox; info rows as Name: Value;
 * the Cluster map row in General; Hide BMW's turn box ticked as the render
 * reports, each press one guide command to the render, greyed and unticked,
 * its label kept, while the cluster renderer holds the box shown; Show on,
 * a drop-down of Cluster, HUD and both in General, Cluster by default, each
 * pick through the render and patchd, the display turned on first, — for a
 * render on neither; the HUD off by default, its size slider and position
 * buttons greyed (a greyed slider turned goes back), the slider a 5 % step
 * a turn, Disabled after errors with the slider and position buttons
 * greyed; no label greyed (the HMI's labels have no setEnabled, its
 * drop-downs and sliders only the property);
 * hiding the page closes both sockets; a page opened again reads the
 * render's current state; a pending patch, from the daemon and, before the
 * daemon runs, from its marker; a failed restart on the restart's own line,
 * CarPlay's line unchanged; the restart press restarts once, a greyed
 * button pressed sends nothing. The Logs
 * page: Start capture and the Capture row on it; Logs opens it (a child of the
 * main page), moving there keeps the app shown and its sockets open, it
 * holds the logs socket while shown; Save logs saves once and lists the
 * archive; the address shows as text and as a QR code, a new code replacing
 * the old one when the address changes and a blank one without an address;
 * back from an overlay on the Logs page, the logs socket opens again; a tile
 * launch after leaving on the Logs page opens none. The display language,
 * from HMIContext: a change writes the rows of both pages again in its
 * words, English for a word it lacks, and English again after.
 */
const assert = require('assert');
function testPath(name) { return process.platform === 'win32' && /\.sock$/.test(name) ? '\\\\.\\pipe\\' + name : require('path').join(require('os').tmpdir(), name); }

const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { FakeRender, FakePatch, FakeLogs, RENDER_PAGE, RENDER_FPS } = require('./fakes.js');
const { RENDER_PATH, PATCH_PATH, PENDING_PATH, SIZE, SAFE, HUD_SIZE_STEPS } = require('../src/waze_cluster_control.js');
const { LOGS_PATH } = require('../src/logs_control.js');
const { PAGE_KEYS: DIAGNOSTIC_KEYS } = require('../src/diagnostics_view.js');

const STAGED = fs.readdirSync(path.join(__dirname, '..'))
    .find((name) => name.startsWith('marku_kaluga_cameras@') && !name.endsWith('.tgz'));
const PKG = path.join(__dirname, '..', STAGED);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mgu-app.json'), 'utf8'));
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8');
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));

/* short: macOS limits a socket path to 104 bytes */
const RSOCK = testPath(`woc-pr-${process.pid}.sock`);
const PSOCK = testPath(`woc-pp-${process.pid}.sock`);
const PENDING = testPath(`woc-ppend-${process.pid}.json`);
const LSOCK = testPath(`woc-pl-${process.pid}.sock`);
const CSOCK = testPath(`woc-pc-${process.pid}.sock`);
const SOCKETS = { [RENDER_PATH]: RSOCK, [PATCH_PATH]: PSOCK, [LOGS_PATH]: LSOCK,
    '/dev/shm/marku-kaluga-cameras/ctl.sock': CSOCK };
const cameraPeers = new Set(), cameraCommands = [];
let cameraState = { enabled: true, capabilities: { outputs: true, hudOpacity: true }, hudOpacityPct: 100,
    actions:{displayTest:{allowed:true},calibrationTest:{allowed:true},audioTest:{allowed:false,reason:'Нет проверенного аудиоканала'},
        databaseCheck:{allowed:true},databaseRollback:{allowed:false,reason:'Нет предыдущей базы'},
        displayTestStop:{allowed:true},cardLayout:{allowed:true},cardMove:{allowed:true}},
    cardLayout:{hud:{x:500,y:820,scalePct:100,brightnessPct:100,opacityPct:100},
        map:{x:500,y:880,scalePct:100,brightnessPct:100,opacityPct:100}},storage:{persistent:true,settingsSaved:false},
    outputs: { cluster: false, hud: false }, database: { source: 'OpenStreetMap', count: 150, updated: '2026-11-05T00:00:00Z' } };
const cameraReply = () => cameraPeers.forEach((s) => s.write(JSON.stringify({ ev: 'status', state: cameraState }) + '\n'));
const cameraServer = net.createServer((s) => {
    cameraPeers.add(s); s.setEncoding('utf8'); let buffer = '';
    s.on('error', () => {}); s.on('close', () => cameraPeers.delete(s));
    s.on('data', (chunk) => {
        buffer += chunk; let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const command = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); cameraCommands.push(command);
            if (command.cmd === 'status') cameraReply();
        }
    });
});
const realConnect = net.connect;
const exit = process.exit.bind(process);
net.connect = (p, ...rest) => realConnect.call(net, SOCKETS[p] || p, ...rest);
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => realRead.call(fs, p === PENDING_PATH ? PENDING : p, ...rest);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function until(what, check) {
    const deadline = Date.now() + 2000;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) resolve();
            else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
            else setTimeout(poll, 10);
        };
        poll();
    });
}

/* ---- fake HMI, from the shipped uiDescription ----------------------------- */

class FakeComponent extends EventEmitter {
    constructor(id, desc) {
        super();
        this.id = Number(id);
        this.desc = desc;
        this.text = null;
        this.cells = {};
        this.enabled = null;
        this.visible = (desc && desc.properties && desc.properties.Visible) ? desc.properties.Visible.value === 1 : null;
        this.enabledSeen = new Set();
        this.ticks = [];
        const type = desc && desc.type;
        if (type === 'label') {
            this.setEnabled = undefined;   /* the HMI greys no label */
        }
        /* the oap-sdk's DropDown and Slider: no setEnabled or setVisible, only
         * setProperty; the HMI moves their value itself, the SDK writing it */
        if (type === 'dropDownMenu' || type === 'slider') {
            this.setEnabled = this.setVisible = undefined;
        }
        if (type === 'dropDownMenu') {
            this.on('action', ({ row }) => { this.cells.SelectedItem = row; });
        }
        if (type === 'slider') {
            this._step = 0;
            this.on('action', ({ subType }) => this.setStepValue(this.cells['0:Value'] + (subType === 4 ? 1 : -1)));
        }
    }
    getId() { return this.id; }
    setValue(...args) {
        const [row, cell, value] = args.length === 3 ? [null, ...args] : args;
        this.cells[row == null ? cell : `${row}:${cell}`] = value;
        if (cell === 'eParam_RowSelected') {
            this.selected = value;
            this.ticks.push(value);
        } else if (this.desc.type !== 'dropDownMenu' && (this.desc.type !== 'slider' || cell === 'TextDescription')) {
            this.text = value;
        }
        return Promise.resolve();
    }
    /* the SDK's Slider: held between its ends, 'changed' when it moves */
    setStepValue(v) {
        const row = this.desc.rows[0];
        const value = Math.max(row.MinValue.value, Math.min(row.MaxValue.value, v));
        if (value !== this._step) {
            this._step = value;
            this.emit('changed', value);
        }
        return this.setValue(0, 'Value', value, 'SInt');
    }
    setProperty(name, value) {
        assert.strictEqual(name, 'Enabled');
        this.enabled = value === 1;
        this.enabledSeen.add(this.enabled);
        return Promise.resolve();
    }
    /* A drop-down as it shows: its header and its chosen item. */
    shown() {
        return `${this.cells.HeaderText}: ${this.cells[`${this.cells.SelectedItem}:ItemText`]}`;
    }
    /* A press, as the HMI makes it: a checkbox ticks or unticks itself first. */
    press() {
        if (this.desc.type === 'checkBox') {
            this.selected = !this.selected;
            this.ticks.push(this.selected);
        }
        this.emit('action');
    }
    /* An item of the drop-down picked; the slider turned a step (Increase 4, Decrease 5). */
    pick(row) { this.emit('action', { row }); }
    turn(dir) { this.emit('action', { row: 0, subType: dir > 0 ? 4 : 5 }); }
    setEnabled(enabled) { this.enabled = enabled; this.enabledSeen.add(enabled); return Promise.resolve(); }
    setVisible(visible) { this.visible = visible; shownOrHidden.add(this.desc.name); return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}

const shownOrHidden = new Set();
const byName = {};
Object.entries(UI.containers).forEach(([cid, cont]) => {
    byName[cont.name] = new FakeComponent(cid, cont);
    Object.entries(cont.components).forEach(([id, desc]) => {
        byName[desc.name] = new FakeComponent(id, desc);
    });
});
const rhmi = new EventEmitter();
rhmi.getByName = (name) => byName[name] || null;
rhmi.mapEntryState = () => Promise.resolve();
rhmi.openEntryState = () => Promise.resolve();
rhmi.opened = [];
rhmi.openState = (name) => { rhmi.opened.push(name); return Promise.resolve(); };
rhmi.flush = () => Promise.resolve();
rhmi.handles = new Set();
rhmi.getResourceBundle = () => ({
    createResourceHandles: (files) => { files.forEach((f) => rhmi.handles.add(f)); return Promise.resolve(); },
    destroyResourceHandles: (files) => { files.forEach((f) => rhmi.handles.delete(f)); return Promise.resolve(); }
});

/* ---- fake SDK ----------------------------------------------------------------- */

const logs = [];
let inactiveReports = 0;
let activeReports = 0;
const hmiVisibilityReports = [];
const logger = {};
['error', 'warn', 'info', 'verbose', 'debug'].forEach((level) => {
    logger[level] = (msg) => logs.push(`${level}: ${msg}`);
});

class OnlineApp extends EventEmitter {
    constructor() {
        super();
        this._packageJson = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
        this.appDescription = APP_JSON;
        this.rhmiApplication = rhmi;
        this.startReason = 'ENTRY_POINT';
        OnlineApp.instance = this;
        this._initialized = false;
        this._appStatusService = null;
        const description = APP_JSON.application.entryPoints[0];
        this._entryPoints = [{
            entryPoint: { setText: () => Promise.resolve(), setIcon: () => Promise.resolve() },
            getDescription: () => description,
            init: () => Promise.resolve(),
            setAvailability: () => Promise.resolve()
        }];
    }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    getAppId() { return 'robertn_waze_cluster'; }
    getEntryPoints() { return this._entryPoints; }
    getLastExecutedEntryPointUuid() { return null; }
    initialized() { this._initialized = true; this._appStatusService = {}; return Promise.resolve(); }
    registerActive() { activeReports++; return Promise.resolve(); }
    registerInactive() { inactiveReports++; return Promise.resolve(); }
    registerHmiVisible() { hmiVisibilityReports.push(true); return Promise.resolve(); }
    unregisterHmiVisible() { hmiVisibilityReports.push(false); return Promise.resolve(); }
    destroyBundles() { return Promise.resolve(); }
}

/* HMIContext: its display language, English at first; displayLanguage(v) is a change. */
const hmiContexts = [];
let displayLanguage = null;
let gpsPositionEvent = null;
let controllerEvent = null, controllerButton = 0;
const someipBuilders = {
    buildTypedProxy: (iface, instance) => Promise.resolve(iface === 'de.bmw.infotainment.SatellitePositioning' ? {
        init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
        updatePosition: { subscribe: (cb) => { assert.strictEqual(instance, '1'); gpsPositionEvent = cb; return Promise.resolve(); } }
    } : iface === 'de.bmw.infotainment.controlelements.FrontCCU' ? {
        init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
        statusRotaryEncoderState: {
            subscribe: (cb) => { assert.strictEqual(instance, '1'); controllerEvent=cb; return Promise.resolve(); },
            getValue: () => Promise.resolve({frontRotaryEncoderPushButton:controllerButton})
        }
    } : {
        init: () => Promise.resolve(),
        waitUntilAvailable: () => Promise.resolve(),
        currentDisplayLanguage: {
            subscribe: (cb) => { displayLanguage = cb; hmiContexts.push(`${iface} ${instance}`); return Promise.resolve(); },
            getValue: () => Promise.resolve('ENGLISCH__UK')
        }
    })
};

const FAKE_MODULES = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/someip/someipBuilders': someipBuilders,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => logger }
};

/* Loads the app's entry module (mgu-app.json's first) with the SDK's names
 * answered by the fakes, as the unit's link of the source package would. */
function runSource() {
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        return FAKE_MODULES[request] || load.call(this, request, parent, isMain);
    };
    require(path.join(__dirname, '..', MANIFEST.modules[0]));
}

/* ---- scenario ----------------------------------------------------------------- */

async function main() {
    const components = UI.containers['1'].components;
    const matches = (text, pattern) => { const found=[];let match;while((match=pattern.exec(text)))found.push(match);return found; };
    const xmlIds = (cid) => matches(XML.split('<container id="').find((c) => c.startsWith(`${cid}"`)),
        /<component id="(\d+)" type="(\w+)"(?: widget="(\w+)")?/g).map((m) => [m[1], m[2], m[3]]);
    /* application.xml orders the rows; uiDescription holds them by id */
    const shipped = (d) => (d.type === 'dropDownMenu' ? `${d.cells.HeaderText.value}: ${d.rows[d.cells.SelectedItem.value].ItemText.value}`
        : d.type === 'slider' ? d.rows[0].TextDescription.value : d.rows[0].Text.value);
    const main = xmlIds('1').filter(([id]) => !['wocCameras', 'wocHudOpacity'].includes(components[id].name)).map(([id]) => [id, components[id].type, components[id].name, shipped(components[id])]);
    assert.deepStrictEqual(main.map(([id, type, name, text]) => (type === 'title' ? name : `${name} ${text}`)), [
        'wocTitle',
        'wocHeadGeneral General', 'wocShowOn Show on: Cluster', 'wocMap Cluster map: Off', "wocGuide Hide BMW's turn box", 'wocLogs Logs',
        'wocHeadHud HUD', 'wocHud HUD map: \u2014', 'wocHudSize Size: \u2014', 'wocHudPos Position: \u2014', 'wocHudLeft Move left',
        'wocHudRight Move right', 'wocHudUp Move up', 'wocHudDown Move down', 'wocHudCentre Centre',
        'wocHeadCarPlay CarPlay', 'wocStatus Status: Connecting…', 'wocEnable Patch', 'wocDisable Remove patch', 'wocWifi ', 'wocWifiHint ',
        'wocHeadAa Android Auto', 'wocAaStatus Status: Connecting…', 'wocAaEnable Patch', 'wocAaDisable Remove patch',
        'wocAaZoom Zoom: —', 'wocAaZoomOut Zoom out', 'wocAaZoomIn Zoom in', "wocAaCard Hide phone's turn card",
        'wocRestart Restart head unit', 'wocRestartStatus '],
        'the main page: four sections, in order');
    assert.deepStrictEqual(xmlIds('1').map(([id, type]) => `${id} ${type}`).sort(),
        Object.entries(components).map(([id, d]) => `${id} ${d.type}`).sort(), 'application.xml and uiDescription agree on the main page');
    const widgets = {};
    xmlIds('1').forEach(([id, , widget]) => { widgets[components[id].name] = widget; });
    assert.deepStrictEqual(['wocHeadGeneral', 'wocHeadHud', 'wocHeadCarPlay', 'wocHeadAa'].map((n) => widgets[n]), Array(4).fill('LT_Label_Header_1Row'),
        'the section headers are header rows');
    /* application.xml's property 3: 0 a row the controller passes over, 3 one it stops on */
    const focus = {};
    matches(XML.split('<container id="2"')[0], /<component id="(\d+)"[^>]*>\s*<property id="2" value="\d"\/>\s*<property id="3" value="(\d)"\/>/g)
        .forEach((m) => { focus[components[m[1]].name] = m[2]; });
    assert.deepStrictEqual(['wocHeadGeneral', 'wocHeadHud', 'wocHeadCarPlay', 'wocHeadAa'].map((n) => [focus[n], components[Object.keys(components)
        .find((id) => components[id].name === n)].properties.Focusable.value]), Array(4).fill(['0', 0]), 'the section headers take no focus');
    assert.strictEqual(main.find(([, , name]) => focus[name] === '3')[2], 'wocShowOn', 'the first row the controller stops on: Show on');
    assert(!main.some(([, , name]) => /^wocRow|^wocSetup|^wocCapture/.test(name)), 'no log rows, setup line or capture on the main page');
    assert.deepStrictEqual(['wocAaCard', 'wocGuide'].map((n) => widgets[n]), Array(2).fill('LT_CheckBox_1Row'),
        'the on/off settings are checkboxes');
    assert.deepStrictEqual([widgets.wocShowOn, widgets.wocHudSize], ['LT_DropDownMenu_1Row_2Col3070', 'LT_Slider_LeftJustified_Fill_Steps'],
        'where the map shows: a drop-down of three; the HUD\'s size: a slider');
    assert.deepStrictEqual(components['62'].rows.map((r) => r.ItemText.value), ['Cluster', 'HUD (experimental)', 'Cluster and HUD (experimental)']);
    assert.deepStrictEqual(['MinValue', 'MaxValue', 'NumberOfSteps'].map((k) => components['52'].rows[0][k].value), [0, HUD_SIZE_STEPS, HUD_SIZE_STEPS],
        'the slider: one step for each 5 %');
    /* every info row reads "Name: Value" */
    assert(main.filter(([, type, name]) => type === 'label' && !/^wocHead|^(wocRestartStatus|wocWifi|wocWifiHint)$/.test(name))
        .every(([, , , text]) => /^[A-Z][A-Za-z ]+: [A-Z\u2014]/.test(text)), 'info rows as Name: Value');
    const hidden = Object.values(components).filter((d) => d.properties.Visible.value !== 1).map((d) => d.name);
    assert.deepStrictEqual(hidden, ['wocWifi', 'wocWifiHint', 'wocRestart', 'wocRestartStatus'],
        'every row ships shown but CarPlay Wi-Fi, its line and the restart\'s two');
    assert(/<component id="34" type="button" widget="LT_Button_1Row">\s*<property id="2" value="0"\/>/.test(XML), 'application.xml: the restart, hidden');
    ['29', '30'].forEach((id) => assert(new RegExp(`<component id="${id}" type="label" widget="LT_Label_1Row">\\s*<property id="2" value="0"\\/>\\s*` +
        '<property id="3" value="0"\\/>').test(XML), `application.xml: ${components[id].name}, hidden and unfocusable`));
    console.log('ok   the main page: General, HUD, CarPlay and Android Auto under unfocusable header rows, Show on the first stop; no log rows; ' +
        'CarPlay Wi-Fi and its line CarPlay\'s last, the restart\'s rows the page\'s last, all four hidden');
    const logsPage = UI.containers['2'];
    assert.strictEqual(logsPage.name, 'ST_OnlineApps_WazeClusterLogs');
    assert.deepStrictEqual(logsPage.properties.ParentState, { value: 1, type: 'UInt' }, 'the Logs page is a child of the main page');
    assert(/<container id="2" type="state" widget="LT_State_Wide">\s*<property id="9" value="1"\/>/.test(XML));
    assert.deepStrictEqual(xmlIds('2').map(([id, type]) => `${id} ${type}`).sort(),
        Object.entries(logsPage.components).map(([id, d]) => `${id} ${d.type}`).sort(), 'application.xml and uiDescription agree on the Logs page');
    assert.deepStrictEqual(xmlIds('2').map(([id]) => logsPage.components[id].name), ['wocLogsTitle', 'wocCapture', 'wocCaptureStatus',
        'wocLogsSave', 'wocLogsStatus', 'wocLogsQr', 'wocLogsUrl', 'wocLogsRow1', 'wocLogsRow2', 'wocLogsRow3', 'wocLogsRow4', 'wocLogsRow5']);
    assert(/<component id="83" type="label" widget="LT_Label_1Graphic_Scalable">/.test(XML), 'the QR code is a graphic');
    assert.strictEqual(APP_JSON.application.entryPoints.length, 1);
    assert.deepStrictEqual(xmlIds('2').slice(1).map(([id]) => logsPage.components[id].rows[0].Text && logsPage.components[id].rows[0].Text.value)
        .slice(0, 4), ['Start capture', 'Capture: Unavailable', 'Save logs', 'Saved logs: Connecting…']);
    console.log('ok   the Logs page: Start capture and its row, Save logs and its row, QR code, address, five archives; a child of the main page');

    const cameraPage=UI.containers['3'], cameraRows=xmlIds('3'), cameraXml=XML.split('<container id="3"')[1].split('<container id="4"')[0];
    assert.deepStrictEqual(cameraRows.map(([id,type])=>`${id} ${type}`).sort(),
        Object.entries(cameraPage.components).map(([id,d])=>`${id} ${d.type}`).sort(),'camera XML and JSON agree');
    const calibrationNames=['cameraHeadCalibration','cameraCardTarget','cameraTestStart','cameraTestStop','cameraCardStatus','cameraCardPosition',
        'cameraCardX','cameraCardY',
        'cameraCardUp','cameraCardDown','cameraCardLeft','cameraCardRight','cameraCardScale','cameraCardBrightness','cameraCardTransparency',
        'cameraCardSave','cameraCardReset','cameraCardHint','cameraCardStorage'];
    const cameraOrder=cameraRows.map(([id])=>cameraPage.components[id].name), calibrationAt=cameraOrder.indexOf('cameraHeadCalibration');
    assert.deepStrictEqual(cameraOrder.slice(calibrationAt,calibrationAt+calibrationNames.length),calibrationNames);
    const prefsAt=cameraOrder.indexOf('cameraPreferencesHead');
    assert.strictEqual(cameraOrder[prefsAt-1],'cameraHud','warning preferences follow output toggles on the first camera page');
    const overspeedAt=cameraOrder.indexOf('cameraOverspeedHead');
    assert.deepStrictEqual(cameraOrder.slice(prefsAt,overspeedAt),['cameraPreferencesHead','cameraWarningDistance','cameraPreferencesStatus']
        .concat(require('../src/view_model.js').ALERT_TYPES.map(type=>'cameraType_'+type.key),['cameraPreferencesHint']));
    assert.deepStrictEqual(cameraOrder.slice(overspeedAt,calibrationAt),['cameraOverspeedHead','cameraOverspeedRecommended','cameraOverspeedStatus',
        'cameraVisualFlash','cameraVisualOffset','cameraSoundEnabled','cameraSoundOffset','cameraAudioStatus','cameraOverspeedHint','cameraGpsReset','cameraGpsResetHint']);
    calibrationNames.forEach(name=>{
        const id=Object.keys(cameraPage.components).find(key=>cameraPage.components[key].name===name),d=cameraPage.components[id],focus=name==='cameraHeadCalibration'?0:3;
        assert.strictEqual(d.properties.Focusable.value,focus);
        assert(new RegExp('<component id="'+id+'"[^>]*><property id="2" value="1"/><property id="3" value="'+focus+'"/>').test(cameraXml));
    });
    [['360',15,5],['361',18,18],['362',18,0]].forEach(([id,steps,value])=>{
        const row=cameraPage.components[id].rows[0];
        assert.deepStrictEqual([row.MinValue.value,row.MaxValue.value,row.NumberOfSteps.value,row.Value.value],[0,steps,steps,value]);
    });
    [['367',100],['368',164]].forEach(([id,value])=>{
        const row=cameraPage.components[id].rows[0];
        assert.deepStrictEqual([row.MinValue.value,row.MaxValue.value,row.NumberOfSteps.value,row.Value.value],[0,200,200,value]);
    });
    console.log('ok   first camera page contains target, pinned test, position, controller arrows and independent size/brightness/transparency sliders');

    const diagnosticPage = UI.containers['4'];
    const diagnosticRows = xmlIds('4');
    assert.deepStrictEqual(diagnosticRows.map(([id, type]) => `${id} ${type}`).sort(),
        Object.entries(diagnosticPage.components).map(([id, d]) => `${id} ${d.type}`).sort(),
        'application.xml and uiDescription agree on every diagnostic component');
    const diagnosticXml = XML.split('<container id="4"')[1];
    const diagnosticFocus = {};
    matches(diagnosticXml, /<component id="(\d+)"[^>]*>\s*<property id="2" value="\d"\/>\s*<property id="3" value="(\d)"\/>/g)
        .forEach((m) => { diagnosticFocus[m[1]] = Number(m[2]); });
    const diagnosticNames = DIAGNOSTIC_KEYS.map((key) => `cameraDiag_${key}`).sort();
    assert.deepStrictEqual(Object.values(diagnosticPage.components).filter((d) => /^cameraDiag_/.test(d.name)).map((d) => d.name).sort(),
        diagnosticNames, 'every diagnostic source row has an HMI component');
    Object.entries(diagnosticPage.components).forEach(([id, d]) => {
        if (!/^cameraDiag_|^cameraDiagHead_/.test(d.name)) return;
        const expected = /^cameraDiagHead_/.test(d.name) ? 0 : 3;
        assert.strictEqual(d.properties.Focusable.value, expected, `${d.name}: JSON controller focus`);
        assert.strictEqual(diagnosticFocus[id], expected, `${d.name}: XML controller focus`);
    });
    const controllerStops = diagnosticRows.filter(([id]) => diagnosticFocus[id] === 3)
        .map(([id]) => diagnosticPage.components[id].name);
    assert.deepStrictEqual(controllerStops.filter((name) => /^cameraDiag_/.test(name)).sort(), diagnosticNames,
        'the controller can stop on every diagnostic data row, including all rows below GPS');
    assert.deepStrictEqual(diagnosticRows.slice(0,9).map(([id]) => diagnosticPage.components[id].name),
        ['cameraDiagTitle','cameraDiag_page','cameraDiag_stamp','cameraDiag_versions','cameraDiag_command','cameraDiag_commandMore',
            'cameraDiagResultMore','cameraDiagFreeze','cameraDiagLive'],
        'page, snapshot identity and live command result precede report data');
    const uniqueRhmiIds = matches(XML, /<(?:container|layoutGroup|component) id="(\d+)"/g).map((m) => m[1]);
    assert.strictEqual(uniqueRhmiIds.length, new Set(uniqueRhmiIds).size, 'RHMI ids stay globally unique');
    assert(!byName.cameraDisable, 'one warning toggle replaces opposite enable/disable controls');
    console.log('ok   paged diagnostic data and command results are controller stops; snapshot identity remains above data');
    const reportView=require('../src/diagnostics_view');
    const reportState={serviceVersion:'test-service',observedAtMs:Date.now(),gpsFix:{lat:54.5,lon:36.2,accuracyM:19.4,speedKmh:0,timeMs:Date.now()},
        rendererDetails:{connection:'ready',versionReported:false,backend:'mapped',protocol:'cluster-render',map:{state:'visible',layout:{backend:'mapped',canvas:{width:1088,height:480},
            card:{x:700,y:340,width:280,height:96,scale:.875},withinBounds:true,profile:'compact',safeArea:{known:false}}},
            hud:{state:'отказ',reason:'TARGET_NOT_AVAILABLE',layout:{canvas:null,card:null,safeArea:{known:false}}}},
        cardLayout:{hud:{x:500,y:820,scalePct:125,brightnessPct:40,opacityPct:30},map:{x:450,y:880,scalePct:100,brightnessPct:95,opacityPct:100}},
        database:{sha256:'a'.repeat(64),source:'OpenStreetMap'},actions:{displayTest:{allowed:true}},
        databaseUpdate:{phase:'recovered-from-previous',recovery:{source:'previous',reasonCode:'LOCAL_DATA_JSON',
            originalVersion:'2026.1.3',recoveredVersion:'2026.1.2'},durability:{mode:'rename',directorySynced:false,reasonCode:'DIRECTORY_FSYNC_UNAVAILABLE'}},
        error:'Подробная причина '.repeat(12)};
    const full=reportView.capture(reportState,'test-app',1000), allPages=[];
    for(let p=0;p<6;p++){
        const first=reportView.reportPage(full,reportState,'ignored-version',p,0);
        let contents='';
        for(let b=0;b<first.blocks;b++){
            const v=reportView.reportPage(full,reportState,'ignored-version',p,b);
            assert(v.rows.page.includes((p+1)+'/6'));
            assert.strictEqual(v.rows.stamp,first.rows.stamp);
            assert.strictEqual(v.rows.versions,'Приложение test-app • сервис test-service');
            for(let i=1;i<=10;i++){assert(v.rows['row'+i].length<=66);contents+=v.rows['row'+i]+'\n';}
        }
        allPages.push(contents);
    }
    assert(allPages[4].includes('1088×480')&&allPages[4].includes('масштаб 0.875'));
    assert(allPages[4].includes('hud: неизвестно×неизвестно')&&allPages[4].includes('не подтверждена'));
    assert(allPages[4].replace(/\n/g,' ').includes('HUD профиль: X/Y 500/820 • размер 125 % • яркость 40 % • прозрачность 70 %'));
    assert(allPages[3].includes('TARGET_NOT_AVAILABLE'));
    assert(allPages[3].replace(/\n/g,' ').includes('версия renderer не сообщается протоколом'));
    assert(allPages[3].includes('Соединение renderer: ready'));
    assert(allPages[5].includes('Восстановление базы: previous')&&allPages[5].includes('LOCAL_DATA_JSON'));
    assert(allPages[5].includes('До восстановления: 2026.1.3')&&allPages[5].includes('загружена 2026.1.2'));
    assert(allPages[5].includes('DIRECTORY_FSYNC_UNAVAILABLE')&&allPages[5].includes('не синхронизирован'));
    const knownRenderer=reportView.reportPage(null,{rendererDetails:{connection:'disconnected',version:'1.2.3',versionReported:true}},'test',3,0);
    assert(Object.keys(knownRenderer.rows).map(k=>knownRenderer.rows[k]).join(' ').includes('Renderer: версия 1.2.3'));
    assert(Object.keys(knownRenderer.rows).map(k=>knownRenderer.rows[k]).join(' ').includes('Соединение renderer: disconnected'));
    const longResult='Завершено: '+Array.from({length:45},(_,i)=>'часть'+i).join(' ')+' ОКОНЧАТЕЛЬНАЯ ПРИЧИНА';
    const resultStart=reportView.commandPage(null,longResult,0), resultLines=[];
    for(let b=0;b<resultStart.blocks;b++){
        const v=reportView.reportPage(full,reportState,'ignored-version',0,0,longResult,b);
        resultLines.push(v.rows.command,v.rows.commandMore.trim());
    }
    assert.strictEqual(resultLines.filter(Boolean).join(' '),longResult,'all final-result text survives independent paging');
    assert(allPages[0].split('Подробная причина').length>10,'long reason stays accessible in successive blocks');
    reportState.gpsFix.lat=1;
    assert.strictEqual(full.state.gpsFix.lat,54.5,'snapshot is isolated from live changes');
    console.log('ok   all six report pages preserve identity, wrap every field, show runtime geometry and keep unknown values honest');

    const render = new FakeRender(RSOCK);
    let patch = new FakePatch(PSOCK);
    await render.listen();
    await patch.listen();
    await new Promise((resolve) => cameraServer.listen(CSOCK, resolve));
    patch.res = SIZE;
    patch.safe = SAFE;
    patch.announce('patched', 'high', null);
    render.stream(true);
    await until('fake showing', () => render.state === 'showing');

    try {
        process.exit = (code) => { throw new Error(`process.exit(${code})`); };
        runSource();
        const status = byName.wocStatus;
        await until('page shows the map', () => byName.wocMap.text === `Cluster map: Showing ${RENDER_PAGE} — ${RENDER_FPS}` && status.text === 'Status: Patched');
        assert(!logs.some((l) => /^error/.test(l)), logs.filter((l) => /^error/.test(l)).join('\n'));
        const bound = logs.filter((l) => l.startsWith('info: BIND OK: ')).map((l) => l.split(' ')[3]).filter((name) => !/^camera|^wocCameras$/.test(name)).sort();
        assert.deepStrictEqual(bound, ['wocAaCard', 'wocAaDisable', 'wocAaEnable', 'wocAaZoomIn', 'wocAaZoomOut', 'wocCapture', 'wocDisable', 'wocEnable',
            'wocGuide', 'wocHudCentre', 'wocHudDown', 'wocHudLeft', 'wocHudRight', 'wocHudUp', 'wocLogs', 'wocLogsSave', 'wocRestart'],
            'bound buttons and checkbox');
        assert.strictEqual(byName.wocRestart.visible, false, 'restart button hidden while the map shows');
        console.log('ok   a page opened while the map is up shows it');
        await until('confirmed camera service opacity', () => byName.wocHudOpacity.enabled === true && byName.wocHudOpacity.cells['0:Value'] === 0);
        byName.wocHudOpacity.turn(1);
        await until('real opacity command', () => cameraCommands.some((m) => m.cmd === 'hud-opacity' && m.percent === 95));
        await until('unconfirmed slider returns', () => byName.wocHudOpacity.cells['0:Value'] === 0);
        cameraState.hudOpacityPct = 95; cameraReply();
        await until('service confirms opacity', () => byName.wocHudOpacity.cells['0:Value'] === 1);
        assert.strictEqual(cameraCommands.filter((m) => m.cmd === 'hud-opacity').length, 1);
        await until('BMW GPS subscription ready', () => !!gpsPositionEvent && cameraPeers.size === 2);
        const inactiveAtHide = inactiveReports;
        OnlineApp.instance.emit('changeVisibility', { visible: false });
        await until('hidden UI sockets closed, GPS client remains', () => cameraPeers.size === 1 && patch._clients.size === 0);
        await until('HMI reports hidden', () => hmiVisibilityReports[hmiVisibilityReports.length - 1] === false);
        assert.strictEqual(inactiveReports, inactiveAtHide, 'GPS work keeps activity while HMI is hidden');
        assert(activeReports > 0);
        gpsPositionEvent({ nmeaString: '$GNRMC,120000.00,A,5400.000,N,03600.000,E,1,90,061126,,,A*00\r\n' });
        await until('GPS still forwards while using another screen', () => cameraCommands.some((m) => m.cmd === 'vehicle-nmea'));
        cameraState.enabled = false; cameraReply();
        await until('disabled warnings release hidden activity hold', () => inactiveReports === inactiveAtHide + 1);
        OnlineApp.instance.emit('entryPointExecute', APP_JSON.application.entryPoints[0].uuid);
        await until('reopened original map controls', () => patch._clients.size === 1 && cameraPeers.size === 2);
        cameraState.enabled = true; cameraReply();
        console.log('ok   GPS continues over separate IPC while UI hidden; HMI invisible but activity held; disabling warnings releases hold; tile reopens');
        byName.wocCameras.emit('action');
        await until('camera child page opens', () => rhmi.opened.includes('ST_OnlineApps_WazeStrelkaCameras'));
        byName.ST_OnlineApps_WazeStrelkaCameras.emit('visible', { visible: true });
        await until('camera database shown', () => byName.cameraDatabase.text.includes('150'));
        await until('single toggle follows confirmed enabled state',()=>byName.cameraEnable.text==='Выключить предупреждения');
        byName.cameraEnable.emit('action');
        await until('camera disable command', () => cameraCommands.some((m) => m.cmd === 'disable'));
        cameraState.observedAtMs = Date.UTC(2026,10,6,13,3,0);
        cameraState.serviceVersion = '0.3.1';
        cameraState.capabilities.displayTest = true;
        cameraState.outputs = {cluster:true,hud:true};
        cameraState.gpsFix = {lat:54.51758,lon:36.24867,timeMs:cameraState.observedAtMs,speedKmh:0,headingDeg:15,accuracyM:5,source:'bmw-nmea'};
        cameraState.gpsInput = {nmeaTiming: {rmcTime:'160300.250',ggaTime:'160300.000',gstTime:'160300.000',
            rmcGgaDeltaMs:-250,ggaGstDeltaMs:0,pairReason:'READY',lastRmcAgeMs:110,lastGgaAgeMs:200,lastGstAgeMs:200}};
        cameraState.nearest = {id:'osm:node:11980400006',title:'Светофор и скорость',description:'Спектр-Поток CCR0047',distanceM:30};
        cameraReply();
        {
        const lastCommand=(name,after)=>cameraCommands.slice(after||0).filter(m=>m.cmd===name).slice(-1)[0];
        let calibrationResultId=100;
        const confirmCommand=(command,message)=>{
            cameraState.commandResult={id:++calibrationResultId,requestId:command.requestId,command:command.cmd,phase:'finished',message};
            ['hud','map'].forEach(target=>{cameraState.rendererDetails[target].layout.settings=Object.assign({},cameraState.cardLayout[target]);});
            cameraReply();
        };
        cameraState.rendererDetails={connection:'ready',hud:{state:'visible',layout:{canvas:{width:640,height:240},withinBounds:true,settings:Object.assign({},cameraState.cardLayout.hud)}},
            map:{state:'visible',layout:{canvas:{width:1088,height:480},withinBounds:true,settings:Object.assign({},cameraState.cardLayout.map)}}};
        cameraReply();
        await until('camera calibration uses HUD profile',()=>byName.cameraCardTarget.shown()==='Настраивать: HUD'&&byName.cameraCardScale.cells['0:Value']===5&&
            OnlineApp.instance._cameras.state.outputs.hud===true);
        assert.strictEqual(byName.cameraCardUp.enabled,false,'moving a notification requires an active preview');
        let before=cameraCommands.length;
        byName.cameraTestStart.emit('action');
        await until('HUD pinned preview request',()=>!!lastCommand('display-test',before));
        let command=lastCommand('display-test',before);assert.strictEqual(command.target,'hud');
        cameraState.displayTest={active:true,pinned:true,target:'hud',untilMs:0};confirmCommand(command,'Тест закреплён на HUD до завершения');
        await until('HUD preview confirmed',()=>byName.cameraCardStatus.text.includes('HUD • закреплён')&&byName.cameraCardUp.enabled===true);
        before=cameraCommands.length;byName.cameraCardScale.turn(1);
        await until('notification scale request',()=>!!lastCommand('card-layout',before));
        command=lastCommand('card-layout',before);assert.strictEqual(command.target,'hud');assert.strictEqual(command.scalePct,105);
        await until('unconfirmed notification scale returns',()=>byName.cameraCardScale.cells['0:Value']===5);
        cameraState.cardLayout.hud.scalePct=105;confirmCommand(command,'Размер сохранён');
        await until('confirmed notification scale',()=>byName.cameraCardScale.cells['0:Value']===6);
        before=cameraCommands.length;byName.cameraCardBrightness.turn(-1);
        await until('notification brightness request',()=>!!lastCommand('card-layout',before));
        command=lastCommand('card-layout',before);assert.strictEqual(command.brightnessPct,95);assert.strictEqual(command.target,'hud');
        cameraState.cardLayout.hud.brightnessPct=95;confirmCommand(command,'Яркость сохранена');
        await until('confirmed notification brightness',()=>byName.cameraCardBrightness.cells['0:Value']===17);
        before=cameraCommands.length;byName.cameraCardTransparency.turn(1);
        await until('notification transparency request',()=>!!lastCommand('card-layout',before));
        command=lastCommand('card-layout',before);assert.strictEqual(command.opacityPct,95);assert.strictEqual(command.target,'hud');
        cameraState.cardLayout.hud.opacityPct=95;confirmCommand(command,'Прозрачность сохранена');
        await until('confirmed notification transparency',()=>byName.cameraCardTransparency.cells['0:Value']===1);
        assert.strictEqual(cameraState.hudOpacityPct,95,'notification appearance does not change original HUD map opacity');
        assert.deepStrictEqual(cameraState.cardLayout.map,{x:500,y:880,scalePct:100,brightnessPct:100,opacityPct:100});
        before=cameraCommands.length;byName.cameraCardTarget.pick(1);
        await until('active preview moves only to selected cluster target',()=>!!lastCommand('display-test',before));
        command=lastCommand('display-test',before);assert.strictEqual(command.target,'map');
        cameraState.displayTest.target='map';confirmCommand(command,'Тест закреплён на приборах');
        await until('cluster profile independently selected',()=>byName.cameraCardTarget.shown()==='Настраивать: Приборы'&&
            byName.cameraCardScale.cells['0:Value']===5&&byName.cameraCardBrightness.cells['0:Value']===18&&byName.cameraCardTransparency.cells['0:Value']===0&&
            byName.cameraCardLeft.enabled===true);
        byName.cameraCardLeft.emit('focus',{value:true});
        await until('neutral before short click',()=>!!controllerEvent&&!OnlineApp.instance._holdBridge.status().requiresNewPress);
        before=cameraCommands.length;byName.cameraCardLeft.emit('action');
        await until('selected notification movement request',()=>!!lastCommand('card-move',before));
        command=lastCommand('card-move',before);assert.strictEqual(command.target,'map');assert.strictEqual(command.direction,'left');
        cameraState.cardLayout.map.x=490;confirmCommand(command,'Положение сохранено');
        await until('confirmed notification position',()=>byName.cameraCardPosition.text.includes('X 49.0 %'));
        before=cameraCommands.length;byName.cameraCardX.setStepValue(130);
        await until('touch horizontal position request',()=>!!lastCommand('card-layout',before));
        command=lastCommand('card-layout',before);assert.strictEqual(command.target,'map');assert.strictEqual(command.x,650);
        cameraState.cardLayout.map.x=650;confirmCommand(command,'Положение X сохранено');
        await until('horizontal position confirmed',()=>byName.cameraCardX.cells['0:Value']===130);
        before=cameraCommands.length;byName.cameraCardY.setStepValue(100);
        await until('touch vertical position request',()=>!!lastCommand('card-layout',before));
        command=lastCommand('card-layout',before);assert.strictEqual(command.target,'map');assert.strictEqual(command.y,500);
        cameraState.cardLayout.map.y=500;confirmCommand(command,'Положение Y сохранено');
        await until('vertical position confirmed',()=>byName.cameraCardY.cells['0:Value']===100);
        assert.strictEqual(cameraState.cardLayout.hud.x,500,'touch sliders only affect the selected profile');
        // Sliders are touch-operated in this scenario; the actual controller
        // focus must remain on Left after an ordinary Click on the same row.
        byName.cameraCardLeft.emit('focus',{value:true});
        await until('controller has a neutral baseline',()=>!!controllerEvent&&!OnlineApp.instance._holdBridge.status().requiresNewPress);
        before=cameraCommands.length;OnlineApp.instance._lastPress={};byName.cameraCardLeft.emit('action');
        await until('short click on focused arrow',()=>!!lastCommand('card-move',before));
        command=lastCommand('card-move',before);confirmCommand(command,'Положение сохранено');
        assert.strictEqual(OnlineApp.instance._cameraFocusedArrow,'left','a short click must not discard actual controller focus');
        before=cameraCommands.length;controllerButton=2;controllerEvent({frontRotaryEncoderPushButton:2});
        await until('held controller sends first move',()=>!!lastCommand('card-move',before));
        command=lastCommand('card-move',before);
        await sleep(220);
        assert.strictEqual(cameraCommands.slice(before).filter(m=>m.cmd==='card-move').length,1,'hold waits for one terminal acknowledgement');
        cameraState.cardLayout.map.x=640;confirmCommand(command,'Положение сохранено');
        await until('held controller sends second move',()=>cameraCommands.slice(before).filter(m=>m.cmd==='card-move').length===2);
        command=lastCommand('card-move',before);controllerButton=0;controllerEvent({frontRotaryEncoderPushButton:0});
        cameraState.cardLayout.map.x=630;confirmCommand(command,'Положение сохранено');
        const releasedCount=cameraCommands.slice(before).filter(m=>m.cmd==='card-move').length;
        OnlineApp.instance._lastPress={};byName.cameraCardLeft.emit('action',{subType:0});
        await sleep(260);
        assert.strictEqual(cameraCommands.slice(before).filter(m=>m.cmd==='card-move').length,releasedCount,'release cancels repeats and suppresses its trailing Click');
        byName.cameraCardLeft.emit('focus',{value:false});
        assert.strictEqual(OnlineApp.instance._moveRepeater.status().active,false);
        assert.strictEqual(OnlineApp.instance._cameraDiagnosticState().calibrationInput.touchHoldConfirmed,false);
        assert.strictEqual(OnlineApp.instance._cameraDiagnosticState().calibrationInput.events.slice(-1)[0].data.subType,0);
        byName.cameraCardRight.emit('focus',{value:true});
        await until('new direction re-arms after neutral',()=>!OnlineApp.instance._holdBridge.status().requiresNewPress);
        before=cameraCommands.length;controllerButton=2;controllerEvent({frontRotaryEncoderPushButton:2});
        await until('new held direction moves',()=>!!lastCommand('card-move',before));
        command=lastCommand('card-move',before);
        OnlineApp.instance._lastPress={};byName.cameraCardUp.emit('action');
        assert.strictEqual(OnlineApp.instance._moveRepeater.status().active,false,'manual opposite arrow stops the old hold');
        await sleep(200);
        assert.strictEqual(cameraCommands.slice(before).filter(m=>m.cmd==='card-move').length,1,'another arrow cannot overwrite an in-flight move');
        cameraState.cardLayout.map.x=640;confirmCommand(command,'Положение сохранено');
        controllerButton=0;controllerEvent({frontRotaryEncoderPushButton:0});
        byName.cameraCardDown.emit('focus',{focus:true});
        await until('neutral after new focus',()=>!OnlineApp.instance._holdBridge.status().requiresNewPress);
        before=cameraCommands.length;controllerButton=2;controllerEvent({frontRotaryEncoderPushButton:2});
        await until('held move before overlay',()=>!!lastCommand('card-move',before));
        command=lastCommand('card-move',before);
        byName.ST_OnlineApps_WazeStrelkaCameras.emit('focus',{focus:false});
        assert.strictEqual(OnlineApp.instance._moveRepeater.status().active,false,'overlay focus loss stops without a visibility event');
        cameraState.cardLayout.map.y=510;confirmCommand(command,'Положение сохранено');
        controllerButton=0;controllerEvent({frontRotaryEncoderPushButton:0});
        await sleep(200);
        assert.strictEqual(cameraCommands.slice(before).filter(m=>m.cmd==='card-move').length,1,'overlay cannot resume a cancelled hold');
        before=cameraCommands.length;
        byName.cameraCardTarget.pick(0);byName.cameraCardTarget.pick(1);byName.cameraCardTarget.pick(0);
        await until('rapid target selection follows final row',()=>cameraCommands.slice(before).filter(m=>m.cmd==='display-test').length===3);
        assert.strictEqual(OnlineApp.instance._cameraCardTarget,'hud');assert.strictEqual(byName.cameraCardTarget.cells.SelectedItem,0);
        command=lastCommand('display-test',before);cameraState.displayTest.target='hud';confirmCommand(command,'Тест закреплён на HUD');
        cameraState.outputs.hud=false;cameraReply();await sleep(20);
        before=cameraCommands.length;OnlineApp.instance._lastPress={};byName.cameraCardTarget.pick(0);
        await until('disabled selected output stops old preview',()=>!!lastCommand('display-test-stop',before));
        command=lastCommand('display-test-stop',before);cameraState.displayTest.active=false;confirmCommand(command,'Тест скрыт; настройки сохранены');
        await until('disabled output explains next action',()=>byName.cameraCardStatus.text.includes('HUD выключена'));
        assert(!cameraCommands.slice(before).some(m=>m.cmd==='display-test'),'selecting a disabled output does not preview or silently enable it');
        cameraState.outputs.hud=true;cameraState.actions.cardLayout={allowed:false,reason:'Настройка только на стоянке'};
        cameraState.actions.cardMove={allowed:false,reason:'Настройка только на стоянке'};cameraReply();
        await until('motion guard disables calibration sliders',()=>byName.cameraCardScale.enabled===false&&byName.cameraCardStorage.text.includes('на стоянке'));
        assert.strictEqual(byName.cameraTestStop.enabled,true,'stop remains reachable when motion invalidates adjustment');
        before=cameraCommands.length;byName.cameraCardSave.emit('action');
        await until('finish requests native save and stop',()=>!!lastCommand('display-test-stop',before));
        command=lastCommand('display-test-stop',before);
        assert(!OnlineApp.instance._cameraFeedback.message.includes('сохранены'),'save never claims persistence before native confirmation');
        cameraState.storage.settingsSaved=true;confirmCommand(command,'Тест скрыт; настройки сохранены');
        await until('save confirms native persistence',()=>OnlineApp.instance._cameraFeedback.message.includes('настройки сохранены'));
        cameraState.actions.cardLayout={allowed:true};cameraState.actions.cardMove={allowed:true};cameraReply();
        await until('stationary calibration controls return',()=>byName.cameraCardScale.enabled===true&&byName.cameraCardStorage.text.includes('сохранены в автомобиле'));
        before=cameraCommands.length;byName.cameraCardReset.emit('action');
        await until('reset applies to selected target only',()=>!!lastCommand('card-layout-reset',before));
        command=lastCommand('card-layout-reset',before);assert.strictEqual(command.target,'hud');
        cameraState.cardLayout.hud={x:500,y:820,scalePct:100,brightnessPct:100,opacityPct:100};confirmCommand(command,'Настройки HUD сброшены');
        await until('HUD default profile confirmed',()=>byName.cameraCardScale.cells['0:Value']===5&&byName.cameraCardBrightness.cells['0:Value']===18);
        assert.strictEqual(cameraState.cardLayout.map.x,640,'resetting HUD does not reset the cluster profile');
        console.log('ok   first-page pinned preview targets, confirmed sliders, independent profiles, native movement, safe stop/save/reset and disabled-output switching');
        }
        byName.cameraDiagnostics.emit('action');
        await until('dedicated diagnostics opens', () => rhmi.opened.includes('ST_OnlineApps_WazeStrelkaDiagnostics'));
        byName.ST_OnlineApps_WazeStrelkaCameras.emit('visible',{visible:false});
        byName.ST_OnlineApps_WazeStrelkaDiagnostics.emit('visible',{visible:true});
        const reportRows=()=>Array.from({length:10},(_,i)=>byName['cameraDiag_row'+(i+1)].text).join('\n');
        await until('summary reports accepted GPS',()=>reportRows().includes('позиция принята')&&reportRows().includes('READY'));
        byName.cameraDiagFreeze.emit('action');
        await until('snapshot frozen',()=>byName.cameraDiag_stamp.text.startsWith('Снимок S'));
        const stamp=byName.cameraDiag_stamp.text;
        byName.cameraDiagNext.emit('action');
        await until('GPS page opens',()=>byName.cameraDiag_page.text.startsWith('GPS 2/6'));
        assert(reportRows().includes('54.517580'));
        const frozenRows = reportRows();
        cameraState.observedAtMs+=5000;cameraState.gpsFix.lat=54.518;
        Object.assign(cameraState.gpsInput.nmeaTiming, {rmcTime:'160305.250',ggaTime:'160305.350',gstTime:'160305.400',
            rmcGgaDeltaMs:100,ggaGstDeltaMs:50,pairReason:'RMC_GGA_OFFSET',lastRmcAgeMs:15,lastGgaAgeMs:10,lastGstAgeMs:5});
        cameraReply();await sleep(60);
        assert.strictEqual(reportRows(),frozenRows,'frozen GPS page keeps old data');
        assert.strictEqual(byName.cameraDiag_stamp.text,stamp);
        cameraState.commandResult={id:'test-frozen',command:'display-test',phase:'finished',message:'Приборы: тест запрошен; HUD: отказ',timeMs:Date.now()};
        byName.cameraDiagTest.emit('action');
        await until('parked display test sent',()=>cameraCommands.some(m=>m.cmd==='display-test'));
        cameraState.commandResult.id='test-frozen-done';cameraReply();
        cameraState.commandResult.requestId=OnlineApp.instance._cameraPending.requestId;cameraReply();
        await until('live command result despite frozen report',()=>byName.cameraDiag_command.text.includes('HUD: отказ'));
        assert.strictEqual(byName.cameraDiag_stamp.text,stamp,'test does not discard frozen snapshot');
        assert.strictEqual(reportRows(),frozenRows);
        // Intermediate ACKs retain the original six-second terminal watchdog.
        const app=OnlineApp.instance, realSetTimeout=global.setTimeout;
        let deadline=null;
        global.setTimeout=(fn,ms)=>{
            if(ms===6000){deadline={fn,ms};return realSetTimeout(fn,60000);}
            return realSetTimeout(fn,ms);
        };
        try {app._cameraCommand({cmd:'database-check'});} finally {global.setTimeout=realSetTimeout;}
        const waiting=app._cameraPending, watchdog=app._cameraCommandTimer;
        assert.strictEqual(deadline.ms,6000);
        cameraState.commandResult={id:41,command:'database-check',phase:'finished',message:'Без requestId'};
        app._cameras.state=cameraState;app._refreshCameraFeedback();
        assert.strictEqual(app._cameraPending,waiting,'legacy numeric IDs cannot ambiguously satisfy a correlated request');
        cameraState.commandResult={id:42,requestId:waiting.requestId,command:'database-check',phase:'requested',message:'Проверка принята'};
        app._cameras.state=cameraState;app._refreshCameraFeedback();app._renderCameras();
        assert.strictEqual(app._cameraCommandTimer,watchdog,'requested ACK never clears the terminal watchdog');
        assert.strictEqual(app._cameraPending,waiting);
        clearTimeout(watchdog);deadline.fn();
        assert(app._cameraFeedback.awaiting&&app._cameraFeedback.message.includes('Нет окончательного подтверждения'));
        // Two equal command names remain separate requests, even if an old completion/error arrives late.
        app._cameraCommand({cmd:'database-check'});const firstId=app._cameraPending.requestId;
        app._cameraCommand({cmd:'database-check'});const secondId=app._cameraPending.requestId;
        assert.notStrictEqual(firstId,secondId);assert(/^[A-Za-z0-9._-]{1,64}$/.test(secondId));
        cameraState.commandResult={id:43,requestId:firstId,command:'database-check',phase:'finished',message:'СТАРАЯ КОМАНДА'};
        app._cameras.state=cameraState;app._refreshCameraFeedback();
        assert.strictEqual(app._cameraPending.requestId,secondId);
        cameraPeers.forEach(s=>s.write(JSON.stringify({ev:'error',requestId:firstId,error:'Чужая ошибка'})+'\n'));
        await until('transport preserves error correlation',()=>app._cameras.commandErrorRequestId===firstId);
        assert.strictEqual(app._cameraPending.requestId,secondId,'an error for an older request cannot finish the latest one');
        assert(app._cameraCommandTimer,'other-client errors leave terminal watchdog active');
        cameraState.commandResult={id:44,requestId:secondId,command:'database-check',phase:'finished',message:longResult};
        cameraReply();await until('exact terminal result',()=>!app._cameraPending&&app._cameraFeedback.message===longResult);
        assert.strictEqual(app._cameraCommandTimer,null);
        const mainResult=[],diagResult=[],guiBlocks=app._cameraResultView().blocks;
        for(let b=0;b<guiBlocks;b++){
            app._lastPress={};
            mainResult.push(byName.cameraCommand.text,byName.cameraCommandMore.text.trim());
            diagResult.push(byName.cameraDiag_command.text,byName.cameraDiag_commandMore.text.trim());
            assert(byName.cameraResultMore.text.includes('строки')&&byName.cameraDiagResultMore.text.includes('строки'));
            (b%2?byName.cameraDiagResultMore:byName.cameraResultMore).emit('action');
        }
        assert.strictEqual(mainResult.filter(Boolean).join(' '),longResult,'main controller paging exposes every result character');
        assert.strictEqual(diagResult.filter(Boolean).join(' '),longResult,'diagnostic controller paging exposes every result character');
        assert.strictEqual(byName.cameraDiag_stamp.text,stamp,'result paging preserves frozen report identity');
        assert.strictEqual(reportRows(),frozenRows);
        cameraState.commandResult={id:45,requestId:firstId,command:'database-check',phase:'finished',message:'СТАРАЯ КОМАНДА'};
        cameraReply();await sleep(30);
        assert.strictEqual(app._cameraFeedback.message,longResult,'late old completion cannot replace the displayed terminal result');
        // A matching transport error is terminal; uncorrelated legacy errors stay diagnostic only.
        app._cameraCommand({cmd:'database-check'});const errorId=app._cameraPending.requestId;
        cameraPeers.forEach(s=>s.write(JSON.stringify({ev:'error',error:'Без ID'})+'\n'));
        await until('legacy error received',()=>app._cameras.commandError==='Без ID');
        assert(app._cameraPending&&app._cameraCommandTimer);
        cameraPeers.forEach(s=>s.write(JSON.stringify({ev:'error',requestId:errorId,error:'Ошибка текущей команды'})+'\n'));
        await until('matching transport error ends current command',()=>!app._cameraPending);
        assert(app._cameraFeedback.message.includes('Ошибка текущей команды'));assert.strictEqual(app._cameraCommandTimer,null);
        console.log('ok   requested ACK retains six-second watchdog; exact request IDs reject stale completions/errors; both controller pages read complete long results');
        byName.cameraDiagAudio.emit('action');
        await until('audio denial visible beside command',()=>byName.cameraDiag_command.text.includes('Нет проверенного аудиоканала'));
        assert(!cameraCommands.some(m=>m.cmd==='audio-test'),'unavailable action is explained without sending an unsupported request');
        byName.cameraDiagExport.emit('action');
        await until('explicit local JSON export',()=>!!OnlineApp.instance._lastDiagnosticExport);
        const exportFile=OnlineApp.instance._lastDiagnosticExport;
        const exported=JSON.parse(fs.readFileSync(exportFile,'utf8'));
        assert.strictEqual(exported.state.gpsFix.lat,54.51758,'export is the exact frozen report, not a later live state');
        fs.unlinkSync(exportFile);
        byName.cameraDiagMore.emit('action');
        await until('second GPS block',()=>byName.cameraDiag_page.text.includes('строки 11'));
        assert(frozenRows.includes('(GGA − RMC): -250 мс'));
        assert(reportRows().includes('(GST − GGA): 0 мс')&&reportRows().includes('READY'),reportRows());
        byName.cameraDiagLive.emit('action');
        await until('live diagnostics resumes',()=>reportRows().includes('54.518000'));
        assert(byName.cameraDiag_stamp.text.startsWith('Живые '));
        byName.cameraUpdate.emit('action');
        await until('real database check request',()=>cameraCommands.some(m=>m.cmd==='database-check'));
        byName.cameraDiagCalibration.emit('action');
        await until('real calibration request',()=>cameraCommands.some(m=>m.cmd==='calibration-test'));
        byName.ST_OnlineApps_WazeStrelkaDiagnostics.emit('visible',{visible:false});
        console.log('ok   six-page diagnostics, frozen JSON report, live command results, exact action guards, database check and calibration');
        byName.ST_OnlineApps_WazeStrelkaCameras.emit('visible', { visible: false });
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: true });
        cameraPeers.forEach((s) => s.destroy());
        await new Promise((resolve) => cameraServer.close(resolve));
        await until('camera unavailable disables only its slider', () => byName.wocHudOpacity.enabled === false);
        assert.strictEqual(status.text, 'Status: Patched');
        assert(byName.wocMap.text.startsWith('Cluster map: Showing'));
        console.log('ok   real camera socket, child page and opacity command; only confirmed state shown; camera outage leaves original map controls usable');

        await until('patched: CarPlay\'s Remove patch button enabled, CarPlay\'s Patch button greyed', () => byName.wocDisable.enabled === true &&
            byName.wocEnable.enabled === false);
        // Real RHMI raw actions carry only a component id, independent of page.
        assert.strictEqual(OnlineApp.instance._actionById[32].name, 'wocEnable');
        assert.strictEqual(OnlineApp.instance._actionById[35].name, 'wocGuide');
        rhmi.emit('userEvent', { eventType: 'ACTION', sourceId: byName.wocDisable.getId() });
        await until('reverted', () => patch.count('revert') === 1 && !patch.busy && patch.state === 'original');
        await until('original: CarPlay\'s Patch button enabled, CarPlay\'s Remove patch button greyed', () => byName.wocEnable.enabled === true &&
            byName.wocDisable.enabled === false);
        ['wocEnable', 'wocCapture'].forEach((name) => byName[name].emit('action'));
        await until('apply and capture sent', () => patch.count('apply') === 1 && patch.count('capture-start') === 1 && !patch.busy);
        assert.deepStrictEqual(render.received, [], 'no command to the render');
        console.log('ok   CarPlay\'s Remove patch button enabled while patched, CarPlay\'s Patch button while not; presses go to the patch daemon, none to the render');

        /* Android Auto next to CarPlay: its line, Patch, then Remove patch, the zoom and the card. */
        const aaRow = () => ['wocAaEnable', 'wocAaDisable', 'wocAaZoomOut', 'wocAaZoomIn', 'wocAaCard'].map((n) => byName[n].enabled);
        await until('Android Auto off, Patch enabled', () => byName.wocAaStatus.text === 'Status: Not patched' &&
            JSON.stringify(aaRow()) === JSON.stringify([true, false, false, false, false]) && byName.wocAaZoom.text === 'Zoom: —' &&
            byName.wocAaCard.text === "Hide phone's turn card" && byName.wocAaCard.selected === false);
        byName.wocAaEnable.emit('action');
        await until('Android Auto on', () => byName.wocAaStatus.text === 'Status: Patched' &&
            JSON.stringify(aaRow()) === JSON.stringify([false, true, true, true, true]));
        byName.wocAaZoomOut.emit('action');
        await until('zoomed out', () => patch.received.some((m) => m.cmd === 'aa-density' && m.value === 170) &&
            byName.wocAaZoom.text === 'Zoom: 170 dpi');
        assert(status.text !== '' && !/Android Auto/.test(status.text), 'CarPlay\'s line is its own');
        await until('the card shown', () => byName.wocAaCard.enabled === true && byName.wocAaCard.selected === false);
        const card = byName.wocAaCard;
        card.ticks.length = 0;
        card.press();
        await until('card hidden', () => patch.received.some((m) => m.cmd === 'aa-card' && m.value === 'hidden') &&
            patch.aa.state === 'patched' && patch.aa.diskCard === 'hidden' && card.selected === true &&
            card.text === "Hide phone's turn card");
        await sleep(100);
        assert(card.ticks.every((t) => t === true), `ticked from the press on, never unticked meanwhile: ${JSON.stringify(card.ticks)}`);
        patch.aa = Object.assign({}, patch.aa, { state: 'unknown', pending: 'apply', aapd: 'deferred', dpi: 160, density: 160, runDpi: 170, runCard: 'shown' });
        patch.announce('patched', 'high', null);
        await until('waiting for a restart', () => byName.wocAaZoom.text === 'Zoom: 160 dpi (after restart)' &&
            byName.wocAaCard.text === "Hide phone's turn card (after restart)" && byName.wocAaCard.selected === true &&
            byName.wocAaStatus.text === 'Status: Patched after restart' && byName.wocRestart.visible === true);
        patch.aa = { state: 'original', density: 160, densities: [150, 400, 10], conflict: 'not supported on this car (KI_KOMBI_VARIANT 9)' };
        patch.announce('patched', 'high', null);
        await until('not supported', () => byName.wocAaStatus.text === 'Status: Not supported on this car' &&
            JSON.stringify(aaRow()) === JSON.stringify([false, false, false, false, false]) && byName.wocRestart.visible === false);
        patch.aa = { state: 'patched', dpi: 160, density: 160, densities: [150, 400, 10] };
        patch.announce('patched', 'high', null);
        console.log('ok   Android Auto: its own line, Patch, Remove patch, the zoom and the Hide phone\'s turn card checkbox with their values, marked while waiting; ' +
            'not supported on this car: every button greyed');

        const guide = byName.wocGuide;
        await until('the switch enabled, ticked', () => guide.enabled === true && guide.selected === true);
        guide.press();
        await until('unticked by the render', () => render.hide === 0 && guide.selected === false);
        assert.deepStrictEqual(render.received, [{ cmd: 'guide', hide: 0 }], 'one guide command');
        await sleep(450);
        guide.press();
        await until('ticked again', () => render.hide === 1 && guide.selected === true);
        assert.deepStrictEqual(render.received[1], { cmd: 'guide', hide: 1 });
        render.received.length = 0;
        console.log('ok   Hide BMW\'s turn box: ticked as the render says, each press flips it through the render');

        render.guideDisabled = 1;
        render.announce(render.state, render.reason);
        await until('unavailable', () => guide.enabled === false && guide.selected === false &&
            guide.text === "Hide BMW's turn box");
        await sleep(450);
        guide.press();
        await sleep(100);
        assert.deepStrictEqual(render.received, [], 'no command while unavailable');
        render.guideDisabled = 0;
        render.announce(render.state, render.reason);
        await until('available again', () => guide.enabled === true && guide.selected === true &&
            guide.text === "Hide BMW's turn box");
        console.log('ok   held off by the cluster renderer: greyed and unticked, its label kept, presses send nothing');

        /* ---- where the map shows, and the HUD ---- */
        const showOn = byName.wocShowOn;
        const size = byName.wocHudSize;
        const hudRows = () => ['wocHudSize', 'wocHudLeft', 'wocHudRight', 'wocHudUp', 'wocHudDown'].map((n) => byName[n].enabled);
        await until('the cluster, the HUD off', () => showOn.shown() === 'Show on: Cluster' && showOn.enabled === true &&
            byName.wocHud.text === 'HUD map: Off' && size.text === 'Size: Standard' && size.cells['0:Value'] === 5 &&
            byName.wocHudPos.text === 'Position: Centre');
        assert(hudRows().every((e) => e === false) && byName.wocHudCentre.enabled === false, 'the size and position greyed while off');
        render.received.length = 0;
        size.turn(1);
        await until('a greyed slider turned: back where it was', () => size.cells['0:Value'] === 5);
        assert.deepStrictEqual(render.received, [], 'nothing sent');
        showOn.pick(1);
        await until('the HUD alone', () => render.hud === 1 && render.cluster === 0 && showOn.shown() === 'Show on: HUD (experimental)' &&
            byName.wocHud.text === 'HUD map: Showing' && byName.wocMap.text === 'Cluster map: Off' && byName.wocGuide.enabled === false);
        await until('the size and position enabled', () => hudRows().every((e) => e === true));
        assert.deepStrictEqual(render.received, [{ cmd: 'hud', on: '1' }, { cmd: 'cluster', on: '0' }], 'the HUD on, then the cluster off');
        await until('saved', () => patch.count('hud') === 1 && patch.count('cluster') === 1);
        size.turn(1);
        await until('larger', () => size.text === 'Size: 60 %' && render.hudWidth === 60 && size.cells['0:Value'] === 6);
        await until('saved', () => patch.received.some((m) => m.cmd === 'hud-size' && m.hud_width_pct === 60));
        size.turn(-1);
        size.turn(-1);
        await until('smaller', () => size.text === 'Size: 50 %' && render.hudWidth === 50);
        byName.wocHudLeft.emit('action');
        await until('moved', () => byName.wocHudPos.text === 'Position: 10 px left' && byName.wocHudCentre.enabled === true);
        await sleep(450);
        showOn.pick(2);
        await until('both', () => render.cluster === 1 && showOn.shown() === 'Show on: Cluster and HUD (experimental)' &&
            byName.wocGuide.enabled === true);
        render.hudState = 'disabled';
        render.announce(render.state, render.reason);
        await until('disabled after errors', () => byName.wocHud.text === 'HUD map: Disabled after errors' &&
            showOn.shown() === 'Show on: Cluster and HUD (experimental)' && hudRows().every((e) => e === false) && byName.wocHudCentre.enabled === false);
        render.hudState = null;
        await sleep(450);
        render.received.length = 0;
        showOn.pick(2);
        await sleep(100);
        assert.deepStrictEqual(render.received, [], 'the choice it has: nothing sent');
        await sleep(450);
        showOn.pick(0);
        await until('the cluster again', () => render.hud === 0 && showOn.shown() === 'Show on: Cluster' && byName.wocHud.text === 'HUD map: Off');
        render.received.length = 0;
        /* the render on neither (its own configuration): no choice shown, one to make */
        render.cluster = 0;
        render.announce(render.state, render.reason);
        await until('neither', () => showOn.shown() === 'Show on: —' && showOn.enabled === true &&
            showOn.cells['1:ItemText'] === 'HUD (experimental)');
        await sleep(450);
        showOn.pick(0);
        await until('the cluster', () => render.cluster === 1 && showOn.shown() === 'Show on: Cluster');
        render.received.length = 0;
        console.log('ok   where the map shows: a drop-down, Cluster by default, each choice through the render and patchd, the HUD on first, ' +
            '— for neither; the HUD: off by default with its size and position greyed; the size slider and Position change it; ' +
            'Disabled after errors greys them');

        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: false });
        await until('sockets closed', () => render._clients.size === 0 && patch._clients.size === 0);
        console.log('ok   hiding the page closes both sockets');

        render.stream(false);
        patch.announce('patched', 'high', null);
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: true });
        await until('page reads the current state', () => status.text === 'Status: Patched' && byName.wocMap.text === 'Cluster map: Waiting for the phone');
        console.log('ok   a page opened again reads the render\'s current state');

        /* The patch the install wrote, from the daemon: its line, Patch and
         * Remove patch greyed, the restart offered. */
        patch.pending = 'apply';
        patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
        await until('pending on screen', () => status.text === 'Status: Patched after restart' && byName.wocMap.text === 'Cluster map: Waiting for the phone' &&
            byName.wocEnable.enabled === false && byName.wocDisable.enabled === false &&
            byName.wocRestart.visible === true && byName.wocRestart.enabled === true);
        console.log('ok   a pending patch from the daemon: its line, Patch and Remove patch greyed, the restart offered');

        /* Before the head-unit start that starts the daemon: from the marker. */
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: false });
        await until('closed', () => patch._clients.size === 0);
        await patch.close();
        fs.writeFileSync(PENDING, JSON.stringify({ action: 'apply' }) + '\n');
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: true });
        await until('pending from the marker', () => status.text === 'Status: Patched after restart' &&
            byName.wocEnable.enabled === false && byName.wocDisable.enabled === false && byName.wocRestart.visible === false &&
            byName.wocAaStatus.text === 'Status: Unavailable');
        console.log('ok   installed, the daemon not yet running: the marker\'s pending patch, every button greyed');

        /* The daemon up with the pending patch: the restart press reboots once. */
        patch = new FakePatch(PSOCK);
        await patch.listen();
        patch.pending = 'apply';
        patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
        await until('restart offered', () => byName.wocRestart.visible === true && byName.wocRestart.enabled === true &&
            byName.wocRestartStatus.visible === false);
        /* NSM does not take it: the reason on the restart's line, CarPlay's line as it was */
        patch.rebootFails = 'refused';
        byName.wocRestart.emit('action');
        await until('failed on screen', () => byName.wocRestartStatus.text === 'Restart: Failed, not accepted' &&
            byName.wocRestartStatus.visible === true && status.text === 'Status: Patched after restart' && byName.wocRestart.enabled === true);
        console.log('ok   a failed restart: its reason on the restart\'s own line, CarPlay\'s line unchanged, the button back');
        patch.rebootFails = null;
        await sleep(450);
        byName.wocRestart.emit('action');
        await until('rebooted once more', () => patch.reboots === 2);
        await until('restarting on screen', () => byName.wocRestartStatus.text === 'Restart: In progress' && byName.wocRestart.enabled === false &&
            status.text === 'Status: Patched after restart');
        await sleep(450);
        byName.wocRestart.emit('action');
        await sleep(100);
        assert.strictEqual(patch.count('reboot'), 2, 'a greyed button pressed sends nothing');
        console.log('ok   pressing the restart button restarts the unit once; pressed again while greyed, nothing');

        /* CarPlay's Wi-Fi band: its row while patchd knows it, the line under
         * it on 2.4 GHz only, neither without patchd. */
        const wifi = byName.wocWifi, hint = byName.wocWifiHint;
        assert.deepStrictEqual([wifi.visible, hint.visible], [false, false], 'no band: neither row');
        patch.setWifi({ band: '5', iface: 'p2p-wlan0-0', freq: 5785 });
        await until('5 GHz', () => wifi.visible === true && wifi.text === 'CarPlay Wi-Fi: 5 GHz' && hint.visible === false);
        assert(/^[A-Z][A-Za-z -]+: [0-9]/.test(wifi.text), 'CarPlay Wi-Fi as Name: Value');
        patch.setWifi({ band: '2.4', iface: 'p2p-wlan0-1', freq: 2462 });
        await until('2.4 GHz', () => wifi.text === 'CarPlay Wi-Fi: 2.4 GHz' && wifi.visible === true && hint.visible === true &&
            hint.text === 'Audio may cut out. On your iPhone, turn Wi-Fi off and on.');
        patch.setWifi({ band: '6', iface: 'p2p-wlan0-1', freq: 5955 });
        await until('a band the app does not know', () => wifi.visible === false && hint.visible === false);
        patch.setWifi({ band: '2.4', iface: 'p2p-wlan0-1', freq: 2462 });
        await until('2.4 GHz again', () => wifi.visible === true && hint.visible === true);
        patch.setWifi(null);
        await until('unknown', () => wifi.visible === false && hint.visible === false);
        console.log('ok   CarPlay Wi-Fi: 5 GHz alone, 2.4 GHz with the line under it; neither while the band is unknown');

        /* Through every state above, no row came or went but CarPlay Wi-Fi,
         * its line and the restart's, and each button was greyed and enabled
         * in place. */
        assert.deepStrictEqual([...shownOrHidden].sort(), ['wocRestart', 'wocRestartStatus', 'wocWifi', 'wocWifiHint'],
            'only CarPlay Wi-Fi, its line and the restart\'s rows are shown and hidden');
        Object.values(components).filter((d) => !/^(wocRestart|wocWifi)/.test(d.name) && d.type !== 'title')
            .forEach((d) => assert.strictEqual(byName[d.name].visible, true, `${d.name} stays on the page`));
        ['wocEnable', 'wocDisable', 'wocAaEnable', 'wocAaDisable', 'wocAaZoomOut', 'wocAaZoomIn', 'wocAaCard', 'wocGuide', 'wocShowOn', 'wocHudSize',
            'wocHudLeft', 'wocHudCentre']
            .forEach((n) => assert.deepStrictEqual([...byName[n].enabledSeen].sort(), [false, true], `${n} greyed and enabled in place`));
        const valueRow = /^[A-Z][A-Za-z ]+: [A-Z0-9\u2014]/;
        ['wocStatus', 'wocAaStatus', 'wocAaZoom', 'wocMap', 'wocHud', 'wocHudSize', 'wocHudPos', 'wocRestartStatus']
            .forEach((n) => assert(valueRow.test(byName[n].text), `${n}: "${byName[n].text}" as Name: Value`));
        console.log('ok   no row came or went but CarPlay Wi-Fi, its line and the restart\'s; the buttons were greyed and enabled in place; ' +
            'info rows as Name: Value');

        /* ---- the Logs page ---- */
        const lserver = new FakeLogs(LSOCK);
        await lserver.listen();
        const main = byName.ST_OnlineApps_WazeCluster;
        const logsState = byName.ST_OnlineApps_WazeClusterLogs;
        await until('the Logs button', () => byName.wocLogs.visible === true);
        byName.wocLogs.emit('action');
        await until('Logs opened', () => rhmi.opened.indexOf('ST_OnlineApps_WazeClusterLogs') >= 0);
        await until('capture on the Logs page', () => byName.wocCapture.text === 'Start capture' &&
            byName.wocCaptureStatus.text === 'Capture: Unavailable');
        const inactiveBefore = inactiveReports;
        main.emit('visible', { visible: false });
        await sleep(100);
        logsState.emit('visible', { visible: true });
        await until('logs socket open', () => lserver._clients.size === 1);
        await sleep(900);
        assert.strictEqual(inactiveReports, inactiveBefore, 'moving to the Logs page keeps the app shown');
        assert.strictEqual(patch._clients.size, 1, 'and its sockets open');
        await until('logs state shown', () => byName.wocLogsStatus.text === 'Saved logs: None' &&
            byName.wocLogsUrl.text === `Address: ${lserver.url}` && byName.wocLogsSave.enabled === true);
        const qr1 = byName.wocLogsQr.text;
        assert(qr1 && rhmi.handles.has(qr1), 'the QR code shown through a resource handle');
        assert.deepStrictEqual(fs.readFileSync(qr1).slice(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if (process.platform !== 'win32') assert.strictEqual(fs.statSync(qr1).mode & 0o777, 0o644, 'the HMI reads it');
        console.log('ok   Logs opens the Logs page; the app stays shown; the page shows the address and its QR code');

        byName.wocLogsSave.emit('action');
        ['wocCaptureStatus', 'wocLogsStatus', 'wocLogsUrl'].forEach((n) => assert(/^[A-Z][a-z ]+: [A-Z0-9h]/.test(byName[n].text), byName[n].text));
        await until('saved', () => byName.wocLogsStatus.text === 'Saved logs: 1' &&
            /^woc-logs-\d{8}T\d{6}Z\.tar\.gz · 412 KB$/.test(byName.wocLogsRow1.text));
        assert.strictEqual(lserver.count('save'), 1);
        assert.strictEqual(byName.wocLogsRow2.text, '');
        console.log('ok   Save logs saves once and lists the archive');

        lserver.url = 'http://172.16.222.97:8475/fedcba9876543210fedcba9876543210/';
        lserver.announce();
        await until('a new QR code', () => byName.wocLogsUrl.text === `Address: ${lserver.url}` && byName.wocLogsQr.text !== qr1);
        await until('the old one gone', () => !fs.existsSync(qr1) && !rhmi.handles.has(qr1));
        lserver.url = null;
        lserver.announce();
        await until('no address', () => byName.wocLogsUrl.text === 'Address: Wi-Fi hotspot off');
        const blank = byName.wocLogsQr.text;
        await until('blank code', () => rhmi.handles.has(blank) && fs.existsSync(blank));
        console.log('ok   a new address gets a new QR code, the old one removed; no address: a blank one');

        /* an overlay takes the screen (ROOT_APP gone) and gives it back; the
         * Logs page says nothing of its own */
        lserver.url = 'http://172.16.222.97:8475/0123456789abcdef0123456789abcdef/';
        lserver.announce();
        rhmi.emit('applicationStackChanged', { OVERLAY: 1 });
        await until('hidden: logs socket closed', () => lserver._clients.size === 0);
        rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
        await until('back: logs socket open', () => lserver._clients.size === 1 && byName.wocLogsUrl.text === `Address: ${lserver.url}` &&
            byName.wocLogsStatus.text !== 'Saved logs: Connecting…');
        console.log('ok   back from an overlay on the Logs page, the logs socket opens again');

        logsState.emit('visible', { visible: false });
        main.emit('visible', { visible: true });
        await until('logs socket closed', () => lserver._clients.size === 0);
        rhmi.emit('applicationStackChanged', { OVERLAY: 1 });
        await sleep(50);
        rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
        await sleep(200);
        assert.strictEqual(lserver._clients.size, 0, 'back on the main page: no logs socket');

        /* left from the Logs page, launched again from the tile: the main
         * page, no logs socket (which would start the page server) */
        byName.wocLogs.emit('action');
        main.emit('visible', { visible: false });
        logsState.emit('visible', { visible: true });
        await until('on the Logs page', () => lserver._clients.size === 1);
        rhmi.emit('applicationStackChanged', { OTHER_APP: 1 });
        await until('left: logs socket closed', () => lserver._clients.size === 0);
        rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
        OnlineApp.instance.emit('entryPointExecute', APP_JSON.application.entryPoints[0].uuid);
        await sleep(400);
        assert.strictEqual(lserver._clients.size, 0, 'a tile launch opens no logs socket');
        assert.strictEqual(patch._clients.size, 1, 'the main page\'s sockets are open');
        console.log('ok   launched from the tile after leaving on the Logs page: the main page, no logs socket');
        assert.strictEqual(patch._clients.size, 1, 'the main page keeps its sockets');
        console.log('ok   leaving the Logs page closes the logs socket');

        /* the display language: every row in its words, English for a word it lacks */
        assert.deepStrictEqual(hmiContexts, ['de.bmw.infotainment.hmi.hmicontext.HMIContext HMI_CID'], 'HMIContext HMI_CID followed');
        const de = require('../src/locales.js').find((l) => l.code === 'de');
        const deWords = de.words;
        de.words = { Patch: 'Patchen', 'Remove patch': 'Patch entfernen', General: 'Allgemein', 'Save logs': 'Logs speichern',
            'Status: {0}': 'Zustand: {0}', 'Saved logs: {0}': 'Gespeicherte Logs: {0}', "Hide BMW's turn box": 'BMW-Abbiegebox ausblenden',
            'HUD map: {0}': 'Karte im HUD: {0}', 'Show on': 'Anzeigen auf', 'HUD (experimental)': 'HUD (experimentell)', 'Move left': 'Nach links' };
        const before = ['wocStatus', 'wocAaStatus', 'wocMap', 'wocLogsStatus', 'wocHud'].map((n) => byName[n].text);
        displayLanguage('DEUTSCH');
        await until('German', () => byName.wocEnable.text === 'Patchen' && byName.wocAaDisable.text === 'Patch entfernen' &&
            byName.wocHeadGeneral.text === 'Allgemein' && byName.wocLogsSave.text === 'Logs speichern' &&
            byName.wocGuide.text === 'BMW-Abbiegebox ausblenden' && byName.wocStatus.text === before[0].replace(/^Status:/, 'Zustand:') &&
            byName.wocAaStatus.text === before[1].replace(/^Status:/, 'Zustand:') && byName.wocLogsStatus.text.startsWith('Gespeicherte Logs: ') &&
            byName.wocHud.text === before[4].replace(/^HUD map:/, 'Karte im HUD:') && byName.wocShowOn.cells.HeaderText === 'Anzeigen auf' &&
            byName.wocShowOn.cells['1:ItemText'] === 'HUD (experimentell)' && byName.wocShowOn.cells['0:ItemText'] === 'Cluster' &&
            byName.wocHudLeft.text === 'Nach links');
        assert.strictEqual(byName.wocMap.text, before[2], 'a word German lacks: its English');
        assert.strictEqual(byName.wocAaZoomIn.text, 'Zoom in', 'a word German lacks: its English');
        displayLanguage('ENGLISCH__US');
        await until('English again', () => byName.wocEnable.text === 'Patch' && byName.wocHeadGeneral.text === 'General' &&
            byName.wocLogsSave.text === 'Save logs' && byName.wocGuide.text === "Hide BMW's turn box" && byName.wocStatus.text === before[0] &&
            byName.wocHud.text === before[4] && byName.wocHudLeft.text === 'Move left');
        de.words = deWords;
        console.log('ok   a display language change writes every row again in its words, English for a word it lacks');
        await lserver.close();
    } finally {
        await render.close();
        await patch.close();
        [RSOCK, PSOCK, PENDING, LSOCK].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* gone */ } });
    }
}

/* The app's sockets keep retrying, so the run ends here. */
main().then(() => {
    console.log('all passed');
    exit(0);
}, (err) => {
    console.log(`FAIL ${err && err.stack}`);
    exit(1);
});
