'use strict';
// AC-003: real persisted 0.7 settings, real child/service/socket restarts and EROFS.
var assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),cp=require('child_process');
var cards=require('../native/marku-kaluga-cameras/files/card-layout'),prefs=require('../native/marku-kaluga-cameras/files/alert-preferences');
var root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'strelka-upgrade-080-')),file=path.join(root,'settings.json'),runs=[],seq=0;
var legacy={enabled:true,outputs:{cluster:false,hud:true},hudOpacityPct:45,
 cardLayout:{hud:{x:230,y:690,scalePct:80,brightnessPct:55,opacityPct:30},map:{x:750,y:220,scalePct:145,brightnessPct:65,opacityPct:85}},
 alertPreferences:prefs.normalize({warningDistanceM:850,cameraTypes:{speed:false,belt:false,phone:false}}),
 overspeedPreferences:{visualFlash:false,visualOffsetKmh:7,soundEnabled:true,soundOffsetKmh:23}};
function copy(value){return JSON.parse(JSON.stringify(value));}
function delay(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
async function until(fn){for(var i=0;i<400;i++){if(fn())return;await delay(10);}throw Error('Upgrade fixture timed out');}
function known(state){return{enabled:state.enabled,outputs:state.outputs,hudOpacityPct:state.hudOpacityPct,cardLayout:state.cardLayout,alertPreferences:state.alertPreferences,overspeedPreferences:state.overspeedPreferences};}
async function start(){
 var socket=process.platform==='win32'?'\\\\.\\pipe\\strelka-upgrade-'+process.pid+'-'+(++seq):path.join(root,'ctl-'+(++seq)+'.sock');
 var child=cp.spawn(process.execPath,[path.join(__dirname,'fixtures/upgrade-service.cjs'),root,socket],{windowsHide:true,stdio:['pipe','pipe','pipe']}),output='',errors='',states=[],buffer='';
 child.stdout.on('data',function(b){output+=b;});child.stderr.on('data',function(b){errors+=b;});
 var run={child:child,output:function(){return output;},state:function(){return states[states.length-1];}};runs.push(run);
 await until(function(){if(child.exitCode!==null)throw Error(errors||'Service exited early');return output.indexOf('READY\n')>=0;});
 var client=net.connect(socket);run.client=client;client.setEncoding('utf8');client.on('error',function(){});
 client.on('data',function(b){buffer+=b;var nl;while((nl=buffer.indexOf('\n'))>=0){var msg=JSON.parse(buffer.slice(0,nl));buffer=buffer.slice(nl+1);if(msg.state)states.push(msg.state);}});
 await until(function(){return states.length>0;});
 run.command=async function(message){var id='upgrade-'+(++seq);client.write(JSON.stringify(Object.assign({requestId:id},message))+'\n');await until(function(){return states.some(function(s){return s.commandResult&&s.commandResult.requestId===id&&s.commandResult.phase!=='requested';});});return states.filter(function(s){return s.commandResult&&s.commandResult.requestId===id;}).pop();};
 run.refresh=async function(){var count=states.length;client.write('{"cmd":"status"}\n');await until(function(){return states.length>count;});return run.state();};
 run.deny=async function(){child.stdin.write('deny\n');await until(function(){return output.indexOf('DENY\n')>=0;});};
 run.close=async function(){client.destroy();child.stdin.write('stop\n');await until(function(){return child.exitCode!==null;});assert.strictEqual(child.exitCode,0,errors);};
 return run;
}
async function main(){
 fs.writeFileSync(file,JSON.stringify(legacy,null,2)+'\n');var initial=fs.readFileSync(file),run=await start(),expected=copy(legacy);
 assert.deepStrictEqual(known(run.state()),legacy);await delay(650);assert(!/WRITE /.test(run.output()),'First open/ticks cannot rewrite legacy preferences');assert(fs.readFileSync(file).equals(initial));
 var s=await run.command({cmd:'display-test',target:'hud'});assert.strictEqual(s.displayTest.active,true);assert.strictEqual(s.displayTest.target,'hud');
 var bytes=fs.readFileSync(file),writes=run.output().split('WRITE ').length;
 await run.refresh();
 assert(fs.readFileSync(file).equals(bytes));assert.strictEqual(run.output().split('WRITE ').length,writes);
 s=await run.command({cmd:'display-test',target:'map'});assert.strictEqual(s.commandResult.phase,'error');assert.strictEqual(s.displayTest.target,'hud');assert.strictEqual(s.displayTest.active,true);
 s=await run.command({cmd:'outputs',cluster:true,hud:true});expected.outputs.cluster=true;
 s=await run.command({cmd:'display-test',target:'map'});assert.strictEqual(s.displayTest.target,'map');assert.strictEqual(s.displayTest.active,true);
 s=await run.command({cmd:'card-layout',target:'hud',x:245});expected.cardLayout.hud.x=245;assert.deepStrictEqual(known(s),expected);
 s=await run.command({cmd:'card-layout-reset',target:'map'});expected.cardLayout.map=cards.defaultLayouts().map;assert.deepStrictEqual(known(s),expected);
 s=await run.command({cmd:'display-test-stop',target:'map'});assert.strictEqual(s.displayTest.active,false);assert.strictEqual(s.storage.settingsSaved,true);assert.deepStrictEqual(JSON.parse(fs.readFileSync(file,'utf8')),expected);
 await run.close();run=await start();assert.deepStrictEqual(known(run.state()),expected);assert(!/WRITE /.test(run.output()),'Upgrade/restart reading writes no preferences');assert.strictEqual(run.state().displayTest.active,false);
 var durable=fs.readFileSync(file);await run.deny();s=await run.command({cmd:'card-layout',target:'hud',x:900});assert.strictEqual(s.cardLayout.hud.x,900);assert.strictEqual(s.storage.persistent,false);assert.strictEqual(s.storage.settingsSaved,false);assert(/временно/.test(s.commandResult.message));assert(fs.readFileSync(file).equals(durable));
 s=await run.command({cmd:'display-test-stop',target:'hud'});assert.strictEqual(s.displayTest.active,false);assert(/временно/.test(s.commandResult.message));assert.strictEqual(s.storage.settingsSaved,false);
 await run.close();run=await start();assert.deepStrictEqual(known(run.state()),expected);assert(fs.readFileSync(file).equals(durable));await run.close();
 console.log('PASS real 0.7 settings -> new service/IPC -> zero opening writes -> independent preview targets/profiles/reset -> Done -> process restart; EROFS temporary state never claimed durable and restart reads last saved values');
}
function remove(dir){assert(dir===root||dir.indexOf(root+path.sep)===0);fs.readdirSync(dir).forEach(function(name){var p=path.join(dir,name),s=fs.lstatSync(p);if(s.isDirectory()&&!s.isSymbolicLink())remove(p);else fs.unlinkSync(p);});fs.rmdirSync(dir);}
main().catch(function(error){console.error(error.stack);process.exitCode=1;}).then(function(){runs.forEach(function(r){if(r.client)r.client.destroy();if(r.child.exitCode===null)r.child.kill();});remove(root);});
