// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Run the actual app handlers against native-widget proposals. This isolated
// harness creates no QR files, sockets, audio adapters, or vehicle connections.
const assert=require('assert'),fs=require('fs'),path=require('path'),Module=require('module'),EventEmitter=require('events');
const view=require('../src/view_model'),diagnostics=require('../src/diagnostics_view');
const appDir=path.join(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(appDir,'mgu-app.json'),'utf8'));
const stage=path.join(appDir,manifest.tree,'rhmiData/uiDescriptions/ID7');
const ui=JSON.parse(fs.readFileSync(path.join(stage,'uiDescription.json'),'utf8')),xml=fs.readFileSync(path.join(stage,'application.xml'),'utf8'),byName={};
class Component extends EventEmitter{
    constructor(id,desc){super();this.id=Number(id);this.desc=desc;this.cells={};this.selected=null;this.enabled=null;this.step=null;}
    getId(){return this.id;}
    setValue(){const args=Array.prototype.slice.call(arguments),offset=args.length===4?1:0,key=(offset?args[0]+':':'')+args[offset];
        this.cells[key]=args[offset+1];if(args[offset]==='eParam_RowSelected')this.selected=args[offset+1];return Promise.resolve();}
    setStepValue(value){if(value!==this.step){this.step=value;this.emit('changed',value);}return this.setValue(0,'Value',value,'SInt');}
    setEnabled(value){this.enabled=value;return Promise.resolve();}
    setProperty(name,value){if(name==='Enabled')this.enabled=value===1;return Promise.resolve();}
    setVisible(){return Promise.resolve();}
    updateResources(){return Promise.resolve();}
    press(){if(this.desc.type==='checkBox')this.selected=!this.selected;this.emit('action');}
    propose(step){this.emit('changed',step);this.step=step;this.cells['0:Value']=step;}
}
Object.keys(ui.containers).forEach(id=>{
    const container=ui.containers[id];byName[container.name]=new Component(id,container);
    Object.keys(container.components).forEach(key=>{const c=container.components[key];byName[c.name]=new Component(key,c);});
});
const rhmi=new EventEmitter();rhmi.getByName=name=>byName[name];rhmi.openState=()=>Promise.resolve();
const logger={};['info','warn','error','verbose','debug'].forEach(key=>logger[key]=()=>{});
class OnlineApp extends EventEmitter{constructor(){super();this._packageJson={version:manifest.version};this.rhmiApplication=rhmi;}}
const sourcePath=path.join(appDir,'src/robertn_waze_cluster.js');
const source=fs.readFileSync(sourcePath,'utf8').replace(/const app = new WazeClusterApp\(\);[\s\S]*$/,'module.exports = WazeClusterApp;');
const load=Module._load,loaded=new Module(sourcePath,module);loaded.filename=sourcePath;loaded.paths=Module._nodeModulePaths(path.dirname(sourcePath));
Module._load=function(name,parent,isMain){
    if(name==='oap-sdk/src/core/OnlineApp.js')return OnlineApp;
    if(name==='oap-sdk/src/logging/logging')return{getSDKLogger:()=>logger};
    if(name==='oap-sdk/src/someip/someipBuilders')return{};
    return load.call(this,name,parent,isMain);
};
try{loaded._compile(source,sourcePath);}finally{Module._load=load;}
const app=new loaded.exports(),commands=[],tick=()=>new Promise(resolve=>setImmediate(resolve));
app._removeStaleQr=app._render=app._renderLogs=()=>{};
app._cameras.send=command=>{commands.push(command);return true;};app._cameras.link='up';
const allTypes=()=>view.ALERT_TYPES.reduce((result,type)=>{result[type.key]=true;return result;},{});
function state(){return {enabled:true,capabilities:{alertPreferences:true,overspeedPreferences:true,gpsReset:true},
    alertPreferences:{warningDistanceM:950,cameraTypes:allTypes()},overspeedPreferences:Object.assign({},view.OVERSPEED_RECOMMENDED),
    audio:{available:false,phase:'unavailable',reason:'Канал BMW не подтверждён'},storage:{persistent:true},outputs:{},observedAtMs:2000,
    gpsFix:{timeMs:2000,speedKmh:80.1},gpsReset:{phase:'waiting-fresh',reason:'Ожидание новых пригодных координат'},
    actions:{audioTest:{allowed:false,code:'AUDIO_UNAVAILABLE',reason:'Канал BMW не подтверждён'}},
    speedWarning:{eligible:true,reason:'READY',speedKmh:80.1,limitKmh:60,
        visualBoundaryKmh:60,soundBoundaryKmh:80,flashActive:true,soundExceeded:true,nested:{marker:'last-policy-field'}},
    database:{coverage:{complete:false,sourceRecords:308,directLimit:106,referenceLimit:97,unknownLimit:105,
        roadZones:19,numericRoadZones:18,recordsWithoutRoadZone:289,facingKnown:20,captureSideKnown:0}},
    nearest:{id:'osm:node:1',cameraFacing:{state:'mapped',bearingsDeg:[310],raw:'310',interpretation:'camera-facing',
        sourceUrl:'https://www.openstreetmap.org/node/1'},captureDirection:'front',captureDirectionVerified:false}};}
function resetCommand(){clearTimeout(app._cameraCommandTimer);app._cameraCommandTimer=null;app._cameraPending=null;app._cameraFeedback=null;
    app._cameras.commandError=null;app._cameras.commandErrorRequestId=null;}
function apply(next){app._cameras.state=next;app._renderCameras();}
function press(name,raw){app._lastPress[name]=0;const c=byName[name];if(raw)rhmi.emit('userEvent',{eventType:'ACTION',sourceId:c.id});else c.press();}
function rows(report,live,page){let result=[],block=0;while(true){const p=diagnostics.reportPage(report,live,manifest.version,page,block);
    diagnostics.PAGE_KEYS.filter(k=>/^row/.test(k)).forEach(k=>result.push(p.rows[k]));if(++block>=p.blocks)break;}return result.join(' ');}
let count=0;
function check(label,fn){fn();console.log('ok '+(++count)+' - '+label);}
(async()=>{
    await app._setupRhmi();apply(state());await tick();
    check('native order, two checkboxes, two 0–30 sliders and explicit recommendation',()=>{
        const camera=ui.containers['3'].components,section=xml.split('<container id="3"')[1].split('<container id="4"')[0];
        const names=[],regex=/<component id="(\d+)"/g;let match;while((match=regex.exec(section)))names.push(camera[match[1]].name);
        assert(names.indexOf('cameraOverspeedHead')>names.indexOf('cameraPreferencesHint'));
        assert(names.indexOf('cameraGpsResetHint')<names.indexOf('cameraHeadCalibration'));
        ['cameraVisualFlash','cameraSoundEnabled'].forEach(name=>assert.strictEqual(byName[name].desc.type,'checkBox'));
        ['cameraVisualOffset','cameraSoundOffset'].forEach(name=>{
            const r=byName[name].desc.rows[0];assert.deepStrictEqual([r.MinValue.value,r.MaxValue.value,r.NumberOfSteps.value],[0,30,30]);
        });
        assert.strictEqual(byName.cameraOverspeedHead.desc.properties.Focusable.value,0);
        assert.strictEqual(commands.filter(c=>c.cmd==='overspeed-preferences'||c.cmd==='gps-reset').length,0,'no automatic preset/reset');
        assert.strictEqual(byName.cameraVisualFlash.selected,true);assert.strictEqual(byName.cameraSoundEnabled.selected,false);
    });
    for(const pair of [['cameraVisualOffset','visualOffsetKmh'],['cameraSoundOffset','soundOffsetKmh']]){
        for(let step=0;step<=30;step++){
            resetCommand();commands.length=0;const before=state();apply(before);byName[pair[0]].propose(step);await tick();
            assert.strictEqual(byName[pair[0]].cells['0:Value'],before.overspeedPreferences[pair[1]],'wait for confirmed value');
            assert.strictEqual(commands.length,step===before.overspeedPreferences[pair[1]]?0:1);
            if(commands.length){assert.deepStrictEqual(Object.keys(commands[0]).sort(),['cmd',pair[1],'requestId'].sort());
                assert.strictEqual(commands[0][pair[1]],step);assert.strictEqual(commands[0].cmd,'overspeed-preferences');}
            const confirmed=state();confirmed.overspeedPreferences[pair[1]]=step;apply(confirmed);await tick();
            assert.strictEqual(byName[pair[0]].cells['0:Value'],step);
        }
        for(const invalid of [-1,31,0.5,NaN,Infinity,'2']){resetCommand();commands.length=0;apply(state());byName[pair[0]].propose(invalid);await tick();assert.strictEqual(commands.length,0);}
    }
    check('all 62 slider choices and malformed steps preserve service confirmation and partial patches',()=>{});
    for(const pair of [['cameraVisualFlash','visualFlash'],['cameraSoundEnabled','soundEnabled']]){
        resetCommand();commands.length=0;apply(state());const c=byName[pair[0]],previous=app._cameras.state.overspeedPreferences[pair[1]];
        press(pair[0]);assert.strictEqual(commands.length,1);assert.deepStrictEqual(Object.keys(commands[0]).sort(),['cmd',pair[1],'requestId'].sort());
        assert.strictEqual(commands[0][pair[1]],!previous);assert.strictEqual(c.selected,previous);
        c.press();rhmi.emit('userEvent',{eventType:'ACTION',sourceId:c.id});assert.strictEqual(commands.length,1);assert.strictEqual(c.selected,previous);
        const confirmed=state();confirmed.overspeedPreferences[pair[1]]=!previous;apply(confirmed);assert.strictEqual(c.selected,!previous);
    }
    check('native/raw duplicate checkbox deliveries never drift desired settings',()=>{
        assert.strictEqual(byName.cameraSoundEnabled.selected,true);assert(/недоступен/.test(byName.cameraAudioStatus.cells['0:Text']));
        assert(!/воспроизвед|played/i.test(byName.cameraAudioStatus.cells['0:Text']));
    });
    resetCommand();commands.length=0;const manual=state();Object.assign(manual.overspeedPreferences,{visualFlash:false,visualOffsetKmh:11,soundEnabled:true,soundOffsetKmh:7});apply(manual);
    press('cameraOverspeedRecommended');
    check('one-tap recommended profile is exact, leaves audio off and waits for acknowledgement',()=>{
        const sent=Object.assign({},commands[0]);delete sent.requestId;
        assert.deepStrictEqual(sent,Object.assign({cmd:'overspeed-preferences'},view.OVERSPEED_RECOMMENDED));
        assert.strictEqual(byName.cameraVisualFlash.selected,false);assert.strictEqual(byName.cameraSoundEnabled.selected,true);
        assert.strictEqual(app._cameras.state.alertPreferences.warningDistanceM,950);
        const confirmed=state();confirmed.storage.persistent=false;apply(confirmed);
        assert.strictEqual(byName.cameraSoundEnabled.selected,false);assert(/временные/.test(byName.cameraOverspeedStatus.cells['0:Text']));
    });
    const unavailable=[null,{},Object.assign(state(),{capabilities:{}}),Object.assign(state(),{overspeedPreferences:{visualFlash:true,soundEnabled:false,visualOffsetKmh:0,soundOffsetKmh:'20'}})];
    for(const previous of unavailable){
        resetCommand();commands.length=0;apply(previous);await tick();
        ['cameraOverspeedRecommended','cameraVisualFlash','cameraSoundEnabled','cameraVisualOffset','cameraSoundOffset'].forEach(name=>assert.strictEqual(byName[name].enabled,false));
        press('cameraOverspeedRecommended');press('cameraVisualFlash');press('cameraSoundEnabled',true);byName.cameraVisualOffset.propose(2);byName.cameraSoundOffset.propose(2);await tick();
        assert.strictEqual(commands.length,0);assert(/недоступен|обновите сервис|Ожидание подтверждённых/.test(byName.cameraOverspeedStatus.cells['0:Text']));
    }
    check('older/absent/incomplete service cannot receive unsupported overspeed patches',()=>{});
    resetCommand();apply(state());commands.length=0;press('cameraSoundEnabled');const pending=app._cameraPending,timer=app._cameraCommandTimer;
    app._cameras.state.commandResult={command:'overspeed-preferences',phase:'requested',requestId:pending.requestId};app._refreshCameraFeedback();
    assert.strictEqual(app._cameraCommandTimer,timer);
    app._cameras.commandError='Настройки не приняты';app._cameras.commandErrorRequestId=pending.requestId;app._refreshCameraFeedback();app._renderCameras();
    check('rejected settings restore the confirmed checkbox and expose the real error',()=>{
        assert.strictEqual(byName.cameraSoundEnabled.selected,false);assert.strictEqual(app._cameraCommandTimer,null);
        assert(/Настройки не приняты/.test(byName.cameraOverspeedHint.cells['0:Text']));
    });
    resetCommand();commands.length=0;apply(state());press('cameraDiagAudio');
    check('unavailable audio test explains its guard without a fabricated request or playback',()=>{
        assert.strictEqual(commands.length,0);assert(/Канал BMW не подтверждён/.test(app._cameraResultView().text));
    });
    resetCommand();commands.length=0;const utcError=state();utcError.gps='UTC пришёл в обратном порядке';apply(utcError);await tick();
    assert.strictEqual(commands.length,0);press('cameraGpsReset');
    check('GPS reset is explicit, capability-gated and asks for fresh coordinates',()=>{
        assert.strictEqual(commands.length,1);assert.strictEqual(commands[0].cmd,'gps-reset');
        assert(/свежие координаты/.test(byName.cameraGpsResetHint.cells['0:Text']));
        resetCommand();commands.length=0;const old=state();old.capabilities.gpsReset=false;apply(old);press('cameraGpsReset',true);
        assert.strictEqual(byName.cameraGpsReset.enabled,false);assert.strictEqual(commands.length,0);
    });
    resetCommand();const live=state(),snapshot=diagnostics.capture(live,manifest.version,2000);
    live.overspeedPreferences.soundOffsetKmh=1;live.speedWarning.reason='GPS_STALE';live.speedWarning.nested.marker='changed';live.nearest.cameraFacing.bearingsDeg[0]=20;
    check('frozen six-page diagnostic preserves precise policy, audio outcome, reset and source-facing evidence',()=>{
        const camera=rows(snapshot,live,2),compact=camera.replace(/\s/g,'');
        assert(compact.includes('"speedKmh":80.1'));assert(compact.includes('"soundBoundaryKmh":80'));assert(compact.includes('"soundOffsetKmh":20'));
        assert(compact.includes('READY')&&compact.includes('last-policy-field'));assert(!compact.includes('GPS_STALE'));
        assert(rows(snapshot,live,0).includes('Политика превышения: доступна'));
        assert(camera.includes('310°')&&camera.includes('https://www.openstreetmap.org/node/1'));
        assert(rows(snapshot,live,3).includes('unavailable'));assert(rows(snapshot,live,1).includes('waiting-fresh'));
        assert(rows(null,live,2).includes('GPS_STALE'));
        ['GPS_STALE','ROAD_UNCONFIRMED','LIMIT_UNKNOWN','TYPE_DISABLED','TEST'].forEach(reason=>{
            const denied=state();denied.speedWarning={eligible:false,reason};assert(rows(null,denied,2).includes(reason));
            assert(rows(null,denied,0).includes('Политика превышения: недоступна'));
        });
    });
    check('coverage distinguishes 203 source limits from 18 numerical road zones and never invents capture side',()=>{
        const text=rows(snapshot,live,5),m=view.model(state());
        ['106','97','105','289','18','19','20'].forEach(number=>assert(text.includes(number)));
        assert(text.includes('Покрытие неполное'));assert(m.text.cameraCoverageRoad.includes('с лимитом 18'));
        assert(m.text.cameraCoverageLimits.includes('справочные 97'));assert(m.text.cameraMotion.includes('80.1'));
        assert(m.text.cameraFacing.includes('объектив OSM: 310°'));assert(!/спереди|сзади/.test(m.text.cameraFacing));
        assert(m.text.cameraDirection.includes('неизвестно'),'unverified capture direction stays unknown');
        assert(view.cameraFacing({cameraFacing:{state:'mapped',bearingsDeg:[90],interpretation:'traffic-direction'}}).includes('неизвестно'));
    });
    console.log('PASS overspeed UI: '+count+' checks, 62 native slider values, frozen six-page evidence, no hardware claims');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).then(()=>{
    app._shutdownPromise=Promise.resolve();resetCommand();app._moveRepeater.close();app._holdBridge.close();app._gpsBridge.stop();app._navigationBridge.stop();
    app._cameras.close();app._control.close();app._logs.close();
});
