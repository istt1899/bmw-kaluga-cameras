// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Actual app handlers with native-widget proposals, no sockets, QR directory,
// SDK provider, or vehicle writes. Keep independent from test_page's resources.
const assert=require('assert'),fs=require('fs'),path=require('path'),Module=require('module'),EventEmitter=require('events');
const view=require('../src/view_model'),diagnostics=require('../src/diagnostics_view');
const appDir=path.join(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(appDir,'mgu-app.json'),'utf8'));
const staged=path.join(appDir,manifest.tree),ui=JSON.parse(fs.readFileSync(path.join(staged,'rhmiData/uiDescriptions/ID7/uiDescription.json'),'utf8'));
const byName={};
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
    // The SDK tells listeners, then writes the proposed new step itself.
    propose(step){this.emit('changed',step);this.step=step;this.cells['0:Value']=step;}
}
Object.keys(ui.containers).forEach(id=>{
    const container=ui.containers[id];byName[container.name]=new Component(id,container);
    Object.keys(container.components).forEach(key=>{const c=container.components[key];byName[c.name]=new Component(key,c);});
});
const rhmi=new EventEmitter();rhmi.getByName=name=>byName[name];rhmi.openState=()=>Promise.resolve();
const logger={};['info','warn','error','verbose','debug'].forEach(key=>logger[key]=()=>{});
class OnlineApp extends EventEmitter{
    constructor(){super();this._packageJson={version:manifest.version};this.rhmiApplication=rhmi;}
}
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
const App=loaded.exports,app=new App(),commands=[];
app._removeStaleQr=app._render=app._renderLogs=()=>{};
app._cameras.send=command=>{commands.push(command);return true;};app._cameras.link='up';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const allTypes=()=>view.ALERT_TYPES.reduce((result,type)=>{result[type.key]=true;return result;},{});
const state=()=>({enabled:true,capabilities:{alertPreferences:true},alertPreferences:{warningDistanceM:1000,cameraTypes:allTypes()},
    storage:{persistent:true},observedAtMs:2000,outputs:{},guidance:{mode:'road',reason:'TRACKING_APPROACH',
        transition:{from:'nearby',to:'road',reason:'ENTERED',cameraId:'camera-long-id',timeMs:1800}},
    nearest:{id:'mixed',title:'Комплекс',description:'Полоса, скорость и светофор',controls:['lane','speed','redlight'],filterMatched:true}});
function resetCommand(){clearTimeout(app._cameraCommandTimer);app._cameraCommandTimer=null;app._cameraPending=null;app._cameraFeedback=null;}
function apply(next){app._cameras.state=next;app._renderCameras();}
function rows(report,live,page){let block=0,result=[];do{const p=diagnostics.reportPage(report,live,manifest.version,page,block);
    diagnostics.PAGE_KEYS.filter(k=>/^row/.test(k)).forEach(k=>result.push(p.rows[k]));if(++block>=p.blocks)break;}while(true);return result.join(' ');}
let count=0;
function check(label,fn){fn();console.log('ok '+(++count)+' - '+label);}
(async()=>{
    await app._setupRhmi();apply(state());await tick();
    check('native range and all eleven default checks are explicit',()=>{
        assert.strictEqual(view.ALERT_TYPES.length,11);const c=byName.cameraWarningDistance;
        assert.strictEqual(c.desc.rows[0].MinValue.value,0);assert.strictEqual(c.desc.rows[0].MaxValue.value,19);
        assert.strictEqual(c.desc.rows[0].NumberOfSteps.value,19);assert.strictEqual(c.cells['0:Value'],19);
        view.ALERT_TYPES.forEach(t=>{assert.strictEqual(byName['cameraType_'+t.key].desc.rows[0].eParam_RowSelected.value,true);
            assert.strictEqual(byName['cameraType_'+t.key].selected,true);});
    });
    for(let step=0;step<20;step++){
        resetCommand();commands.length=0;apply(state());byName.cameraWarningDistance.propose(step);await tick();
        assert.strictEqual(byName.cameraWarningDistance.cells['0:Value'],19,'slider must wait for confirmed state');
        assert.strictEqual(commands.length,step===19?0:1);
        if(step!==19){assert.strictEqual(commands[0].warningDistanceM,50+step*50);assert.strictEqual(commands[0].cmd,'alert-preferences');
            const confirmed=state();confirmed.alertPreferences.warningDistanceM=50+step*50;apply(confirmed);await tick();
            assert.strictEqual(byName.cameraWarningDistance.cells['0:Value'],step);}
    }
    check('all twenty slider values including 950 wait for service confirmation',()=>{});
    for(const step of [-1,20,1.5,NaN,'2']){resetCommand();commands.length=0;apply(state());byName.cameraWarningDistance.propose(step);await tick();
        assert.strictEqual(commands.length,0);assert.strictEqual(byName.cameraWarningDistance.cells['0:Value'],19);}
    check('malformed or out-of-range widget steps cannot issue a patch',()=>{});
    for(const type of view.ALERT_TYPES){
        resetCommand();commands.length=0;apply(state());const name='cameraType_'+type.key,c=byName[name];app._lastPress[name]=0;c.press();
        assert.strictEqual(commands.length,1);assert.deepStrictEqual(commands[0].cameraTypes,{[type.key]:false});
        assert.strictEqual(c.selected,true,'native optimistic tick restored');
        c.press();assert.strictEqual(commands.length,1,'duplicate action suppressed');assert.strictEqual(c.selected,true,'duplicate must not drift checkbox');
        rhmi.emit('userEvent',{eventType:'ACTION',sourceId:c.id});assert.strictEqual(commands.length,1);
        const confirmed=state();confirmed.alertPreferences.cameraTypes[type.key]=false;apply(confirmed);assert.strictEqual(c.selected,false);
    }
    check('every type sends a partial patch; duplicate native/raw delivery cannot drift a tick',()=>{});
    resetCommand();commands.length=0;apply(state());
    for(const key of ['speed','lane']){app._lastPress['cameraType_'+key]=0;byName['cameraType_'+key].press();}
    check('rapid changes of different types never send a stale full configuration',()=>{
        assert.strictEqual(commands.length,2);assert.deepStrictEqual(commands.map(c=>c.cameraTypes),[{speed:false},{lane:false}]);
    });
    resetCommand();const none=state();Object.keys(none.alertPreferences.cameraTypes).forEach(key=>none.alertPreferences.cameraTypes[key]=false);apply(none);
    check('all disabled is visible and mixed-control description is preserved',()=>{
        assert(/Все типы выключены/.test(byName.cameraPreferencesStatus.cells['0:Text']));
        assert(view.model(none).text.cameraDescription.includes(none.nearest.description));
        none.nearest.filterMatched=false;assert(/Ближайшая: .*тип отключён/.test(view.model(none).text.cameraAlert));
    });
    for(const unavailable of [null,{},Object.assign(state(),{capabilities:{}}),Object.assign(state(),{alertPreferences:{warningDistanceM:500,cameraTypes:{speed:true}}})]){
        resetCommand();commands.length=0;apply(unavailable);await tick();assert.strictEqual(byName.cameraWarningDistance.enabled,false);
        byName.cameraWarningDistance.propose(1);await tick();
        for(const type of view.ALERT_TYPES){const name='cameraType_'+type.key;assert.strictEqual(byName[name].enabled,false);app._lastPress[name]=0;byName[name].press();}
        assert.strictEqual(commands.length,0);assert(/Сервис недоступен|обновите сервис|Ожидание подтверждённых/.test(byName.cameraPreferencesStatus.cells['0:Text']));
    }
    check('older, absent or incomplete service state is explained and never receives unsupported patches',()=>{});
    resetCommand();apply(state());commands.length=0;byName.cameraWarningDistance.propose(9);await tick();
    const pending=app._cameraPending,timer=app._cameraCommandTimer;
    app._cameras.state.commandResult={command:'alert-preferences',phase:'requested',requestId:pending.requestId,id:41};app._refreshCameraFeedback();
    check('requested keeps the watchdog; exact error restores controls with real failure text',()=>{
        assert.strictEqual(app._cameraCommandTimer,timer);assert.strictEqual(app._cameraPending,pending);
        app._cameras.commandError='Отказ записи настроек';app._cameras.commandErrorRequestId=pending.requestId;app._refreshCameraFeedback();app._renderCameras();
        assert.strictEqual(app._cameraCommandTimer,null);assert.strictEqual(byName.cameraWarningDistance.cells['0:Value'],19);
        assert(app._cameraResultView().text.includes('Отказ записи настроек'));app._cameras.commandError=null;
    });
    resetCommand();const live=state(),snap=diagnostics.capture(live,manifest.version,2000);live.alertPreferences.warningDistanceM=50;live.alertPreferences.cameraTypes.speed=false;
    check('six-page report preserves frozen settings, full type list and exact transition',()=>{
        const text=rows(snap,live,2);assert(text.includes('Настроенная дистанция: 1000 м'));
        view.ALERT_TYPES.forEach(type=>assert(text.includes(type.label+': вкл')));
        assert(text.includes('nearby → road')&&text.includes('ENTERED')&&text.includes('camera-long-id'));
        assert(rows(null,live,0).includes('Настроенная дистанция: 50 м'));
    });
    console.log('PASS alert preferences UI: '+count+' checks, twenty distances and eleven controls');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).then(()=>{
    app._shutdownPromise=Promise.resolve();resetCommand();app._moveRepeater.close();app._holdBridge.close();app._gpsBridge.stop();app._navigationBridge.stop();
    app._cameras.close();app._control.close();app._logs.close();
});
