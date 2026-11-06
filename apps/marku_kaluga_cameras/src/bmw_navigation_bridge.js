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
        this.retryMs=o.retryMs||10000;this.retryMaxMs=Math.max(this.retryMs,o.retryMaxMs||60000);
        this.running=false;this.generation=0;this.proxy=null;this.timer=null;this.pollPending=false;this.pollGeneration=0;this.subscribed=false;
        this.channels={nav:{active:null,attempts:new Set(),retry:null,failures:0},audio:{active:null,attempts:new Set(),retry:null,failures:0}};
        this.maxAttempts=3;this.pendingGetter=null;
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
    build(iface,instance,active){
        if(!this.builders)return Promise.reject(new Error('BUILDER_UNAVAILABLE'));
        if(typeof this.builders.buildAndInitTypedProxy==='function')return this.builders.buildAndInitTypedProxy(iface,instance,{timeoutMs:this.timeoutMs});
        let proxy;
        return Promise.resolve(this.builders.buildTypedProxy(iface,instance)).then(p=>{if(!active())return;proxy=p;return p.init();})
            .then(()=>active()?proxy.waitUntilAvailable():null).then(()=>active()?proxy:null);
    }
    current(generation){return this.running&&generation===this.generation;}
    active(kind,attempt){return this.current(attempt.generation)&&this.channels[kind].active===attempt;}
    unavailable(kind,reason){
        if(kind==='nav')this.street={name:null,source:'BMW',state:'unavailable',reason,observedAtMs:null};
        else this.audio={available:false,state:'unavailable',reason};
        this.publish();
    }
    schedule(kind,generation){
        const channel=this.channels[kind];
        if(!this.current(generation)||channel.retry||channel.active)return;
        const delay=Math.min(this.retryMaxMs,this.retryMs*Math.pow(2,Math.min(channel.failures++,10)));
        channel.retry=setTimeout(()=>{channel.retry=null;this.connect(kind,generation);},delay);
    }
    connect(kind,generation){
        const channel=this.channels[kind];
        if(!this.current(generation)||channel.active)return;
        if(channel.attempts.size>=this.maxAttempts){
            this.unavailable(kind,kind==='nav'?'Лимит незавершённых запросов BMW; требуется перезапуск приложения':'Лимит незавершённых звуковых запросов BMW; требуется перезапуск приложения');
            return;
        }
        const attempt={generation,retained:false,deadline:null};channel.active=attempt;channel.attempts.add(attempt);
        const active=()=>this.active(kind,attempt);
        const settle=()=>{
            if(!attempt.retained)channel.attempts.delete(attempt);
            if(!active()&&this.running&&channel.attempts.size<this.maxAttempts)this.schedule(kind,this.generation);
        };
        attempt.deadline=setTimeout(()=>{
            if(!active())return;channel.active=null;
            this.unavailable(kind,kind==='nav'?'Интерфейс или подписка улицы BMW не ответили; повторное подключение':'Проверка звукового сервиса BMW не получила ответа; повторное подключение');
            this.schedule(kind,generation);
        },this.timeoutMs);
        Promise.resolve().then(()=>active()?this.build(kind==='nav'?NAV:GONG,kind==='nav'?'Main_Instance':'1',active):null).then(proxy=>{
            if(!active())return;
            if(kind==='nav'){
                if(!proxy||!proxy.currentLocation||typeof proxy.currentLocation.subscribe!=='function'||typeof proxy.currentLocation.getValue!=='function')throw new Error('CURRENT_LOCATION_UNAVAILABLE');
                // No verified SDK unsubscribe exists. Keep this slot even if
                // subscribe hangs: retired callbacks cannot publish, and at
                // most three native registrations can exist in this process.
                attempt.retained=true;
                return Promise.resolve(proxy.currentLocation.subscribe(value=>{if(active())this.receive(value,generation);})).then(()=>proxy);
            }
            // Listing supported sound samples is read-only. Never requestGong:
            // discovery does not establish ownership or safe system priority.
            if(!proxy||typeof proxy.getAllSampleSets!=='function')throw new Error('GONG_PROBE_UNAVAILABLE');
            return proxy.getAllSampleSets();
        }).then(result=>{
            settle();if(!active())return;clearTimeout(attempt.deadline);channel.failures=0;
            if(kind==='nav'){
                this.proxy=result;this.subscribed=true;this.poll(generation);
                this.timer=setInterval(()=>this.poll(generation),this.pollMs);
            }else{
                const samples=result&&result.listSampleNames;
                this.audio={available:false,state:'detected',reason:'Сервис звука найден; параметры безопасного уведомления ещё не подтверждены',sampleSetCount:Array.isArray(samples)?Math.min(samples.length,50):null};this.publish();
            }
        }).catch(()=>{
            settle();if(!active())return;clearTimeout(attempt.deadline);channel.active=null;
            this.unavailable(kind,kind==='nav'?'Чтение улицы BMW временно недоступно; повторное подключение':'Безопасный звуковой канал BMW недоступен; радио не переключается');
            this.schedule(kind,generation);
        });
    }
    start(){
        if(this.running)return;this.running=true;this.subscribed=false;this.pollPending=false;const generation=++this.generation;
        this.street={name:null,source:'BMW',state:'unavailable',reason:'Название улицы BMW ещё не получено',observedAtMs:null};
        this.audio={available:false,state:'unverified',reason:'Безопасный звуковой канал BMW не подтверждён'};
        this.lastPublished='';this.publish();
        this.connect('nav',generation);this.connect('audio',generation);
    }
    poll(generation){
        if(!this.current(generation)||!this.proxy||this.pendingGetter)return;
        const proxy=this.proxy;
        this.pollPending=true;const request=++this.pollGeneration;let expired=false;
        const pending={};this.pendingGetter=pending;
        this.pollDeadline=setTimeout(()=>{expired=true;if(this.current(generation)&&this.pollGeneration===request){
            this.street={name:null,source:'BMW',state:'unavailable',reason:'Чтение улицы BMW задержано; ожидаются живые уведомления',observedAtMs:null};this.publish();
        }},this.timeoutMs);
        // Keep one outstanding SDK getter. A timeout is visible but does not
        // create an unbounded queue of uncancellable native requests. Live
        // subscribed updates can still deliver the street while it is pending.
        Promise.resolve().then(()=>this.current(generation)&&this.pollGeneration===request?proxy.currentLocation.getValue():null).then(value=>{if(!expired&&this.current(generation)&&this.pollGeneration===request)this.receive(value,generation);},()=>{
            if(this.current(generation)&&this.pollGeneration===request){this.street={name:null,source:'BMW',state:'unavailable',reason:'Не удалось прочитать текущую улицу BMW',observedAtMs:null};this.publish();}
        }).then(()=>{if(this.pendingGetter===pending)this.pendingGetter=null;if(this.current(generation)&&this.pollGeneration===request){clearTimeout(this.pollDeadline);this.pollPending=false;}});
    }
    receive(value,generation){
        if(!this.current(generation))return;
        const name=streetOf(value);
        this.street={name,source:'BMW',state:name?'ready':'unavailable',reason:name?null:'BMW не передала подтверждённое название текущей улицы',observedAtMs:this.now()};
        this.publish();this.emit('change');
    }
    stop(){
        if(!this.running)return;this.running=false;this.generation++;
        Object.keys(this.channels).forEach(kind=>{const channel=this.channels[kind];clearTimeout(channel.retry);channel.retry=null;channel.attempts.forEach(attempt=>clearTimeout(attempt.deadline));channel.active=null;});
        clearTimeout(this.pollDeadline);clearInterval(this.timer);this.timer=null;this.proxy=null;this.pollPending=false;this.subscribed=false;this.pollGeneration++;
        // Pending uncancellable getters/registrations retain their bounded
        // slots across start/stop. Late callbacks cannot publish cached data.
    }
}
module.exports={BmwNavigationBridge,streetOf,NAV,GONG};
