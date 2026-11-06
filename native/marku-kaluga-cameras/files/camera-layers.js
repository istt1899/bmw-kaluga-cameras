'use strict';
const {ClusterRender}=require('./cluster_render_client');
const card=require('./alert-card'), width=card.width, height=card.height;
function parseTargets(value) {
    const result={},seen={};
    if(typeof value!=='string'||value.length>512)return result;
    value.split(',').forEach(part=>{
        const m=/^(map|hud|panel):([1-9]\d{1,3})x([1-9]\d{1,3})$/.exec(part.trim());
        if(!m)return;
        if(seen[m[1]]){result[m[1]]=null;return;}seen[m[1]]=true;
        const w=Number(m[2]),h=Number(m[3]);
        result[m[1]]=w<=8192&&h<=8192?{width:w,height:h}:null;
    });
    return result;
}
function layoutFor(target,canvas,backend) {
    const layout={backend:typeof backend==='string'?backend.slice(0,32):null,canvas:canvas||null,card:null,
        withinBounds:null,profile:target==='hud'?'hud-compact':'map-compact',safeArea:{known:false,source:null}};
    if(!canvas)return layout;
    const margin=Math.max(8,Math.min(20,Math.round(Math.min(canvas.width,canvas.height)*.035)));
    const scale=Math.min(1,(canvas.width-2*margin)/width,(canvas.height-2*margin)/height);
    if(scale<.75){layout.withinBounds=false;return layout;}
    const w=Math.floor(width*scale),h=Math.floor(height*scale);
    const x=Math.round((canvas.width-w)/2), bottom=Math.max(margin,Math.round(canvas.height*(target==='hud'?.16:.12)));
    const y=Math.max(margin,canvas.height-bottom-h);
    layout.card={x,y,width:w,height:h,intrinsicWidth:width,intrinsicHeight:height,scale:w/width};
    layout.withinBounds=x>=0&&y>=0&&x+w<=canvas.width&&y+h<=canvas.height;
    return layout;
}
function createDisplay(options){
    let client=null,layers={},states={},sentPixels={},signature='',requested='',active=null;
    function release(remember){
        if(client)client.close();
        client=null;layers={};sentPixels={};signature='';requested='';active=null;
        if(remember)Object.keys(states).forEach(n=>{states[n]=Object.assign({},states[n],{lastState:states[n].state,state:'скрыт',reason:'NO_ACTIVE_ALERT'});});
        else states={};
    }
    function send(){
        if(!client||!client.ready||!active)return;
        for(const key of Object.keys(layers)){
            if(!states[key].layout.withinBounds)continue;
            const next=card.card(active,key),prev=sentPixels[key];
            if(!prev)client.pixels(layers[key],null,next);
            else{
                let left=width,top=height,right=-1,bottom=-1;
                for(let i=0;i<next.length;i+=4)if(next[i]!==prev[i]||next[i+1]!==prev[i+1]||next[i+2]!==prev[i+2]||next[i+3]!==prev[i+3]){
                    const x=(i/4)%width,y=Math.floor(i/4/width);left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
                }
                if(right>=left){
                    const w=right-left+1,h=bottom-top+1,dirty=Buffer.alloc(w*h*4);
                    for(let y=0;y<h;y++)next.copy(dirty,y*w*4,((top+y)*width+left)*4,((top+y)*width+left+w)*4);
                    client.pixels(layers[key],[{x:left,y:top,w:w,h:h}],dirty);
                }
            }
            sentPixels[key]=next;
            client.set(layers[key],{visible:true});
        }
    }
    function arrange(targets){
        const canvases=parseTargets(client.targets);
        for(const name of targets){
            const layout=layoutFor(name,canvases[name],client.backend),r=layout.card;
            states[name]=Object.assign({},states[name],{layout,state:'ожидание',reason:!layout.canvas?'CANVAS_UNKNOWN':!layout.withinBounds?'CANVAS_TOO_SMALL':null});
            if(!r||!layout.withinBounds){if(layers[name])client.set(layers[name],{visible:false});continue;}
            const box={x:r.x,y:r.y,w:r.width,h:r.height,visible:false};
            if(layers[name])client.set(layers[name],box);
            else layers[name]=client.image(Object.assign({target:name,klass:'alert',iw:width,ih:height,
                exclusive:false,contend:true,z:8,fps:2,sampling:'bilinear'},box));
        }
        sentPixels={};send();
    }
    return {update:function(alert,outputs){
        outputs=outputs||{};
        const targets=['map','hud'].filter(t=>t==='map'?outputs.cluster:outputs.hud);
        if(!alert||!targets.length){if(client)release(true);return;}
        const key=targets.join(','),sig=JSON.stringify(card.presentation(alert));
        if(!client||key!==requested){
            release(false);requested=key;active=alert;signature=sig;
            client=new ClusterRender('marku_kaluga_cameras',options&&options.socket);
            const session=client;
            targets.forEach(n=>{states[n]={state:'ожидание',reason:'WAITING_RENDERER',layout:layoutFor(n,null,null)};});
            client.on('ready',()=>{if(client===session&&active)arrange(targets);});
            client.on('layer',(ref,state,reason)=>{if(client===session)for(const n of targets)if(layers[n]===ref&&states[n].layout.withinBounds)states[n]=Object.assign({},states[n],{state:String(state),reason:reason?String(reason).slice(0,120):null});});
            client.on('target',(target,state,holder,reason,guideDisabled,disabled)=>{if(client===session&&states[target])states[target]=Object.assign({},states[target],{
                target:String(state),holder:holder?String(holder).slice(0,80):null,targetReason:reason?String(reason).slice(0,120):null,guideDisabled:!!guideDisabled,disabled:!!disabled});});
            client.on('disconnected',()=>{if(client===session)for(const n of targets){
                // Update replay options while disconnected: an old visible
                // rectangle must not replay before a new target hello.
                if(layers[n])client.set(layers[n],{visible:false});
                states[n]=Object.assign({},states[n],{state:'нет связи',reason:'RENDERER_DISCONNECTED'});
            }});
            client.on('refused',(op,ref,reason)=>{if(client===session)for(const n of targets)if(!ref||layers[n]===ref)states[n]=Object.assign({},states[n],{state:'отказ',reason:String(reason||op||'unknown').slice(0,120)});});
            client.connect();
        }else{active=alert;if(signature!==sig){signature=sig;send();}}
    },status:function(){return client?Object.keys(states).map(k=>k+' '+states[k].state+(states[k].reason?' '+states[k].reason:'')).join(', '):'Ожидание подтверждённого предупреждения';},
    diagnostics:function(){return JSON.parse(JSON.stringify(states));},close:function(){release(false);}};
}
module.exports={createDisplay,parseTargets,layoutFor};
