'use strict';
const {ClusterRender}=require('./cluster_render_client');
const width=148,height=36;
const shapes={
    '0':[7,5,5,5,7],'1':[2,6,2,2,7],'2':[7,1,7,4,7],'3':[7,1,7,1,7],'4':[5,5,7,1,1],
    '5':[7,4,7,1,7],'6':[7,4,7,5,7],'7':[7,1,1,1,1],'8':[7,5,7,5,7],'9':[7,5,7,1,7],
    'M':[0,7,7,5,5]
};
function pixels(alert,target){
    const px=Buffer.alloc(width*height*4);
    function rect(x,y,w,h,rgba){
        for(let j=Math.max(0,y);j<Math.min(height,y+h);j++)for(let i=Math.max(0,x);i<Math.min(width,x+w);i++){
            const offset=(j*width+i)*4;px[offset]=rgba[0];px[offset+1]=rgba[1];px[offset+2]=rgba[2];px[offset+3]=rgba[3];
        }
    }
    const amber=[255,190,94,255],white=[240,244,242,255],dark=[25,28,30,255];
    function text(value,x,y,s,ink){
        for(const key of String(value)){
            const rows=shapes[key];if(!rows)continue;
            rows.forEach((bits,row)=>{for(let b=0;b<3;b++)if(bits&(4>>b))rect(x+b*s,y+row*s,s,s,ink);});
            x+=4*s;
        }
    }
    if(target==='map')rect(0,0,width,height,[12,17,23,214]);
    rect(3,12,23,14,amber);rect(6,8,9,4,amber);rect(14,15,7,7,dark);rect(16,17,3,3,white);
    if(alert.limitKmh!=null)text(alert.limitKmh,31,12,3,amber);
    text(String(Math.max(0,Math.round(alert.distanceM/10)*10))+'M',75,8,4,white);
    return px;
}
function createDisplay(options){
    let client=null, layers={}, states={},signature='',requested='',active=null;
    function close(){
        if(client)client.close();
        client=null;layers={};states={};signature='';requested='';active=null;
    }
    function send(){
        for(const key of Object.keys(layers)){
            client.pixels(layers[key],null,pixels(active,key));
            client.set(layers[key],{visible:true});
        }
    }
    return {update:function(alert,outputs){
        outputs=outputs||{};
        const targets=['map','hud'].filter(t=>t==='map'?outputs.cluster:outputs.hud);
        if(!alert||!targets.length){if(client)close();return;}
        const key=targets.join(','), sig=[alert.id,Math.round(alert.distanceM/10),alert.limitKmh].join(':');
        if(!client||key!==requested){
            close();requested=key;active=alert;signature=sig;
            client=new ClusterRender('marku_kaluga_cameras',options&&options.socket);
            const session=client;
            for(const name of targets){
                layers[name]=client.image({target:name,klass:'alert',x:name==='map'?565:452,y:name==='map'?353:315,
                    w:width,h:height,iw:width,ih:height,visible:false,exclusive:false,contend:false,z:8,fps:2});
                states[name]='ожидание';
            }
            client.on('ready',()=>{if(client===session&&active)send();});
            client.on('layer',(ref,state)=>{if(client===session)for(const n of targets)if(layers[n]===ref)states[n]=String(state);});
            client.on('disconnected',()=>{if(client===session)for(const n of targets)states[n]='нет связи';});
            client.on('refused',()=>{if(client===session)for(const n of targets)states[n]='отказ';});
            client.connect();
        }else if(signature!==sig){active=alert;signature=sig;send();}
    },status:function(){return client?Object.keys(states).map(k=>k+' '+states[k]).join(', '):'Ожидание подтверждённого предупреждения';},close:close};
}
module.exports={createDisplay:createDisplay};
