'use strict';
const assert=require('assert'),EventEmitter=require('events');
const {BmwNavigationBridge,streetOf,NAV,GONG}=require('../apps/marku_kaluga_cameras/src/bmw_navigation_bridge');
const valid={status:'ON_ROAD',textDescription:{textDescriptorList:{STREET:{orthography:'Тульское шоссе'}}}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+1500;while(!check()){if(Date.now()>deadline)throw new Error('navigation bridge test timeout');await sleep(3);}}
assert.strictEqual(streetOf(valid),'Тульское шоссе');
assert.strictEqual(streetOf(Object.assign({},valid,{status:'OFF_ROAD'})),null);
assert.strictEqual(streetOf({status:1,textDescription:{textDescriptorList:{14:{orthography:'улица Болдина'}}}}),'улица Болдина');
assert.strictEqual(streetOf({status:1,textDescription:{textDescriptorList:{LOCATION_NAME:{orthography:'Not a street'}}}}),null);
assert.strictEqual(streetOf({status:1,textDescription:{textDescriptorList:{STREET:{orthography:'bad\nname'}}}}),null);
assert.strictEqual(streetOf({status:1,textDescription:{textDescriptorList:{STREET:{orthography:'x'.repeat(97)}}}}),null);
async function main(){
 const control=new EventEmitter(),sent=[],calls=[];control.link='up';control.send=x=>{sent.push(x);return true;};
 let callback;
 const builders={buildAndInitTypedProxy:(iface,instance)=>{calls.push([iface,instance]);return Promise.resolve(iface===NAV?{currentLocation:{subscribe:cb=>{callback=cb;return Promise.resolve();},getValue:()=>Promise.resolve(valid)}}:{getAllSampleSets:()=>Promise.resolve({listSampleNames:['standard']})});}};
 const bridge=new BmwNavigationBridge({builders,control,pollMs:1000});bridge.start();
 await new Promise(r=>setTimeout(r,20));
 assert(calls.some(c=>c[0]===NAV&&c[1]==='Main_Instance'));
 assert(calls.some(c=>c[0]===GONG));assert(sent.some(s=>s.street.name==='Тульское шоссе'));
 assert(sent.every(s=>s.cmd==='vehicle-context'&&s.audio.available===false),'read-only discovery never pretends to have played a sound');
 const before=sent.length;control.link='down';control.emit('change');control.link='up';control.emit('change');assert(sent.length>before,'reconnect must republish context');
 bridge.stop();const after=sent.length;callback(valid);assert.strictEqual(sent.length,after,'late native notifications after shutdown are inert');
 const denied=new BmwNavigationBridge({builders:{buildAndInitTypedProxy:()=>Promise.reject(new Error('EACCES'))},control});denied.start();await new Promise(r=>setTimeout(r,10));assert.strictEqual(denied.status().street.name,null);denied.stop();
 let pendingCallback,getCalls=0;
 const stalled=new BmwNavigationBridge({timeoutMs:8,pollMs:5,control,builders:{buildAndInitTypedProxy:iface=>Promise.resolve(iface===NAV?{currentLocation:{subscribe:cb=>{pendingCallback=cb;return Promise.resolve();},getValue:()=>{getCalls++;return new Promise(()=>{});}}}:{getAllSampleSets:()=>Promise.resolve({listSampleNames:[]})})}});
 stalled.start();await new Promise(r=>setTimeout(r,25));assert.strictEqual(getCalls,1,'a timed-out uncancellable SDK request must not grow a queue');assert.strictEqual(stalled.status().street.name,null);
 pendingCallback(valid);assert.strictEqual(stalled.status().street.name,'Тульское шоссе','live notifications remain usable during a stalled getter');
 const previousCallback=pendingCallback;stalled.stop();stalled.start();await sleep(20);
 assert.strictEqual(getCalls,1,'a stopped/restarted bridge does not queue another uncancellable getter');
 previousCallback(valid);assert.strictEqual(stalled.status().street.name,null,'old lifecycle notification is inert');
 pendingCallback(valid);assert.strictEqual(stalled.status().street.name,'Тульское шоссе');stalled.stop();

 // Audit P2-1: independent NAV/GONG transient failures recover; successful
 // channels are not rebuilt while the other channel is retrying.
 const retries={};let recoveredCallback;
 const recovered=new BmwNavigationBridge({control,timeoutMs:20,retryMs:5,retryMaxMs:10,pollMs:1000,builders:{buildAndInitTypedProxy:iface=>{
  retries[iface]=(retries[iface]||0)+1;if(retries[iface]===1)return Promise.reject(new Error('temporarily unavailable'));
  return Promise.resolve(iface===NAV?{currentLocation:{subscribe:cb=>{recoveredCallback=cb;return Promise.resolve();},getValue:()=>Promise.resolve(valid)}}:{getAllSampleSets:()=>Promise.resolve({listSampleNames:['readonly']})});
 }}});
 try{recovered.start();await until(()=>recovered.subscribed&&recovered.status().audio.state==='detected');await sleep(20);
  assert.strictEqual(retries[NAV],2);assert.strictEqual(retries[GONG],2);assert(recoveredCallback);assert.strictEqual(recovered.status().audio.available,false);
 }finally{recovered.stop();}

 const lateBuilds={},lateResolvers={};let lateSubscriptions=0;
 const pendingBuild=new BmwNavigationBridge({control,timeoutMs:8,retryMs:4,retryMaxMs:8,pollMs:1000,builders:{buildAndInitTypedProxy:iface=>{
  lateBuilds[iface]=(lateBuilds[iface]||0)+1;if(lateBuilds[iface]===1)return new Promise(resolve=>{lateResolvers[iface]=resolve;});
  return Promise.resolve(iface===NAV?{currentLocation:{subscribe:()=>{lateSubscriptions++;return Promise.resolve();},getValue:()=>Promise.resolve(valid)}}:{getAllSampleSets:()=>Promise.resolve({listSampleNames:[]})});
 }}});
 try{pendingBuild.start();await until(()=>pendingBuild.subscribed&&pendingBuild.status().audio.state==='detected');
  lateResolvers[NAV]({currentLocation:{subscribe:()=>{throw new Error('late NAV must not subscribe');},getValue:()=>Promise.resolve(valid)}});
  lateResolvers[GONG]({getAllSampleSets:()=>{throw new Error('late GONG must not read');}});await sleep(15);
  assert.strictEqual(lateSubscriptions,1);assert.strictEqual(lateBuilds[NAV],2);assert.strictEqual(lateBuilds[GONG],2);
 }finally{pendingBuild.stop();}

 let subscribeDone,subscriptionBuilds=0;const subscriptionCallbacks=[];
 const pendingSubscription=new BmwNavigationBridge({control,timeoutMs:8,retryMs:4,pollMs:1000,builders:{buildAndInitTypedProxy:iface=>{
  if(iface===GONG)return Promise.resolve({getAllSampleSets:()=>Promise.resolve({listSampleNames:[]})});
  const build=++subscriptionBuilds;return Promise.resolve({currentLocation:{subscribe:cb=>{subscriptionCallbacks.push(cb);return build===1?new Promise(resolve=>{subscribeDone=resolve;}):Promise.resolve();},getValue:()=>Promise.resolve(valid)}});
 }}});
 try{pendingSubscription.start();await until(()=>pendingSubscription.subscribed);assert.strictEqual(subscriptionBuilds,2);
  const before=sent.length;subscriptionCallbacks[0](valid);subscribeDone();await sleep(15);assert.strictEqual(sent.length,before,'late subscription cannot overwrite recovered context');
 }finally{pendingSubscription.stop();}

 const cappedCalls={};const capped=new BmwNavigationBridge({control,timeoutMs:5,retryMs:3,retryMaxMs:5,builders:{buildAndInitTypedProxy:iface=>{cappedCalls[iface]=(cappedCalls[iface]||0)+1;return new Promise(()=>{});}}});
 try{capped.start();await until(()=>/Лимит/.test(capped.status().street.reason)&&/Лимит/.test(capped.status().audio.reason));assert.strictEqual(cappedCalls[NAV],3);assert.strictEqual(cappedCalls[GONG],3);
  assert(/Лимит/.test(capped.status().street.reason));assert(/Лимит/.test(capped.status().audio.reason));
 }finally{capped.stop();}
 let cancelled=0;const stoppedRetry=new BmwNavigationBridge({control,retryMs:25,builders:{buildAndInitTypedProxy:()=>{cancelled++;return Promise.reject(new Error('temporary'));}}});
 stoppedRetry.start();await sleep(5);stoppedRetry.stop();await sleep(40);assert.strictEqual(cancelled,2,'stop cancels both retry timers');
 console.log('PASS read-only BMW NAV/GONG recovery, bounded hung builder/subscription retries, stale token guards, single-flight getter, reconnect and shutdown');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
