// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * robertn_waze_cluster - the control panel for the native
 * waze-on-cluster tool, which puts the CarPlay cluster map on the instrument
 * cluster. It drives the tool entirely from the HMI, so no shell is needed.
 *
 * The main page, one LT_State_Wide list in four sections, each under a
 * header row: General, HUD, CarPlay, Android Auto, then the restart's two
 * rows. General: Show on (a drop-down of Cluster, HUD and both), Cluster map
 * (the shared render's map), the Hide BMW's turn box checkbox (the render's
 * setting; a press asks the render to flip it), Logs. HUD: HUD map (the map
 * on the HUD), the Size slider, Position with Move left, Move right, Move
 * up, Move down and Centre; the slider and the position buttons are greyed
 * while the HUD is off or disabled after errors. CarPlay and Android Auto
 * have the same rows: Status, Patch, Remove patch; CarPlay adds CarPlay
 * Wi-Fi (the band, 5 GHz or 2.4 GHz) and, on 2.4 GHz, the line under it;
 * Android Auto adds Zoom with Zoom out and Zoom in, and the Hide phone's
 * turn card checkbox. Info rows read "Name: Value"; every on/off setting is
 * a checkbox. One that cannot act now is greyed, and while patchd runs any
 * operation every operation is. Every row stays on the page but four, the
 * only rows shown and hidden: CarPlay Wi-Fi while CarPlay runs over Wi-Fi
 * and patchd knows the band, and its line on 2.4 GHz, CarPlay's last two
 * (only Android Auto's rows move); Restart head unit while a written change
 * waits for the next head-unit start, and the Restart row while it has
 * something to say, the page's last two (no row moves). Once patched, the
 * render puts the map on the cluster whenever the phone streams it, with no
 * button.
 *
 * The Logs page (logs_control.js): Start capture and the Capture row, Save
 * logs and the Saved logs row, the QR code of the address a phone on the
 * car's hotspot downloads the saved archives from, that address, and the
 * archives. The app holds the logs socket while the page is visible; the QR
 * code is a PNG in QR_DIR (RAM), replaced when the address changes.
 *
 * CarPlay's Patch button is enabled for an unpatched or unknown state and Remove
 * patch for a patch, both only with no change pending (waze_cluster_control.js
 * canEnable/canDisable); capture is enabled while the patch daemon is
 * reachable. The app connects both sockets while one of its pages is visible
 * and closes them when it is hidden or the app shuts down; the tools keep
 * running. Moving between its pages hides one before the other shows, so a
 * hide counts only after HIDE_SETTLE_MS. waze_cluster_control.js holds the
 * protocol.
 *
 * Every word on both pages is in the HMI's display language (src/i18n.js),
 * read from HMIContext at start and on each change, which writes every row
 * again; English until then, and without it. The tile's name and the Logs
 * page's title are string ids the HMI shows itself (the RHMI text files).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const i18n = require('./i18n.js');
const { WazeClusterControl, ZOOM_STEP, SHOWN_ON } = require('./waze_cluster_control.js');
const { LogsControl, ROWS: LOGS_ROWS } = require('./logs_control.js');
const { qrPng } = require('./qr.js');
const { CameraControl } = require('./control.js');
const cameraView = require('./view_model.js');
const cameraDiagnostics = require('./diagnostics_view.js');
const { BmwGpsBridge } = require('./bmw_gps_bridge.js');
const { BmwNavigationBridge } = require('./bmw_navigation_bridge.js');
const { BmwHoldBridge } = require('./bmw_hold_bridge.js');
const { CameraMoveRepeater } = require('./camera_move_repeater.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_WazeCluster';
const STATUS_NAME = 'wocStatus';
const MAP_NAME = 'wocMap';
const ENABLE_NAME = 'wocEnable';
const DISABLE_NAME = 'wocDisable';
const RESTART_NAME = 'wocRestart';
const RESTART_STATUS_NAME = 'wocRestartStatus';
const WIFI_NAME = 'wocWifi';
const WIFI_HINT_NAME = 'wocWifiHint';
const AA_STATUS_NAME = 'wocAaStatus';
const AA_ENABLE_NAME = 'wocAaEnable';
const AA_DISABLE_NAME = 'wocAaDisable';
const AA_ZOOM_NAME = 'wocAaZoom';
const AA_ZOOM_OUT_NAME = 'wocAaZoomOut';
const AA_ZOOM_IN_NAME = 'wocAaZoomIn';
const AA_CARD_NAME = 'wocAaCard';
const GUIDE_NAME = 'wocGuide';
const HEAD_GENERAL_NAME = 'wocHeadGeneral';
const HEAD_HUD_NAME = 'wocHeadHud';
const HUD_NAME = 'wocHud';
const SHOW_ON_NAME = 'wocShowOn';
const HUD_SIZE_NAME = 'wocHudSize';
const HUD_OPACITY_NAME = 'wocHudOpacity';
const HUD_POS_NAME = 'wocHudPos';
const HUD_MOVE_NAMES = { left: 'wocHudLeft', right: 'wocHudRight', up: 'wocHudUp', down: 'wocHudDown' };
const HUD_CENTRE_NAME = 'wocHudCentre';
const CAPTURE_NAME = 'wocCapture';
const CAPTURE_STATUS = 'wocCaptureStatus';
const LOGS_NAME = 'wocLogs';
const LOGS_STATE = 'ST_OnlineApps_WazeClusterLogs';
const LOGS_SAVE = 'wocLogsSave';
const LOGS_STATUS = 'wocLogsStatus';
const LOGS_QR = 'wocLogsQr';
const LOGS_URL = 'wocLogsUrl';
const CAMERA_LINK = 'wocCameras';
const CAMERA_STATE = 'ST_OnlineApps_WazeStrelkaCameras';
const DIAG_STATE = 'ST_OnlineApps_WazeStrelkaDiagnostics';
const DIAG_NAMES = cameraDiagnostics.PAGE_KEYS.map(k => 'cameraDiag_' + k).concat(['cameraDiagFreeze','cameraDiagLive','cameraDiagTest',
    'cameraDiagCalibration','cameraDiagAudio','cameraDiagExport','cameraDiagPrev','cameraDiagNext','cameraDiagMore','cameraDiagResultMore']);
const CAMERA_NAMES = ['cameraStatus', 'cameraAlert', 'cameraDatabase', 'cameraDate', 'cameraGps',
    'cameraEnable', 'cameraCluster', 'cameraHud', 'cameraUpdate', 'cameraRollback', 'cameraDiagnostics', 'cameraInfo', 'cameraDescription',
    'cameraMotion','cameraStreet','cameraCommand','cameraCommandMore','cameraLimit','cameraDirection','cameraFacing','cameraResultMore',
    'cameraCoverage','cameraCoverageLimits','cameraCoverageRoad','cameraCoverageDirection'];
const PREFERENCE_NAMES = ['cameraPreferencesHead','cameraWarningDistance','cameraPreferencesStatus','cameraPreferencesHint']
    .concat(cameraView.ALERT_TYPES.map(type=>'cameraType_'+type.key));
const OVERSPEED_CHECKS = {cameraVisualFlash:'visualFlash',cameraSoundEnabled:'soundEnabled'};
const OVERSPEED_SLIDERS = {cameraVisualOffset:{key:'visualOffsetKmh',label:'Порог мигания'},cameraSoundOffset:{key:'soundOffsetKmh',label:'Порог звука'}};
const OVERSPEED_NAMES = ['cameraOverspeedHead','cameraOverspeedRecommended','cameraOverspeedStatus','cameraOverspeedHint',
    'cameraAudioStatus','cameraGpsReset','cameraGpsResetHint'].concat(Object.keys(OVERSPEED_CHECKS),Object.keys(OVERSPEED_SLIDERS));
const CARD_MOVE_NAMES = {up:'cameraCardUp',down:'cameraCardDown',left:'cameraCardLeft',right:'cameraCardRight'};
const CARD_SLIDERS = {cameraCardX:{key:'x',min:0,max:1000,label:'По горизонтали',divisor:10},
    cameraCardY:{key:'y',min:0,max:1000,label:'По вертикали',divisor:10},cameraCardScale:{key:'scalePct',min:75,max:150,label:'Размер предупреждения'},
    cameraCardBrightness:{key:'brightnessPct',min:10,max:100,label:'Яркость предупреждения'},
    cameraCardTransparency:{key:'opacityPct',min:0,max:90,label:'Прозрачность предупреждения',inverse:true}};
const CARD_NAMES = ['cameraHeadCalibration','cameraCardTarget','cameraCardStatus','cameraCardPosition','cameraCardHint','cameraCardStorage',
    'cameraTestStart','cameraTestStop','cameraCardSave','cameraCardReset'].concat(Object.values(CARD_MOVE_NAMES),Object.keys(CARD_SLIDERS));
const LOGS_ROW_NAMES = Array.from({ length: LOGS_ROWS }, (_, i) => `wocLogsRow${i + 1}`);
const ROW_CHARS = 90;
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const HMI_CONTEXT = ['de.bmw.infotainment.hmi.hmicontext.HMIContext', 'HMI_CID'];
const { t } = i18n;
let cameraClientSequence = 0;
const CAMERA_TERMINAL_PHASES = ['finished','shown','error','unconfirmed','played','timeout','unavailable','outcome-unknown'];
const QR_DIR = path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(),
    `robertn_waze_cluster_qr_${typeof process.getuid === 'function' ? process.getuid() : 'x'}`);

/* A line as one row: no line breaks, at most ROW_CHARS characters. */
function oneRow(line) {
    const flat = line.replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? `${flat.slice(0, ROW_CHARS - 1)}…` : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class WazeClusterApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._pages = { main: false, logs: false, cameras: false, diagnostics: false };
        this._diagFrozen = null;
        this._diagPage = 0; this._diagBlock = 0;
        this._cameraFeedback = null; this._cameraCommandTimer = null;
        this._cameraPending = null; this._cameraCommandSequence = 0;
        this._cameraClientId = 'strelka-'+Date.now().toString(36)+'-'+process.pid.toString(36)+'-'+(++cameraClientSequence).toString(36);
        this._cameraResultBlock = 0; this._cameraResultText = null;
        this._cameraCardTarget = 'hud'; this._cameraCardSelectionReason = null;
        this._cameraFocusedArrow=null; this._cameraInputEvents=[]; this._cameraConsumedArrow=null; this._cameraSuppressUntil=0; this._cameraHoldStop=null;
        this._shownPage = 'main';   /* the page last shown, which shows again when the app does */
        this._hideTimer = null;
        this._qr = { url: undefined, file: null, chain: Promise.resolve() };
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._shuttingDown = false;
        this._activityReported = null;
        this._control = new WazeClusterControl({ log: logger });
        this._control.on('change', () => this._render());
        this._logs = new LogsControl({ log: logger });
        this._logs.on('change', () => this._renderLogs());
        this._cameraState = null;
        this._cameraInfoMode = null;
        this._cameras = new CameraControl();
        this._cameras.on('change', () => { this._refreshCameraFeedback(); this._renderCameras(); this._renderHudOpacity(); });
        this._gpsBridge = new BmwGpsBridge({ builders: someipBuilders });
        this._navigationBridge = new BmwNavigationBridge({builders:someipBuilders,control:this._gpsBridge.control});
        this._gpsBridge.on('change', () => this._syncActivity());
        this._holdBridge=new BmwHoldBridge({builders:someipBuilders});
        this._moveRepeater=new CameraMoveRepeater({guard:context=>this._cameraHeldMoveGuard(context),pending:()=>this._cameraPending,
            step:context=>{this._cameraAction('cardLayout','card-move',{target:context.target,direction:context.direction});return !!this._cameraPending;},
            onStop:reason=>{this._cameraHoldStop=reason;}});
        this._holdBridge.on('held',event=>{
            if(event.held){this._cameraConsumedArrow=event.direction;this._cameraSuppressUntil=Infinity;this._moveRepeater.start(event.direction,event.target);}
            else{this._cameraSuppressUntil=Date.now()+450;this._moveRepeater.stop(event.reason);}
            this._renderCameras();
        });
        this._holdBridge.on('change',()=>this._renderCameras());

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error(`robertn_waze_cluster init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._setVisible(false);
            }
        });
    }

    _appInitialized() {
        logger.info(`robertn_waze_cluster ${this.getAppId()} v${this._packageJson.version} starting`);
        // Never await GPS for RHMI startup. Its separate local IPC client and
        // background hold survive leaving this screen for CarPlay.
        Promise.resolve().then(() => { this._gpsBridge.start(); this._navigationBridge.start(); this._holdBridge.start(); }).catch(() => logger.warn('BMW context bridge start failed'));
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return Promise.resolve(this.initialized()).then(() => this._syncActivity());
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._setupLanguage())
            .then(() => this._registerEntryPoints())
            .then(() => {
                // A foreground start declares itself ACTIVE before initialized()
                // reports the first app status, so the manager keeps it running.
                if (foregroundStart) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid &&
                    this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            })
            // A ready GPS subscription can emit before initialized() lets us
            // report activity. Reconcile it also for a hidden RHMI start.
            .then(() => this._syncActivity());
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK',
            'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.includes(reason);
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE_NAME);
        this._logsState = rhmi.getByName(LOGS_STATE);
        this._cameraState = rhmi.getByName(CAMERA_STATE);
        this._diagState = rhmi.getByName(DIAG_STATE);
        if (!this._state || !this._logsState || !this._cameraState || !this._diagState) {
            return Promise.reject(new Error(`uiDescription has no ${STATE_NAME} or ${LOGS_STATE}`));
        }
        const names = [STATUS_NAME, MAP_NAME, RESTART_STATUS_NAME, ENABLE_NAME, DISABLE_NAME, WIFI_NAME, WIFI_HINT_NAME, AA_STATUS_NAME,
            AA_ENABLE_NAME, AA_DISABLE_NAME, AA_ZOOM_NAME, AA_ZOOM_OUT_NAME, AA_ZOOM_IN_NAME, AA_CARD_NAME, RESTART_NAME, GUIDE_NAME,
            HEAD_GENERAL_NAME, HEAD_HUD_NAME, SHOW_ON_NAME, HUD_NAME, HUD_SIZE_NAME, HUD_OPACITY_NAME, HUD_POS_NAME]
            .concat(Object.values(HUD_MOVE_NAMES), [HUD_CENTRE_NAME, CAPTURE_NAME, CAPTURE_STATUS,
                LOGS_NAME, LOGS_SAVE, LOGS_STATUS, LOGS_QR, LOGS_URL, CAMERA_LINK], LOGS_ROW_NAMES, CAMERA_NAMES, DIAG_NAMES, CARD_NAMES, PREFERENCE_NAMES, OVERSPEED_NAMES);
        names.forEach((name) => { this._components[name] = rhmi.getByName(name); });
        const missing = names.filter((name) => !this._components[name]);
        if (missing.length) {
            return Promise.reject(new Error(`uiDescription lacks ${missing.join(', ')}`));
        }
        this._bind(ENABLE_NAME, () => this._control.enableMap());
        this._bind(DISABLE_NAME, () => this._control.disableMap());
        this._bind(AA_ENABLE_NAME, () => this._control.enableAa());
        this._bind(AA_DISABLE_NAME, () => this._control.disableAa());
        this._bind(AA_ZOOM_OUT_NAME, () => this._control.zoom(-ZOOM_STEP));
        this._bind(AA_ZOOM_IN_NAME, () => this._control.zoom(ZOOM_STEP));
        this._bind(AA_CARD_NAME, () => {
            /* as for the turn box: patchd's answer decides the tick */
            delete this._written[`selected:${AA_CARD_NAME}`];
            this._control.toggleCard();
        });
        this._bind(RESTART_NAME, () => this._control.requestRestart());
        this._bind(GUIDE_NAME, () => {
            /* the HMI ticks or unticks the box itself; the render's answer
             * decides what it shows */
            delete this._written[`selected:${GUIDE_NAME}`];
            this._control.toggleGuidance();
        });
        /* The HMI moves the drop-down's choice and the slider itself; the
         * control's state, as asked and then as the render says, decides
         * what they show. */
        this._components[SHOW_ON_NAME].on('action', (ev) => this._press(SHOW_ON_NAME, () => {
            delete this._written[`cell:${SHOW_ON_NAME}:SelectedItem`];
            this._control.showOn(SHOWN_ON[ev && ev.row]);
            this._render();
        }));
        /* the SDK writes the slider's new step after telling it: the step it
         * shows is written again after that */
        this._components[HUD_SIZE_NAME].on('changed', (step) => {
            if (step !== this._written[`cell:${HUD_SIZE_NAME}:0:Value`]) {
                logger.info(`SLIDER ${HUD_SIZE_NAME} ${step}`);
                delete this._written[`cell:${HUD_SIZE_NAME}:0:Value`];
                this._control.setHudSizeStep(step);
                setImmediate(() => this._render());
            }
        });
        this._components[HUD_OPACITY_NAME].on('changed', (step) => {
            const state = this._cameras.state;
            if (state && state.capabilities && state.capabilities.hudOpacity && Number.isInteger(step) && step >= 0 && step <= 18 &&
                100 - step * 5 !== state.hudOpacityPct) {
                this._cameras.send({ cmd: 'hud-opacity', percent: 100 - step * 5 });
            }
            delete this._written[`cell:${HUD_OPACITY_NAME}:0:Value`];
            setImmediate(() => this._renderHudOpacity());
        });
        Object.keys(HUD_MOVE_NAMES).forEach((dir) => this._bind(HUD_MOVE_NAMES[dir], () => this._control.moveHud(dir)));
        this._bind(HUD_CENTRE_NAME, () => this._control.centreHud());
        this._bind(CAPTURE_NAME, () => this._control.capture());
        this._bind(LOGS_NAME, () => Promise.resolve(rhmi.openState(LOGS_STATE))
            .catch((err) => logger.warn(`openState ${LOGS_STATE} failed: ${err && err.message}`)));
        this._bind(LOGS_SAVE, () => this._logs.save());
        this._bind(CAMERA_LINK, () => Promise.resolve(rhmi.openState(CAMERA_STATE))
            .catch((err) => logger.warn('camera page: ' + err.message)));
        this._bind('cameraEnable', () => this._cameraCommand({ cmd: this._cameras.state && this._cameras.state.enabled ? 'disable' : 'enable' }));
        this._bind('cameraCluster', () => this._cameraCommand(cameraView.outputCommand(this._cameras.state, 'cluster')));
        this._bind('cameraHud', () => this._cameraCommand(cameraView.outputCommand(this._cameras.state, 'hud')));
        this._components.cameraWarningDistance.on('changed',step=>{
            const prefs=cameraView.alertPreferences(this._cameras.state), value=50+step*50;
            if(prefs.available&&Number.isInteger(step)&&step>=0&&step<=19&&value!==prefs.warningDistanceM)
                this._cameraCommand({cmd:'alert-preferences',warningDistanceM:value});
            // Slider writes its proposed value after emitting changed. Restore
            // the confirmed service value after that write, including rejects.
            delete this._written['cell:cameraWarningDistance:0:Value'];
            setImmediate(()=>this._renderAlertPreferences());
        });
        cameraView.ALERT_TYPES.forEach(type=>{
            const name='cameraType_'+type.key;
            this._bind(name,()=>{
                const prefs=cameraView.alertPreferences(this._cameras.state);
                if(prefs.available){
                    const patch={};patch[type.key]=!prefs.cameraTypes[type.key];
                    this._cameraCommand({cmd:'alert-preferences',cameraTypes:patch});
                }
            });
            // HMI checkboxes toggle locally before action, even when _press
            // deduplicates a second delivery. Always restore the server tick.
            this._components[name].on('action',()=>{
                delete this._written['selected:'+name];
                this._renderAlertPreferences();
            });
        });
        this._bind('cameraOverspeedRecommended',()=>{
            if(cameraView.overspeedPreferences(this._cameras.state).available)
                this._cameraCommand(Object.assign({cmd:'overspeed-preferences'},cameraView.OVERSPEED_RECOMMENDED));
        });
        Object.keys(OVERSPEED_CHECKS).forEach(name=>{
            this._bind(name,()=>{
                const prefs=cameraView.overspeedPreferences(this._cameras.state),key=OVERSPEED_CHECKS[name];
                if(prefs.available){const patch={cmd:'overspeed-preferences'};patch[key]=!prefs[key];this._cameraCommand(patch);}
            });
            this._components[name].on('action',()=>{
                delete this._written['selected:'+name];this._renderOverspeedPreferences();
            });
        });
        Object.keys(OVERSPEED_SLIDERS).forEach(name=>this._components[name].on('changed',step=>{
            const prefs=cameraView.overspeedPreferences(this._cameras.state),key=OVERSPEED_SLIDERS[name].key;
            if(prefs.available&&Number.isInteger(step)&&step>=0&&step<=30&&step!==prefs[key]){
                const patch={cmd:'overspeed-preferences'};patch[key]=step;this._cameraCommand(patch);
            }
            delete this._written['cell:'+name+':0:Value'];setImmediate(()=>this._renderOverspeedPreferences());
        }));
        this._bind('cameraGpsReset',()=>{
            const state=this._cameras.state;
            if(state&&state.capabilities&&state.capabilities.gpsReset===true)this._cameraCommand({cmd:'gps-reset'});
        });
        this._bind('cameraResultMore', () => this._nextCameraResult());
        this._bind('cameraDiagResultMore', () => this._nextCameraResult());
        this._components.cameraCardTarget.on('action',(event)=>{
            const target=['hud','map'][event&&event.row];
            if(!target)return;
            const active=!!((this._cameras.state||{}).displayTest||{}).active;
            this._cameraCardTarget=target; this._cameraCardSelectionReason=null;
            delete this._written['cell:cameraCardTarget:SelectedItem'];
            if(active){
                const allowed=this._cameraTestGuard();
                if(allowed.allowed)this._cameraAction('displayTest','display-test',{target});
                else {
                    this._cameraCardSelectionReason=allowed.reason;
                    this._cameraAction('displayTestStop','display-test-stop',{target});
                }
            }
            this._renderCameras();
        });
        this._bind('cameraTestStart',()=>this._startCameraTest(false));
        this._bind('cameraTestStop',()=>this._cameraAction('displayTestStop','display-test-stop',{target:this._cameraCardTarget}));
        this._bind('cameraCardSave',()=>this._cameraAction('displayTestStop','display-test-stop',{target:this._cameraCardTarget}));
        this._bind('cameraCardReset',()=>this._cameraAction('cardLayout','card-layout-reset',{target:this._cameraCardTarget}));
        Object.keys(CARD_MOVE_NAMES).forEach(direction=>{
            const name=CARD_MOVE_NAMES[direction],component=this._components[name];
            component.on('focus',event=>{
                const focus=event&&(event.focus!==undefined?event.focus:event.value);
                if(isTrue(focus))this._cameraFocusedArrow=direction;
                else if((focus===false||focus===0||focus==='false'||focus==='0')&&this._cameraFocusedArrow===direction)this._cameraFocusedArrow=null;
                this._syncCameraHold();
            });
            this._bind(name,()=>{
                if(this._cameraConsumedArrow===direction&&Date.now()<this._cameraSuppressUntil)return;
                if(this._holdBridge.status().held){this._holdBridge.stopHeld('MANUAL_ARROW');this._moveRepeater.stop('MANUAL_ARROW');}
                if(this._cameraPending)return;
                const guard=this._cameraMoveGuard();
                if(!guard.allowed){this._cameraFeedback={message:guard.reason};this._renderCameras();return;}
                this._cameraAction('cardLayout','card-move',{target:this._cameraCardTarget,direction});
            });
        });
        Object.keys(CARD_SLIDERS).forEach(name=>this._components[name].on('changed',step=>{
            const config=CARD_SLIDERS[name], state=this._cameras.state, current=state&&state.cardLayout&&state.cardLayout[this._cameraCardTarget];
            const value=config.inverse?100-step*5:config.min+step*5;
            if(Number.isInteger(step)&&step>=0&&step<=(config.max-config.min)/5&&current&&
                value!==current[config.key]){
                const fields={target:this._cameraCardTarget};fields[config.key]=value;
                this._cameraAction('cardLayout','card-layout',fields);
            }
            delete this._written['cell:'+name+':0:Value'];
            setImmediate(()=>this._renderCameraCard());
        }));
        this._bind('cameraDiagnostics', () => {
            this._diagPage = 0; this._diagBlock = 0;
            this._cameras.send({ cmd: 'status' }); this._renderDiagnostics();
            return Promise.resolve(rhmi.openState(DIAG_STATE)).catch(() => logger.warn('camera diagnostics page unavailable'));
        });
        this._bind('cameraDiagFreeze', () => {
            if (this._cameras.state) {
                this._diagFrozen = cameraDiagnostics.capture(this._cameraDiagnosticState(),this._packageJson.version,Date.now());
                this._cameraFeedback = {message:'Снимок '+this._diagFrozen.id+' зафиксирован; команды остаются живыми'};
                this._diagBlock = 0;
            } else this._cameraFeedback = {message:'Снимок недоступен: сервис не отвечает'};
            this._renderDiagnostics();
        });
        this._bind('cameraDiagLive', () => { this._diagFrozen = null; this._diagBlock=0;
            this._cameraFeedback={message:'Живые данные включены'}; this._renderDiagnostics(); });
        this._bind('cameraDiagTest', () => {this._startCameraTest(false);return rhmi.openState(CAMERA_STATE);});
        this._bind('cameraDiagCalibration', () => {this._startCameraTest(true);return rhmi.openState(CAMERA_STATE);});
        this._bind('cameraDiagAudio', () => this._cameraAction('audioTest','audio-test'));
        this._bind('cameraDiagExport', () => this._exportDiagnostic());
        this._bind('cameraDiagPrev', () => { this._diagPage=(this._diagPage+5)%6; this._diagBlock=0; this._renderDiagnostics(); });
        this._bind('cameraDiagNext', () => { this._diagPage=(this._diagPage+1)%6; this._diagBlock=0; this._renderDiagnostics(); });
        this._bind('cameraDiagMore', () => {
            const page=cameraDiagnostics.reportPage(this._diagFrozen,this._cameraDiagnosticState(),this._packageJson.version,this._diagPage,this._diagBlock);
            this._diagBlock=(this._diagBlock+1)%page.blocks;
            if(page.blocks===1)this._cameraFeedback={message:'Все строки этой страницы уже показаны'};
            this._renderDiagnostics();
        });
        this._bind('cameraUpdate', () => this._cameraAction('databaseCheck','database-check'));
        this._bind('cameraRollback', () => this._cameraAction('databaseRollback','database-rollback'));
        // Presses also arrive as the application's raw 'userEvent'; both paths
        // land in _press, which keeps a press delivered twice to one.
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler);
                if(entry.name.indexOf('cameraType_')===0){
                    delete this._written['selected:'+entry.name];
                    this._renderAlertPreferences();
                }
                if(Object.prototype.hasOwnProperty.call(OVERSPEED_CHECKS,entry.name)){
                    delete this._written['selected:'+entry.name];this._renderOverspeedPreferences();
                }
            }
        });
        rhmi.on('applicationStackChanged', (stack) => {
            // The app holds the foreground while the stack has a ROOT_APP slot;
            // the empty stack seen during startup is ignored.
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._written = {};
            this._qr.url = undefined;
            this._render();
            this._renderLogs();
            this._renderCameras();
        });
        this._state.on('visible', (event) => this._pageVisible('main', isTrue(event && event.visible)));
        this._logsState.on('visible', (event) => this._pageVisible('logs', isTrue(event && event.visible)));
        this._cameraState.on('visible', (event) => this._pageVisible('cameras', isTrue(event && event.visible)));
        this._cameraState.on('focus',event=>{
            const focus=event&&(event.focus!==undefined?event.focus:event.value);
            if(focus===false||focus===0||focus==='false'||focus==='0'){
                this._cameraFocusedArrow=null;this._syncCameraHold();this._moveRepeater.stop('PAGE_FOCUS_LOST');
            }
        });
        this._diagState.on('visible', (event) => this._pageVisible('diagnostics', isTrue(event && event.visible)));
        this._removeStaleQr();
        return Promise.all([this._state.updateResources(), this._logsState.updateResources(), this._cameraState.updateResources(), this._diagState.updateResources()]).then(() => {
            logger.info(`page ready: ${names.length} components found`);
            this._render();
            this._renderLogs();
            this._renderCameras();
        });
    }

    /* The words follow the HMI's display language: read at start and on
     * each change; English until then, and without it. Never holds up the
     * start. */
    _setupLanguage() {
        logger.info(`languages: en ${i18n.codes().join(' ')}`);
        const [iface, instance] = HMI_CONTEXT;
        let proxy;
        Promise.resolve()
            .then(() => someipBuilders.buildTypedProxy(iface, instance))
            .then((p) => { proxy = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => proxy.currentDisplayLanguage.subscribe((v) => this._displayLanguage(v)))
            .then(() => proxy.currentDisplayLanguage.getValue())
            .then((v) => this._displayLanguage(v))
            .catch((err) => logger.warn(`display language unavailable from ${iface}: ${err && err.message}`));
    }

    _displayLanguage(value) {
        if (i18n.setHmiLanguage(value)) {
            logger.info(`display language ${value}: ${i18n.language()}`);
            this._render();
            this._renderLogs();
            this._renderCameras();
        }
    }

    _bind(name, handler) {
        const comp = this._components[name];
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null) {
            this._actionById[Number(id)] = { name, handler };
        }
        logger.info(`BIND OK: ${name} (id ${id})`);
        comp.on('action', event => {if(Object.values(CARD_MOVE_NAMES).indexOf(name)>=0)this._recordCameraInput(name,event);this._press(name, handler);});
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[name] = now;
        logger.info(`BUTTON ACTION ${name}`);
        try {
            handler();
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    /* The app manager inserts the public tile from application.json and hands
     * it to the app at start; the SDK emits 'entryPointExecute' on a tap. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription &&
            this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn(`entry point text/icon: ${err && err.message}`)))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._sawForeground = true;
        /* the tile opens the main page, whichever page the app was left on;
         * its stack change may have come first and opened the Logs page's socket */
        this._shownPage = 'main';
        this._pages.logs = false;
        this._logs.close();
        this._pages.cameras = false;
        this._pages.diagnostics = false;
        this._diagFrozen = null;
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* ---- visibility ---- */
    /* One page shown or hidden. The logs socket follows the Logs page; the
     * app counts as hidden once neither page has shown for HIDE_SETTLE_MS. */
    _pageVisible(page, visible) {
        if (this._shutdownPromise) {
            return;
        }
        this._pages[page] = visible;
        if(page==='cameras'&&!visible)this._cameraFocusedArrow=null;
        this._syncCameraHold();
        if (visible) {
            this._shownPage = page;
        }
        if (page === 'logs') {
            if (visible) {
                this._logs.open();
            } else {
                this._logs.close();
            }
        }
        if (page === 'cameras' || page === 'diagnostics') {
            if (visible) this._cameras.open();
        }
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
        if (visible) {
            this._sawForeground = true;
            this._setVisible(true);
        } else if (!this._pages.main && !this._pages.logs && !this._pages.cameras && !this._pages.diagnostics) {
            this._hideTimer = setTimeout(() => {
                this._hideTimer = null;
                this._setVisible(false);
            }, HIDE_SETTLE_MS);
        }
    }

    _setVisible(visible) {
        if (!visible) {
            this._pages = { main: false, logs: false, cameras: false, diagnostics: false };
            this._cameraFocusedArrow=null;this._syncCameraHold();
            this._logs.close();
            this._cameras.close();
        }
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        logger.info(`page ${visible ? 'visible' : 'hidden'}`);
        this._reportVisibilityStatus(visible);
        if (visible) {
            this._control.open();
            this._cameras.open();
            /* back from an overlay or another app on the Logs page, which
             * says nothing of its own */
            if (this._shownPage === 'logs') {
                this._pages.logs = true;
                this._logs.open();
            }
            if (this._shownPage === 'cameras') {
                this._pages.cameras = true;
                this._cameras.open();
            }
        } else {
            this._control.close();
            this._cameras.close();
        }
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        this._syncActivity();
        Promise.resolve().then(() => visible ? this.registerHmiVisible() : this.unregisterHmiVisible())
            .catch(() => logger.warn('app HMI visibility report failed'));
    }

    _syncActivity() {
        if (!this._initialized || !this._appStatusService || this._shuttingDown) return;
        const active = this._visible || this._gpsBridge.shouldHold();
        if (this._activityReported === active) return;
        this._activityReported = active;
        Promise.resolve().then(() => active ? this.registerActive() : this.registerInactive())
            .catch(() => { this._activityReported = null; logger.warn('app activity report failed'); });
    }

    /* ---- rendering ---- */
    /* Writes text into a component's row unless it already shows it. */
    _write(name, text) {
        if (this._written[name] !== text) {
            this._written[name] = text;
            Promise.resolve(this._components[name].setValue(0, 'Text', text, 'Text'))
                .catch((err) => logger.warn(`${name} render failed: ${err && err.message}`));
        }
    }

    /* Writes a cell unless it already holds that value: a cell of the
     * component's (row null) or of its row. The slider's value goes through
     * the slider's own setStepValue, which keeps its step in step with it. */
    _writeCell(name, cell, value, type, row) {
        const key = `cell:${name}:${row == null ? '' : `${row}:`}${cell}`;
        if (this._written[key] !== value) {
            this._written[key] = value;
            const comp = this._components[name];
            Promise.resolve(cell === 'Value' && comp.setStepValue ? comp.setStepValue(value)
                : row == null ? comp.setValue(cell, value, type) : comp.setValue(row, cell, value, type))
                .catch((err) => logger.warn(`${name} ${cell} failed: ${err && err.message}`));
        }
    }

    /* Enables a component unless it already holds that state (the
     * drop-down and the slider have no setEnabled, only the property). */
    _setEnabled(name, enabled) {
        const key = `enabled:${name}`;
        if (this._written[key] !== enabled) {
            this._written[key] = enabled;
            const comp = this._components[name];
            Promise.resolve(comp.setEnabled ? comp.setEnabled(enabled) : comp.setProperty('Enabled', enabled ? 1 : 0, 'UInt'))
                .catch((err) => logger.warn(`${name} enable failed: ${err && err.message}`));
        }
    }

    /* Shows or hides a component unless it already holds that state. */
    _setVisibleComp(name, visible) {
        const key = `visible:${name}`;
        if (this._written[key] !== visible) {
            this._written[key] = visible;
            Promise.resolve(this._components[name].setVisible(visible))
                .catch((err) => logger.warn(`${name} visibility failed: ${err && err.message}`));
        }
    }

    /* Ticks or unticks a checkbox unless it already holds that state. */
    _setSelected(name, selected) {
        const key = `selected:${name}`;
        if (this._written[key] !== selected) {
            this._written[key] = selected;
            Promise.resolve(this._components[name].setValue(0, 'eParam_RowSelected', selected, 'Bool'))
                .catch((err) => logger.warn(`${name} select failed: ${err && err.message}`));
        }
    }

    _render() {
        if (!this._state || this._shutdownPromise) {
            return;
        }
        const c = this._control;
        [[ENABLE_NAME, t('Patch')], [DISABLE_NAME, t('Remove patch')], [AA_ENABLE_NAME, t('Patch')], [AA_DISABLE_NAME, t('Remove patch')],
            [AA_ZOOM_OUT_NAME, t('Zoom out')], [AA_ZOOM_IN_NAME, t('Zoom in')], [HEAD_GENERAL_NAME, t('General')], [LOGS_NAME, t('Logs')],
            [HEAD_HUD_NAME, t('HUD')], [CAMERA_LINK, t('Cameras')],
            [HUD_MOVE_NAMES.left, t('Move left')], [HUD_MOVE_NAMES.right, t('Move right')], [HUD_MOVE_NAMES.up, t('Move up')],
            [HUD_MOVE_NAMES.down, t('Move down')], [HUD_CENTRE_NAME, t('Centre')],
            [RESTART_NAME, t('Restart head unit')]].forEach(([name, text]) => this._write(name, text));
        this._write(STATUS_NAME, c.statusText());
        this._write(MAP_NAME, c.mapText());
        this._write(AA_STATUS_NAME, c.aaStatusText());
        this._write(AA_ZOOM_NAME, c.zoomText());
        this._write(AA_CARD_NAME, c.cardText());
        this._setSelected(AA_CARD_NAME, c.cardHidden());
        this._write(CAPTURE_NAME, c.captureButtonText());
        this._write(CAPTURE_STATUS, c.captureText());
        [[ENABLE_NAME, c.canEnable()], [DISABLE_NAME, c.canDisable()],
            [AA_ENABLE_NAME, c.canEnableAa()], [AA_DISABLE_NAME, c.canDisableAa()],
            [AA_ZOOM_OUT_NAME, c.canZoom(-ZOOM_STEP)], [AA_ZOOM_IN_NAME, c.canZoom(ZOOM_STEP)],
            [AA_CARD_NAME, c.canToggleCard()], [CAPTURE_NAME, c.canCapture()], [RESTART_NAME, c.canRestart()]]
            .forEach(([name, enabled]) => this._setEnabled(name, enabled));
        const restartText = c.restartText();
        this._setVisibleComp(RESTART_NAME, c.restartNeeded() || c.restartRequested());
        this._write(RESTART_STATUS_NAME, restartText);
        this._setVisibleComp(RESTART_STATUS_NAME, restartText !== '');
        const wifi = c.wifiText(), hint = c.wifiHint();
        this._write(WIFI_NAME, wifi);
        this._setVisibleComp(WIFI_NAME, wifi !== '');
        this._write(WIFI_HINT_NAME, hint);
        this._setVisibleComp(WIFI_HINT_NAME, hint !== '');
        const hide = c.hideGuidance();
        const unavailable = c.guidanceUnavailable();
        /* where the map shows: the choice, '—' in its place while there is none */
        const shownOn = SHOWN_ON.indexOf(c.shownOn());
        this._writeCell(SHOW_ON_NAME, 'HeaderText', t('Show on'), 'Text');
        [t('Cluster'), t('HUD (experimental)'), t('Cluster and HUD (experimental)')].forEach((text, row) =>
            this._writeCell(SHOW_ON_NAME, 'ItemText', row === 0 && shownOn < 0 ? '—' : text, 'Text', row));
        this._writeCell(SHOW_ON_NAME, 'SelectedItem', Math.max(shownOn, 0), 'UInt');
        this._setEnabled(SHOW_ON_NAME, c.canChooseShownOn());
        /* the turn box's hold follows the map on the cluster */
        this._setEnabled(GUIDE_NAME, hide !== null && !unavailable && c.clusterOn() !== false);
        this._write(GUIDE_NAME, t("Hide BMW's turn box"));
        this._setSelected(GUIDE_NAME, !!hide && !unavailable);
        this._write(HUD_NAME, c.hudText());
        /* the size slider and the place buttons: greyed while the HUD is off
         * or disabled (the HMI greys no label) */
        const adjust = c.canChangeHudSize();
        this._writeCell(HUD_SIZE_NAME, 'TextDescription', c.hudSizeText(), 'Text', 0);
        if (c.hudSizeStep() !== null) {
            this._writeCell(HUD_SIZE_NAME, 'Value', c.hudSizeStep(), 'SInt', 0);
        }
        this._setEnabled(HUD_SIZE_NAME, adjust);
        this._write(HUD_POS_NAME, c.hudPositionText());
        Object.values(HUD_MOVE_NAMES).forEach((n) => this._setEnabled(n, adjust));
        this._setEnabled(HUD_CENTRE_NAME, c.canCentreHud());
        this._renderHudOpacity();
    }

    _renderHudOpacity() {
        if (!this._state || !this._components[HUD_OPACITY_NAME] || this._shutdownPromise) return;
        const state = this._cameras.state;
        const supported = !!(state && state.capabilities && state.capabilities.hudOpacity &&
            Number.isFinite(state.hudOpacityPct) && state.hudOpacityPct >= 10 && state.hudOpacityPct <= 100);
        this._setEnabled(HUD_OPACITY_NAME, supported);
        this._writeCell(HUD_OPACITY_NAME, 'TextDescription', supported ?
            'Прозрачность HUD: ' + (100 - state.hudOpacityPct) + ' %' : 'Прозрачность HUD: сервис недоступен', 'Text', 0);
        this._writeCell(HUD_OPACITY_NAME, 'Value', supported ? Math.round((100 - state.hudOpacityPct) / 5) : 0, 'SInt', 0);
    }

    _cameraCommand(message) {
        if(message&&message.cmd==='card-move'&&this._cameraPending)return;
        if(message&&message.cmd!=='card-move'){
            if(this._holdBridge.status().held)this._holdBridge.stopHeld('OTHER_COMMAND');
            this._moveRepeater.stop('OTHER_COMMAND');this._syncCameraHold();
        }
        clearTimeout(this._cameraCommandTimer); this._cameraCommandTimer=null;
        this._cameraPending=null;
        if (!message) {
            this._cameraFeedback={message:'Действие недоступно: сервис не подтвердил управление выходом'};
            this._renderCameras(); return;
        }
        this._cameraInfoMode = null;
        const requestId=this._cameraClientId+'-'+(++this._cameraCommandSequence).toString(36);
        const commandName={'display-test':'тест предупреждения','calibration-test':'проверка границ',
            'display-test-stop':'сохранение и остановка теста','card-layout':'настройка предупреждения',
            'card-layout-reset':'сброс настроек предупреждения','card-move':'положение предупреждения',
            'alert-preferences':'настройки предупреждений','overspeed-preferences':'настройки превышения',
            'gps-reset':'сброс истории GPS; ожидайте свежие координаты'}[message.cmd]||message.cmd;
        const pending={message:'Ожидание ответа: '+commandName,command:message.cmd,target:message.target,requestId,pending:true};
        this._cameraFeedback=pending; this._cameraPending=pending;
        if (!this._cameras.send(Object.assign({},message,{requestId}))) {
            this._cameraPending=null; this._cameraFeedback={message:this._cameras.diagnostic()};
        }
        else {
            this._cameraCommandTimer=setTimeout(()=>{
                this._cameraCommandTimer=null;
                if(this._cameraPending===pending){
                    pending.pending=false; pending.awaiting=true;
                    pending.message='Нет окончательного подтверждения: '+commandName+'; проверьте связь и обновите сервис';
                    this._cameraFeedback=pending;
                    this._renderCameras();
                }
            },6000);
            if(this._cameraCommandTimer.unref)this._cameraCommandTimer.unref();
        }
        this._renderCameras();
    }

    _cameraAction(name,command,fields) {
        const a=cameraDiagnostics.action(this._cameras.state,name);
        if(!a.allowed){
            this._cameraFeedback={message:a.reason||'Действие недоступно ('+a.code+')'};
            this._renderCameras(); return;
        }
        this._cameraCommand(Object.assign({cmd:command},fields||{}));
    }

    _cameraTestGuard() {
        const state=this._cameras.state, allowed=cameraDiagnostics.action(state,'displayTest');
        if(!allowed.allowed)return allowed;
        const output=this._cameraCardTarget==='map'?'cluster':'hud';
        return state.outputs&&state.outputs[output]===true?allowed:
            {allowed:false,reason:(output==='hud'?'Проекция HUD':'Приборная панель')+' выключена. Включите выбранный выход выше.'};
    }

    _startCameraTest(calibration) {
        const allowed=this._cameraTestGuard();
        this._cameraCardSelectionReason=allowed.allowed?null:allowed.reason;
        if(!allowed.allowed){this._cameraFeedback={message:allowed.reason};this._renderCameras();return;}
        this._cameraAction(calibration?'calibrationTest':'displayTest',calibration?'calibration-test':'display-test',
            {target:this._cameraCardTarget});
    }

    _syncCameraHold() {
        if(!this._holdBridge)return;
        const state=this._cameras.state||{},test=state.displayTest||{},renderer=state.rendererDetails||{},stationary=cameraDiagnostics.action(this._cameras.state,'cardLayout');
        this._holdBridge.setContext({visible:!!this._pages.cameras&&!this._shutdownPromise,focusedDirection:this._cameraFocusedArrow,target:this._cameraCardTarget,
            stationary:stationary.allowed===true,activeTest:test.active===true&&test.target===this._cameraCardTarget,
            serviceReady:this._cameras.link==='up'&&renderer.connection==='ready'});
    }
    _cameraHeldMoveGuard(context) {
        const state=this._cameras.state||{},test=state.displayTest||{},renderer=state.rendererDetails||{},hold=this._holdBridge.status(),profile=(state.cardLayout||{})[context.target];
        if(!hold.held||!this._pages.cameras||this._cameraFocusedArrow!==context.direction||this._cameraCardTarget!==context.target||!test.active||test.target!==context.target||renderer.connection!=='ready')return {allowed:false,reason:'CONTEXT_LOST'};
        const still=cameraDiagnostics.action(this._cameras.state,'cardLayout');if(!still.allowed)return still;
        if(!profile)return {allowed:false,reason:'PROFILE_UNAVAILABLE'};
        if((context.direction==='left'&&profile.x<=0)||(context.direction==='right'&&profile.x>=1000)||(context.direction==='up'&&profile.y<=0)||(context.direction==='down'&&profile.y>=1000))return{allowed:false,reason:'EDGE_REACHED'};
        const allowed=this._cameraMoveGuard();
        if(!allowed.allowed&&allowed.reason==='Дождитесь подтверждения текущих настроек изображения')return {allowed:false,waiting:true,reason:'RENDER_CONFIRMATION'};
        return allowed;
    }
    _recordCameraInput(name,event) {
        // Local diagnostic metadata only. No arbitrary SDK objects, strings,
        // coordinates, pointers or secrets are serialized.
        const safe={};for(const key of ['type','subType','subtype','actionType','value','row','pressed','long','keyCode','code']){
            let value;try{value=event&&event[key];}catch(ignored){continue;}
            if(typeof value==='boolean'||Number.isFinite(value)||typeof value==='string'&&/^[A-Za-z0-9_.-]{1,32}$/.test(value))safe[key]=value;
        }
        for(const key of ['args','parameters','parameterMap']){
            const value=event&&event[key],fields={};
            if(value instanceof Map)value.forEach((v,k)=>{if(/^\d{1,2}$/.test(String(k))&&(typeof v==='boolean'||Number.isFinite(v)))fields[k]=v;});
            else if(value&&typeof value==='object')Object.keys(value).slice(0,16).forEach(k=>{const v=value[k];if(/^\d{1,2}$/.test(k)&&(typeof v==='boolean'||Number.isFinite(v)))fields[k]=v;});
            if(Object.keys(fields).length)safe[key]=fields;
        }
        this._cameraInputEvents.push({at:new Date().toISOString(),component:name,data:safe});if(this._cameraInputEvents.length>6)this._cameraInputEvents.shift();
    }
    _cameraDiagnosticState() {
        return Object.assign({},this._cameras.state||{},{calibrationInput:{controller:this._holdBridge.status(),repeat:this._moveRepeater.status(),focusedDirection:this._cameraFocusedArrow,
            stopReason:this._cameraHoldStop,touchHoldConfirmed:false,events:this._cameraInputEvents.map(e=>Object.assign({},e))}});
    }

    _cameraMoveGuard() {
        const state=this._cameras.state||{}, guard=cameraDiagnostics.action(this._cameras.state,'cardMove'), test=state.displayTest||{},
            renderer=state.rendererDetails||{}, layout=(renderer[this._cameraCardTarget]||{}).layout||{};
        if(!guard.allowed)return guard;
        if(!test.active||test.target!==this._cameraCardTarget)return {allowed:false,reason:'Для перемещения покажите тест на выбранном выходе'};
        if(renderer.connection!=='ready')return {allowed:false,reason:'Перемещение: ожидание соединения renderer'};
        if(!layout.canvas||layout.withinBounds!==true)return {allowed:false,reason:'Перемещение: ожидаются размеры и границы изображения'};
        const profile=(state.cardLayout||{})[this._cameraCardTarget], rendered=layout.settings;
        if(!profile||!rendered||['x','y','scalePct','brightnessPct','opacityPct'].some(key=>profile[key]!==rendered[key]))
            return {allowed:false,reason:'Дождитесь подтверждения текущих настроек изображения'};
        return guard;
    }

    _renderCameraCard() {
        this._syncCameraHold();
        if(!this._cameraState||this._shutdownPromise)return;
        const state=this._cameras.state||{}, target=this._cameraCardTarget, profile=state.cardLayout&&state.cardLayout[target],
            test=state.displayTest||{}, guard=cameraDiagnostics.action(this._cameras.state,'cardLayout'), storage=state.storage||{},
            name=target==='hud'?'HUD':'Приборы', move=this._cameraMoveGuard(), feedback=this._cameraFeedback,
            cardFeedback=feedback&&feedback.target===target&&(/^(card-|display-test|calibration-test)/.test(feedback.command||''));
        this._write('cameraHeadCalibration','Настройка предупреждения • на стоянке');
        this._writeCell('cameraCardTarget','HeaderText','Настраивать','Text');
        ['HUD','Приборы'].forEach((label,row)=>this._writeCell('cameraCardTarget','ItemText',label,'Text',row));
        this._writeCell('cameraCardTarget','SelectedItem',target==='hud'?0:1,'UInt');
        this._setEnabled('cameraCardTarget',true);
        this._write('cameraTestStart','Показать тест • до остановки');
        this._write('cameraTestStop','Скрыть тест');
        this._write('cameraCardSave','Готово • сохранить и скрыть тест');
        this._write('cameraCardReset','Сбросить настройки '+name);
        this._write('cameraCardStatus',this._cameraCardSelectionReason||
            (cardFeedback&&(feedback.pending||feedback.awaiting||feedback.phase==='error'||feedback.command==='display-test-stop')?
                cameraDiagnostics.commandPage(null,feedback.message,0).command:null)||
            (test.active?'Тест: '+(test.target==='hud'?'HUD':'Приборы')+' • '+(test.pinned?'закреплён до остановки':'показан'):
                'Тест скрыт • профиль '+name));
        this._write('cameraCardPosition',profile?'Положение: X '+(profile.x/10).toFixed(1)+' % • Y '+(profile.y/10).toFixed(1)+' %':
            'Настройки предупреждения: сервис не сообщил профиль');
        this._write('cameraCardHint',move.allowed?(this._holdBridge.status().state==='ready'?'Контроллер: удерживайте стрелку • сенсор: ползунки X/Y':'Быстро: ползунки X/Y • стрелки: один шаг'):
            move.reason||'Покажите тест на выбранном выходе для перемещения');
        this._write('cameraCardStorage',!profile?'Обновите сервис для настройки предупреждения':
            !guard.allowed?guard.reason||'Настройка доступна на стоянке со свежей скоростью':
            storage.settingsSaved===true&&storage.persistent===true?'Изменения сохранены в автомобиле':
            storage.persistent===false?'Изменения временные • хранилище недоступно':'Изменения сохраняются после подтверждения сервиса');
        Object.keys(CARD_MOVE_NAMES).forEach(direction=>this._write(CARD_MOVE_NAMES[direction],
            {up:'↑ Выше',down:'↓ Ниже',left:'← Левее',right:'Правее →'}[direction]));
        Object.keys(CARD_SLIDERS).forEach(component=>{
            const config=CARD_SLIDERS[component], value=profile&&profile[config.key], supported=Number.isFinite(value),
                display=config.inverse?100-value:value;
            this._writeCell(component,'TextDescription',config.label+': '+(supported?(config.divisor?(display/config.divisor).toFixed(1):display)+' %':'нет данных'),'Text',0);
            this._writeCell(component,'Value',supported?Math.round((display-config.min)/5):0,'SInt',0);
            this._setEnabled(component,!!profile&&guard.allowed);
        });
        const held=this._holdBridge.status(),waitingForRenderer=move.reason==='Дождитесь подтверждения текущих настроек изображения';
        Object.keys(CARD_MOVE_NAMES).forEach(direction=>this._setEnabled(CARD_MOVE_NAMES[direction],move.allowed||
            held.held&&held.direction===direction&&held.target===target&&guard.allowed&&test.active&&test.target===target&&waitingForRenderer));
        ['cameraTestStart','cameraTestStop','cameraCardSave','cameraCardReset'].forEach(component=>this._setEnabled(component,true));
    }

    _refreshCameraFeedback() {
        const pending=this._cameraPending, result=(this._cameras.state||{}).commandResult;
        if(!pending)return;
        if(this._cameras.commandError&&this._cameras.commandErrorRequestId===pending.requestId){
            this._cameraFeedback={message:'Ошибка: '+this._cameras.commandError,requestId:pending.requestId,
                command:pending.command,target:pending.target,phase:'error'};
        }else if(result&&result.requestId===pending.requestId&&result.command===pending.command){
            if(CAMERA_TERMINAL_PHASES.indexOf(result.phase)<0){
                // Acknowledgement is not completion. Preserve the original terminal deadline.
                if(pending.pending){pending.message=cameraDiagnostics.commandText({commandResult:result});this._cameraFeedback=pending;}
                return;
            }
            // Keep this request's complete result even if a late result from another client arrives.
            this._cameraFeedback={message:cameraDiagnostics.commandText({commandResult:result}),requestId:pending.requestId,
                command:pending.command,target:pending.target,phase:result.phase};
        }else return;
        if(pending.command==='card-move'&&this._cameraFeedback.phase==='error')this._moveRepeater.stop('MOVE_REJECTED');
        this._cameraPending=null;
        clearTimeout(this._cameraCommandTimer); this._cameraCommandTimer=null;
    }

    _cameraResultView() {
        const local=this._cameraFeedback&&this._cameraFeedback.message;
        const text=cameraDiagnostics.commandText(this._cameras.state,local);
        if(text!==this._cameraResultText){this._cameraResultText=text;this._cameraResultBlock=0;}
        const result=cameraDiagnostics.commandPage(this._cameras.state,local,this._cameraResultBlock);
        this._cameraResultBlock=result.block;
        return result;
    }

    _nextCameraResult() {
        const result=this._cameraResultView();
        this._cameraResultBlock=(result.block+1)%result.blocks;
        this._renderCameras(); this._renderDiagnostics();
    }

    _exportDiagnostic() {
        try {
            if(!this._diagFrozen&&!this._cameras.state)throw new Error('Нет снимка или ответа сервиса');
            const report=this._diagFrozen||cameraDiagnostics.capture(this._cameraDiagnosticState(),this._packageJson.version,Date.now());
            const payload=JSON.stringify(report,null,2)+'\n';
            if(Buffer.byteLength(payload,'utf8')>262144)throw new Error('Отчёт больше 256 КБ; экспорт отменён');
            if(!fs.existsSync(QR_DIR))fs.mkdirSync(QR_DIR,0o700);
            const dir=path.join(QR_DIR,'diagnostics');
            if(!fs.existsSync(dir))fs.mkdirSync(dir,0o700);
            if(fs.lstatSync(QR_DIR).isSymbolicLink()||fs.lstatSync(dir).isSymbolicLink())throw new Error('Небезопасный каталог отчёта');
            const file=path.join(dir,'diagnostic-'+report.id+'.json');
            if(fs.existsSync(file)){
                if(fs.lstatSync(file).isSymbolicLink()||fs.readFileSync(file,'utf8')!==payload)throw new Error('Файл отчёта уже существует с другими данными');
            }else {
                if(fs.readdirSync(dir).filter(name=>/^diagnostic-S[A-Z0-9-]+\.json$/.test(name)).length>=20)
                    throw new Error('Сохранено 20 временных отчётов; новые снимки не записаны');
                fs.writeFileSync(file,payload,{flag:'wx',mode:0o600});
            }
            this._cameraFeedback={message:'JSON '+report.id+' сохранён локально в RAM; не отправлен. Путь: '+file};
            this._lastDiagnosticExport=file;
        }catch(err){this._cameraFeedback={message:'Экспорт: '+String(err.message||err).slice(0,150)};}
        this._renderDiagnostics();
    }

    _renderAlertPreferences() {
        if(!this._cameraState||this._shutdownPromise)return;
        const state=this._cameras.state, prefs=cameraView.alertPreferences(state), feedback=this._cameraFeedback;
        this._write('cameraPreferencesHead','Предупреждения о камерах');
        this._writeCell('cameraWarningDistance','TextDescription',prefs.available?
            'Предупреждать за: '+prefs.warningDistanceM+' м':'Дистанция: нет подтверждённых данных','Text',0);
        this._writeCell('cameraWarningDistance','Value',prefs.available?(prefs.warningDistanceM-50)/50:19,'SInt',0);
        this._setEnabled('cameraWarningDistance',prefs.available);
        const summary=!prefs.available?prefs.reason:prefs.enabledCount===0?'Все типы выключены — предупреждений не будет':
            'Типы включены: '+prefs.enabledCount+'/'+cameraView.ALERT_TYPES.length+' • дистанция '+prefs.warningDistanceM+' м';
        const temporary=state&&state.storage&&state.storage.persistent===false?' • настройки временные':'';
        this._write('cameraPreferencesStatus',summary+temporary);
        this._write('cameraPreferencesHint',prefs.available?feedback&&feedback.command==='alert-preferences'?
            feedback.message:'У комплекса достаточно любого включённого типа':'Нужен обновлённый сервис и подтверждённые настройки');
        cameraView.ALERT_TYPES.forEach(type=>{
            const name='cameraType_'+type.key;
            this._write(name,type.label+(prefs.available?'':' • нет данных'));
            this._setEnabled(name,prefs.available);
            this._setSelected(name,prefs.available?prefs.cameraTypes[type.key]:false);
        });
    }

    _renderOverspeedPreferences() {
        if(!this._cameraState||this._shutdownPromise)return;
        const state=this._cameras.state,prefs=cameraView.overspeedPreferences(state),feedback=this._cameraFeedback;
        const temporary=state&&state.storage&&state.storage.persistent===false?' • настройки временные':'';
        this._write('cameraOverspeedHead','Превышение скорости');
        this._write('cameraOverspeedRecommended','Рекомендуется: мигание +0, звук выкл (+20)');
        this._setEnabled('cameraOverspeedRecommended',prefs.available);
        this._write('cameraOverspeedStatus',!prefs.available?prefs.reason:
            'Мигание '+(prefs.visualFlash?'вкл':'выкл')+' • звук выбран '+(prefs.soundEnabled?'вкл':'выкл')+temporary);
        this._write('cameraOverspeedHint',feedback&&feedback.command==='overspeed-preferences'?feedback.message:
            'Знак не меняется. 60/+20: сигнал только свыше 80 км/ч');
        this._write('cameraVisualFlash','Мигание при превышении');
        this._write('cameraSoundEnabled','Включать звуковой сигнал');
        Object.keys(OVERSPEED_CHECKS).forEach(name=>{
            this._setEnabled(name,prefs.available);this._setSelected(name,prefs.available?prefs[OVERSPEED_CHECKS[name]]:false);
        });
        Object.keys(OVERSPEED_SLIDERS).forEach(name=>{
            const config=OVERSPEED_SLIDERS[name];
            this._writeCell(name,'TextDescription',config.label+': '+(prefs.available?'+'+prefs[config.key]+' км/ч':'нет подтверждённых данных'),'Text',0);
            this._writeCell(name,'Value',prefs.available?prefs[config.key]:0,'SInt',0);
            this._setEnabled(name,prefs.available);
        });
        this._write('cameraAudioStatus','Звук '+(prefs.audioAvailable?'доступен':'недоступен')+': '+prefs.audioReason);
        const resetAvailable=!!(state&&state.capabilities&&state.capabilities.gpsReset===true),reset=state&&state.gpsReset||{};
        this._write('cameraGpsReset','Сбросить историю GPS');this._setEnabled('cameraGpsReset',resetAvailable);
        this._write('cameraGpsResetHint',!resetAvailable?'Для сброса истории GPS обновите сервис камер':
            feedback&&feedback.command==='gps-reset'?feedback.message:
            reset.reason||reset.message||'После ошибки UTC начните новый сеанс и дождитесь свежих координат');
    }

    _renderCameras() {
        if (!this._cameraState || this._shutdownPromise) return;
        const view = cameraView.model(this._cameras.state);
        if (!this._cameras.state) view.text.cameraStatus = this._cameras.diagnostic();
        if (this._cameraInfoMode === 'diagnostics') view.text.cameraInfo = this._cameras.state ? cameraView.diagnostics(this._cameras.state) : this._cameras.diagnostic();
        const result=this._cameraResultView();
        view.text.cameraCommand=result.command; view.text.cameraCommandMore=result.commandMore;
        view.text.cameraResultMore=result.label;
        Object.keys(view.text).forEach((name) => this._write(name, view.text[name]));
        Object.keys(view.enabled).forEach((name) => this._setEnabled(name, view.enabled[name]));
        this._setEnabled('cameraResultMore',true);
        this._renderAlertPreferences();
        this._renderOverspeedPreferences();
        this._renderCameraCard();
        this._renderDiagnostics();
    }

    _renderDiagnostics() {
        if (!this._diagState || this._shutdownPromise) return;
        const result=this._cameraResultView();
        const page=cameraDiagnostics.reportPage(this._diagFrozen,this._cameraDiagnosticState(),this._packageJson.version,this._diagPage,this._diagBlock,
            this._cameraFeedback&&this._cameraFeedback.message,result.block);
        this._diagBlock=page.block;
        cameraDiagnostics.PAGE_KEYS.forEach(key=>this._write('cameraDiag_'+key,page.rows[key]));
        this._write('cameraDiagFreeze','Зафиксировать снимок'); this._write('cameraDiagLive','Живые данные');
        this._write('cameraDiagPrev','← Предыдущая страница'); this._write('cameraDiagNext','Следующая страница →');
        this._write('cameraDiagMore',page.blocks>1?'Следующие строки • '+(page.block+1)+'/'+page.blocks:'Все строки показаны');
        this._write('cameraDiagResultMore',result.label);
        this._write('cameraDiagTest','Тест изображения • на стоянке');
        this._write('cameraDiagCalibration','Проверить границы • на стоянке');
        this._write('cameraDiagAudio','Проверить звук'); this._write('cameraDiagExport','Сохранить JSON локально • RAM');
        // Keep diagnostic actions reachable: every press either acts or explains the exact service guard.
        ['cameraDiagFreeze','cameraDiagLive','cameraDiagTest','cameraDiagCalibration','cameraDiagAudio','cameraDiagExport',
            'cameraDiagPrev','cameraDiagNext','cameraDiagMore','cameraDiagResultMore'].forEach(name=>this._setEnabled(name,true));
    }

    _renderLogs() {
        if (!this._logsState || this._shutdownPromise) {
            return;
        }
        this._write(LOGS_SAVE, t('Save logs'));
        this._write(LOGS_STATUS, this._logs.statusText());
        this._write(LOGS_URL, this._logs.urlText());
        this._setEnabled(LOGS_SAVE, this._logs.canSave());
        const rows = this._logs.rows();
        LOGS_ROW_NAMES.forEach((name, i) => this._write(name, oneRow(rows[i])));
        this._showQr(this._logs.url());
    }

    /* Writes url's QR code (none: a blank square) as a new file and shows it,
     * then removes the one it replaced. */
    _showQr(url) {
        const rhmi = this.rhmiApplication;
        if (this._qr.url === url || !rhmi) {
            return this._qr.chain;
        }
        this._qr.url = url;
        this._qr.chain = this._qr.chain.then(() => {
            /* the HMI reads the picture: the folder and the file world-readable */
            try {
                fs.mkdirSync(QR_DIR);
            } catch (e) {
                if (e.code !== 'EEXIST') {
                    throw e;
                }
            }
            fs.chmodSync(QR_DIR, 0o755);
            const file = path.join(QR_DIR, `qr_${Date.now()}.png`);
            fs.writeFileSync(file, qrPng(url).png);
            fs.chmodSync(file, 0o644);
            const bundle = rhmi.getResourceBundle();
            const old = this._qr.file;
            return Promise.resolve(bundle.createResourceHandles([file]))
                .then(() => this._components[LOGS_QR].setValue(0, 'Graphic', file, 'ResourceId'))
                .then(() => rhmi.flush())
                .then(() => {
                    this._qr.file = file;
                    return old ? this._retireQr(bundle, old) : undefined;
                });
        }).catch((err) => {
            this._qr.url = undefined;
            logger.warn(`QR code failed: ${err && err.message}`);
        });
        return this._qr.chain;
    }

    _retireQr(bundle, file) {
        return Promise.resolve()
            .then(() => bundle.destroyResourceHandles([file]))
            .catch((err) => logger.warn(`QR handle ${file}: ${err && err.message}`))
            .then(() => {
                try {
                    fs.unlinkSync(file);
                } catch (e) {
                    /* gone already */
                }
            });
    }

    _removeStaleQr() {
        try {
            fs.readdirSync(QR_DIR).filter((n) => /^qr_\d+\.png$/.test(n))
                .forEach((n) => fs.unlinkSync(path.join(QR_DIR, n)));
        } catch (e) {
            /* no folder yet */
        }
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`robertn_waze_cluster shutdown: ${JSON.stringify(reason)}`);
        this._shuttingDown = true;
        clearTimeout(this._cameraCommandTimer); this._cameraCommandTimer=null;
        clearTimeout(this._hideTimer);
        this._control.close();
        this._logs.close();
        this._cameras.close();
        this._gpsBridge.stop();
        this._navigationBridge.stop();
        this._moveRepeater.close();this._holdBridge.close();
        if (this._qr.file) {
            try {
                fs.unlinkSync(this._qr.file);
            } catch (e) {
                /* gone already */
            }
        }
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new WazeClusterApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`robertn_waze_cluster failed to start: ${err && err.message}`);
});
