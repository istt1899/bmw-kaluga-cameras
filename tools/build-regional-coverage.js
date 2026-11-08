'use strict';
// Host-only deterministic audit. Never writes camera data, limits or manifests.
var fs=require('fs'),path=require('path'),crypto=require('crypto');
var info=require('../native/marku-kaluga-cameras/files/camera-info');
var coverage=require('../native/marku-kaluga-cameras/files/database-coverage');
var INPUTS={database:'data/camera-database-2026.11.7.2.json',osm:'data/references/osm-camera-source-2026-11-07.json',official:'data/references/gibdd-kaluga-2026-10-01.json',quality:'native/marku-kaluga-cameras/files/official-camera-quality.json',limits:'native/marku-kaluga-cameras/files/speed-limit-data.json'};
function copy(v){return JSON.parse(JSON.stringify(v));}
function index(rows){var result=Object.create(null);rows.forEach(function(r){if(result[r.id])throw Error('DUPLICATE_SOURCE_ID');result[r.id]=r;});return result;}
function build(root){
 var data={},inputs={};Object.keys(INPUTS).forEach(function(key){var bytes=fs.readFileSync(path.join(root,INPUTS[key]));data[key]=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));inputs[key]={path:INPUTS[key],sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};});
 var db=data.database,osm=index(data.osm.records),official=index(data.official.records),audits=index(data.limits.audit),zones=index(db.zones),describe=info.createDescriber(db.records);
 if(db.version!=='2026.11.7.2'||data.official.sourceSha256!=='a62b2858aecdbeb63e43445b556c9db9d6c628e674c9e96fb5a5a01074d16089'||data.osm.inputSha256!=='e91bb43834e2130bd1c1f13b7e51a827f2ac69e4e49a215f98a82ed7d29d59bb')throw Error('SOURCE_CHECK_REQUIRES_NEW_AUDIT');
 var records=db.records.map(function(record){
  var detail=describe(record),source=osm[record.id]||official[record.id],zone=zones[record.id];
  var direct=Number.isFinite(detail.cameraLimitKmh)&&detail.cameraLimitKmh>0;
  var reference=detail.limitReference&&detail.limitReference.state==='known';
  var limit={state:direct?'direct':reference?'reference':'unknown',valueKmh:direct?detail.cameraLimitKmh:reference?detail.limitReference.valueKmh:null,
   evidence:record.speedLimitEvidence?copy(record.speedLimitEvidence):detail.limitReference?copy(detail.limitReference):null,
   unknownReason:direct||reference?null:audits[record.id]?audits[record.id].reason:'NO_SOURCE_BOUND_LIMIT'};
  return {id:record.id,position:copy(record.position),positionKind:record.positionKind||'camera-node',sourceUrl:record.sourceUrl||null,
   physicalDeviceVerified:false,operatingStatus:'not-verified',limit:limit,
   sourceObservation:source?{sourceUrl:source.sourceUrl,position:copy(source.position),positionMatchesRecord:source.position.lat===record.position.lat&&source.position.lon===record.position.lon,sourceRow:source.sourceRow||null,osmVersion:source.osmVersion||null,osmTimestamp:source.osmTimestamp||null,
    sourcePublishedAt:source.sourcePublishedAt||null,rawTags:source.rawTags?copy(source.rawTags):null,rawControls:source.rawControls||null,operatingConditions:source.operatingConditions||null}:null,
   road:{state:zone?'zone-present':'no-zone',numericLimit:!!zone&&Number.isFinite(zone.limit)&&zone.limit>0,limitKmh:zone&&Number.isFinite(zone.limit)&&zone.limit>0?zone.limit:null,
    runtimeConfirmed:false,reason:zone?'REQUIRES_LIVE_POSITION_AND_ROAD_MATCH':'NO_COMPILED_ROAD_ZONE',
    evidence:zone?{input:'database',jsonPointer:'/zones/'+db.zones.indexOf(zone),roadIds:zone.roads.map(function(r){return r.id;}),geometryEncoding:'bundle local metre offsets from zone lat/lon; original bytes bound by inputs.database.sha256'}:null},
   travel:{state:zone&&zone.travel&&zone.travel.length?'compiled-candidate':'unknown',bearingsDeg:zone&&zone.travel?copy(zone.travel):[],
    interpretation:'compiled approach candidates, not camera-facing or capture-side proof',
    evidence:zone?{input:'database',jsonPointer:'/zones/'+db.zones.indexOf(zone)+'/travel'}:null,
    enforcementRelations:record.enforcementRelations?copy(record.enforcementRelations):[],
    unknownReason:zone&&zone.travel&&zone.travel.length?null:'NO_COMPILED_TRAVEL_BEARINGS'},
   cameraFacing:detail.cameraFacing,captureSide:{state:detail.captureDirectionVerified?'known':'unknown',value:detail.captureDirection||null,sourceUrl:detail.captureDirectionSource||null,
    unknownReason:detail.captureDirectionVerified?null:'NO_VERIFIED_CAPTURE_SIDE_EVIDENCE'}};
 }).sort(function(a,b){return a.id<b.id?-1:a.id>b.id?1:0;});
 return {schema:1,region:'RU-KLU',databaseVersion:db.version,checkedAt:'2026-11-08T07:57:02Z',
  checkMeaning:'HTTPS source retrieval and reproducible source-object audit, not field verification of each camera',
  complete:false,physicalDeviceCount:null,countUnit:'source records, not deduplicated physical cameras',inputs:inputs,
  sourceChecks:[{source:'gibdd-official',sourceUrl:data.official.sourceUrl,publishedAt:data.official.publishedAt,sourceLastModified:data.official.sourceLastModified,
   retrievedAt:'2026-11-08T07:57:02Z',bytes:42347,sha256:'a62b2858aecdbeb63e43445b556c9db9d6c628e674c9e96fb5a5a01074d16089',result:'unchanged-bytes'},
  {source:'OpenStreetMap',sourceUrl:data.osm.sourceUrl,sourceTimestamp:data.osm.sourceTimestamp,retrievedAt:'2026-11-08T07:57:02Z',bytes:46323171,
   sha256:'e91bb43834e2130bd1c1f13b7e51a827f2ac69e4e49a215f98a82ed7d29d59bb',result:'unchanged-bytes'}],
  summary:coverage.summarize(db.records,db.zones),records:records,
  reviewQueue:{officialUnparseableCoordinates:copy(data.official.audit.rejected),officialGeographicExclusions:data.quality.excluded.map(function(e){return{decision:copy(e),sourceRecord:copy(official[e.id])};}),
   officialMobileRoutes:{count:data.official.audit.mobileRoutes,countUnit:'source route rows, not cameras',importAsFixedCamera:false,sourceUrl:data.official.sourceUrl,records:copy(data.official.audit.mobileRouteRecords)},
   osmReviewCandidates:copy(data.osm.reviewCandidates),osmExcludedOutsideBoundary:copy(data.osm.excluded),osmInactiveRecords:copy(data.osm.inactiveRecords)},
  unresolved:['Coverage of all operating physical cameras is not established','105 source records have no direct or reference limit','Camera-facing tags do not establish enforced travel direction or front/rear capture','Source snapshot dates are not dates of on-road verification']};
}
function serialize(report){return JSON.stringify(report,null,2)+'\n';}
if(require.main===module){
 var args=process.argv.slice(2);if(args.length!==2||args[0]!=='--output'||!args[1])throw Error('Usage: node tools/build-regional-coverage.js --output NEW_JSON');
 var output=path.resolve(args[1]),report=build(path.resolve(__dirname,'..'));
 fs.writeFileSync(output,serialize(report),{flag:'wx'});
 console.log(JSON.stringify({output:path.basename(output),summary:report.summary,sha256:crypto.createHash('sha256').update(serialize(report)).digest('hex')}));
}
module.exports={build:build,serialize:serialize};
