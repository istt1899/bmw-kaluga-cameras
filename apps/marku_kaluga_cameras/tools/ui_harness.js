// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Actual application source, native graph, event routing and widget proposals.
// No sockets, QR files, background GPS or vehicle services are started here.
const assert=require('assert'),fs=require('fs'),path=require('path'),Module=require('module'),EventEmitter=require('events');
const appDir=path.join(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(appDir,'mgu-app.json'),'utf8'));
const folder=path.join(appDir,manifest.tree,'rhmiData/uiDescriptions/ID7');
const ui=JSON.parse(fs.readFileSync(path.join(folder,'uiDescription.json'),'utf8')),xml=fs.readFileSync(path.join(folder,'application.xml'),'utf8');
function create(){
    const byName={},commands=[],stats={cameraOpens:0,cameraCloses:0,controlCloses:0,gpsStops:0,active:0,inactive:0,hmi:0};
    class Component extends EventEmitter{
        constructor(id,desc){super();this.id=Number(id);this.desc=desc;this.cells={};this.enabled=true;this.selected=null;this.step=null;this.resources=0;this.visible=true;
            if(desc.type==='label')this.setEnabled=undefined;
            if(desc.type==='slider'||desc.type==='dropDownMenu')this.setEnabled=this.setVisible=undefined;
        }
        getId(){return this.id;}
        setValue(){const a=Array.prototype.slice.call(arguments),offset=a.length===4?1:0,key=(offset?a[0]+':':'')+a[offset];
            this.cells[key]=a[offset+1];if(a[offset]==='eParam_RowSelected')this.selected=a[offset+1];return Promise.resolve();}
        setStepValue(value){if(value!==this.step){this.step=value;this.emit('changed',value);}return this.setValue(0,'Value',value,'SInt');}
        setEnabled(value){this.enabled=value;return Promise.resolve();}
        setProperty(name,value){assert.strictEqual(name,'Enabled');this.enabled=value===1;return Promise.resolve();}
        setVisible(value){this.visible=value;return Promise.resolve();}
        updateResources(){this.resources++;return Promise.resolve();}
        press(){if(!this.enabled)return false;if(this.desc.type==='checkBox')this.selected=!this.selected;this.emit('action');return true;}
        pick(row){if(this.enabled){this.cells.SelectedItem=row;this.emit('action',{row});}}
        propose(value){this.emit('changed',value);this.cells['0:Value']=value;}
        text(){return this.cells['0:Text'];}
    }
    Object.keys(ui.containers).forEach(id=>{const c=ui.containers[id];byName[c.name]=new Component(id,c);
        Object.keys(c.components).forEach(key=>{const d=c.components[key];byName[d.name]=new Component(key,d);});});
    const rhmi=new EventEmitter();rhmi.getByName=name=>byName[name];rhmi.opened=[];rhmi.order='hide-first';
    let current=null,controller=null,button=0,getter=()=>Promise.resolve({frontRotaryEncoderPushButton:button});
    const builders={buildAndInitTypedProxy(){return Promise.resolve({statusRotaryEncoderState:{
        subscribe(fn){controller=fn;return Promise.resolve();},getValue(){return getter();}
    }});}};
    rhmi.openState=name=>{assert(byName[name]&&byName[name].desc.type==='state',name);rhmi.opened.push(name);
        const previous=current;current=name;
        if(previous===name){byName[name].emit('visible',{visible:true});return Promise.resolve();}
        if(rhmi.order==='show-first')byName[name].emit('visible',{visible:true});
        if(previous)byName[previous].emit('visible',{visible:false});
        if(rhmi.order!=='show-first')byName[name].emit('visible',{visible:true});
        return Promise.resolve();};
    const logger={};['info','warn','error','debug','verbose'].forEach(key=>{logger[key]=()=>{};});
    class OnlineApp extends EventEmitter{
        constructor(){super();this._packageJson={version:manifest.version};this.rhmiApplication=rhmi;this._initialized=true;this._appStatusService={};}
        registerActive(){stats.active++;return Promise.resolve();} registerInactive(){stats.inactive++;return Promise.resolve();}
        registerHmiVisible(){stats.hmi++;return Promise.resolve();} unregisterHmiVisible(){stats.hmi--;return Promise.resolve();}
    }
    const sourcePath=path.join(appDir,'src/robertn_waze_cluster.js'),loaded=new Module(sourcePath,module),load=Module._load;
    loaded.filename=sourcePath;loaded.paths=Module._nodeModulePaths(path.dirname(sourcePath));
    Module._load=function(name,parent,isMain){
        if(name==='oap-sdk/src/core/OnlineApp.js')return OnlineApp;
        if(name==='oap-sdk/src/logging/logging')return{getSDKLogger:()=>logger};
        if(name==='oap-sdk/src/someip/someipBuilders')return builders;
        return load.call(this,name,parent,isMain);
    };
    try{loaded._compile(fs.readFileSync(sourcePath,'utf8').replace(/const app = new WazeClusterApp\(\);[\s\S]*$/,'module.exports=WazeClusterApp;'),sourcePath);}finally{Module._load=load;}
    const app=new loaded.exports();app._removeStaleQr=app._render=app._renderLogs=()=>{};
    app._cameras.open=()=>{stats.cameraOpens++;app._cameras.opened=true;};
    app._cameras.close=()=>{stats.cameraCloses++;app._cameras.opened=false;};
    app._cameras.send=command=>{commands.push(Object.assign({},command));return true;};app._cameras.link='up';
    app._control.open=()=>{};app._control.close=()=>{stats.controlCloses++;};app._logs.close=()=>{};
    app._gpsBridge.running=true;app._gpsBridge.enabled=true;app._gpsBridge.stop=()=>{stats.gpsStops++;};
    return {app,byName,rhmi,commands,stats,ui,xml,manifest,
        setState(state){app._cameras.state=state;app._cameras.emit('change');},
        reset(){clearTimeout(app._cameraCommandTimer);app._cameraCommandTimer=null;app._cameraPending=null;app._cameraFeedback=null;
            app._cameras.commandError=null;app._cameras.commandErrorRequestId=null;},
        async enter(name,order){if(order)rhmi.order=order;return rhmi.openState(name);},
        back(){const id=byName[current].desc.properties.ParentState.value;return rhmi.openState(ui.containers[id].name);},
        controller(value){button=value;assert(controller,'controller subscribed');controller({frontRotaryEncoderPushButton:value});},
        getter(fn){getter=fn;},current:()=>current,
        close(){app._shutdownPromise=Promise.resolve();clearTimeout(app._hideTimer);clearTimeout(app._cameraCommandTimer);
            app._moveRepeater.close();app._holdBridge.close();app._navigationBridge.stop();}
    };
}
module.exports={create,ui,xml};
