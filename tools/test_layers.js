'use strict';
const net=require('net'),assert=require('assert'),os=require('os'),path=require('path');
const displayModule=require('../native/marku-kaluga-cameras/files/camera-layers');
const card=require('../native/marku-kaluga-cameras/files/alert-card');
const socketName=process.platform==='win32'?'\\\\.\\pipe\\kaluga-layer-test-'+process.pid:path.join(os.tmpdir(),'kaluga-layer-test-'+process.pid+'.sock');
const frame=(o)=>{
    const payload=Buffer.from(JSON.stringify(o),'utf8'), message=Buffer.alloc(5+payload.length);
    message.writeUInt32LE(payload.length+1,0);message[4]=74;payload.copy(message,5);return message;
};
const displayed=new Set(),layers=new Map(),pixels=new Set(),peers=new Set();
let opens=0,pendingError=null,dirtyFrames=0;
const server=net.createServer(sock=>{
    peers.add(sock);sock.on('close',()=>peers.delete(sock));
    opens++;let buf=Buffer.alloc(0);
    sock.on('error',()=>{});
    sock.on('data',chunk=>{
        try{
            buf=Buffer.concat([buf,chunk]);
            while(buf.length>=5&&buf.length>=4+buf.readUInt32LE(0)){
                const end=4+buf.readUInt32LE(0),type=buf[4],data=buf.slice(5,end);buf=buf.slice(end);
                if(type===70){
                    if(data.readUInt16LE(12)===0)assert.strictEqual(data.length,14+card.width*card.height*4);
                    else{assert.strictEqual(data.readUInt16LE(12),1);assert(data.length<card.width*card.height*2);dirtyFrames++;}
                    pixels.add(data.readUInt32LE(0));continue;
                }
                const msg=JSON.parse(data.toString());
                if(msg.op==='hello')sock.write(frame({ev:'hello',backend:'test',targets:'map,hud'}));
                if(msg.op==='layer'){
                    assert.strictEqual(msg.visible,0);assert.strictEqual(msg.contend,1);assert.strictEqual(msg.exclusive,0);
                    assert.strictEqual(msg.class,'alert');layers.set(msg.ref,msg.target);
                }
                if(msg.op==='set'&&msg.visible===1){displayed.add(msg.ref);sock.write(frame({ev:'layer',ref:msg.ref,state:'visible'}));
                    sock.write(frame({ev:'target',target:layers.get(msg.ref),state:'mapped'}));}
            }
        }catch(e){pendingError=e;}
    });
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
    const display=displayModule.createDisplay({socket:socketName});
    const a={id:'test',title:'Светофор и скорость',description:'Спектр-Поток CCR0047',controls:['redlight','speed'],distanceM:240,limitKmh:60,roadConfirmed:true};
    const image=card.card(a,'map'),near=card.card(Object.assign({},a,{roadConfirmed:false}),'map');
    assert(!image.equals(near),'road-confirmed and nearby cards must have distinct labels and no nearby speed-limit badge');
    await new Promise(resolve=>server.listen(socketName,resolve));
    try{
        display.update(a,{cluster:false,hud:false});display.update(null,{cluster:true,hud:true});
        await sleep(20);assert.strictEqual(opens,0);
        display.update(a,{cluster:true,hud:true});
        for(let wait=0;wait<100&&(!pendingError&&(displayed.size<2||pixels.size<2));wait++)await sleep(15);
        if(pendingError)throw pendingError;
        assert.deepStrictEqual(Array.from(layers.values()).sort(),['hud','map']);
        for(const ref of layers.keys()){assert(pixels.has(ref));assert(displayed.has(ref));}
        display.update(Object.assign({},a,{distanceM:230}),{cluster:true,hud:true});
        for(let wait=0;wait<100&&!pendingError&&dirtyFrames<2;wait++)await sleep(15);
        if(pendingError)throw pendingError;assert.strictEqual(dirtyFrames,2,'distance-only changes update compact dirty rectangles');
        const hudRef=Array.from(layers.keys()).find(ref=>layers.get(ref)==='hud');
        peers.forEach(sock=>sock.write(frame({ev:'error',op:'layer',ref:hudRef,reason:'HUD_GUARD'})));
        for(let wait=0;wait<100&&display.diagnostics().hud.state!=='отказ';wait++)await sleep(10);
        assert.strictEqual(display.diagnostics().hud.reason,'HUD_GUARD');assert.strictEqual(display.diagnostics().map.state,'visible');
        display.update(null,{cluster:true,hud:true});
        await sleep(25);const count=await new Promise((resolve,reject)=>server.getConnections((e,n)=>e?reject(e):resolve(n)));
        assert.strictEqual(count,0);
        console.log('PASS nonexclusive typed Cyrillic HUD/map cards, mapping contention, exact RGBA upload, off by default and release on lost alert');
    }finally{display.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
