'use strict';
// Regression: 0.3.1 rejected a 200 ms RMC/GGA offset despite fresh valid GNSS.
// Coordinates and metric uncertainty now share GGA's epoch, while RMC motion
// is bounded separately. No receipt timestamp is used as GNSS UTC.
const assert = require('assert');
const { GpsProvider } = require('../native/marku-kaluga-cameras/files/gps-source');
const base = Date.UTC(2026,10,6,15,46,0);
let now=base+1000, checks=0;
function check(name, fn) {fn();checks++;console.log('PASS '+name);}
function provider() {return new GpsProvider({now:()=>now,nmeaPort:0});}
function pad(n,len) {return ('000'+n).slice(-(len||2));}
function epoch(ms,whole) {const d=new Date(ms);return pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+(whole?'':'.'+pad(d.getUTCMilliseconds(),3));}
function date(ms) {const d=new Date(ms);return pad(d.getUTCDate())+pad(d.getUTCMonth()+1)+String(d.getUTCFullYear()).slice(-2);}
function coord(n,lon) {const v=Math.abs(n),deg=Math.floor(v);return pad(deg,lon?3:2)+('0'+((v-deg)*60).toFixed(8)).slice(-11);}
function position(lat) {return coord(lat,false)+',N,'+coord(36.24867,true)+',E';}
function sentence(body) {let c=0;for(let i=0;i<body.length;i++)c^=body.charCodeAt(i);return '$'+body+'*'+('0'+c.toString(16)).slice(-2);}
function parts(rmc,gga,gst,options) {
 const o=options||{};
 return {RMC:sentence('GNRMC,'+epoch(rmc,o.whole)+',A,'+position(54.51760)+',20,90,'+date(rmc)+',,,'+(o.mode||'A')),
  GGA:sentence('GNGGA,'+epoch(gga)+','+position(54.51765)+','+(o.quality===undefined?1:o.quality)+',10,0.8,150,M,0,M,,'),
  GST:sentence('GNGST,'+epoch(gst)+',1,1,1,0,'+(o.zeroSigma?0:3)+',4,6')};
}
function feed(p,records,order) {(order||['RMC','GGA','GST']).forEach(k=>p.inputNmea(records[k]));}
function anchored(fix,gga,accuracy) {
 assert(fix,'valid offset GNSS must produce a position');assert.strictEqual(fix.timeMs,gga);
 assert(Math.abs(fix.lat-54.51765)<1e-8,'position must come from GGA, not an older RMC');
 assert.strictEqual(fix.accuracyM,accuracy);
}
check('all six arrival orders accept 200 ms RMC offset and retain GGA position UTC',()=>{
 for(const order of [['RMC','GGA','GST'],['RMC','GST','GGA'],['GGA','RMC','GST'],['GGA','GST','RMC'],['GST','RMC','GGA'],['GST','GGA','RMC']]) {
  const p=provider();feed(p,parts(base,base+200,base+200),order);const fix=p.current(now);anchored(fix,base+200,10);
  assert.strictEqual(fix.motionTimeMs,base);assert.strictEqual(fix.accuracyTimeMs,base+200);
  const t=p.diagnostics(now).gpsInput.nmeaTiming;assert.strictEqual(t.rmcGgaDeltaMs,200);assert.strictEqual(t.ggaGstDeltaMs,0);assert.strictEqual(t.pairReason,'READY');
 }
});
check('RMC/GGA 500 ms and GGA/GST 100 ms boundaries, reciprocal offset and no excessive motion lag',()=>{
 let p=provider();feed(p,parts(base,base+500,base+600));anchored(p.current(now),base+500,10);assert.strictEqual(p.current(now).accuracyTimeMs,base+600);
 p=provider();feed(p,parts(base+200,base,base));anchored(p.current(now),base,10);
 p=provider();feed(p,parts(base,base+501,base+501));assert.strictEqual(p.current(now),null);
 assert.strictEqual(p.diagnostics(now).gpsInput.nmeaTiming.pairReason,'RMC_GGA_OFFSET');assert(/501/.test(p.description(null,now)));
});
check('GST follows GGA epoch, never RMC epoch or the next position',()=>{
 let p=provider();feed(p,parts(base,base+200,base));anchored(p.current(now),base+200,null);assert.strictEqual(p.diagnostics(now).gpsInput.nmeaTiming.pairReason,'GGA_GST_OFFSET');
 assert(/GST\/GGA/.test(p.description(p.current(now),now)));
 p=provider();feed(p,parts(base,base+200,base+301));anchored(p.current(now),base+200,null);
 p=provider();feed(p,parts(base,base+200,base+200,{zeroSigma:true}));anchored(p.current(now),base+200,null);
 assert.strictEqual(p.diagnostics(now).gpsInput.nmeaTiming.pairReason,'INVALID_GST');
});
check('whole-second repeated RMC is not compared with a later GGA position timestamp',()=>{
 const p=provider(),records=parts(base,base+200,base+200,{whole:true});feed(p,records);
 p.inputNmea(records.RMC);anchored(p.current(now),base+200,10);assert.strictEqual(p.diagnostics(now).gpsInput.rejectReason,null);
 assert.strictEqual(p.diagnostics(now).gpsInput.nmeaTiming.rmcTime,'154600');
});
check('2 Hz GGA/RMC and 1 Hz GST preserve complete source measurements between epochs',()=>{
 const p=provider();let complete=null;
 for(let i=0;i<10;i++) {
  const r=base+Math.floor(i/2)*1000,g=base+i*500+200;now=g+100;
  const records=parts(r,g,g,{whole:true});
  for(const k of ['RMC','GGA'].concat(i%2===0?['GST']:[])) {
   p.inputNmea(records[k]);if(k==='GST')complete=g;
   if(complete!==null)anchored(p.current(now),complete,10);
  }
 }
 now=base+1000;
});
check('midnight calendar rollover is derived from RMC date and signed source-time delta',()=>{
 const r=Date.UTC(2026,10,6,23,59,59,900),g=r+200;now=g+100;
 const p=provider();feed(p,parts(r,g,g));anchored(p.current(now),g,10);assert.strictEqual(new Date(p.current(now).timeMs).getUTCDate(),7);
 const other=provider();feed(other,parts(g,r,r));anchored(other.current(now),r,10);now=base+1000;
});
check('position UTC is independently bounded; bad date, future, simulation and quality withdraw complete fixes',()=>{
 let p=provider();feed(p,parts(now+501,now+501,now+501));assert.strictEqual(p.current(now),null);
 p=provider();feed(p,parts(now-4000,now-3800,now-3800));assert.strictEqual(p.current(now),null);
 p=provider();feed(p,parts(now+300,now+600,now+600));assert.strictEqual(p.current(now),null);assert.strictEqual(p.diagnostics(now).gpsInput.nmeaTiming.pairReason,'STALE_GGA');
 p=provider();feed(p,parts(base,base+200,base+200));assert(p.current(now));p.inputNmea(parts(base+500,base+700,base+700,{mode:'S'}).RMC);assert.strictEqual(p.current(now),null);
 p=provider();feed(p,parts(base,base+200,base+200));p.inputNmea(parts(base,base+200,base+200,{quality:6}).GGA);assert.strictEqual(p.current(now),null);
});
check('output GGA UTC is monotonic and old accuracy cannot revive after source freshness expires',()=>{
 const p=provider();feed(p,parts(base,base+200,base+200));now=base+2000;
 feed(p,parts(base+1000,base+1200,base+1200));anchored(p.current(now),base+1200,10);
 feed(p,parts(base+1000,base+1100,base+1100),['GGA','GST']);anchored(p.current(now),base+1200,10);
 assert.strictEqual(p.diagnostics(now).gpsInput.nmeaTiming.pairReason,'INVALID_GGA');
 now=base+4500;assert.strictEqual(p.current(now),null);
 feed(p,parts(base+4000,base+4200,base+4200),['RMC','GGA']);anchored(p.current(now),base+4200,null);
 now=base+1000;
});
check('safe timing diagnostics show partial packet ages and source strings without coordinates',()=>{
 const p=provider();feed(p,parts(base,base+200,base+200),['RMC','GGA']);now+=250;
 const t=p.diagnostics(now).gpsInput.nmeaTiming;
 assert.strictEqual(t.rmcTime,'154600.000');assert.strictEqual(t.ggaTime,'154600.200');assert.strictEqual(t.gstTime,null);
 assert.strictEqual(t.lastRmcAgeMs,250);assert.strictEqual(t.lastGgaAgeMs,250);assert.strictEqual(t.lastGstAgeMs,null);
 assert.strictEqual(t.pairReason,'MISSING_GST');assert(!/5431\.|03614\.|54\.517|36\.248/.test(JSON.stringify(t)));
 p.setBridgeStatus('stopped');assert.strictEqual(p.current(now),null);assert.strictEqual(p.diagnostics(now).gpsInput.nmeaTiming.rmcTime,null);now=base+1000;
});
console.log('PASS '+checks+' GPS epoch-alignment regressions; source UTC/metric bounds retained');
