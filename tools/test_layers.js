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
const wireLayers=new Map(),wirePixels=new Map(),wireFrames=[],wireMessages=[];
let opens=0,pendingError=null,dirtyFrames=0,compactDirty=true,announcedTargets='map:1088x480,panel:1920x720,hud:800x480';
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
                    const ref=data.readUInt32LE(0),count=data.readUInt16LE(12);
                    const image=wirePixels.has(ref)?Buffer.from(wirePixels.get(ref)):Buffer.alloc(card.width*card.height*4);
                    if(count===0){assert.strictEqual(data.length,14+image.length);data.copy(image,0,14);}
                    else{
                        if(compactDirty){assert.strictEqual(count,1);assert(data.length<card.width*card.height*2);dirtyFrames++;}
                        let offset=14+count*8;
                        for(let i=0;i<count;i++){
                            const head=14+i*8,x=data.readUInt16LE(head),y=data.readUInt16LE(head+2),w=data.readUInt16LE(head+4),h=data.readUInt16LE(head+6);
                            assert(w>0&&h>0&&x+w<=card.width&&y+h<=card.height,'wire dirty rectangle stays inside the intrinsic raster');
                            for(let row=0;row<h;row++){data.copy(image,((y+row)*card.width+x)*4,offset,offset+w*4);offset+=w*4;}
                        }
                        assert.strictEqual(offset,data.length,'wire frame contains exactly the declared rectangle pixels');
                    }
                    wirePixels.set(ref,image);wireFrames.push({ref,image:Buffer.from(image)});
                    pixels.add(ref);continue;
                }
                const msg=JSON.parse(data.toString());
                wireMessages.push(msg);
                if(msg.op==='hello')sock.write(frame({ev:'hello',backend:'test',targets:announcedTargets}));
                if(msg.op==='layer'){
                    assert.strictEqual(msg.visible,0);assert.strictEqual(msg.contend,1);assert.strictEqual(msg.exclusive,0);
                    assert.strictEqual(msg.class,'alert');layers.set(msg.ref,msg.target);
                    wireLayers.set(msg.ref,Object.assign({},msg));
                    const canvas=displayModule.parseTargets(announcedTargets)[msg.target];
                    assert(canvas,'never create a layer without reported runtime dimensions');
                    // Reconnect may replay an old rectangle only while hidden;
                    // every visible set below must fit the new runtime target.
                    if(opens===1)assert(msg.x>=0&&msg.y>=0&&msg.x+msg.w<=canvas.width&&msg.y+msg.h<=canvas.height);
                }
                if(msg.op==='set'&&wireLayers.has(msg.ref)){
                    const layer=wireLayers.get(msg.ref);Object.assign(layer,msg);
                    if(layer.visible===1){
                        const canvas=displayModule.parseTargets(announcedTargets)[layer.target];
                        assert(canvas&&layer.x>=0&&layer.y>=0&&layer.x+layer.w<=canvas.width&&layer.y+layer.h<=canvas.height,'every live set keeps displayed geometry inside the reported target');
                    }
                }
                if(msg.op==='set'&&msg.visible===1){displayed.add(msg.ref);sock.write(frame({ev:'layer',ref:msg.ref,state:'visible'}));
                    sock.write(frame({ev:'target',target:layers.get(msg.ref),state:'mapped'}));}
            }
        }catch(e){pendingError=e;}
    });
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(label,check){for(let wait=0;wait<150&&!pendingError;wait++){if(check())return;await sleep(10);}if(pendingError)throw pendingError;throw new Error(label+' timed out');}
function styleMatches(actual,original,brightnessPct,opacityPct){
    assert.strictEqual(actual.length,original.length);
    for(let i=0;i<actual.length;i++)assert(Math.abs(actual[i]-Math.round(original[i]*(i%4===3?opacityPct:brightnessPct)/100))<=1,'RGBA style mismatch at byte '+i);
}
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
        const layout=display.diagnostics();
        assert.strictEqual(layout.connection,'ready');
        assert.strictEqual(layout.version,null);
        assert.strictEqual(layout.versionReported,false,'protocol without version must not invent one');
        assert.strictEqual(layout.map.layout.backend,'test');
        assert.deepStrictEqual(layout.map.layout.canvas,{width:1088,height:480});
        assert.strictEqual(layout.map.layout.safeArea.known,false,'renderer does not establish a manufacturer safe area');
        assert(layout.hud.layout.withinBounds&&layout.hud.layout.card.width<=320);
        const liveAlert=Object.assign({},a,{distanceM:230}),outputs={cluster:true,hud:true};
        display.update(liveAlert,outputs);
        for(let wait=0;wait<100&&!pendingError&&dirtyFrames<2;wait++)await sleep(15);
        if(pendingError)throw pendingError;assert.strictEqual(dirtyFrames,2,'distance-only changes update compact dirty rectangles');
        const hudRef=Array.from(layers.keys()).find(ref=>layers.get(ref)==='hud');
        const mapRef=Array.from(layers.keys()).find(ref=>layers.get(ref)==='map');
        compactDirty=false;
        const profiles={hud:{x:500,y:820,scalePct:100,brightnessPct:100,opacityPct:100},map:{x:500,y:880,scalePct:100,brightnessPct:100,opacityPct:100}};
        display.update(liveAlert,outputs,profiles);
        await until('profile geometry',()=>!!display.diagnostics().hud.layout.positionRange);
        const beforeMove=Object.assign({},wireLayers.get(hudRef)),range=display.diagnostics().hud.layout.positionRange;
        const move=Math.round(10*1000/(range.maxX-range.minX)),moveY=Math.round(10*1000/(range.maxY-range.minY));
        const opensBefore=opens,createdBefore=wireMessages.filter(m=>m.op==='layer').length,editsStart=wireMessages.length;
        const moved=JSON.parse(JSON.stringify(profiles));moved.hud.x+=move;moved.hud.y+=moveY;
        display.update(liveAlert,outputs,moved);
        await until('live HUD position move',()=>wireLayers.get(hudRef).x!==beforeMove.x&&wireLayers.get(hudRef).y!==beforeMove.y);
        assert(Math.abs(wireLayers.get(hudRef).x-beforeMove.x-10)<=1,'normalized movement produces approximately 10 actual renderer pixels');
        assert(Math.abs(wireLayers.get(hudRef).y-beforeMove.y-10)<=1,'normalized vertical movement produces approximately 10 actual renderer pixels');
        assert.strictEqual(wireLayers.get(mapRef).x,layout.map.layout.card.x,'HUD positioning does not move map warning');
        assert.strictEqual(opens,opensBefore,'live transform keeps renderer connection');
        assert.strictEqual(wireMessages.filter(m=>m.op==='layer').length,createdBefore,'live transform reuses existing image refs');

        const mapBeforeStyle=Buffer.from(wirePixels.get(mapRef)),hudFrames=wireFrames.filter(f=>f.ref===hudRef).length;
        const styled=JSON.parse(JSON.stringify(moved));styled.hud.brightnessPct=40;styled.hud.opacityPct=50;
        display.update(liveAlert,outputs,styled);
        await until('style-only raster update',()=>wireFrames.filter(f=>f.ref===hudRef).length>hudFrames);
        styleMatches(wirePixels.get(hudRef),card.card(liveAlert,'hud'),40,50);
        assert(wirePixels.get(mapRef).equals(mapBeforeStyle),'HUD brightness/opacity cannot dim map card or map scene');
        assert(wireMessages.filter(m=>m.op==='layer').every(m=>m.class==='alert'&&m.iw===320&&m.ih===96),'camera calibration never introduces a full-canvas map dimmer');
        assert(wireMessages.every(m=>m.opacity===undefined||m.opacity===1),'raster alpha is not multiplied again by layer opacity');

        const preview=Object.assign({},liveAlert,{test:true,calibration:true}),saved=JSON.parse(JSON.stringify(styled));
        saved.map={x:230,y:200,scalePct:125,brightnessPct:70,opacityPct:80};
        const beforePreviewFrames=wireFrames.filter(f=>f.ref===mapRef).length;
        display.update(preview,outputs,saved);
        await until('styled preview',()=>wireFrames.filter(f=>f.ref===mapRef).length>beforePreviewFrames);
        styleMatches(wirePixels.get(mapRef),card.card(preview,'map'),70,80);
        const previewLayout=JSON.parse(JSON.stringify(display.diagnostics().map.layout)),previewFrames=wireFrames.filter(f=>f.ref===mapRef).length,savedCopy=JSON.stringify(saved);
        const wire=wireLayers.get(mapRef),rect=previewLayout.card;
        assert.deepStrictEqual([wire.x,wire.y,wire.w,wire.h],[rect.x,rect.y,rect.width,rect.height],'profile scale and coordinates reach real renderer set messages');
        assert.strictEqual(wire.w,400);assert.strictEqual(wire.h,120);
        display.update(liveAlert,outputs,saved);
        await until('real warning after preview',()=>wireFrames.filter(f=>f.ref===mapRef).length>previewFrames);
        styleMatches(wirePixels.get(mapRef),card.card(liveAlert,'map'),70,80);
        assert.deepStrictEqual(display.diagnostics().map.layout,previewLayout,'saved calibration geometry applies unchanged to a real alert');
        styleMatches(wirePixels.get(hudRef),card.card(liveAlert,'hud'),40,50);
        assert.strictEqual(JSON.stringify(saved),savedCopy,'renderer does not mutate persisted profile');
        assert.strictEqual(wireMessages.filter(m=>m.op==='layer').length,createdBefore,'preview, style and real warnings all reuse layer refs');
        assert(!wireMessages.slice(editsStart).some(m=>m.op==='set'&&m.visible===0),'live edits never hide/show an existing layer and cause flicker');

        // Exercise the actual reconnect/replay path, not just layoutFor(). A
        // profile edited while disconnected must replace cached geometry before
        // the renderer is told to display anything on its smaller new canvas.
        peers.forEach(sock=>sock.destroy());
        await until('renderer disconnect',()=>display.diagnostics().connection==='disconnected');
        const offline=JSON.parse(JSON.stringify(saved));offline.hud={x:1000,y:1000,scalePct:150,brightnessPct:30,opacityPct:30};
        display.update(liveAlert,outputs,offline);
        announcedTargets='map:874x749,hud:353x203';
        const reconnectAt=wireMessages.length;
        await until('resized renderer reconnect',()=>opens>opensBefore&&display.diagnostics().connection==='ready'&&display.diagnostics().hud.layout.canvas.width===353&&wireLayers.get(hudRef).visible===1&&wireLayers.get(hudRef).w<353);
        const resumed=display.diagnostics().hud.layout,resumedWire=wireLayers.get(hudRef);
        assert.deepStrictEqual([resumedWire.x,resumedWire.y,resumedWire.w,resumedWire.h],[resumed.card.x,resumed.card.y,resumed.card.width,resumed.card.height],'reconnect uses latest offline profile with fresh target dimensions');
        assert.strictEqual(resumed.settings.scalePct,150);assert(resumed.card.scale<1.5&&resumed.card.scale>=.75);
        assert.strictEqual(resumed.settings.x,1000);assert.strictEqual(resumed.settings.y,1000);
        styleMatches(wirePixels.get(hudRef),card.card(liveAlert,'hud'),30,30);
        assert(wireMessages.slice(reconnectAt).filter(m=>m.op==='layer').every(m=>m.visible===0),'cached old geometry is hidden during renderer replay');
        peers.forEach(sock=>sock.write(frame({ev:'error',op:'layer',ref:hudRef,reason:'HUD_GUARD'})));
        for(let wait=0;wait<100&&display.diagnostics().hud.state!=='отказ';wait++)await sleep(10);
        assert.strictEqual(display.diagnostics().hud.reason,'HUD_GUARD');assert.strictEqual(display.diagnostics().map.state,'visible');
        display.update(null,{cluster:true,hud:true});
        await sleep(25);const count=await new Promise((resolve,reject)=>server.getConnections((e,n)=>e?reject(e):resolve(n)));
        assert.strictEqual(count,0);
        assert.strictEqual(display.diagnostics().map.state,'скрыт');
        assert.strictEqual(display.diagnostics().connection,'disconnected');
        assert.strictEqual(display.diagnostics().map.layout.canvas.width,874,'released layer keeps latest calibration evidence');
        layers.clear();pixels.clear();displayed.clear();wireLayers.clear();wirePixels.clear();announcedTargets='map,hud';
        display.update(a,{cluster:true,hud:true});
        for(let wait=0;wait<100&&display.diagnostics().map.reason!=='CANVAS_UNKNOWN';wait++)await sleep(10);
        assert.strictEqual(layers.size,0,'unknown canvas cannot be replaced with guessed ID7 dimensions');
        assert.strictEqual(display.diagnostics().hud.layout.canvas,null);
        peers.forEach(sock=>sock.write(frame({ev:'hello',backend:'id8',version:'0.4.1',targets:'map:874x749,hud:353x203'})));
        announcedTargets='map:874x749,hud:353x203';
        for(let wait=0;wait<100&&(!pendingError&&displayed.size<2);wait++)await sleep(10);
        if(pendingError)throw pendingError;assert.strictEqual(displayed.size,2);
        assert.strictEqual(display.diagnostics().hud.layout.canvas.width,353);
        assert.strictEqual(display.diagnostics().version,'0.4.1');
        assert.strictEqual(display.diagnostics().versionReported,true);
        peers.forEach(sock=>sock.write(frame({ev:'hello',backend:'id8',targets:announcedTargets})));
        for(let wait=0;wait<100&&display.diagnostics().versionReported;wait++)await sleep(10);
        assert.strictEqual(display.diagnostics().version,null,'a new versionless hello clears stale reported version');
        console.log('PASS runtime canvases, actual wire geometry/pixels, independent live calibration, reused layers, preview/real profile parity, dirty rectangles and refusal');
    }finally{display.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
