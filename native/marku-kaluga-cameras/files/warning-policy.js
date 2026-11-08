'use strict';
var DEFAULTS=Object.freeze({visualFlash:true,visualOffsetKmh:0,soundEnabled:false,soundOffsetKmh:20});
var keys=Object.keys(DEFAULTS);
function object(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}
function valid(k,v){return k==='visualFlash'||k==='soundEnabled'?typeof v==='boolean':typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=30;}
function normalize(raw){var result={};keys.forEach(function(k){result[k]=object(raw)&&Object.prototype.hasOwnProperty.call(raw,k)&&valid(k,raw[k])?raw[k]:DEFAULTS[k];});return result;}
function patch(previous,partial){
 if(!object(partial))throw new Error('Некорректные настройки превышения: ожидается объект');
 Object.keys(partial).forEach(function(k){if(keys.indexOf(k)<0||!valid(k,partial[k]))throw new Error('Некорректный параметр превышения: '+k);});
 var result=normalize(previous);Object.keys(partial).forEach(function(k){result[k]=partial[k];});return result;
}
function evaluate(alert,fix,now,raw){
 var p=normalize(raw), out={eligible:false,reason:null,limitKmh:null,speedKmh:null,overspeed:false,visualBoundaryKmh:null,soundBoundaryKmh:null,flashActive:false,flashPhase:false,soundExceeded:false,displayBoundaryKmh:null};
 if(!alert){out.reason='NO_ALERT';return out;}
 if(alert.test||alert.calibration){out.reason='TEST';return out;}
 if(alert.filterMatched===false){out.reason='TYPE_DISABLED';return out;}
 if(alert.roadConfirmed!==true){out.reason='ROAD_UNCONFIRMED';return out;}
 if(!Number.isFinite(alert.limitKmh)||alert.limitKmh<=0||alert.limitKmh>300){out.reason='LIMIT_UNKNOWN';return out;}
 if(!fix||![fix.lat,fix.lon,fix.accuracyM,fix.timeMs,now].every(Number.isFinite)||Math.abs(fix.lat)>90||Math.abs(fix.lon)>180||fix.accuracyM<=0||fix.accuracyM>15){out.reason='GPS_INVALID';return out;}
 if(now-fix.timeMs>3000||fix.timeMs>now+500){out.reason='GPS_STALE';return out;}
 if(Object.prototype.hasOwnProperty.call(fix,'motionTimeMs')&&(!Number.isFinite(fix.motionTimeMs)||now-fix.motionTimeMs>3000||fix.motionTimeMs>now+500)){out.reason='MOTION_STALE';return out;}
 if(!Number.isFinite(fix.speedKmh)||fix.speedKmh<0||fix.speedKmh>400){out.reason='SPEED_INVALID';return out;}
 out.eligible=true;out.reason='READY';out.limitKmh=alert.limitKmh;out.speedKmh=fix.speedKmh;
 out.visualBoundaryKmh=out.limitKmh+p.visualOffsetKmh;out.soundBoundaryKmh=out.limitKmh+p.soundOffsetKmh;
 out.overspeed=out.speedKmh>out.limitKmh;out.flashActive=p.visualFlash&&out.speedKmh>out.visualBoundaryKmh;
 out.flashPhase=out.flashActive&&Math.floor(now/500)%2===0;out.soundExceeded=out.speedKmh>out.soundBoundaryKmh;
 [out.limitKmh,out.visualBoundaryKmh,out.soundBoundaryKmh].forEach(function(boundary){if(out.speedKmh>boundary&&Math.round(out.speedKmh)<=boundary&&(out.displayBoundaryKmh===null||boundary>out.displayBoundaryKmh))out.displayBoundaryKmh=boundary;});
 return out;
}
module.exports={DEFAULTS:DEFAULTS,normalize:normalize,patch:patch,evaluate:evaluate};
