// SPDX-License-Identifier: GPL-3.0-or-later
// RHMI lifecycle adapted from the GPL-3.0-or-later Kimi strelka-hud project.
'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { CameraControl } = require('./control.js');
const { model, outputCommand, diagnostics } = require('./view_model.js');

const logger = logging.getSDKLogger();
const STATE_NAME = 'ST_OnlineApps_MarkuKalugaCameras';
const NAMES = ['cameraStatus', 'cameraAlert', 'cameraDatabase', 'cameraDate', 'cameraGps',
    'cameraEnable', 'cameraDisable', 'cameraCluster', 'cameraHud', 'cameraUpdate', 'cameraDiagnostics', 'cameraInfo'];

class KalugaCamerasApp extends OnlineApp {
    constructor() {
        super();
        this.components = {}; this.state = null; this.visible = false;
        this.reportedVisibility = null; this.sawForeground = false; this.written = {};
        this.shutdownPromise = null; this.infoMode = null;
        this.control = new CameraControl();
        this.control.on('change', () => this.render());
        this.on('initialized', () => this.appInitialized().catch((err) => logger.error('kaluga init: ' + err.message)));
        this.on('shutdown', () => this.handleShutdown());
        this.on('error', (err) => logger.warn('kaluga OAP: ' + err.message));
        this.on('entryPointExecute', (uuid) => this.openEntry(uuid));
        this.on('changeVisibility', (data) => { if (data && data.visible === false) this.setVisible(false); });
    }
    startedForeground() {
        const reasons = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        return reasons.indexOf((data && data.reason) || this.startReason) >= 0;
    }
    appInitialized() {
        if (!this.rhmiApplication) return this.initialized();
        const foreground = this.startedForeground();
        return this.setupRhmi().then(() => this.registerEntryPoint()).then(() => this.initialized()).then(() => {
            if (foreground || this.visible) { this.sawForeground = true; this.setVisible(true); }
            const uuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
            return uuid ? this.openEntry(uuid) : undefined;
        });
    }
    setupRhmi() {
        const rhmi = this.rhmiApplication;
        this.state = rhmi.getByName(STATE_NAME);
        if (!this.state) return Promise.reject(new Error('missing ' + STATE_NAME));
        NAMES.forEach((name) => { this.components[name] = rhmi.getByName(name); });
        const missing = NAMES.filter((name) => !this.components[name]);
        if (missing.length) return Promise.reject(new Error('missing components ' + missing.join(',')));
        this.components.cameraEnable.on('action', () => this.command({ cmd: 'enable' }));
        this.components.cameraDisable.on('action', () => this.command({ cmd: 'disable' }));
        this.components.cameraCluster.on('action', () => this.command(outputCommand(this.control.state, 'cluster')));
        this.components.cameraHud.on('action', () => this.command(outputCommand(this.control.state, 'hud')));
        this.components.cameraUpdate.on('action', () => { this.infoMode = this.infoMode === 'update' ? null : 'update'; this.render(); });
        this.components.cameraDiagnostics.on('action', () => {
            this.infoMode = this.infoMode === 'diagnostics' ? null : 'diagnostics';
            this.control.send({ cmd: 'status' }); this.render();
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) return;
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) { this.sawForeground = true; this.setVisible(true); }
            else if (this.sawForeground) this.setVisible(false);
        });
        rhmi.on('restoreHmi', () => { this.written = {}; this.render(); });
        this.state.on('visible', (ev) => {
            const value = ev && ev.visible;
            const visible = value === true || value === 'true' || value === 1 || value === '1';
            if (visible) this.sawForeground = true;
            this.setVisible(visible);
        });
        return Promise.resolve(this.state.updateResources()).then(() => this.render());
    }
    registerEntryPoint() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) return Promise.reject(new Error('no entry point'));
        const d = ours.getDescription();
        return ours.init().then(() => this.rhmiApplication.mapEntryState(d.uuid, this.state))
            .then(() => ours.entryPoint.setText(d.textId)).then(() => d.icon ? ours.entryPoint.setIcon(d.icon) : undefined)
            .then(() => ours.setAvailability('ENABLED'));
    }
    openEntry(uuid) {
        if (this.shutdownPromise || !this.rhmiApplication || !uuid) return Promise.resolve();
        this.sawForeground = true; this.setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid)).catch((err) => logger.warn('kaluga open: ' + err.message));
    }
    setVisible(visible) {
        if (this.shutdownPromise) return;
        this.visible = visible;
        if (visible) this.control.open(); else this.control.close();
        if (!this._initialized || !this._appStatusService || this.reportedVisibility === visible) return;
        this.reportedVisibility = visible;
        const reports = visible ? [this.registerActive(), this.registerHmiVisible()] : [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((p) => Promise.resolve(p).catch(() => {}));
    }
    command(message) {
        if (!message) return;
        this.infoMode = null;
        if (!this.control.send(message)) this.write('cameraInfo', 'Команда не отправлена: сервис недоступен');
    }
    write(name, text) {
        if (this.written[name] === text) return;
        this.written[name] = text;
        Promise.resolve(this.components[name].setValue(0, 'Text', text, 'Text')).catch(() => {});
    }
    enabled(name, value) {
        const key = 'enabled:' + name;
        if (this.written[key] === value) return;
        this.written[key] = value;
        Promise.resolve(this.components[name].setEnabled(value)).catch(() => {});
    }
    render() {
        if (!this.state || this.shutdownPromise) return;
        const view = model(this.control.state);
        if (this.infoMode === 'update') view.text.cameraInfo = 'База обновляется на ПК и устанавливается через Store новым пакетом';
        if (this.infoMode === 'diagnostics') view.text.cameraInfo = diagnostics(this.control.state);
        Object.keys(view.text).forEach((name) => this.write(name, view.text[name]));
        Object.keys(view.enabled).forEach((name) => this.enabled(name, view.enabled[name]));
    }
    handleShutdown() {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.control.close();
        this.shutdownPromise = Promise.resolve().then(() => this.destroyBundles().catch(() => {})).then(() => process.exit(0));
        return this.shutdownPromise;
    }
}

const app = new KalugaCamerasApp();
app.start().catch((err) => logger.error('kaluga start: ' + err.message));
