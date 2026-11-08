'use strict';
// OSM direction describes where the camera faces, not the enforced travel course.
var DEFINITION='https://wiki.openstreetmap.org/wiki/Tag:highway%3Dspeed_camera';
var CARDINAL={N:0,NNE:22.5,NE:45,ENE:67.5,E:90,ESE:112.5,SE:135,SSE:157.5,S:180,SSW:202.5,SW:225,WSW:247.5,W:270,WNW:292.5,NW:315,NNW:337.5};
function describe(record){
 var raw=record&&typeof record.rawDirection==='string'?record.rawDirection:null;
 var result={state:'unknown',bearingsDeg:[],raw:raw,interpretation:'camera-facing',sourceUrl:null,sourceDefinition:DEFINITION};
 var id=record&&/^osm:node:([1-9][0-9]*)$/.exec(record.id||'');
 var url=record&&/^https:\/\/(?:www\.)?openstreetmap\.org\/node\/([1-9][0-9]*)$/.exec(record.sourceUrl||'');
 if(!id||!url||id[1]!==url[1]){result.reason='NO_EXACT_OSM_NODE_SOURCE';return result;}
 result.sourceUrl=record.sourceUrl;
 if(raw===null||!raw.trim()){result.reason='DIRECTION_MISSING';return result;}
 if(raw.length>256){result.reason='DIRECTION_UNSUPPORTED';return result;}
 var parts=raw.split(';'),bearings=[];
 for(var i=0;i<parts.length;i++){
  var part=parts[i].trim(),key=part.toUpperCase(),angle;
  if(Object.prototype.hasOwnProperty.call(CARDINAL,key))angle=CARDINAL[key];
  else if(/^\d{1,3}(?:\.\d+)?$/.test(part)&&Number(part)<=360)angle=Number(part)%360;
  else {result.reason='DIRECTION_UNSUPPORTED';return result;}
  if(bearings.indexOf(angle)<0)bearings.push(angle);
 }
 result.state='mapped';result.bearingsDeg=bearings;return result;
}
module.exports={describe:describe};
