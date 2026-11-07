'use strict';
// Production startup + real database store; socket/GPS only are local stand-ins.
var assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),EventEmitter=require('events');
var base=path.resolve(__dirname,'../native/marku-kaluga-cameras/files'),store=require(path.join(base,'database-store'));
var latest=require('./build-camera-database').bundle(),old=require('../data/camera-database-2026.11.6.1.json');
var root=fs.mkdtempSync(path.join(os.tmpdir(),'strelka-source-bootstrap-')),apps=[],seq=0;
function run(extra,saved){
 var dir=path.join(root,String(++seq));fs.mkdirSync(dir);if(saved)fs.writeFileSync(path.join(dir,'camera-database-active.json'),JSON.stringify(saved));
 var server=new EventEmitter();server.listen=function(at,cb){cb();};server.close=function(){};
 var module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(base,'marku-kaluga-cameras.js'),'utf8'),{
  require:function(name){return name==='net'?{createServer:function(){return server;}}:require(name[0]==='.'?path.join(base,name):name);},
  module:module,exports:module.exports,__dirname:base,process:{env:{},pid:123},Buffer:Buffer,console:console,
  setInterval:function(){return 1;},clearInterval:function(){}});
 var gps=new EventEmitter();gps.start=gps.close=function(){};gps.current=function(){return null;};
 var app=module.exports.start(Object.assign({dataDir:dir,socket:'\\\\.\\pipe\\bootstrap-test',gps:gps,
  display:{update:function(){},status:function(){return'off';},close:function(){}},dimmer:{update:function(){},status:function(){return'off';},close:function(){}}},extra||{}));
 apps.push(app);return{app:app,dir:dir,state:app.state()};
}
var broken=path.join(root,'broken.json'),missing=path.join(root,'missing.json');fs.writeFileSync(broken,'{broken');
async function main(){
 var ok=run();assert.strictEqual(ok.state.database.count,308);assert.strictEqual(ok.state.database.version,latest.version);assert.strictEqual(ok.state.sourceAssembly.state,'complete');
 [ {officialCatalog:broken},{officialCatalog:missing},{officialQuality:broken},{officialQuality:missing},{speedLimitData:broken},{speedLimitData:missing} ].forEach(function(options){
  var r=run(options);assert.strictEqual(r.state.database.count,156);assert.strictEqual(r.state.database.version,old.version);
  assert.strictEqual(r.state.database.generatedAt,old.generatedAt);assert.strictEqual(r.state.sourceAssembly.state,'legacy-fallback');
  assert.strictEqual(r.state.sourceAssembly.errorCode,'OFFICIAL_SOURCE_ASSEMBLY_FAILED');assert(r.state.sourceAssembly.reason);
  assert.strictEqual(r.state.sourceAssembly.wantedVersion,latest.version);assert.strictEqual(r.state.sourceAssembly.activeVersion,old.version);
  assert.strictEqual(r.state.capabilities.update,true);
 });
 var retained=run({officialCatalog:broken},latest);assert.strictEqual(retained.state.database.version,latest.version);assert.strictEqual(retained.state.database.count,308);
 assert.strictEqual(retained.state.sourceAssembly.state,'legacy-fallback');assert.strictEqual(retained.state.sourceAssembly.activeVersion,latest.version);
 assert.strictEqual(JSON.parse(fs.readFileSync(path.join(retained.dir,'camera-database-active.json'),'utf8')).records.length,308);
 var legacy=run({officialCatalog:broken},old);assert.strictEqual(legacy.state.database.version,old.version);assert.strictEqual(legacy.state.database.count,156);
 assert.strictEqual(JSON.parse(fs.readFileSync(path.join(legacy.dir,'camera-database-active.json'),'utf8')).version,old.version);
 var liveStore,bytes=Buffer.from(JSON.stringify(latest)),crypto=require('crypto');
 var recovery=run({officialQuality:missing,storeFactory:function(options){liveStore=store.createStore(Object.assign({},options,{_test:{explicit:true,transport:function(url){
  return Promise.resolve(url===store.SOURCE_URL?Buffer.from(JSON.stringify({schema:1,region:'RU-KLU',version:latest.version,generatedAt:latest.generatedAt,artifact:{url:'https://raw.githubusercontent.com/istt1899/bmw-kaluga-cameras/'+new Array(41).join('a')+'/data/camera-database-'+latest.version+'.json',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}})):bytes);
 }}}));return liveStore;}},old);
 await liveStore.check();assert.strictEqual(recovery.state.database.count,308);assert.strictEqual(recovery.state.database.version,latest.version);
 assert.strictEqual(recovery.state.sourceAssembly.state,'legacy-fallback','Packaged source failure remains visible after active data recovers');
 console.log('PASS source bootstrap is transactional: corrupt/missing optional files retain correct old version; complete stored bundle survives; explicit update recovers 156 to 308 without hiding packaged fault');
}
function cleanup(d){fs.readdirSync(d).forEach(function(n){var p=path.join(d,n);if(fs.lstatSync(p).isDirectory())cleanup(p);else fs.unlinkSync(p);});fs.rmdirSync(d);}
main().then(function(){apps.forEach(function(a){a.close();});assert.strictEqual(path.dirname(root),os.tmpdir());assert(/^strelka-source-bootstrap-/.test(path.basename(root)));cleanup(root);},function(e){apps.forEach(function(a){a.close();});console.error(e.stack);process.exitCode=1;});
