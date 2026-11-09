'use strict';
// Explicit local test adapters. No BMW interfaces, internet or discovery.
var fs=require('fs'),path=require('path'),EventEmitter=require('events');
var root=path.resolve(__dirname,'../../native/marku-kaluga-cameras/files');
var dir=process.argv[2],socket=process.argv[3],deny=false,writes=0,originalWrite=fs.writeFileSync;
fs.writeFileSync=function(file){
 var name=path.resolve(String(file));
 if(name===path.resolve(dir,'settings.json')||name===path.resolve(dir,'settings.json.tmp')){
  writes++;process.stdout.write('WRITE '+writes+'\n');
  if(deny)throw Object.assign(Error('Injected read-only settings filesystem'),{code:'EROFS'});
 }
 return originalWrite.apply(fs,arguments);
};
var gps=new EventEmitter();gps.start=gps.close=function(){};
gps.current=function(){return{lat:54.4932,lon:36.2282,timeMs:Date.now(),motionTimeMs:Date.now(),speedKmh:0,headingDeg:90,accuracyM:19.4};};
var details={connection:'ready'},layers=require(path.join(root,'camera-layers'));
var app=require(path.join(root,'marku-kaluga-cameras')).start({dataDir:dir,socket:socket,gps:gps,
 guidance:{evaluate:function(){return null;}},
 display:{update:function(alert,outputs,layouts){['map','hud'].forEach(function(target){details[target]={state:alert?'shown':'off',layout:layers.layoutFor(target,target==='map'?{width:1088,height:480}:{width:800,height:400},'fixture',layouts[target])};});},
  diagnostics:function(){return details;},status:function(){return'ready';},close:function(){}},
 dimmer:{update:function(){},status:function(){return'off';},close:function(){}},
 onListening:function(){process.stdout.write('READY\n');},onError:function(error){process.stderr.write(error.stack);process.exitCode=1;}});
var input='';process.stdin.on('data',function(bytes){input+=bytes;var newline;while((newline=input.indexOf('\n'))>=0){var line=input.slice(0,newline);input=input.slice(newline+1);
 if(line==='deny'){deny=true;process.stdout.write('DENY\n');}
 if(line==='allow'){deny=false;process.stdout.write('ALLOW\n');}
 if(line==='stop'){app.close();process.stdout.write('STOPPED\n');process.exit(0);}
}});
