'use strict';
// Local coordinates in metres. Only ways that share an OSM node with a camera
// can yield an approach. Nearby other roads act as ambiguity vetoes.
const pack = require('./road-zones.json');
function angle(x,y){ return (Math.atan2(x,y)*180/Math.PI+360)%360; }
function diff(a,b){return Math.abs((a-b+540)%360-180);}
function prepare(z){
    return Object.assign({},z,{roads:z.roads.map(function(r){
        const lengths=[0],segments=[];
        for(let i=1;i<r.pts.length;i++){
            const a=r.pts[i-1],b=r.pts[i],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.sqrt(dx*dx+dy*dy);
            lengths.push(lengths[i-1]+len);
            if(len)segments.push({x:a[0],y:a[1],dx:dx,dy:dy,len:len,s:lengths[i-1],bearing:angle(dx,dy)});
        }
        return {segments:segments,id:r.id,cam:r.cam<0?null:lengths[r.cam],dir:r.dir};
    })});
}
function project(road,x,y){
    let nearest=null;
    for(const seg of road.segments){
        const t=Math.max(0,Math.min(1,((x-seg.x)*seg.dx+(y-seg.y)*seg.dy)/(seg.len*seg.len)));
        const ex=x-seg.x-t*seg.dx, ey=y-seg.y-t*seg.dy, error=Math.sqrt(ex*ex+ey*ey);
        if(!nearest||error<nearest.error)nearest={road:road,error:error,s:seg.s+t*seg.len,bearing:seg.bearing};
    }
    return nearest;
}
function candidate(z,fix){
    const x=(fix.lon-z.lon)*111320*Math.cos(z.lat*Math.PI/180),y=(fix.lat-z.lat)*111320;
    const range=Math.max(220,Math.min(600,fix.speedKmh/3.6*24));
    if(x*x+y*y>(range+20)*(range+20))return null;
    const hits=z.roads.map(r=>project(r,x,y)).filter(Boolean).sort((a,b)=>a.error-b.error);
    const hit=hits[0];
    if(!hit||hit.error>Math.min(12,Math.max(6,fix.accuracyM))||hit.road.cam===null)return null;
    if(hits.slice(1).some(other=>other.error-hit.error<Math.max(8,fix.accuracyM+3)))return null;
    const offset=hit.road.cam-hit.s, sign=offset>0?1:-1, distance=Math.abs(offset);
    if(distance<8||distance>range||(hit.road.dir&&hit.road.dir!==sign))return null;
    const heading=(hit.bearing+(sign<0?180:0))%360;
    if(diff(heading,fix.headingDeg)>32)return null;
    // The tag describes the facing direction at the camera. On a bend the
    // heading there differs from the vehicle's current heading.
    const end=hit.road.cam-sign*1;
    const at=hit.road.segments.find(s=>s.s<=end&&end<=s.s+s.len);
    if(!at||!z.travel.some(h=>diff(h,(at.bearing+(sign<0?180:0))%360)<=35))return null;
    return {id:z.id,way:hit.road.id,sign:sign,type:'speed',title:'Камера по курсу',distanceM:distance,limitKmh:z.limit};
}
function createGuidance(data){
    const zones=(data||pack).zones.map(prepare);
    let prior=null,active=null,lastTime=0;
    function reset(){prior=null;active=null;lastTime=0;return null;}
    return {evaluate:function(f,now,enabled){
        if(!enabled||!f||![f.timeMs,f.lat,f.lon,f.speedKmh,f.headingDeg,f.accuracyM,now].every(Number.isFinite)||
            Math.abs(f.lat)>90||Math.abs(f.lon)>180||f.headingDeg<0||f.headingDeg>=360||f.speedKmh<8||
            f.accuracyM<=0||f.accuracyM>15||now-f.timeMs>3000||f.timeMs>now+500||f.timeMs<lastTime)return reset();
        if(lastTime===f.timeMs)return active;
        const dt=(f.timeMs-lastTime)/1000;lastTime=f.timeMs;
        const hits=zones.map(z=>candidate(z,f)).filter(Boolean).sort((a,b)=>a.distanceM-b.distanceM);
        const next=hits[0]||null;
        active=null;
        if(next&&prior&&dt>0&&dt<=3&&prior.id===next.id&&prior.way===next.way&&prior.sign===next.sign){
            const gain=prior.distanceM-next.distanceM;
            if(gain>0.5&&gain<=f.speedKmh/3.6*dt*2+6)active=next;
        }
        prior=next;return active;
    },reset:reset,count:zones.length};
}
module.exports={createGuidance:createGuidance};
