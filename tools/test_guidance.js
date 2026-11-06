'use strict';
const assert=require('assert');
const path=require('path');
const mod=require('../native/marku-kaluga-cameras/files/vehicle-guidance');
const dir='../native/marku-kaluga-cameras/files/';
const real=require(dir+'road-zones.json'),db=require(dir+'kaluga-speed.json');
assert.strictEqual(real.sourceTimestamp,db.sourceTimestamp);
assert.strictEqual(real.pbfMd5,db.pbfMd5);
assert(real.zones.every(z=>db.records.some(r=>r.id===z.id)));
const z={id:'test',lon:36,lat:54,travel:[90],limit:60,roads:[{id:1,dir:0,cam:1,pts:[[-800,0],[0,0],[100,0]]}]};
function fix(x,t,y,heading){
    return {lat:54+(y||0)/111320,lon:36+x/(111320*Math.cos(54*Math.PI/180)),speedKmh:72,
        headingDeg:heading===undefined?90:heading,accuracyM:5,timeMs:t};
}
function replay(zone){
    const g=mod.createGuidance({zones:[zone],nearby:false});
    assert.strictEqual(g.evaluate(fix(-150,1000),1000,true),null);
    return g;
}
const g=replay(z);
assert.strictEqual(g.evaluate(fix(-150,1000),1500,true),null);
const alert=g.evaluate(fix(-130,2000),2000,true);
assert(alert&&alert.id==='test'&&Math.abs(alert.distanceM-130)<1);
assert.strictEqual(g.evaluate(fix(-130,2000),5100,true),null);
assert.strictEqual(replay(z).evaluate(fix(-130,2000,0,270),2000,true),null);
assert.strictEqual(replay(z).evaluate(fix(-130,2000),2000,false),null);
assert.strictEqual(replay(Object.assign({},z,{travel:[270]})).evaluate(fix(-130,2000),2000,true),null);
const parallel=Object.assign({},z,{roads:z.roads.concat([{id:2,dir:0,cam:-1,pts:[[-800,7],[100,7]]}])});
assert.strictEqual(replay(parallel).evaluate(fix(-130,2000),2000,true),null);
const far=replay(z);assert.strictEqual(far.evaluate(fix(-130,2000,20),2000,true),null);
// A real map fixture must produce an alert, not only synthetic sample geometry.
let demonstrated=false;
for(const zone of real.zones){
    if(demonstrated)break;
    for(const road of zone.roads.filter(r=>r.cam>=0)){
        if(demonstrated)break;
        for(const d of [-1,1]){
            let distance=0;
            for(let i=road.cam;i+d>=0&&i+d<road.pts.length;i+=d){
                const a=road.pts[i],b=road.pts[i+d],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
                distance+=len;if(len<30||distance>410)continue;
                const test=mod.createGuidance({zones:[zone]});
                const f={lat:zone.lat+(a[1]+dy*.75)/111320,lon:zone.lon+(a[0]+dx*.75)/(111320*Math.cos(zone.lat*Math.PI/180)),
                    speedKmh:72,headingDeg:(Math.atan2(-dx,-dy)*180/Math.PI+360)%360,accuracyM:4,timeMs:1000};
                test.evaluate(f,1000,true);
                f.lat-=dy/len*8/111320;f.lon-=dx/len*8/(111320*Math.cos(zone.lat*Math.PI/180));f.timeMs+=500;
                if(test.evaluate(f,1500,true)){demonstrated=true;break;}
            }
        }
    }
}
assert(demonstrated,'No accepted approach on the real map data');
console.log('PASS road membership, ambiguity, direction, fresh fixes, disabled outputs and actual map replay');
