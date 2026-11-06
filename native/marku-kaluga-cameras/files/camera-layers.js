'use strict';
const {ClusterRender}=require('./cluster_render_client');
const {card:pixels,width,height}=require('./alert-card');
function createDisplay(options){
    let client=null, layers={}, states={},sentPixels={},signature='',requested='',active=null;
    function close(){
        if(client)client.close();
        client=null;layers={};states={};sentPixels={};signature='';requested='';active=null;
    }
    function send(){
        for(const key of Object.keys(layers)){
            const next=pixels(active,key),prev=sentPixels[key];
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
    return {update:function(alert,outputs){
        outputs=outputs||{};
        const targets=['map','hud'].filter(t=>t==='map'?outputs.cluster:outputs.hud);
        if(!alert||!targets.length){if(client)close();return;}
        const key=targets.join(','), sig=[alert.id,Math.round(alert.distanceM/10),alert.limitKmh,alert.confidence,alert.title,alert.description,alert.test].join(':');
        if(!client||key!==requested){
            close();requested=key;active=alert;signature=sig;
            client=new ClusterRender('marku_kaluga_cameras',options&&options.socket);
            const session=client;
            for(const name of targets){
                layers[name]=client.image({target:name,klass:'alert',x:name==='map'?480:400,y:name==='map'?320:290,
                    w:width,h:height,iw:width,ih:height,visible:false,exclusive:false,contend:true,z:8,fps:2});
                states[name]={state:'ожидание',reason:null};
            }
            client.on('ready',()=>{if(client===session&&active)send();});
            client.on('layer',(ref,state,reason)=>{if(client===session)for(const n of targets)if(layers[n]===ref)states[n]=Object.assign({},states[n],{state:String(state),reason:reason?String(reason).slice(0,120):null});});
            client.on('target',(target,state,holder,reason,guideDisabled,disabled)=>{if(client===session&&states[target])states[target]=Object.assign({},states[target],{
                target:String(state),holder:holder?String(holder).slice(0,80):null,targetReason:reason?String(reason).slice(0,120):null,disabled:!!disabled});});
            client.on('disconnected',()=>{if(client===session)for(const n of targets)states[n]={state:'нет связи',reason:null};});
            client.on('refused',(op,ref,reason)=>{if(client===session)for(const n of targets)if(!ref||layers[n]===ref)states[n]={state:'отказ',reason:String(reason||op||'unknown').slice(0,120)};});
            client.connect();
        }else if(signature!==sig){active=alert;signature=sig;send();}
    },status:function(){return client?Object.keys(states).map(k=>k+' '+states[k].state+(states[k].reason?' '+states[k].reason:'')).join(', '):'Ожидание подтверждённого предупреждения';},diagnostics:function(){return JSON.parse(JSON.stringify(states));},close:close};
}
module.exports={createDisplay:createDisplay};
