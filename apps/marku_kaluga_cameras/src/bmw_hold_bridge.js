// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Passive controller observation only. This module neither grabs the iDrive
// controller nor writes SOME/IP/CAN or camera settings. Native RHMI Click is
// not a release event: only the verified FrontCCU long-press state can hold.
const EventEmitter = require('events');
const INTERFACE = 'de.bmw.infotainment.controlelements.FrontCCU';
const INSTANCE = '1';
const FIELD = 'statusRotaryEncoderState';
const PUSH = {KEINE_BETAETIGUNG:0,DREHGEBER_KURZ_GEDRUECKT:1,DREHGEBER_LANG_GEDRUECKT:2,UNWIRKSAM:3,SIGNAL_UNGUELTIG:15};
const DIRECTIONS = ['up','down','left','right'];
function buttonOf(value) {
    const raw=value&&value.frontRotaryEncoderPushButton;
    if(typeof raw==='number')return [0,1,2,3,15].indexOf(raw)>=0?raw:null;
    return typeof raw==='string'&&Object.prototype.hasOwnProperty.call(PUSH,raw)?PUSH[raw]:null;
}
function monotonicNow() {
    if(typeof process.hrtime==='function'){const time=process.hrtime();return time[0]*1000+time[1]/1e6;}
    return Date.now();
}
function bounded(value,fallback,min,max) {return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;}

class BmwHoldBridge extends EventEmitter {
    constructor(options) {
        super();const o=options||{};
        this.builders=o.builders;this.now=o.now||monotonicNow;
        this.timeoutMs=bounded(o.timeoutMs,8000,10,30000);
        this.retryMs=bounded(o.retryMs,1000,1,10000);
        this.pollMs=bounded(o.pollMs,150,10,200);
        this.deadlineMs=bounded(o.deadlineMs,500,20,500);
        this.staleMs=bounded(o.staleMs,500,20,500);
        this.maxAttempts=3;this.builds=0;this.started=false;this.running=false;this.closed=false;
        this.generation=0;this.attempt=null;this.attempts=new Set();this.retry=null;
        this.proxy=null;this.subscribed=false;this.state='stopped';this.errorCode=null;
        this.context={visible:false,focusedDirection:null,target:null,stationary:false,activeTest:false,serviceReady:false};
        this.held=false;this.armed=false;this.holdGeneration=0;this.inputGeneration=0;this.contextGeneration=0;this.sequence=0;
        this.lastButton=null;this.lastFreshAt=null;this.reason='not-started';
        this.pendingGetter=null;this.pollTimer=null;this.watchTimer=null;this.getters=0;
        this.baselineNeeded=true;
    }
    status() {
        return {state:this.state,errorCode:this.errorCode,subscribed:this.subscribed,held:this.held,
            direction:this.held?this.context.focusedDirection:null,target:this.held?this.context.target:null,
            reason:this.reason,button:this.lastButton,requiresNewPress:!this.armed&&!this.held,
            sourceAgeMs:this.lastFreshAt===null?null:Math.max(0,this.now()-this.lastFreshAt),
            attempts:this.builds,maxAttempts:this.maxAttempts,getterPending:!!this.pendingGetter,getters:this.getters,
            input:'FrontCCU',touchHold:false};
    }
    stateChanged(state,code) {
        const changed=state!==this.state||(code||null)!==this.errorCode;
        this.state=state;this.errorCode=code||null;if(changed)this.emit('change',this.status());
    }
    eligible() {
        const c=this.context;
        return c.visible&&c.stationary&&c.activeTest&&c.serviceReady&&
            DIRECTIONS.indexOf(c.focusedDirection)>=0&&(c.target==='hud'||c.target==='map');
    }
    setContext(value) {
        const c=value||{},next={visible:c.visible===true,focusedDirection:DIRECTIONS.indexOf(c.focusedDirection)>=0?c.focusedDirection:null,
            target:c.target==='hud'||c.target==='map'?c.target:null,stationary:c.stationary===true,
            activeTest:c.activeTest===true,serviceReady:c.serviceReady===true};
        if(Object.keys(next).every(key=>next[key]===this.context[key]))return;
        const previous=this.context;
        this.context=next;this.armed=false;this.inputGeneration++;this.contextGeneration++;this.baselineNeeded=true;
        // Publish the new gate before synchronous listeners run; a renderer
        // refreshing the same context from 'held'/'change' must not recurse.
        this.stopHeld('context-changed',previous);this.emit('change',this.status());this.baseline();
    }
    start() {
        if(this.started||this.closed)return false;
        this.started=true;this.running=true;this.generation++;this.connect();return true;
    }
    current(attempt) {return this.running&&!this.closed&&this.attempt===attempt&&attempt.generation===this.generation;}
    build(active) {
        if(!this.builders)throw new Error('CCU_BUILDER_UNAVAILABLE');
        if(typeof this.builders.buildAndInitTypedProxy==='function')return this.builders.buildAndInitTypedProxy(INTERFACE,INSTANCE,{timeoutMs:this.timeoutMs});
        if(typeof this.builders.buildTypedProxy!=='function')throw new Error('CCU_TYPED_PROXY_UNAVAILABLE');
        let proxy;
        return Promise.resolve(this.builders.buildTypedProxy(INTERFACE,INSTANCE)).then(value=>{
            if(!active())return null;proxy=value;
            if(!proxy||typeof proxy.init!=='function'||typeof proxy.waitUntilAvailable!=='function')throw new Error('CCU_TYPED_PROXY_UNAVAILABLE');
            return proxy.init();
        }).then(()=>active()?proxy.waitUntilAvailable():null).then(()=>active()?proxy:null);
    }
    connect() {
        if(!this.running||this.closed||this.attempt||this.subscribed)return;
        if(this.builds>=this.maxAttempts){this.stateChanged('unavailable','CCU_RETRY_LIMIT');return;}
        const attempt={generation:this.generation,id:++this.builds,deadline:null,subscriptionStarted:false};
        this.attempt=attempt;this.attempts.add(attempt);this.stateChanged('starting',null);
        const active=()=>this.current(attempt);
        attempt.deadline=setTimeout(()=>this.failed(attempt,attempt.subscriptionStarted?'CCU_SUBSCRIPTION_TIMEOUT':'CCU_PROXY_TIMEOUT',true),this.timeoutMs);
        Promise.resolve().then(()=>active()?this.build(active):null).then(proxy=>{
            if(!active())return null;
            const field=proxy&&proxy[FIELD];
            if(!field||typeof field.subscribe!=='function'||typeof field.getValue!=='function')throw new Error('CCU_FIELD_UNAVAILABLE');
            attempt.subscriptionStarted=true;
            return Promise.resolve(field.subscribe(value=>{if(active())this.receive(value,attempt);})).then(()=>proxy);
        }).then(proxy=>{
            if(!attempt.subscriptionStarted)this.attempts.delete(attempt);
            if(!active()||!proxy)return;
            clearTimeout(attempt.deadline);attempt.deadline=null;this.proxy=proxy;this.subscribed=true;
            this.armed=false;this.lastFreshAt=null;this.baselineNeeded=true;this.stateChanged('ready',null);this.baseline();
        }).catch(error=>{
            if(!attempt.subscriptionStarted)this.attempts.delete(attempt);
            const code=error&&/^CCU_[A-Z_]+$/.test(error.message)?error.message:'CCU_PROXY_ERROR';
            this.failed(attempt,code,code!=='CCU_FIELD_UNAVAILABLE'&&code!=='CCU_TYPED_PROXY_UNAVAILABLE'&&code!=='CCU_BUILDER_UNAVAILABLE');
        });
    }
    failed(attempt,code,retry) {
        if(!this.current(attempt))return;
        clearTimeout(attempt.deadline);attempt.deadline=null;this.attempt=null;this.proxy=null;this.subscribed=false;
        this.stopHeld('source-unavailable');this.armed=false;this.inputGeneration++;
        this.stateChanged('unavailable',retry&&this.builds>=this.maxAttempts?'CCU_RETRY_LIMIT':code);
        if(retry&&this.builds<this.maxAttempts&&!this.retry){
            this.retry=setTimeout(()=>{this.retry=null;this.connect();},this.retryMs*Math.pow(2,this.builds-1));
        }
    }
    receive(value,attempt) {
        if(!this.current(attempt))return;
        const button=buttonOf(value), wasHeld=this.held;
        this.inputGeneration++;this.lastButton=button;this.lastFreshAt=this.now();
        if(button!==2){
            this.stopHeld(button===0?'released':button===1?'short-press':'invalid-input');
            const canArm=!this.pendingGetter||this.pendingGetter.kind==='baseline'&&!this.pendingGetter.expired&&this.pendingGetter.context===this.contextGeneration;
            this.armed=(button===0||button===1&&!wasHeld)&&this.eligible()&&canArm&&this.subscribed;
            if(button===null||button===3||button===15)this.stateChanged('unavailable','CCU_INPUT_INVALID');
            else if(this.subscribed&&canArm)this.stateChanged('ready',null);
            return;
        }
        if(!this.eligible()||!this.subscribed||this.state!=='ready')return;
        if(wasHeld)return; // cyclic LONG notifications never duplicate a hold start
        if(!this.armed||this.pendingGetter&&(this.pendingGetter.kind!=='baseline'||this.pendingGetter.expired||this.pendingGetter.context!==this.contextGeneration))return;
        this.armed=false;this.held=true;this.reason='long-press';this.holdGeneration++;
        this.emit('held',{held:true,direction:this.context.focusedDirection,target:this.context.target,reason:this.reason,sequence:++this.sequence});
        this.emit('change',this.status());this.poll();this.watch();
    }
    watch() {
        clearTimeout(this.watchTimer);this.watchTimer=null;
        if(!this.running||!this.held)return;
        this.watchTimer=setTimeout(()=>{
            this.watchTimer=null;if(!this.running||!this.held)return;
            if(!this.eligible()){this.stopHeld('context-lost');return;}
            if(this.lastFreshAt===null||this.now()-this.lastFreshAt>=this.staleMs){
                this.sourceFailure('CCU_STALE','source-stale');return;
            }
            this.watch();
        },Math.min(50,this.staleMs/2));
    }
    sourceFailure(code,reason) {
        this.stopHeld(reason);this.armed=false;this.inputGeneration++;this.stateChanged('unavailable',code);
    }
    poll() {
        clearTimeout(this.pollTimer);this.pollTimer=null;
        if(!this.running||!this.held||!this.eligible()||!this.proxy||this.pendingGetter)return;
        this.read('held');
    }
    baseline() {
        if(!this.running||this.closed||!this.subscribed||!this.proxy||!this.eligible()||this.held||!this.baselineNeeded||this.pendingGetter)return;
        this.baselineNeeded=false;this.read('baseline');
    }
    read(kind) {
        const proxy=this.proxy,attempt=this.attempt,request={kind,input:this.inputGeneration,context:this.contextGeneration,hold:this.holdGeneration,expired:false,deadline:null};
        this.pendingGetter=request;
        request.deadline=setTimeout(()=>{
            request.expired=true;
            if(this.current(attempt)&&(kind==='baseline'?this.eligible()&&request.context===this.contextGeneration:this.held&&request.hold===this.holdGeneration))
                this.sourceFailure(kind==='baseline'?'CCU_BASELINE_TIMEOUT':'CCU_GETTER_TIMEOUT','source-timeout');
        },this.deadlineMs);
        Promise.resolve().then(()=>{
            if(!this.current(attempt)||!this.eligible()||request.context!==this.contextGeneration||(kind==='held'&&(!this.held||request.hold!==this.holdGeneration)))return null;
            this.getters++;return proxy[FIELD].getValue();
        }).then(value=>{
            if(request.expired||!this.current(attempt)||!this.eligible()||request.input!==this.inputGeneration)return;
            if(kind==='held'&&(!this.held||request.hold!==this.holdGeneration))return;
            const button=buttonOf(value);this.lastButton=button;
            if(kind==='baseline'){
                if(this.held)return;
                // One fresh read makes the first real press usable even when
                // the initial neutral notification preceded focus/subscription.
                // A getter never starts a hold, including a returned LONG state.
                this.lastFreshAt=this.now();this.armed=button===0||button===1;
                this.stateChanged(this.armed?'ready':'unavailable',this.armed?null:button===2?'CCU_WAITING_NEW_PRESS':'CCU_INPUT_INVALID');
                return;
            }
            if(button!==2){this.stopHeld(button===0?'released':button===1?'short-press':'invalid-input');this.armed=false;
                if(button===null||button===3||button===15)this.stateChanged('unavailable','CCU_INPUT_INVALID');return;}
            // A read may confirm an existing hold; it can never start/restart one.
            this.lastFreshAt=this.now();
        },()=>{
            if(this.current(attempt)&&(kind==='baseline'?this.eligible()&&request.context===this.contextGeneration:this.held&&request.hold===this.holdGeneration))this.sourceFailure('CCU_GETTER_ERROR','source-unavailable');
        }).then(()=>{
            clearTimeout(request.deadline);
            if(this.pendingGetter===request)this.pendingGetter=null;
            if(this.current(attempt)&&this.held&&this.eligible()){
                this.pollTimer=setTimeout(()=>{this.pollTimer=null;this.poll();},this.pollMs);
            }else if(this.current(attempt))this.baseline();
        });
    }
    stopHeld(reason,previousContext) {
        const context=previousContext||this.context,wasHeld=this.held,direction=context.focusedDirection,target=context.target;
        this.held=false;this.armed=false;this.reason=reason;this.holdGeneration++;
        clearTimeout(this.pollTimer);this.pollTimer=null;clearTimeout(this.watchTimer);this.watchTimer=null;
        if(wasHeld){this.emit('held',{held:false,direction,target,reason,sequence:++this.sequence});this.emit('change',this.status());}
    }
    close() {
        if(this.closed)return;
        this.running=false;this.closed=true;this.generation++;this.inputGeneration++;this.stopHeld('closed');
        clearTimeout(this.retry);this.retry=null;
        this.attempts.forEach(attempt=>clearTimeout(attempt.deadline));
        if(this.pendingGetter)clearTimeout(this.pendingGetter.deadline);
        this.attempt=null;this.proxy=null;this.subscribed=false;this.stateChanged('closed',null);
        // No documented SDK unsubscribe/cancellation exists. The three retained
        // registration slots and all late getters remain inert until process exit.
    }
}
module.exports={BmwHoldBridge,INTERFACE,INSTANCE,FIELD,buttonOf};
