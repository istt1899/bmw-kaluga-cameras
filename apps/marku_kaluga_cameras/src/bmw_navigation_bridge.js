// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Optional read-only native capabilities. A field must exist in the installed
// SDK and be available on this car; no CAN scale, street or audio route guessed.
const EventEmitter = require('events');
const NAV = 'de.bmw.infotainment.navigation.positioning.Positioning';
const GONG = 'de.bmw.infotainment.gp.gongplayer.IGPCommand';
function streetOf(value) {
    if (!value || (value.status !== 'ON_ROAD' && value.status !== 1)) return null;
    const text=value.textDescription, list=text && text.textDescriptorList;
    let speech=null;
    if(list instanceof Map)speech=list.get('STREET')||list.get(14)||list.get('14');
    else if(list && !Array.isArray(list) && typeof list==='object')speech=list.STREET||list['14'];
    else if(Array.isArray(list)){
        const entry=list.find(e=>e&&(e.key==='STREET'||e.key===14||e.key==='14'));
        speech=entry&&entry.value;
    }
    if(!speech || typeof speech.orthography!=='string')return null;
    const name=speech.orthography.trim();
    return name && name.length<=96 && Buffer.byteLength(name,'utf8')<=240 && !/[\x00-\x1f\x7f]/.test(name)?name:null;
}
class BmwNavigationBridge extends EventEmitter {
    constructor(options){
        super();const o=options||{};this.builders=o.builders;this.control=o.control;
        this.now=o.now||Date.now;this.timeoutMs=o.timeoutMs||8000;this.pollMs=o.pollMs||10000;
        this.running=false;this.generation=0;this.proxy=null;this.timer=null;this.pollPending=false;this.pollGeneration=0;this.subscribed=false;
        this.street={name:null,source:'BMW',state:'unavailable',reason:'Название улицы BMW ещё не получено',observedAtMs:null};
        this.audio={available:false,state:'unverified',reason:'Безопасный звуковой канал BMW не подтверждён'};
        this.lastLinkUp=false;this.controlChanged=()=>{const up=this.control&&this.control.link==='up';if(up&&!this.lastLinkUp)this.lastPublished='';this.lastLinkUp=up;this.publish();};
        if(this.control && this.control.on)this.control.on('change',this.controlChanged);
        this.lastPublished='';
    }
    publish(){
        if(!this.running||!this.control||this.control.link!=='up')return;
        const msg={cmd:'vehicle-context',street:this.street,audio:this.audio};
        const signature=JSON.stringify(msg);if(signature===this.lastPublished)return;
        const sock=this.control.sock,pending=sock&&(typeof sock.writableLength==='number'?sock.writableLength:sock.bufferSize);
        if(typeof pending==='number'&&pending>16384)return;
        try{if(this.control.send(msg))this.lastPublished=signature;}catch(ignored){}
    }
    status(){return {street:Object.assign({},this.street),audio:Object.assign({},this.audio)};}
    build(iface,instance){
        if(!this.builders)return Promise.reject(new Error('BUILDER_UNAVAILABLE'));
        if(typeof this.builders.buildAndInitTypedProxy==='function')return this.builders.buildAndInitTypedProxy(iface,instance,{timeoutMs:this.timeoutMs});
        let proxy;
        return Promise.resolve(this.builders.buildTypedProxy(iface,instance)).then(p=>{proxy=p;return p.init();}).then(()=>proxy.waitUntilAvailable()).then(()=>proxy);
    }
    current(generation){return this.running&&generation===this.generation;}
    start(){
        if(this.running)return;this.running=true;this.subscribed=false;this.pollPending=false;const generation=++this.generation;
        this.lastPublished='';this.publish();
        this.deadline=setTimeout(()=>{if(this.current(generation)&&!this.subscribed){this.street={name:null,source:'BMW',state:'unavailable',reason:'Интерфейс или подписка улицы BMW не ответили',observedAtMs:null};this.publish();}},this.timeoutMs);
        Promise.resolve().then(()=>this.build(NAV,'Main_Instance')).then(proxy=>{
            if(!this.current(generation))return;
            if(!proxy||!proxy.currentLocation||typeof proxy.currentLocation.subscribe!=='function'||typeof proxy.currentLocation.getValue!=='function')throw new Error('CURRENT_LOCATION_UNAVAILABLE');
            this.proxy=proxy;
            return Promise.resolve(proxy.currentLocation.subscribe(value=>this.receive(value,generation))).then(()=>{
                if(!this.current(generation))return;this.subscribed=true;clearTimeout(this.deadline);this.poll(generation);
                this.timer=setInterval(()=>this.poll(generation),this.pollMs);
            });
        }).catch(()=>{if(this.current(generation)){clearTimeout(this.deadline);this.street={name:null,source:'BMW',state:'unavailable',reason:'Чтение улицы BMW недоступно на этой MGU',observedAtMs:null};this.publish();}});
        // Listing supported sound samples is read-only. Deliberately do not
        // call requestGong: location/identifier ownership and system priority
        // are not proven by the existence of a proxy on a different vehicle.
        this.audioDeadline=setTimeout(()=>{if(this.current(generation)&&this.audio.state==='unverified'){this.audio={available:false,state:'unavailable',reason:'Проверка звукового сервиса BMW не получила ответа'};this.publish();}},this.timeoutMs);
        Promise.resolve().then(()=>this.build(GONG,'1')).then(proxy=>{
            if(!this.current(generation))return;
            if(!proxy||typeof proxy.getAllSampleSets!=='function')throw new Error('GONG_PROBE_UNAVAILABLE');
            return Promise.resolve(proxy.getAllSampleSets()).then(result=>{
                if(!this.current(generation))return;
                clearTimeout(this.audioDeadline);const samples=result&&result.listSampleNames;
                this.audio={available:false,state:'detected',reason:'Сервис звука найден; параметры безопасного уведомления ещё не подтверждены',sampleSetCount:Array.isArray(samples)?Math.min(samples.length,50):null};this.publish();
            });
        }).catch(()=>{if(this.current(generation)){clearTimeout(this.audioDeadline);this.audio={available:false,state:'unavailable',reason:'Безопасный звуковой канал BMW недоступен; радио не переключается'};this.publish();}});
    }
    poll(generation){
        if(!this.current(generation)||!this.proxy||this.pollPending)return;
        this.pollPending=true;const request=++this.pollGeneration;let expired=false;
        this.pollDeadline=setTimeout(()=>{expired=true;if(this.current(generation)&&this.pollGeneration===request){
            this.street={name:null,source:'BMW',state:'unavailable',reason:'Чтение улицы BMW задержано; ожидаются живые уведомления',observedAtMs:null};this.publish();
        }},this.timeoutMs);
        // Keep one outstanding SDK getter. A timeout is visible but does not
        // create an unbounded queue of uncancellable native requests. Live
        // subscribed updates can still deliver the street while it is pending.
        Promise.resolve().then(()=>this.proxy.currentLocation.getValue()).then(value=>{if(!expired&&this.current(generation)&&this.pollGeneration===request)this.receive(value,generation);},()=>{
            if(this.current(generation)&&this.pollGeneration===request){this.street={name:null,source:'BMW',state:'unavailable',reason:'Не удалось прочитать текущую улицу BMW',observedAtMs:null};this.publish();}
        }).then(()=>{if(this.current(generation)&&this.pollGeneration===request){clearTimeout(this.pollDeadline);this.pollPending=false;}});
    }
    receive(value,generation){
        if(!this.current(generation))return;
        const name=streetOf(value);
        this.street={name,source:'BMW',state:name?'ready':'unavailable',reason:name?null:'BMW не передала подтверждённое название текущей улицы',observedAtMs:this.now()};
        this.publish();this.emit('change');
    }
    stop(){
        if(!this.running)return;this.running=false;this.generation++;
        clearTimeout(this.deadline);clearTimeout(this.audioDeadline);clearTimeout(this.pollDeadline);clearInterval(this.timer);this.timer=null;this.proxy=null;this.pollPending=false;this.subscribed=false;this.pollGeneration++;
        // A successful SDK subscription is single-use for the process. Late
        // callbacks are generation-guarded and never produce cached GPS data.
    }
}
module.exports={BmwNavigationBridge,streetOf,NAV,GONG};
