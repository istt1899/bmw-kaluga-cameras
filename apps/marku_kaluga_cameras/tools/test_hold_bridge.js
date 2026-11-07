// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Isolated read-only typed FrontCCU provider; no car, renderer, socket or SDK execution.
const assert=require('assert');
const {BmwHoldBridge,INTERFACE,INSTANCE,FIELD,buttonOf}=require('../src/bmw_hold_bridge');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label) {const end=Date.now()+1500;while(!fn()){if(Date.now()>end)throw new Error('Timeout: '+label);await sleep(2);}}
function deferred(){let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};}
const context={visible:true,focusedDirection:'left',target:'hud',stationary:true,activeTest:true,serviceReady:true};
const sample=button=>({frontRotaryEncoderPushButton:button});
function fixture(options){
    const f={callbacks:[],builds:0,reads:0,readActive:0,maxReadActive:0,writes:0,button:2,events:[]};
    f.get=()=>Promise.resolve(sample(f.button));f.baselineGet=()=>sample(0);
    const proxy={};proxy[FIELD]={subscribe(cb){f.callbacks.push(cb);return Promise.resolve();},getValue(){
        f.reads++;f.readActive++;f.maxReadActive=Math.max(f.maxReadActive,f.readActive);
        return Promise.resolve().then(()=>f.bridge.held?f.get():f.baselineGet()).then(value=>{f.readActive--;return value;},error=>{f.readActive--;throw error;});
    },setValue(){f.writes++;throw new Error('must never write FrontCCU');}};
    f.proxy=proxy;
    f.builders={buildAndInitTypedProxy(iface,instance,opts){
        f.builds++;assert.strictEqual(iface,INTERFACE);assert.strictEqual(instance,INSTANCE);assert(opts.timeoutMs>0);
        return Promise.resolve(proxy);
    }};
    f.bridge=new BmwHoldBridge(Object.assign({builders:f.builders,pollMs:10,deadlineMs:80,staleMs:100,timeoutMs:80,retryMs:2},options||{}));
    f.bridge.on('held',event=>f.events.push(event));
    f.event=button=>f.callbacks[f.callbacks.length-1](sample(button));
    f.ready=async()=>{f.bridge.setContext(context);assert.strictEqual(f.bridge.start(),true);assert.strictEqual(f.bridge.start(),false);
        await until(()=>f.bridge.subscribed&&!f.bridge.pendingGetter&&f.bridge.armed,'FrontCCU subscription and one-shot baseline');
        assert.strictEqual(f.builds,1);f.reads=0;};
    f.begin=()=>{f.event(0);f.event(1);f.event(2);};
    return f;
}

(async()=>{
    assert.strictEqual(INTERFACE,'de.bmw.infotainment.controlelements.FrontCCU');assert.strictEqual(INSTANCE,'1');
    assert.strictEqual(FIELD,'statusRotaryEncoderState');
    ['KEINE_BETAETIGUNG','DREHGEBER_KURZ_GEDRUECKT','DREHGEBER_LANG_GEDRUECKT','UNWIRKSAM','SIGNAL_UNGUELTIG']
        .forEach((name,i)=>assert.strictEqual(buttonOf(sample(name)),[0,1,2,3,15][i]));
    [null,{},sample('2'),sample(7),sample(true)].forEach(value=>assert.strictEqual(buttonOf(value),null));
    const bounds=new BmwHoldBridge({pollMs:999,deadlineMs:9999,staleMs:9999});
    assert.strictEqual(bounds.pollMs,200);assert.strictEqual(bounds.deadlineMs,500);assert.strictEqual(bounds.staleMs,500);bounds.close();

    const basic=fixture();
    try {
        await basic.ready();basic.event(1);assert.strictEqual(basic.bridge.held,false,'short press stays an ordinary native click');
        basic.event(2);basic.event(2);basic.event(2);
        await until(()=>basic.reads>=2,'bounded current-state polling');
        assert.strictEqual(basic.events.filter(e=>e.held).length,1,'cyclic LONG states start once');
        assert.deepStrictEqual([basic.events[0].direction,basic.events[0].target],['left','hud']);
        basic.event(0);assert.strictEqual(basic.bridge.held,false);assert.strictEqual(basic.events[1].reason,'released');
        const reads=basic.reads;await sleep(35);assert.strictEqual(basic.reads,reads,'release cancels future polls');
        assert.strictEqual(basic.writes,0);assert.strictEqual(basic.maxReadActive,1);
    } finally {basic.bridge.close();}
    console.log('PASS hold: exact read-only field, long-press only, explicit release, one start and one getter at a time');

    const initial=fixture();
    initial.proxy[FIELD].subscribe=cb=>{initial.callbacks.push(cb);cb(sample(0));return Promise.resolve();};
    try {
        initial.bridge.start();await until(()=>initial.bridge.subscribed,'early initial neutral notification');
        initial.bridge.setContext(context);await until(()=>initial.bridge.armed&&!initial.bridge.pendingGetter,'first focused neutral baseline');
        assert.strictEqual(initial.reads,1,'focus receives exactly one neutral read');
        initial.event(2);assert.strictEqual(initial.bridge.held,true,'first 0→LONG works without a preceding short-press attempt');
        initial.event(0);
    } finally {initial.bridge.close();}
    const baselineLong=fixture(),longRead=deferred();baselineLong.baselineGet=()=>longRead.promise;
    try {
        baselineLong.bridge.setContext(context);baselineLong.bridge.start();await until(()=>baselineLong.reads===1,'baseline LONG getter');
        longRead.resolve(sample(2));await until(()=>!baselineLong.bridge.pendingGetter,'baseline LONG settles');
        assert.strictEqual(baselineLong.bridge.held,false);assert.strictEqual(baselineLong.bridge.armed,false);
        baselineLong.event(2);assert.strictEqual(baselineLong.bridge.held,false,'getter LONG does not arm the currently held controller');
        baselineLong.event(0);baselineLong.event(2);assert.strictEqual(baselineLong.bridge.held,true,'a new physical press works after neutral');
    } finally {longRead.resolve(sample(0));baselineLong.bridge.close();}
    for(const stop of ['invalid','focus']){
        const f=fixture(),baseline=deferred();f.baselineGet=()=>baseline.promise;
        try {
            f.bridge.setContext(context);f.bridge.start();await until(()=>f.reads===1,'pending baseline before '+stop);
            if(stop==='invalid')f.event(15);else f.bridge.setContext(Object.assign({},context,{focusedDirection:null}));
            baseline.resolve(sample(0));await sleep(20);
            assert.strictEqual(f.bridge.armed,false,stop+': stale neutral getter cannot re-arm after input/context loss');
            assert.strictEqual(f.bridge.held,false);
        } finally {baseline.resolve(sample(0));f.bridge.close();}
    }
    const baselineTimeout=fixture({deadlineMs:25,staleMs:80}),baselineHang=deferred();baselineTimeout.baselineGet=()=>baselineHang.promise;
    try {
        baselineTimeout.bridge.setContext(context);baselineTimeout.bridge.start();await until(()=>baselineTimeout.reads===1,'hung baseline');
        baselineTimeout.event(0);baselineTimeout.event(2);
        assert.strictEqual(baselineTimeout.bridge.held,true,'fresh live neutral does not wait behind an old baseline getter');
        await until(()=>baselineTimeout.bridge.errorCode==='CCU_BASELINE_TIMEOUT','hung baseline deadline cuts off the hold');
        assert.strictEqual(baselineTimeout.bridge.held,false);assert.strictEqual(baselineTimeout.reads,1);
        baselineHang.resolve(sample(2));await sleep(15);assert.strictEqual(baselineTimeout.bridge.held,false);
    } finally {baselineHang.resolve(sample(0));baselineTimeout.bridge.close();}
    console.log('PASS hold baseline: first focused long press works; one-shot reads never start holds or re-arm stale gestures, and pending native reads stay singleflight');
    const reentrant=fixture();
    try {
        await reentrant.ready();reentrant.begin();await until(()=>reentrant.bridge.held,'context listener hold');
        const hidden=Object.assign({},context,{visible:false});
        reentrant.bridge.on('change',()=>reentrant.bridge.setContext(hidden));
        reentrant.bridge.setContext(hidden);
        assert.strictEqual(reentrant.bridge.held,false);assert.strictEqual(reentrant.bridge.context.visible,false);
        assert.strictEqual(reentrant.events.filter(event=>!event.held).length,1,'synchronous context listeners cannot duplicate stop or recurse');
        assert.strictEqual(reentrant.events[1].target,'hud');
    } finally {reentrant.bridge.close();}

    for(const stop of ['release','short','invalid','focus','page','target','motion','preview','disconnect','close']){
        const f=fixture(),read=deferred();f.get=()=>read.promise;
        try {
            await f.ready();f.begin();await until(()=>f.reads===1,'pending hold getter');
            if(stop==='release')f.event(0);
            else if(stop==='short')f.event(1);
            else if(stop==='invalid')f.event(15);
            else if(stop==='close')f.bridge.close();
            else f.bridge.setContext(Object.assign({},context,stop==='focus'?{focusedDirection:null}:
                stop==='page'?{visible:false}:stop==='target'?{target:'map'}:stop==='motion'?{stationary:false}:
                stop==='preview'?{activeTest:false}:{serviceReady:false}));
            assert.strictEqual(f.bridge.held,false,stop+' immediately cancels hold');
            read.resolve(sample(2));await sleep(25);
            assert.strictEqual(f.events.filter(e=>e.held).length,1,stop+': late getter LONG cannot restart');
            assert.strictEqual(f.reads,stop==='target'?2:1,stop+': only a newly eligible target may request its one-shot baseline');
            assert.strictEqual(f.maxReadActive,1,stop+': retired read cannot overlap its replacement baseline');
            if(['focus','page','target','motion','preview','disconnect'].indexOf(stop)>=0){
                f.bridge.setContext(context);f.event(2);assert.strictEqual(f.bridge.held,false,'restored context does not restart a held gesture');
            }
        } finally {read.resolve(sample(0));f.bridge.close();}
    }
    console.log('PASS hold: late LONG reads remain inert after release/invalid input/focus/page/target/motion/preview/link loss and close');

    const currentRelease=fixture(),release=deferred();currentRelease.get=()=>release.promise;
    try {
        await currentRelease.ready();currentRelease.begin();await until(()=>currentRelease.reads===1,'release read started');
        release.resolve(sample(0));await until(()=>!currentRelease.bridge.held,'poll detects missing release notification');
        assert.strictEqual(currentRelease.events[1].reason,'released');
    } finally {currentRelease.bridge.close();}
    const failRead=fixture();failRead.get=()=>Promise.reject(new Error('unavailable'));
    try {
        await failRead.ready();failRead.begin();await until(()=>failRead.bridge.errorCode==='CCU_GETTER_ERROR','getter source unavailable');
        assert.strictEqual(failRead.bridge.held,false);const reads=failRead.reads;await sleep(25);assert.strictEqual(failRead.reads,reads);
    } finally {failRead.bridge.close();}

    const stale=fixture({staleMs:25,deadlineMs:80}),hung=deferred();stale.get=()=>hung.promise;
    try {
        await stale.ready();stale.begin();await until(()=>stale.bridge.errorCode==='CCU_STALE','stale source cutoff');
        assert.strictEqual(stale.bridge.held,false);await sleep(90);assert.strictEqual(stale.reads,1,'hung SDK getter never creates a queue');
        hung.resolve(sample(2));await sleep(15);assert.strictEqual(stale.bridge.held,false);
    } finally {hung.resolve(sample(0));stale.bridge.close();}
    const timed=fixture({staleMs:100,deadlineMs:30}),pending=deferred();timed.get=()=>pending.promise;
    let cyclic;
    try {
        await timed.ready();timed.begin();cyclic=setInterval(()=>timed.event(2),4);
        await until(()=>timed.bridge.errorCode==='CCU_GETTER_TIMEOUT','read deadline despite cyclic source');
        clearInterval(cyclic);assert.strictEqual(timed.bridge.held,false);assert.strictEqual(timed.reads,1);
        pending.resolve(sample(2));await sleep(20);assert.strictEqual(timed.bridge.held,false);
    } finally {clearInterval(cyclic);pending.resolve(sample(0));timed.bridge.close();}
    console.log('PASS hold: current neutral read stops a lost release; source rejection, stale data and hung getter deadlines stop without polling queues');

    const oldBuild=deferred();let buildCount=0,oldInit=0,oldSubscriptions=0;
    const recovered=new BmwHoldBridge({timeoutMs:12,retryMs:1,builders:{buildTypedProxy(){
        buildCount++;if(buildCount===1)return oldBuild.promise;
        return Promise.resolve({init:()=>Promise.resolve(),waitUntilAvailable:()=>Promise.resolve(),
            statusRotaryEncoderState:{subscribe:()=>Promise.resolve(),getValue:()=>Promise.resolve(sample(0))}});
    }}});
    try {
        recovered.start();await until(()=>recovered.subscribed,'replacement typed proxy');
        assert.strictEqual(buildCount,2);
        oldBuild.resolve({init(){oldInit++;return Promise.resolve();},waitUntilAvailable:()=>Promise.resolve(),
            statusRotaryEncoderState:{subscribe(){oldSubscriptions++;return Promise.resolve();},getValue:()=>Promise.resolve(sample(2))}});
        await sleep(20);assert.strictEqual(oldInit,0);assert.strictEqual(oldSubscriptions,0,'late retired builder cannot subscribe');
    } finally {recovered.close();}

    const oldSubscribe=deferred();let subscribeBuilds=0;const callbacks=[];
    const subscriptions=new BmwHoldBridge({timeoutMs:12,retryMs:1,builders:{buildAndInitTypedProxy(){
        const index=++subscribeBuilds;
        return Promise.resolve({statusRotaryEncoderState:{subscribe(cb){callbacks.push(cb);return index===1?oldSubscribe.promise:Promise.resolve();},
            getValue:()=>Promise.resolve(sample(2))}});
    }}});
    try {
        subscriptions.setContext(context);subscriptions.start();await until(()=>subscriptions.subscribed,'replacement subscription');
        callbacks[0](sample(0));callbacks[0](sample(2));assert.strictEqual(subscriptions.held,false,'retired live callback is inert');
        oldSubscribe.resolve();await sleep(10);assert.strictEqual(subscribeBuilds,2);
        callbacks[1](sample(0));callbacks[1](sample(2));assert.strictEqual(subscriptions.held,true);
    } finally {oldSubscribe.resolve();subscriptions.close();}
    let failures=0;const cap=new BmwHoldBridge({timeoutMs:10,retryMs:1,builders:{buildAndInitTypedProxy(){failures++;return new Promise(()=>{});}}});
    try {
        cap.start();await until(()=>cap.errorCode==='CCU_RETRY_LIMIT','three-attempt ceiling');await sleep(35);
        assert.strictEqual(failures,3);assert.strictEqual(cap.start(),false);
    } finally {cap.close();}
    let unsupportedBuilds=0;
    const unsupported=new BmwHoldBridge({timeoutMs:10,retryMs:1,builders:{buildAndInitTypedProxy(){unsupportedBuilds++;return Promise.resolve({statusRotaryEncoderState:{subscribe(){throw new Error('must not subscribe without getter');}}});}}});
    try {
        unsupported.start();await until(()=>unsupported.errorCode==='CCU_FIELD_UNAVAILABLE','honest unsupported typed field');await sleep(20);
        assert.strictEqual(unsupportedBuilds,1);
    } finally {unsupported.close();}
    const closed=fixture();await closed.ready();closed.begin();await until(()=>closed.reads===1,'close during read');
    closed.bridge.close();const reads=closed.reads,builds=closed.builds;closed.event(0);closed.event(2);
    await sleep(35);assert.strictEqual(closed.reads,reads);assert.strictEqual(closed.builds,builds);assert.strictEqual(closed.bridge.start(),false);
    console.log('PASS hold lifecycle: bounded builders/subscriptions, late generations isolated, absent API reported, process closes permanently without later work');
})().catch(error=>{console.error(error&&error.stack||error);process.exitCode=1;});
