'use strict';
var assert=require('assert'),fs=require('fs'),api=require('../native/marku-kaluga-cameras/files/speed-limits'),store=require('../native/marku-kaluga-cameras/files/database-store');
var base=require('../data/camera-database-2026.11.7.1.json'),input=require('../data/references/osm-limit-observations-2026-11-07.json'),supplement=require('../data/references/camera-limits-2026-11-07.json');
function clone(v){return JSON.parse(JSON.stringify(v));}
function throws(change,code){var data=clone(supplement);change(data);assert.throws(function(){api.augment(base,data);},code?function(e){return e.code===code;}:undefined);}
assert.strictEqual(api.parseValue('RU:urban').valueKmh,60);assert.strictEqual(api.parseValue('RU:rural').valueKmh,90);assert.strictEqual(api.parseValue('RU:motorway').valueKmh,110);assert.strictEqual(api.parseValue('RU:living_street').valueKmh,20);
['60;90','signals','none','national','urban','RU:unknown','-60','999','60 mph','60junk'].forEach(function(value){assert.strictEqual(api.parseValue(value),null);});
assert.strictEqual(api.wayValue({maxspeed:'RU:rural'}).valueKmh,90);assert.strictEqual(api.wayValue({'maxspeed:forward':'40','maxspeed:backward':'60'}),null);
assert.strictEqual(api.wayValue({maxspeed:'60','maxspeed:conditional':'40 @ wet'}),null);assert.strictEqual(api.wayValue({maxspeed:'60','maxspeed:lanes':'40|60'}),null);
assert.strictEqual(api.wayValue({oneway:'yes',maxspeed:'90','maxspeed:forward':'40'}).valueKmh,40);
assert.strictEqual(api.wayValue({oneway:'-1','maxspeed:forward':'40','maxspeed:backward':'60'}).valueKmh,60);
assert.strictEqual(api.wayValue({'maxspeed:practical':'110','minspeed':'40'}),null);
['motorcar','motor_vehicle','vehicle'].forEach(function(vehicle){
 var equal={maxspeed:'RU:rural'},different={maxspeed:'90'},unknown={maxspeed:'90'};
 equal['maxspeed:'+vehicle]='90';different['maxspeed:'+vehicle]='40';unknown['maxspeed:'+vehicle]='signals';
 assert.strictEqual(api.wayValue(equal).valueKmh,90,'An equal explicit '+vehicle+' override preserves the generic limit');
 assert.strictEqual(api.wayValue(different),null,'A contradictory '+vehicle+' override must not be ignored');
 assert.strictEqual(api.wayValue(unknown),null,'An unsupported '+vehicle+' override cannot establish agreement');
});
assert.strictEqual(api.wayValue({maxspeed:'90','maxspeed:motorcar:forward':'40'}),null);
assert.strictEqual(api.wayValue({maxspeed:'90','maxspeed:motorcar:conditional':'40 @ (wet)'}),null);
assert.strictEqual(api.wayValue({maxspeed:'90','maxspeed:motorcar:lanes':'90|40'}),null);
assert.strictEqual(api.wayValue({oneway:'yes','oneway:conditional':'-1 @ (Mo-Fr)',maxspeed:'90','maxspeed:forward':'40','maxspeed:backward':'90'}),null,'A conditional one-way direction cannot select a fixed directional limit');
var rebuilt=api.buildSupplement(input,base.records,supplement.reviewedAt);assert.deepStrictEqual(rebuilt,supplement);
assert.deepStrictEqual(supplement.counts,{existingNumeric:52,cameraTag:49,enforcementRelation:5,sharedRoadNode:38,addressRoad:57,unresolved:107});
['пересечение улиц Гагарина и Королева','угол ул. Ленина и Суворова','Р-132, обход Калуги, от М-3','улица Гагарина / улица Королева'].forEach(function(address){assert.strictEqual(api.ambiguousAddress(address),true);});
assert.strictEqual(api.ambiguousAddress('М-3, 115 км'),false);
assert.strictEqual(api.addressMatches('пересечение улиц Гагарина и Королева',{name:'улица Гагарина'}),false);
var ambiguous=base.records.find(function(r){return r.id==='gibdd:ru-klu:aa5761e003c41ba8';});
assert(ambiguous&&!supplement.records.some(function(e){return e.id===ambiguous.id;}));
var original=JSON.stringify(base),db=api.augment(base,supplement);assert.strictEqual(JSON.stringify(base),original);
assert.strictEqual(db.records.length,308);assert.strictEqual(db.records.filter(function(r){return r.limitKmh!=null;}).length,106);
assert(db.records.filter(function(r){return r.id.indexOf('gibdd:')===0;}).every(function(r){return r.limitKmh===null;}),'Official numeric fields cannot be rewritten by a road reference');
api.validateBundleEvidence(db);store.validateBundle(db);
throws(function(data){data.records[0].valueKmh=50;});throws(function(data){data.records.push(clone(data.records[0]));});throws(function(data){data.records[0].position.lat+=.001;});
throws(function(data){var e=data.records.find(function(r){return r.kind==='address-road';});e.sources[0].tags.name='Несуществующая улица';delete e.sources[0].tags.ref;});
throws(function(data){var e=data.records.find(function(r){return r.kind==='shared-road-node';});e.sources[0].segment.nodeIds=[1,2];});
throws(function(data){var e=data.records.find(function(r){return r.kind==='address-road';});e.sources[0].segment.positions.forEach(function(p){p.lat+=.01;});});
throws(function(data){var e=data.records.find(function(r){return r.kind==='camera-tag';});e.sources[0].sourceUrl='https://attacker.example';});
throws(function(data){var e=data.records.find(function(r){return r.kind==='shared-road-node';});e.sources[0].tags['maxspeed:conditional']='20 @ wet';});
['footway','cycleway','path','pedestrian','steps','construction'].forEach(function(highway){
 throws(function(data){data.records.find(function(e){return e.kind==='address-road';}).sources[0].tags.highway=highway;},'LIMIT_ROAD_ACCESS');
});
['access','vehicle','motor_vehicle','motorcar'].forEach(function(key){
 throws(function(data){data.records.find(function(e){return e.kind==='shared-road-node';}).sources[0].tags[key]='no';},'LIMIT_ROAD_ACCESS');
});
throws(function(data){data.records.find(function(e){return e.kind==='address-road';}).sources[0].tags.area='yes';},'LIMIT_ROAD_ACCESS');
var inaccessibleInput=clone(input);inaccessibleInput.candidates.find(function(c){return c.roads.length;}).roads[0].tags.motor_vehicle='no';
assert.throws(function(){api.buildSupplement(inaccessibleInput,base.records,supplement.reviewedAt);},function(e){return e.code==='LIMIT_OBSERVATION_ROAD_ACCESS';},'Compiler observations must obey the same drivable contract as downloaded evidence');
throws(function(data){data.records.find(function(e){return e.kind==='enforcement-relation';}).sources[0].version=999;},'LIMIT_RELATION_BINDING');
throws(function(data){data.records.find(function(e){return e.kind==='enforcement-relation';}).sources[0].timestamp='2010-01-01T00:00:00.000Z';},'LIMIT_RELATION_BINDING');
var relationEntry=supplement.records.find(function(e){return e.kind==='enforcement-relation';}),extraBase=clone(base),extraData=clone(supplement);
var relationTarget=extraBase.records.find(function(r){return r.id===relationEntry.id;}),extraRelation=clone(relationTarget.enforcementRelations[0]);
extraRelation.id=99999991;extraRelation.sourceUrl='https://www.openstreetmap.org/relation/'+extraRelation.id;relationTarget.enforcementRelations.push(extraRelation);
assert.throws(function(){api.augment(extraBase,supplement);},function(e){return e.code==='LIMIT_RELATION_COVERAGE';},'An omitted attached relation cannot evade a conflict or unsupported-limit check');
var extraEntry=extraData.records.find(function(e){return e.id===relationEntry.id;}),extraFact=clone(extraEntry.sources[0]);
extraFact.id=extraRelation.id;extraFact.sourceUrl=extraRelation.sourceUrl;extraEntry.sources.push(extraFact);
var allRelations=api.augment(extraBase,extraData);api.validateBundleEvidence(allRelations);store.validateBundle(allRelations);
extraBase.records.find(function(r){return r.id===relationEntry.id;}).enforcementRelations[1].tags.maxspeed='40';
extraEntry.sources[1].tags.maxspeed='40';
assert.throws(function(){api.augment(extraBase,extraData);},function(e){return e.code==='LIMIT_VALUE_SOURCE_MISMATCH';},'Complete but contradictory relation evidence remains unresolved');
var invalidRelationBundle=clone(db),relationRecord=invalidRelationBundle.records.find(function(r){return r.id===relationEntry.id;});
extraRelation.tags.maxspeed='40';relationRecord.enforcementRelations.push(extraRelation);
assert.throws(function(){api.validateBundleEvidence(invalidRelationBundle);},function(e){return e.code==='LIMIT_RELATION_COVERAGE';},'The serialized data gate also requires all attached relations');
var invalidBundle=clone(db);invalidBundle.records.find(function(r){return r.speedLimitEvidence;}).speedLimitEvidence.id='gibdd:wrong';assert.throws(function(){api.validateBundleEvidence(invalidBundle);});
// Explicit camera facts cannot erase a previously diagnosed source conflict or
// contradict a device relation. Non-limit relation annotations do not provide
// a competing numeric limit and leave an explicit node value intact.
var cameraEntry=supplement.records.find(function(e){return e.kind==='camera-tag';});
var cameraRecord=base.records.find(function(r){return r.id===cameraEntry.id;}),cameraObservation=input.candidates.find(function(c){return c.id===cameraEntry.id;});
var otherCameraLimit=cameraEntry.valueKmh===40?'60':'40';
function cameraRelation(tags,otherDevice){return{id:99999992,version:1,timestamp:'2020-01-01T00:00:00.000Z',sourceUrl:'https://www.openstreetmap.org/relation/99999992',tags:Object.assign({type:'enforcement',enforcement:'maxspeed'},tags),members:[{type:'node',ref:otherDevice?1:Number(cameraEntry.id.split(':')[2]),role:'device'}]};}
function cameraCompilation(tags,conflict,otherDevice){
 var r=clone(cameraRecord),observations=clone(input);r.enforcementRelations=[cameraRelation(tags,otherDevice)];if(conflict)r.limitConflict=true;observations.candidates=[clone(cameraObservation)];
 return api.buildSupplement(observations,[r],supplement.reviewedAt);
}
function cameraBundleRejected(tags,code){var serialized=clone(db),r=serialized.records.find(function(v){return v.id===cameraEntry.id;});r.enforcementRelations=[cameraRelation(tags)];assert.throws(function(){api.validateBundleEvidence(serialized);},function(e){return e.code===code;});}
var diagnosedConflict=cameraCompilation({},true);assert.strictEqual(diagnosedConflict.records.length,0);assert.strictEqual(diagnosedConflict.audit[0].reason,'EXPLICIT_SOURCE_LIMIT_CONFLICT');
var diagnosedBundle=clone(db);diagnosedBundle.records.find(function(r){return r.id===cameraEntry.id;}).limitConflict=true;
assert.throws(function(){api.validateBundleEvidence(diagnosedBundle);},function(e){return e.code==='LIMIT_PREEXISTING_CONFLICT';});
var relationConflicts=[{maxspeed:otherCameraLimit},{maxspeed:'signals'},{maxspeed:String(cameraEntry.valueKmh),'maxspeed:conditional':'40 @ (wet)'},{'maxspeed:conditional':'40 @ (wet)'},{maxspeed:String(cameraEntry.valueKmh),'maxspeed:forward':otherCameraLimit},{maxspeed:String(cameraEntry.valueKmh),'maxspeed:backward':otherCameraLimit}];
relationConflicts.forEach(function(tags){
 var blocked=cameraCompilation(tags);assert.strictEqual(blocked.records.length,0);assert.strictEqual(blocked.audit[0].reason,'CAMERA_RELATION_LIMIT_CONFLICT_OR_UNSUPPORTED');
 cameraBundleRejected(tags,'LIMIT_CAMERA_RELATION_CONFLICT');
});
[{maxspeed:String(cameraEntry.valueKmh)},{maxspeed:String(cameraEntry.valueKmh),'maxspeed:forward':String(cameraEntry.valueKmh),'maxspeed:backward':String(cameraEntry.valueKmh)},{},{'maxspeed:advisory':'30','maxspeed:practical':'40'}].forEach(function(tags){
 var allowed=cameraCompilation(tags);assert.strictEqual(allowed.records.length,1);assert.strictEqual(allowed.records[0].valueKmh,cameraEntry.valueKmh);
 var serialized=clone(db);serialized.records.find(function(r){return r.id===cameraEntry.id;}).enforcementRelations=[cameraRelation(tags)];api.validateBundleEvidence(serialized);
});
assert.strictEqual(cameraCompilation({maxspeed:otherCameraLimit},false,true).records.length,1,'A relation for another device is not competing evidence for this camera');
var qualifiedCamera=clone(supplement);qualifiedCamera.records.find(function(e){return e.id===cameraEntry.id;}).sources[0].tags['maxspeed:forward']=otherCameraLimit;
assert.throws(function(){api.augment(base,qualifiedCamera);},function(e){return e.code==='LIMIT_VALUE_SOURCE_MISMATCH';},'Camera node directional constraints also cannot be flattened into the generic value');
var info=require('../native/marku-kaluga-cameras/files/camera-info'),card=require('../native/marku-kaluga-cameras/files/alert-card'),describe=info.createDescriber(db.records),visible=0,values={};
db.records.forEach(function(r){var d=describe(r),p=card.presentation(Object.assign({},d,{roadConfirmed:false,limitKmh:null}));if(p.limit!==null){visible++;values[p.limit]=(values[p.limit]||0)+1;}if(r.speedLimitEvidence)assert.strictEqual(p.limit,r.speedLimitEvidence.valueKmh);});
assert.strictEqual(visible,203);assert(values[40]&&values[50]&&values[60]&&values[70]&&values[90]);
// The new compact badge can only affect its reserved header; warning contents,
// limit, overspeed computation and other pixels are unchanged.
var warning={controls:['speed','redlight','belt','stopline'],roadConfirmed:true,limitKmh:40,speedKmh:50,overspeed:true,distanceM:70};
var a=card.card(warning,'map'),b=card.card(Object.assign({},warning,{decoyReport:{state:'reported'}}),'map');assert(!a.equals(b));
for(var y=0;y<96;y++)for(var x=0;x<320;x++)if(x<63||x>=149||y<1||y>=21)for(var channel=0;channel<4;channel++)assert.strictEqual(a[(y*320+x)*4+channel],b[(y*320+x)*4+channel]);
assert.strictEqual(card.presentation(Object.assign({},warning,{decoyReport:{state:'reported'}})).overspeed,true);
console.log('PASS 49 explicit RU camera codes + 5 relation codes, 38 shared-road references, 57 address/geometry-matched road references, intersection/direction/conditional/vehicle and drivable-access guards, complete exact relation evidence, camera/relation conflict guards, immutable prior data and compact decoy badge without suppressing ordinary warning; visible limits '+visible+'/308 '+JSON.stringify(values));
