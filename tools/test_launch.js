// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Exercise the real launch code against a minimal iDrive SDK stand-in.
const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const events = [];
let resourceFailure = false;
const uuid = 'test-entry';
const components = {};
function component(name) {
    if (!components[name]) {
        const c = components[name] = new EventEmitter();
        c.updateResources = () => Promise.resolve();
        c.setValue = () => Promise.resolve();
        c.setEnabled = () => Promise.resolve();
    }
    return components[name];
}
const rhmi = new EventEmitter();
rhmi.getByName = component;
rhmi.mapEntryState = () => { events.push('map'); return Promise.resolve(); };
rhmi.openEntryState = () => { events.push('open'); return Promise.resolve(); };
const entry = {
    getDescription: () => ({ uuid, textId: 'title', icon: 'icon.png' }),
    init: () => Promise.resolve(),
    setAvailability: () => { events.push('enabled'); return Promise.resolve(); },
    entryPoint: {
        setText: () => resourceFailure ? Promise.reject(new Error('missing title')) : Promise.resolve(),
        setIcon: () => Promise.resolve()
    }
};
class FakeApp extends EventEmitter {
    constructor() { super(); FakeApp.instance = this; this.rhmiApplication = rhmi; this.startReason = 'ENTRY_POINT';
        this.appDescription = { application: { entryPoints: [{ uuid }] } }; this._initialized = false; }
    start() { return Promise.resolve(); }
    getEntryPoints() { return [entry]; }
    getLastExecutedEntryPointUuid() { return uuid; }
    registerActive() { events.push('active'); return Promise.resolve(); }
    initialized() { events.push('initialized'); this._initialized = true; return Promise.resolve(); }
}
class FakeControl extends EventEmitter { open() {} close() {} send() { return false; } diagnostic() { return 'not connected'; } }
const realLoad = Module._load;
Module._load = function (name, parent, isMain) {
    if (name === 'oap-sdk/src/core/OnlineApp.js') return FakeApp;
    if (name === 'oap-sdk/src/logging/logging') return { getSDKLogger: () => ({ warn() {}, error() {} }) };
    if (name === './control.js' && /kaluga_app\.js$/.test(parent.filename)) return { CameraControl: FakeControl };
    return realLoad.call(this, name, parent, isMain);
};
require('../apps/marku_kaluga_cameras/src/kaluga_app.js');
Module._load = realLoad;
(async () => {
    const app = FakeApp.instance;
    await app.appInitialized();
    assert(events.indexOf('active') < events.indexOf('initialized'), 'foreground active before initial status');
    assert(events.includes('enabled') && events.includes('open'), 'tile launch maps and opens entry');
    events.length = 0;
    resourceFailure = true;
    await app.appInitialized();
    assert(events.includes('enabled') && events.includes('open'), 'resource failure cannot block launch');
    console.log('PASS: foreground launch and missing-resource fallback');
})().catch((err) => { console.error(err); process.exitCode = 1; });
