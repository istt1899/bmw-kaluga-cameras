'use strict';
const net=require('net'),assert=require('assert'),os=require('os'),path=require('path');
const displayModule=require('../native/marku-kaluga-cameras/files/camera-layers');
const socketName=process.platform==='win32'?'\\\\.\\pipe\\kaluga-layer-test-'+process.pid:path.join(os.tmpdir(),'kaluga-layer-test-'+process.pid+'.sock');
const frame=(o)=>{
    const payload=Buffer.from(JSON.stringify(o),'utf8'), message=Buffer.alloc(5+payload.length);
    message.writeUInt32LE(payload.length+1,0);message[4]=74;payload.copy(message,5);return message;
};
const displayed=new Set(),layers=new Map(),pixels=new Set();
let opens=0,pendingError=null;
const server=net.createServer(sock=>{
    opens++;let buf=Buffer.alloc(0);
    sock.on('error',()=>{});
    sock.on('data',chunk=>{
        try{
            buf=Buffer.concat([buf,chunk]);
            while(buf.length>=5&&buf.length>=4+buf.readUInt32LE(0)){
                const end=4+buf.readUInt32LE(0),type=buf[4],data=buf.slice(5,end);buf=buf.slice(end);
                if(type===70){
                    assert(data.length>=148*36*4);pixels.add(data.readUInt32LE(0));continue;
                }
                const msg=JSON.parse(data.toString());
                if(msg.op==='hello')sock.write(frame({ev:'hello',backend:'test',targets:'map,hud'}));
                if(msg.op==='layer'){
                    assert.strictEqual(msg.visible,0);assert.strictEqual(msg.contend,0);assert.strictEqual(msg.exclusive,0);
                    assert.strictEqual(msg.class,'alert');layers.set(msg.ref,msg.target);
                }
                if(msg.op==='set'&&msg.visible===1)displayed.add(msg.ref);
            }
        }catch(e){pendingError=e;}
    });
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
    const display=displayModule.createDisplay({socket:socketName});
    const a={id:'test',distanceM:240,limitKmh:60};
    await new Promise(resolve=>server.listen(socketName,resolve));
    try{
        display.update(a,{cluster:false,hud:false});display.update(null,{cluster:true,hud:true});
        await sleep(20);assert.strictEqual(opens,0);
        display.update(a,{cluster:true,hud:true});
        for(let wait=0;wait<100&&(!pendingError&&(displayed.size<2||pixels.size<2));wait++)await sleep(15);
        if(pendingError)throw pendingError;
        assert.deepStrictEqual(Array.from(layers.values()).sort(),['hud','map']);
        for(const ref of layers.keys()){assert(pixels.has(ref));assert(displayed.has(ref));}
        display.update(null,{cluster:true,hud:true});
        await sleep(25);const count=await new Promise((resolve,reject)=>server.getConnections((e,n)=>e?reject(e):resolve(n)));
        assert.strictEqual(count,0);
        console.log('PASS passive HUD/map protocol, actual image upload, off by default, close on lost alert');
    }finally{display.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
