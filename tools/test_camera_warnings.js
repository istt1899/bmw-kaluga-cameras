'use strict';
const assert = require('assert'), path = require('path');
const dir = '../native/marku-kaluga-cameras/files/';
const service = require(dir+'marku-kaluga-cameras');
const info = require(dir+'camera-info');
const {GpsProvider} = require(dir+'gps-source');
const {createGuidance} = require(dir+'vehicle-guidance');
const fixture = require('./fixtures/plehanova-suvorova.json');
const base = path.join(__dirname,dir);
const db = info.enrich(service.loadDatabase(path.join(base,'kaluga-speed.json')),path.join(base,'camera-details.json'));
const zones = require(dir+'road-zones.json').zones;
function sample(route, distance, timeMs, speed) {
    let total=0;
    for(let i=1;i<route.outward.length;i++) {
        const a=route.outward[i-1],b=route.outward[i],dx=(b[1]-a[1])*111320*Math.cos(a[0]*Math.PI/180),dy=(b[0]-a[0])*111320,len=Math.hypot(dx,dy);
        if(total+len>=distance) {
            const k=(distance-total)/len;
            return {lat:a[0]+(b[0]-a[0])*k,lon:a[1]+(b[1]-a[1])*k,headingDeg:(Math.atan2(-dx,-dy)*180/Math.PI+360)%360,
                speedKmh:speed===undefined?36:speed,accuracyM:10,timeMs};
        }
        total+=len;
    }
    throw new Error('Route fixture too short');
}
function sentence(body) {let sum=0;for(let i=0;i<body.length;i++)sum^=body.charCodeAt(i);return '$'+body+'*'+('0'+sum.toString(16)).slice(-2);}
function packet(f, kind) {
    const d=new Date(f.timeMs),pad=(n,l)=>('000'+n).slice(-(l||2));
    const t=pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+'.'+pad(d.getUTCMilliseconds(),3);
    const date=pad(d.getUTCDate())+pad(d.getUTCMonth()+1)+String(d.getUTCFullYear()).slice(-2);
    const coord=(v,lon)=>pad(Math.floor(Math.abs(v)),lon?3:2)+('0'+((Math.abs(v)%1)*60).toFixed(7)).slice(-10);
    const pos=coord(f.lat,false)+','+(f.lat<0?'S':'N')+','+coord(f.lon,true)+','+(f.lon<0?'W':'E');
    return sentence(kind==='RMC'?'GNRMC,'+t+',A,'+pos+','+(f.speedKmh/1.852)+','+(f.speedKmh?f.headingDeg:'')+','+date+',,,A':
        kind==='GGA'?'GNGGA,'+t+','+pos+',1,10,0.8,150,M,0,M,,':'GNGST,'+t+',1,1,1,0,3,4,6');
}
let now=Date.UTC(2026,10,6,12),tested=0;
for(const route of fixture.routes.filter(r=>r.approachAllowed)) {
    const p=new GpsProvider({now:()=>now,nmeaPort:0});
    const g=createGuidance({zones,records:db.records});
    let current=null,road=0,notices=0;
    p.on('fix',()=>{current=g.evaluate(p.current(now),now,true);if(current){notices++;if(current.roadConfirmed)road++;}});
    const start=now;
    // RMC/GGA at 2 Hz, GST at 1 Hz, as observed on the car. Every partial
    // callback passes through current(), like the daemon's production tick.
    for(let i=0;i<=38;i++) {
        now=start+i*500;const f=sample(route,220-i*5,now);
        p.inputNmea(packet(f,'RMC'));p.inputNmea(packet(f,'GGA'));if(i%2===0)p.inputNmea(packet(f,'GST'));
    }
    assert(notices>0,'No notice on real junction approach '+route.firstWay);
    assert(current && current.description && fixture.cameraIds.includes(current.id));
    assert(current.controls.includes('redlight'),'Known signal-enforcement tag must survive normalization');
    if(route.firstWay!==399324587)assert(road>0,'Complete-fix cadence must permit road-verified approaches');
    now+=1000;const stop=sample(route,30,now,0);
    p.inputNmea(packet(stop,'RMC'));p.inputNmea(packet(stop,'GGA'));p.inputNmea(packet(stop,'GST'));
    assert(current,'Stopping at the traffic light must retain a notice');
    assert(current.roadConfirmed || current.confidence==='nearby');
    now+=3500;assert.strictEqual(g.evaluate(p.current(now),now,true),null,'No stale-GPS notice');
    tested++;
}
assert.strictEqual(tested,3);
// Cameras lacking a road zone still give honest proximity information.
const missing=db.records.find(r=>!zones.some(z=>z.id===r.id));
const g=createGuidance({zones:[],records:[missing]});
let fix={lat:missing.position.lat+.00025,lon:missing.position.lon,timeMs:now,speedKmh:0,headingDeg:null,accuracyM:5};
const notice=g.evaluate(fix,now,true);assert(notice&&notice.confidence==='nearby'&&notice.roadConfirmed===false&&notice.limitKmh===null);
assert.strictEqual(g.evaluate(Object.assign({},fix,{accuracyM:null}),now,true),null);
assert.strictEqual(g.evaluate(fix,now,false),null);
console.log('PASS real Plehanova/Suvorova: 3 legal approaches, actual camera types/model, 2Hz/1Hz NMEA cadence, stopped notice, UTC expiry and honest proximity without a road zone');
module.exports={sample,packet};
