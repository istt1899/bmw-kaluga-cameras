'use strict';
// Source-bound speed references, shared by the offline compiler and data gate.
// No network, city bounding-box defaults, sign propagation or code evaluation.
var SYMBOLS={'RU:urban':60,'RU:rural':90,'RU:motorway':110,'RU:living_street':20};
var DEFINITION='https://wiki.openstreetmap.org/wiki/RU:Key:maxspeed';
var DRIVABLE=['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','unclassified','residential','service','living_street','road','track'];
function fail(code){var e=new Error(code);e.code=code;throw e;}
function object(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}
function copy(v){return JSON.parse(JSON.stringify(v));}
function position(v){return object(v)&&Number.isFinite(v.lat)&&Number.isFinite(v.lon)&&v.lat>=53&&v.lat<=56&&v.lon>=33&&v.lon<=38;}
function date(v){return typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)&&isFinite(Date.parse(v));}
function parseValue(raw){
 if(typeof raw!=='string')return null;
 if(Object.prototype.hasOwnProperty.call(SYMBOLS,raw))return{valueKmh:SYMBOLS[raw],raw:raw,basis:'explicit-osm-code',definition:DEFINITION};
 if(/^(?:[1-9]\d{0,2})(?: km\/h)?$/.test(raw)){var value=parseInt(raw,10);if(value>=5&&value<=180)return{valueKmh:value,raw:raw,basis:'explicit-numeric'};}
 return null;
}
function conditional(tags){return Object.keys(tags||{}).some(function(k){return /^maxspeed(?::|$)/.test(k)&&(/:(?:conditional|variable|lanes)(?::|$)/.test(k))||/^oneway(?::|$)/.test(k)&&/:conditional(?::|$)/.test(k);});}
function vehicleValueAgrees(tags,value){
 // A passenger car override may narrow the generic limit. Until every such
 // qualifier is interpreted, only an explicit equal value is safe to retain.
 return Object.keys(tags).filter(function(k){return /^maxspeed:(?:motorcar|motor_vehicle|vehicle)(?::|$)/.test(k);}).every(function(k){var parsed=parseValue(tags[k]);return parsed&&parsed.valueKmh===value;});
}
function drivable(tags){return object(tags)&&DRIVABLE.indexOf(tags.highway)>=0&&tags.area!=='yes'&&!['access','vehicle','motor_vehicle','motorcar'].some(function(k){return typeof tags[k]==='string'&&tags[k].trim().toLowerCase()==='no';});}
function wayValue(tags){
 if(!object(tags)||conditional(tags))return null;
 var dir=tags.oneway==='-1'?-1:tags.oneway==='yes'||tags.oneway==='1'?1:0;
 var keys=dir===1?['maxspeed:forward']:dir===-1?['maxspeed:backward']:['maxspeed:forward','maxspeed:backward'];
 var facts=keys.map(function(key){var actual=tags[key]!==undefined?key:'maxspeed';var value=parseValue(tags[actual]);return value?Object.assign({tag:actual},value):null;});
 if(!facts.length||facts.some(function(f){return !f||f.valueKmh!==facts[0].valueKmh;}))return null;
 if(!vehicleValueAgrees(tags,facts[0].valueKmh))return null;
 return{valueKmh:facts[0].valueKmh,facts:facts.filter(function(f,i,a){return a.findIndex(function(v){return v.tag===f.tag;})===i;})};
}
function nameKey(value){return String(value||'').toLowerCase().replace(/ё/g,'е').replace(/(?:улица|шоссе|автодорога|а\/д|ул\.|проспект|проезд|площадь|набережная)/g,'').replace(/[^а-яa-z0-9]/g,'');}
function ambiguousAddress(address){
 var text=String(address||'');
 if(/пересеч|перекр[её]ст|примыка|развяз|(?:^|[\s,(])уг(?:ол|лу)(?:[\s,)]|$)|(?:^|[\s,;])улиц\s+[^.;]*\sи\s/i.test(text))return true;
 var types=text.match(/(?:^|[\s,;(/])(?:улиц(?:а|ы|у|е)|ул\.|проспект|пр[-.]?кт|проезд|переулок|пер\.|шоссе|ш\.)(?=[\s,;)/]|$)/gi)||[];
 if(types.length>1)return true;
 var refs=Object.create(null),pattern=/(?:^|[^а-яa-z0-9])([мареmape])[-\s]?([0-9]{1,4})(?=$|[^0-9])/gi,match;
 while((match=pattern.exec(text))){var letter=match[1].toLowerCase().replace('m','м').replace('a','а').replace('p','р').replace('e','е');refs[letter+match[2]]=true;}
 return Object.keys(refs).length>1;
}
function addressMatches(address,tags){
 if(ambiguousAddress(address))return false;
 var a=nameKey(address),name=nameKey(tags.name),refs=String(tags.ref||'').split(';').map(nameKey);
 return !!(a&&((name.length>=5&&a.indexOf(name)>=0)||refs.some(function(ref){return ref.length>=2&&a.indexOf(ref)>=0;})));
}
function projectedDistance(p,segment){
 var a=segment.positions[0],b=segment.positions[1],dx=111320*Math.cos(p.lat*Math.PI/180),x=(a.lon-p.lon)*dx,y=(a.lat-p.lat)*111320,vx=(b.lon-a.lon)*dx,vy=(b.lat-a.lat)*111320;
 var length=vx*vx+vy*vy,t=length?Math.max(0,Math.min(1,-(x*vx+y*vy)/length)):0;return Math.hypot(x+t*vx,y+t*vy);
}
function factFromNode(node){return{kind:'node',id:node.id,sourceUrl:'https://www.openstreetmap.org/node/'+node.id,position:copy(node.position),tags:copy(node.tags),version:node.version,timestamp:node.timestamp};}
function factFromRoad(road){return{kind:'way',id:road.id,sourceUrl:'https://www.openstreetmap.org/way/'+road.id,tags:copy(road.tags),segment:copy(road.segment),version:road.version,timestamp:road.timestamp};}
function pointValue(tags){
 if(!object(tags)||conditional(tags))return null;
 var value=parseValue(tags.maxspeed);
 if(!value||!vehicleValueAgrees(tags,value.valueKmh))return null;
 // A camera node/relation has no resolved way travel direction in this
 // contract. Opposing explicit limits therefore cannot be flattened.
 if(!['maxspeed:forward','maxspeed:backward'].every(function(k){var qualified=tags[k]===undefined?value:parseValue(tags[k]);return qualified&&qualified.valueKmh===value.valueKmh;}))return null;
 return value;
}
function valueOfFact(fact){if(fact.kind==='node'||fact.kind==='relation'){var value=pointValue(fact.tags);return value?value.valueKmh:null;}var value=wayValue(fact.tags);return value?value.valueKmh:null;}
function cameraRelationsAgree(record,value){
 return !Array.isArray(record.enforcementRelations)||record.enforcementRelations.every(function(relation){
  if(!relation||!object(relation.tags)||!Array.isArray(relation.members)||!relation.members.some(function(m){return m.type==='node'&&m.role==='device'&&record.id==='osm:node:'+m.ref;}))return true;
  // Advisory/practical/source-type annotations are not a legal maxspeed. An
  // explicit conditional, directional or vehicle constraint cannot be skipped
  // merely because it lacks a parseable unqualified value.
  var explicit=Object.keys(relation.tags).some(function(k){return /^maxspeed(?:$|:(?:forward|backward|conditional|variable|lanes|motorcar|motor_vehicle|vehicle)(?::|$))/.test(k);});
  return !explicit||valueOfFact({kind:'relation',tags:relation.tags})===value;
 });
}
function validateEvidence(e,r,metadata){
 if(!object(e)||e.schema!==1||e.id!==r.id||!position(e.position)||e.position.lat!==r.position.lat||e.position.lon!==r.position.lon||!Number.isInteger(e.valueKmh)||e.valueKmh<5||e.valueKmh>180||
   ['camera-tag','enforcement-relation','shared-road-node','address-road'].indexOf(e.kind)<0||!Array.isArray(e.sources)||!e.sources.length||e.sources.length>32||!date(e.sourceTimestamp)||e.sourceTimestamp!==metadata.sourceTimestamp)fail('LIMIT_EVIDENCE_SCHEMA');
 if(r.limitConflict===true)fail('LIMIT_PREEXISTING_CONFLICT');
 if(e.kind==='camera-tag'&&!cameraRelationsAgree(r,e.valueKmh))fail('LIMIT_CAMERA_RELATION_CONFLICT');
 if(e.kind==='enforcement-relation'&&(!Array.isArray(r.enforcementRelations)||r.enforcementRelations.length!==e.sources.length))fail('LIMIT_RELATION_COVERAGE');
 var ids=Object.create(null),near=false;
 e.sources.forEach(function(f){
  if(!object(f)||['node','way','relation'].indexOf(f.kind)<0||!Number.isSafeInteger(f.id)||f.id<=0||ids[f.kind+f.id]||f.sourceUrl!=='https://www.openstreetmap.org/'+f.kind+'/'+f.id||!object(f.tags)||
    Object.keys(f.tags).length>32||Object.keys(f.tags).some(function(k){return typeof f.tags[k]!=='string'||f.tags[k].length>1500||['__proto__','constructor','prototype'].indexOf(k)>=0;})||
    f.version!==null&&(!Number.isInteger(f.version)||f.version<1)||f.timestamp!==null&&(!date(f.timestamp)||Date.parse(f.timestamp)>Date.parse(metadata.sourceTimestamp)))fail('LIMIT_SOURCE');
  ids[f.kind+f.id]=true;if(valueOfFact(f)!==e.valueKmh)fail('LIMIT_VALUE_SOURCE_MISMATCH');
  if(e.kind==='enforcement-relation'){
   var relation=Array.isArray(r.enforcementRelations)&&r.enforcementRelations.find(function(v){return v.id===f.id;});
   if(f.kind!=='relation'||!relation||relation.sourceUrl!==f.sourceUrl||
      (relation.version===undefined?null:relation.version)!==f.version||(relation.timestamp===undefined?null:relation.timestamp)!==f.timestamp||
      JSON.stringify(relation.tags)!==JSON.stringify(f.tags)||!Array.isArray(relation.members)||!relation.members.some(function(m){return m.type==='node'&&m.role==='device'&&r.id==='osm:node:'+m.ref;}))fail('LIMIT_RELATION_BINDING');
  }else if(e.kind==='camera-tag'){
   if(f.kind!=='node'||r.id!=='osm:node:'+f.id||!position(f.position)||f.position.lat!==r.position.lat||f.position.lon!==r.position.lon||e.sources.length!==1)fail('LIMIT_NODE_BINDING');
  }else{
   if(!drivable(f.tags))fail('LIMIT_ROAD_ACCESS');
   if(f.kind!=='way'||!object(f.segment)||!Array.isArray(f.segment.nodeIds)||f.segment.nodeIds.length!==2||f.segment.nodeIds.some(function(id){return!Number.isSafeInteger(id)||id<=0;})||f.segment.nodeIds[0]===f.segment.nodeIds[1]||
      !Array.isArray(f.segment.positions)||f.segment.positions.length!==2||f.segment.positions.some(function(p){return!position(p);}))fail('LIMIT_ROAD_GEOMETRY');
   var distance=projectedDistance(r.position,f.segment);if(distance>60.01)fail('LIMIT_ROAD_DISTANCE');if(distance<=20.01)near=true;
   if(e.kind==='shared-road-node'){
    var at=f.segment.nodeIds.indexOf(Number(r.id.slice('osm:node:'.length)));
    if(r.id.indexOf('osm:node:')!==0||at<0||f.segment.positions[at].lat!==r.position.lat||f.segment.positions[at].lon!==r.position.lon)fail('LIMIT_SHARED_NODE');
   }else if(r.id.indexOf('gibdd:')!==0||!addressMatches(r.address,f.tags))fail('LIMIT_ADDRESS_BINDING');
  }
 });
 if(e.kind==='address-road'&&!near)fail('LIMIT_ROAD_DISTANCE');
 if(r.limitKmh!=null&&r.limitKmh!==e.valueKmh)fail('LIMIT_PREEXISTING_CONFLICT');
 return e;
}
function buildSupplement(observations,records,reviewedAt){
 if(!object(observations)||observations.schema!==1||observations.region!=='RU-KLU'||observations.source!=='OpenStreetMap'||!date(observations.sourceTimestamp)||!date(reviewedAt)||
  !/^[a-f0-9]{64}$/.test(observations.inputSha256||'')||!/^[a-f0-9]{32}$/.test(observations.inputMd5||'')||!/^[a-f0-9]{32}$/.test(observations.basePbfMd5||'')||!Array.isArray(observations.candidates))fail('LIMIT_OBSERVATIONS');
 var byId=Object.create(null),seen=Object.create(null),entries=[],audit=[],counts={existingNumeric:0,cameraTag:0,enforcementRelation:0,sharedRoadNode:0,addressRoad:0,unresolved:0};records.forEach(function(r){byId[r.id]=r;});
 observations.candidates.forEach(function(c){
  var r=byId[c.id];if(!r||seen[c.id]||!position(c.position)||r.position.lat!==c.position.lat||r.position.lon!==c.position.lon||!Array.isArray(c.roads)||c.roads.length>32)fail('LIMIT_OBSERVATION_BINDING');seen[c.id]=true;
  if(c.roads.some(function(w){return !object(w)||!drivable(w.tags);}))fail('LIMIT_OBSERVATION_ROAD_ACCESS');
  if(r.limitKmh!=null){counts.existingNumeric++;return;}
  if(r.limitConflict===true){counts.unresolved++;audit.push({id:r.id,reason:'EXPLICIT_SOURCE_LIMIT_CONFLICT'});return;}
  var value=null,kind=null,facts=[],reason='NO_UNAMBIGUOUS_SOURCE';
  if(c.node&&r.id==='osm:node:'+c.node.id){
   if(!position(c.node.position)||c.node.position.lat!==r.position.lat||c.node.position.lon!==r.position.lon){reason='SOURCE_CAMERA_POSITION_CHANGED';}
   else if(c.node.tags.maxspeed!==undefined){var parsed=pointValue(c.node.tags);if(parsed&&cameraRelationsAgree(r,parsed.valueKmh)){value=parsed.valueKmh;kind='camera-tag';facts=[factFromNode(c.node)];}else reason=parsed?'CAMERA_RELATION_LIMIT_CONFLICT_OR_UNSUPPORTED':'CAMERA_LIMIT_UNSUPPORTED_OR_CONDITIONAL';}
  }
  if(value===null&&reason==='NO_UNAMBIGUOUS_SOURCE'&&Array.isArray(r.enforcementRelations)&&r.enforcementRelations.length){
   var relationFacts=r.enforcementRelations.map(function(rel){return{kind:'relation',id:rel.id,sourceUrl:rel.sourceUrl,tags:copy(rel.tags),version:rel.version||null,timestamp:rel.timestamp||null};});
   var relationValues=relationFacts.map(valueOfFact);
   if(relationValues.every(function(v){return v!==null&&v===relationValues[0];})){value=relationValues[0];kind='enforcement-relation';facts=relationFacts;}
   else reason='ENFORCEMENT_RELATION_LIMIT_CONFLICT_OR_UNSUPPORTED';
  }
  if(value===null&&reason==='NO_UNAMBIGUOUS_SOURCE'){
   var roads=r.id.indexOf('osm:node:')===0?c.roads.filter(function(w){return w.sharedNode;}):r.id.indexOf('gibdd:')===0?c.roads.filter(function(w){return addressMatches(r.address,w.tags);}):[];
   var values=roads.map(function(w){var v=wayValue(w.tags);return v&&v.valueKmh;});
   if(roads.length&&values.every(function(v){return v!==null&&v===values[0];})&&(r.id.indexOf('osm:node:')===0||roads.some(function(w){return projectedDistance(r.position,w.segment)<=20;}))){
    value=values[0];kind=r.id.indexOf('osm:node:')===0?'shared-road-node':'address-road';facts=roads.map(factFromRoad);
   }else reason=roads.length?'ROAD_LIMIT_MISSING_CONDITIONAL_OR_DIRECTION_CONFLICT':'NO_SHARED_OR_ADDRESS_MATCHED_ROAD';
  }
  if(value!==null){var entry={schema:1,id:r.id,position:copy(r.position),valueKmh:value,kind:kind,sourceTimestamp:observations.sourceTimestamp,sources:facts};validateEvidence(entry,r,observations);entries.push(entry);counts[kind==='camera-tag'?'cameraTag':kind==='enforcement-relation'?'enforcementRelation':kind==='shared-road-node'?'sharedRoadNode':'addressRoad']++;}
  else{counts.unresolved++;audit.push({id:r.id,reason:reason});}
 });
 if(Object.keys(seen).length!==records.length)fail('LIMIT_OBSERVATION_COVERAGE');
 return{schema:1,region:'RU-KLU',source:'OpenStreetMap',sourceTimestamp:observations.sourceTimestamp,inputSha256:observations.inputSha256,inputMd5:observations.inputMd5,basePbfMd5:observations.basePbfMd5,reviewedAt:reviewedAt,
  definition:DEFINITION,counts:counts,records:entries,audit:audit};
}
function validateMetadata(data,database){
 if(!object(data)||data.schema!==1||data.region!=='RU-KLU'||data.source!=='OpenStreetMap'||!date(data.sourceTimestamp)||!date(data.reviewedAt)||Date.parse(data.reviewedAt)<Date.parse(data.sourceTimestamp)||
   !/^[a-f0-9]{64}$/.test(data.inputSha256||'')||!/^[a-f0-9]{32}$/.test(data.inputMd5||'')||data.basePbfMd5!==database.pbfMd5||!Array.isArray(data.records)||data.records.length>20000)fail('LIMIT_SUPPLEMENT');
}
function augment(database,data){
 validateMetadata(data,database);var result=copy(database),byId=Object.create(null),seen=Object.create(null);result.records.forEach(function(r){byId[r.id]=r;});
 data.records.forEach(function(e){var r=byId[e.id];if(!r||seen[e.id])fail('LIMIT_TARGET');seen[e.id]=true;validateEvidence(e,r,data);
  if(e.kind==='camera-tag'||e.kind==='enforcement-relation')r.limitKmh=e.valueKmh;
  r.speedLimitEvidence=copy(e);
 });
 result.speedLimitMetadata={source:data.source,sourceTimestamp:data.sourceTimestamp,inputSha256:data.inputSha256,inputMd5:data.inputMd5,basePbfMd5:data.basePbfMd5,reviewedAt:data.reviewedAt,definition:data.definition,counts:copy(data.counts)};
 return result;
}
function validateBundleEvidence(bundle){
 var meta=bundle.speedLimitMetadata,withEvidence=bundle.records.filter(function(r){return r.speedLimitEvidence!==undefined;});
 if(!meta&&!withEvidence.length)return;
 validateMetadata(Object.assign({},meta,{schema:1,region:'RU-KLU',records:withEvidence}),bundle);
 withEvidence.forEach(function(r){validateEvidence(r.speedLimitEvidence,r,meta);});
 var counts=meta.counts||{},actual={existingNumeric:0,cameraTag:0,enforcementRelation:0,sharedRoadNode:0,addressRoad:0,unresolved:0};
 bundle.records.forEach(function(r){var e=r.speedLimitEvidence;if(e)actual[e.kind==='camera-tag'?'cameraTag':e.kind==='enforcement-relation'?'enforcementRelation':e.kind==='shared-road-node'?'sharedRoadNode':'addressRoad']++;else if(r.limitKmh!=null)actual.existingNumeric++;else actual.unresolved++;});
 Object.keys(actual).forEach(function(k){if(counts[k]!==actual[k])fail('LIMIT_METADATA_COUNTS');});
}
module.exports={parseValue:parseValue,wayValue:wayValue,addressMatches:addressMatches,ambiguousAddress:ambiguousAddress,projectedDistance:projectedDistance,buildSupplement:buildSupplement,augment:augment,validateEvidence:validateEvidence,validateBundleEvidence:validateBundleEvidence};
