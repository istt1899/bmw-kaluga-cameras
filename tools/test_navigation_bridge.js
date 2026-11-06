'use strict';
const assert=require('assert'),EventEmitter=require('events');
const {BmwNavigationBridge,streetOf,NAV,GONG}=require('../apps/marku_kaluga_cameras/src/bmw_navigation_bridge');
const valid={status:'ON_ROAD',textDescription:{textDescriptorList:{STREET:{orthography:'Тульское шоссе'}}}};
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
 pendingCallback(valid);assert.strictEqual(stalled.status().street.name,'Тульское шоссе','live notifications remain usable during a stalled getter');stalled.stop();
 console.log('PASS optional read-only BMW street field, explicit semantic street key, native sound discovery without playback, ACL failure, reconnect and shutdown');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
