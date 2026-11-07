'use strict';
// Local startup/rollback integration. Nothing contacts a vehicle or network.
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
var api=require('../native/marku-kaluga-cameras/files/database-store');
var fresh=require('./build-camera-database').bundle();
var old=require('../data/camera-database-2026.11.6.1.json');
var tempBase=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(tempBase,'strelka-bundled-upgrade-')),stores=[];
function copy(v){return JSON.parse(JSON.stringify(v));}
function dir(name){var d=path.join(root,name);fs.mkdirSync(d);return d;}
function files(d){return{active:path.join(d,'camera-database-active.json'),previous:path.join(d,'camera-database-previous.json'),pin:path.join(d,'camera-database-rollback-pin.json')};}
function save(file,value){fs.writeFileSync(file,JSON.stringify(value));}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function create(d,initial,options){var s=api.createStore(Object.assign({dataDir:d,initial:initial},options||{}));stores.push(s);return s;}
function network(next){var calls=[];return{calls:calls,transport:function(url){calls.push(url);var bytes=Buffer.from(JSON.stringify(next));if(url===api.SOURCE_URL)return Promise.resolve(Buffer.from(JSON.stringify({schema:1,region:'RU-KLU',version:next.version,generatedAt:next.generatedAt,artifact:{url:'https://raw.githubusercontent.com/istt1899/bmw-kaluga-cameras/'+new Array(41).join('a')+'/data/camera-database-'+next.version+'.json',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}})));return Promise.resolve(bytes);}};}
function fault(fn,action){var original=fs.renameSync;fs.renameSync=function(from,to){if(fn(from,to)){var e=new Error('Injected filesystem failure');e.code='EIO';throw e;}return original.apply(fs,arguments);};try{return action();}finally{fs.renameSync=original;}}
async function main(){
 assert.strictEqual(old.records.length,156);assert.strictEqual(fresh.records.length,308);
 var d=dir('upgrade'),f=files(d),consumerCalls=0;save(f.active,old);
 var s=create(d,fresh,{onChange:function(){consumerCalls++;}});
 assert.strictEqual(s.current().version,fresh.version);assert.strictEqual(s.current().records.length,308);assert.strictEqual(s.status().phase,'bundled-upgraded');
 assert.strictEqual(consumerCalls,0,'Constructor returns its chosen database; it does not call a half-initialized consumer');
 assert.deepStrictEqual(read(f.previous),old);assert.deepStrictEqual(read(f.active),fresh);assert.strictEqual(s.status().canRollback,true);
 await s.rollback();assert.strictEqual(s.current().version,old.version);assert.strictEqual(s.status().rollbackPin.state,'valid');
 assert(fs.statSync(f.pin).size<=4096);if(process.platform!=='win32')assert.strictEqual(fs.statSync(f.pin).mode&511,384);
 s.close();var net=network(fresh),outage=true;s=create(d,fresh,{_test:{explicit:true,transport:function(url){if(outage){var e=new Error('offline fixture');e.code='UPDATE_HTTP_503';return Promise.reject(e);}return net.transport(url);}}});
 assert.strictEqual(s.current().version,old.version);assert.strictEqual(s.status().phase,'rollback-pinned');assert.strictEqual(net.calls.length,0,'Rollback restart does not download data');
 var pinBeforeOutage=fs.readFileSync(f.pin);var failedCheck=await s.check();assert.strictEqual(failedCheck.phase,'error');assert.strictEqual(s.current().version,old.version);assert(fs.readFileSync(f.pin).equals(pinBeforeOutage));outage=false;
 var status=await s.check();assert.strictEqual(status.phase,'updated');assert.strictEqual(s.current().version,fresh.version);assert.strictEqual(s.status().rollbackPin.state,'none');assert(!fs.existsSync(f.pin));s.close();
 s=create(d,fresh);assert.strictEqual(s.current().version,fresh.version);assert.strictEqual(s.status().phase,'idle');s.close();
 console.log('PASS real 156→308 offline bundled migration with backup; explicit rollback survives restart; successful latest check clears source-bound pin');

 d=dir('future-bundle');f=files(d);save(f.active,old);s=create(d,fresh);await s.rollback();s.close();
 var future=copy(fresh);future.version='2026.11.8.1';future.generatedAt='2026-11-08T00:00:00.000Z';
 s=create(d,future);assert.strictEqual(s.current().version,future.version);assert.strictEqual(s.status().phase,'bundled-upgraded');assert.deepStrictEqual(read(f.previous),old);assert(!fs.existsSync(f.pin));s.close();

 d=dir('current-check');f=files(d);save(f.active,fresh);save(f.previous,fresh);net=network(fresh);s=create(d,fresh,{_test:{explicit:true,transport:net.transport}});
 await s.rollback();assert(fs.existsSync(f.pin));assert.strictEqual(s.status().rollbackPin.state,'valid');
 status=await s.check();assert.strictEqual(status.phase,'current');assert.strictEqual(net.calls.length,1);assert(!fs.existsSync(f.pin));assert.strictEqual(status.rollbackPin.state,'none');s.close();
 console.log('PASS a future trusted bundle supersedes an older rollback binding; a current check also explicitly clears a same-version pin');

 d=dir('source-bound-pin');f=files(d);save(f.active,old);s=create(d,fresh);await s.rollback();s.close();
 var wrongSource=read(f.pin);wrongSource.source='https://attacker.example/manifest.json';save(f.pin,wrongSource);s=create(d,fresh);
 assert.strictEqual(s.current().version,fresh.version,'A foreign-channel pin cannot suppress the trusted bundled upgrade');assert.strictEqual(s.status().phase,'bundled-upgraded');assert(!fs.existsSync(f.pin));s.close();

 d=dir('upgrade-write-failure');f=files(d);save(f.active,old);
 s=fault(function(from,to){return to===f.active;},function(){return create(d,fresh);});
 assert.strictEqual(s.status().phase,'bundled-upgrade-error');assert.strictEqual(s.current().version,old.version);assert.deepStrictEqual(read(f.active),old);assert.deepStrictEqual(read(f.previous),old);s.close();
 d=dir('pin-write-failure');f=files(d);save(f.active,old);var lastConsumer=null;s=create(d,fresh,{onChange:function(next){lastConsumer=next.version;}});
 var realRename=fs.renameSync;fs.renameSync=function(from,to){if(to===f.pin){var e=new Error('pin rename refused');e.code='EIO';throw e;}return realRename.apply(fs,arguments);};
 try{status=await s.rollback();}finally{fs.renameSync=realRename;}
 assert.strictEqual(status.phase,'error');assert.strictEqual(s.current().version,fresh.version);assert.deepStrictEqual(read(f.active),fresh);assert.strictEqual(lastConsumer,fresh.version);assert(!fs.existsSync(f.pin));s.close();
 d=dir('active-write-rollback-failure');f=files(d);save(f.active,old);s=create(d,fresh);
 realRename=fs.renameSync;fs.renameSync=function(from,to){if(to===f.active){var e=new Error('active rename refused');e.code='EIO';throw e;}return realRename.apply(fs,arguments);};
 try{status=await s.rollback();}finally{fs.renameSync=realRename;}
 assert.strictEqual(status.phase,'error');assert.strictEqual(s.current().version,fresh.version);assert(!fs.existsSync(f.pin),'A failed rollback must undo its already-written pin');s.close();
 d=dir('pin-clear-after-activation-failure');f=files(d);save(f.active,old);net=network(fresh);s=create(d,fresh,{_test:{explicit:true,transport:net.transport}});await s.rollback();
 var rollbackBytes=fs.readFileSync(f.pin),realUnlink=fs.unlinkSync,failClear=true;
 fs.unlinkSync=function(file){if(file===f.pin&&failClear){failClear=false;realUnlink.call(fs,file);var e=new Error('metadata flush after unlink failed');e.code='EIO';throw e;}return realUnlink.apply(fs,arguments);};
 try{status=await s.check();}finally{fs.unlinkSync=realUnlink;}
 assert.strictEqual(status.phase,'error');assert.strictEqual(s.current().version,old.version);assert.deepStrictEqual(read(f.active),old);assert(fs.readFileSync(f.pin).equals(rollbackBytes),'Failed metadata clear restores old pin and old data transactionally');s.close();
 d=dir('closed-consumer');f=files(d);save(f.active,old);var closing;s=create(d,fresh,{onChange:function(){closing.close();}});closing=s;
 status=await s.rollback();assert.strictEqual(status.phase,'closed');assert.deepStrictEqual(read(f.active),fresh);assert(!fs.existsSync(f.pin));
 console.log('PASS failed active/pin writes retain last good database and restore consumer; consumer-close rollback writes no pin or database after close');

 d=dir('bad-metadata');f=files(d);save(f.active,fresh);fs.writeFileSync(f.pin,'{broken');s=create(d,fresh);assert.strictEqual(s.status().rollbackPin.state,'invalid');assert.strictEqual(s.status().rollbackPin.errorCode,'ROLLBACK_PIN_JSON');s.close();
 fs.writeFileSync(f.pin,new Array(4098).join('x'));s=create(d,fresh);assert.strictEqual(s.status().rollbackPin.errorCode,'ROLLBACK_PIN_SIZE');s.close();
 var originalStat=fs.lstatSync,originalRead=fs.readFileSync,pinReads=0;
 fs.lstatSync=function(file){if(file===f.pin)return{isFile:function(){return false;},isSymbolicLink:function(){return true;},size:10};return originalStat.apply(fs,arguments);};
 fs.readFileSync=function(file){if(file===f.pin){pinReads++;throw Error('symlink metadata must never be read');}return originalRead.apply(fs,arguments);};
 try{s=create(d,fresh);assert.strictEqual(s.status().rollbackPin.errorCode,'ROLLBACK_PIN_FILE');assert.strictEqual(pinReads,0);s.close();}finally{fs.lstatSync=originalStat;fs.readFileSync=originalRead;}
 console.log('PASS bounded regular rollback metadata: malformed JSON, oversize and symlink-shaped paths are diagnosed without reading a link target');
}
function cleanup(d){fs.readdirSync(d).forEach(function(n){var p=path.join(d,n),st=fs.lstatSync(p);if(st.isDirectory()&&!st.isSymbolicLink())cleanup(p);else fs.unlinkSync(p);});fs.rmdirSync(d);}
main().then(function(){stores.forEach(function(s){s.close();});assert.strictEqual(path.dirname(path.resolve(root)),tempBase);assert(/^strelka-bundled-upgrade-/.test(path.basename(root)));cleanup(root);},function(e){stores.forEach(function(s){s.close();});console.error(e.stack);process.exitCode=1;});
