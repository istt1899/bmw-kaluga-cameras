// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Exercises the actual entry source around an SDK initialization race. No car,
// SDK redistribution, native service or network is required.
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'robertn_waze_cluster.js'), 'utf8');

function create(hasRhmi) {
    let app, active = 0, inactive = 0, visible = 0, stopped = 0, exited = 0;
    class OnlineApp extends EventEmitter {
        constructor() {
            super(); app = this; this._packageJson = { version: 'test' };
            this.startReason = 'BACKGROUND'; this.rhmiApplication = hasRhmi ? {} : null;
            this._initialized = false; this._appStatusService = null;
        }
        start() { return Promise.resolve(); }
        getAppId() { return 'marku_kaluga_cameras'; }
        getLastExecutedEntryPointUuid() { return null; }
        initialized() { this._initialized = true; this._appStatusService = {}; return Promise.resolve(); }
        registerActive() { active++; return Promise.resolve(); }
        registerInactive() { inactive++; return Promise.resolve(); }
        registerHmiVisible() { visible++; return Promise.resolve(); }
        unregisterHmiVisible() { visible--; return Promise.resolve(); }
        destroyBundles() { return Promise.resolve(); }
    }
    class Control extends EventEmitter { close() {} }
    class GpsBridge extends EventEmitter {
        constructor() { super(); this.running = false; this.enabled = true; }
        start() { this.running = true; this.emit('change'); }
        shouldHold() { return this.running && this.enabled; }
        stop() { this.running = false; stopped++; this.emit('change'); }
    }
    const logger = {}; ['info', 'warn', 'error', 'debug'].forEach((name) => { logger[name] = () => {}; });
    const modules = {
        'oap-sdk/src/core/OnlineApp.js': OnlineApp,
        'oap-sdk/src/logging/logging': { getSDKLogger: () => logger },
        'oap-sdk/src/someip/someipBuilders': {},
        './i18n.js': { t: (key) => key },
        './waze_cluster_control.js': { WazeClusterControl: Control },
        './logs_control.js': { LogsControl: Control, ROWS: 5 },
        './qr.js': {}, './control.js': { CameraControl: Control }, './view_model.js': require('../src/view_model.js'),
        './bmw_gps_bridge.js': { BmwGpsBridge: GpsBridge },
        './bmw_navigation_bridge.js': {BmwNavigationBridge:class { start(){} stop(){} }},
        './diagnostics_view.js': require('../src/diagnostics_view.js')
    };
    vm.runInNewContext(source, {
        require: (name) => Object.prototype.hasOwnProperty.call(modules, name) ? modules[name] : require(name[0]==='.'?path.join(__dirname,'../src',name):name),
        process: { pid: process.pid, getuid: () => 0, exit: () => { exited++; } }, Buffer, setTimeout, clearTimeout
    }, { filename: 'robertn_waze_cluster.js' });
    // Yield one turn while RHMI initialization waits. GPS becomes ready while
    // _initialized is still false: its early change alone cannot report ACTIVE.
    app._setupRhmi = () => new Promise((resolve) => setImmediate(resolve));
    app._setupLanguage = () => Promise.resolve();
    app._registerEntryPoints = () => Promise.resolve();
    return { app, stats: () => ({ active, inactive, visible, stopped, exited }) };
}

(async () => {
    for (const hasRhmi of [true, false]) {
        const test = create(hasRhmi), app = test.app;
        await app._appInitialized();
        assert.strictEqual(app._visible, false, 'background initialization must not open a screen');
        assert.strictEqual(test.stats().active, 1, 'ready GPS reconciles ACTIVE after SDK initialization');
        assert.strictEqual(test.stats().inactive, 0);
        assert.strictEqual(test.stats().visible, 0, 'background GPS does not report HMI visible');
        app._gpsBridge.enabled = false; app._gpsBridge.emit('change');
        await Promise.resolve();
        assert.strictEqual(test.stats().inactive, 1, 'disabled warnings release background activity');
        app._gpsBridge.enabled = true; app._gpsBridge.emit('change');
        await Promise.resolve();
        assert.strictEqual(test.stats().active, 2);
        await app._handleShutdown('test');
        assert.strictEqual(test.stats().stopped, 1);
        assert.strictEqual(test.stats().exited, 1);
        assert.strictEqual(test.stats().inactive, 1, 'shutdown callback cannot report new activity');
    }
    console.log('PASS BMW GPS lifecycle: early-ready hidden initialization with and without RHMI, activity hold, disabled release, shutdown');
})().catch((error) => { console.error(error); process.exitCode = 1; });
