'use strict';
var assert=require('assert'),createAudio=require('../native/marku-kaluga-cameras/files/warning-audio').createAudio;
function defer(){var resolve,reject;var promise=new Promise(function(a,b){resolve=a;reject=b;});return {promise:promise,resolve:resolve,reject:reject};}
function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
function fix(t,s){return {lat:54,lon:36,accuracyM:5,timeMs:t,motionTimeMs:t,speedKmh:s};}
function alert(id){return {id:id,sign:1,roadConfirmed:true,limitKmh:60};}
async function run(){
 var calls=[],queue=[],a=createAudio({play:function(){calls.push(1);var d=defer();queue.push(d);return d.promise;}},{timeoutMs:20});a.configure(true,20);
 a.update(alert('A'),fix(100000,80),100000);await wait(1);assert.strictEqual(calls.length,0);
 a.update(alert('A'),fix(101000,80.1),101000);await wait(1);assert.strictEqual(calls.length,1);
 await wait(30);assert.strictEqual(a.status().phase,'outcome-unknown');assert(a.status().pending);
 a.configure(false,20);a.configure(true,20);a.update(alert('B'),fix(115000,82),115000);await wait(1);assert.strictEqual(calls.length,1);
 await a.test(115000).then(function(){assert.fail();},function(){});
 queue[0].resolve({played:true});await wait(1);assert(!a.status().pending);a.update(alert('A'),fix(116000,82),116000);await wait(1);assert.strictEqual(calls.length,1,'late successful A remains deduplicated');
 a.update(alert('B'),fix(117000,82),117000);await wait(1);assert.strictEqual(calls.length,2);queue[1].reject(new Error('failure'));await wait(1);
 a.update(alert('B'),fix(128999,82),128999);await wait(1);assert.strictEqual(calls.length,2);a.update(alert('B'),fix(129000,82),129000);await wait(1);assert.strictEqual(calls.length,3);queue[2].resolve({played:true});await wait(1);
 a.update(alert('A'),fix(120000,82),120000);await wait(1);assert.strictEqual(calls.length,3,'rollback cannot cause new play');
 a.update(null,null,160001);a.update(alert('A'),Object.assign(fix(160002,82),{motionTimeMs:156000}),160002);await wait(1);assert.strictEqual(calls.length,3,'stale motion cannot play');
 a.update(alert('A'),fix(160003,82),160003);await wait(1);assert.strictEqual(calls.length,4);a.close();queue[3].resolve({played:true});await wait(1);assert.strictEqual(a.status().phase,'closed');
 var cancelledCalls=0,c=createAudio({play:function(){cancelledCalls++;return Promise.resolve({played:true});}});c.configure(true,20);c.update(alert('C'),fix(200000,82),200000);c.update(null,null,200001);await wait(1);assert.strictEqual(cancelledCalls,0,'withdrawal cancels not-yet-started play');c.close();
 var invoked=0,b=createAudio({play:function(){invoked++;return Promise.resolve({played:true});}});var q=b.test(1000);b.close();await q.then(function(){assert.fail();},function(){});await wait(1);assert.strictEqual(invoked,0);
 var epochCalls=[],epochQueue=[],e=createAudio({play:function(){epochCalls.push(1);var d=defer();epochQueue.push(d);return d.promise;}},{timeoutMs:20});e.configure(true,20);
 e.update(alert('A'),fix(500000,81),500000);await wait(1);epochQueue[0].resolve({played:true});await wait(1);
 assert.strictEqual(e.status().phase,'played');e.configure(true,20);assert.strictEqual(e.status().phase,'played','identical configure preserves outcome');
 e.update(alert('B'),fix(511999,81),511999);await wait(1);assert.strictEqual(epochCalls.length,1,'global cooldown across cameras');
 e.resetEpoch(100000);assert.strictEqual(e.status().phase,'ready');
 e.update(alert('B'),fix(100000,81),100000);await wait(1);assert.strictEqual(epochCalls.length,1,'rollback preserves remaining global cooldown');
 e.update(alert('B'),fix(100001,81),100001);await wait(1);assert.strictEqual(epochCalls.length,2);
 await wait(30);assert.strictEqual(e.status().phase,'outcome-unknown');
 e.resetEpoch(90000);assert(e.status().pending,'reset preserves underlying flight');
 e.update(alert('A'),fix(90001,81),90001);await wait(1);assert.strictEqual(epochCalls.length,2);
 epochQueue[1].resolve({played:true});await wait(1);assert.strictEqual(e.status().phase,'outcome-unknown','retired callback cannot change phase');
 e.update(alert('B'),fix(102001,81),102001);await wait(1);assert.strictEqual(epochCalls.length,2,'late played remains deduplicated after epoch reset');e.close();
 var xCalls=0,x=createAudio({play:function(){xCalls++;return Promise.resolve({played:true});}});x.configure(true,20);x.update(alert('X'),fix(100000,81),100000);x.configure(true,21);await wait(1);assert.strictEqual(xCalls,0,'threshold change revokes queued play');x.close();
 console.log('PASS audio timeout quarantine, late acknowledgement, retries, A/B dedup, clock rollback, stale motion and close');
}
run().catch(function(e){console.error(e.stack);process.exitCode=1;});
