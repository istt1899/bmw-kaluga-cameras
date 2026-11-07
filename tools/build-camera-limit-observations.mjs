// Host-only, reproducible source observations. Never converts symbolic limits,
// selects a legal speed limit, or activates a vehicle database.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
export const RADIUS_METRES=60;
export const MAX_ROADS=32;
const METRES_PER_DEGREE=111320, CELL=0.01;
const HIGHWAYS=new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','unclassified','residential','service','living_street','road','track']);
const ROAD_TAGS=new Set(['highway','name','ref','oneway','access','junction','vehicle','motor_vehicle','motorcar','area','lanes','layer','bridge','tunnel']);
function failure(code,message) { const error=new Error(message||code);error.code=code;throw error; }
function isPosition(p) { return !!p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Math.abs(p.lat)<=90&&Math.abs(p.lon)<=180; }
function isTimestamp(value) { return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19); }
function samePosition(a,b) { return isPosition(a)&&isPosition(b)&&a.lat===b.lat&&a.lon===b.lon; }
function safeTags(tags) { return Object.fromEntries(Object.entries(tags||{}).filter(([key,value])=>!['__proto__','prototype','constructor'].includes(key)&&typeof value==='string'&&key.length<=100&&value.length<=4096)); }
export function filterRoadTags(tags) {
  return Object.fromEntries(Object.entries(safeTags(tags)).filter(([key])=>ROAD_TAGS.has(key)||/^(?:maxspeed|source:maxspeed)(?::|$)/.test(key)||/^(?:access|vehicle|motor_vehicle|motorcar|oneway|lanes):/.test(key)));
}
export function isMotorDrivableWay(way) {
  const tags=way?.tags||{};
  return way?.type!=='node'&&HIGHWAYS.has(tags.highway)&&tags.area!=='yes'&&
    !['access','vehicle','motor_vehicle','motorcar'].some(key=>typeof tags[key]==='string'&&tags[key].trim().toLowerCase()==='no');
}
function info(element) {
  const raw=element.timestamp??element.info?.timestamp;
  const parsed=typeof raw==='number'?raw:typeof raw==='string'?Date.parse(raw):NaN;
  const version=element.version??element.info?.version;
  return {version:Number.isSafeInteger(version)&&version>0?version:null,timestamp:Number.isFinite(parsed)?new Date(parsed).toISOString():null};
}
function point(value) { return Array.isArray(value)?{lat:value[0],lon:value[1]}:isPosition(value)?{lat:value.lat,lon:value.lon}:null; }
export function segmentDistance(position,a,b) {
  const scaleX=METRES_PER_DEGREE*Math.cos(position.lat*Math.PI/180),scaleY=METRES_PER_DEGREE;
  const x=(a.lon-position.lon)*scaleX,y=(a.lat-position.lat)*scaleY,vx=(b.lon-a.lon)*scaleX,vy=(b.lat-a.lat)*scaleY;
  const length=vx*vx+vy*vy,t=length?Math.max(0,Math.min(1,-(x*vx+y*vy)/length)):0;
  return Math.hypot(x+t*vx,y+t*vy);
}
function candidateNodeId(candidate) { const match=/^osm:node:([1-9][0-9]*)$/.exec(candidate.id);return match?Number(match[1]):null; }
function segmentAt(refs,index,nodes) {
  const a=point(nodes.get(refs[index-1])),b=point(nodes.get(refs[index]));
  return a&&b?{nodeIds:[refs[index-1],refs[index]],positions:[a,b]}:null;
}
export function nearestSegment(candidate,way,nodes) {
  const refs=way.refs||way.nodes||[],nodeId=candidateNodeId(candidate);
  // An actual shared OSM node is the proof. A nearby segment, equal coordinate
  // of another node, or the closest segment elsewhere in the way is not proof.
  const shared=nodeId!==null&&refs.includes(nodeId)&&samePosition(candidate.position,point(nodes.get(nodeId)));
  let best=null;
  for(let i=1;i<refs.length;i++) {
    if(shared&&refs[i-1]!==nodeId&&refs[i]!==nodeId)continue;
    const segment=segmentAt(refs,i,nodes);if(!segment)continue;
    const distanceM=segmentDistance(candidate.position,...segment.positions);
    if(!best||distanceM<best.distanceM)best={segment,distanceM,sharedNode:shared};
  }
  return best;
}
function candidateGrid(candidates) {
  const cells=new Map();
  candidates.forEach((candidate,index)=>{const p=candidate.position,key=Math.floor(p.lat/CELL)+':'+Math.floor(p.lon/CELL);if(!cells.has(key))cells.set(key,[]);cells.get(key).push(index);});
  const populated=[...cells].map(([key,indices])=>{const[y,x]=key.split(':').map(Number);return{key,x,y,indices};});
  return function query(a,b) {
    const dy=RADIUS_METRES/METRES_PER_DEGREE,maxLatitude=Math.min(89.99,Math.max(Math.abs(a.lat),Math.abs(b.lat))+dy);
    const dx=RADIUS_METRES/(METRES_PER_DEGREE*Math.max(0.01,Math.cos(maxLatitude*Math.PI/180)));
    const loY=Math.floor((Math.min(a.lat,b.lat)-dy)/CELL),hiY=Math.floor((Math.max(a.lat,b.lat)+dy)/CELL);
    const loX=Math.floor((Math.min(a.lon,b.lon)-dx)/CELL),hiX=Math.floor((Math.max(a.lon,b.lon)+dx)/CELL),found=new Set();
    if((hiY-loY+1)*(hiX-loX+1)>1024) {
      for(const cell of populated)if(cell.y>=loY&&cell.y<=hiY&&cell.x>=loX&&cell.x<=hiX)for(const index of cell.indices)found.add(index);
    } else for(let y=loY;y<=hiY;y++)for(let x=loX;x<=hiX;x++)for(const index of cells.get(y+':'+x)||[])found.add(index);
    return found;
  };
}
function validateBase(base) {
  if(!base||base.region!=='RU-KLU'||!Array.isArray(base.records)||!base.records.length||base.records.length>20000||!/^[a-f0-9]{32}$/.test(base.pbfMd5||''))failure('INVALID_BASE');
  const ids=new Set();
  for(const c of base.records) {
    if(typeof c.id!=='string'||!/^(?:osm:(?:node|way|relation):[1-9][0-9]*|gibdd:ru-klu:[a-f0-9]{16}|reported:[a-z0-9][a-z0-9:-]{0,90})$/.test(c.id)||ids.has(c.id)||!isPosition(c.position)||c.position.lat<53||c.position.lat>56||c.position.lon<33||c.position.lon>38||c.address!=null&&typeof c.address!=='string')failure('INVALID_BASE_CANDIDATE');
    ids.add(c.id);
  }
}
export function buildObservations(base,nodes,ways,metadata={}) {
  validateBase(base);
  const candidates=base.records.map(c=>({id:c.id,position:{lat:c.position.lat,lon:c.position.lon},address:c.address||null,node:null,roads:[]}));
  const query=candidateGrid(candidates),seenWays=new Set(),matching=candidates.map(()=>new Map());
  for(const way of ways) {
    if(!isMotorDrivableWay(way))continue;
    if(!Number.isSafeInteger(way.id)||way.id<=0||seenWays.has(way.id))failure('DUPLICATE_OR_INVALID_WAY');seenWays.add(way.id);
    const refs=way.refs||way.nodes;
    if(!Array.isArray(refs)||refs.length<2||refs.some(id=>!Number.isSafeInteger(id)||id<=0))failure('INVALID_WAY_REFS','Invalid drivable way '+way.id);
    if(refs.some(id=>!isPosition(point(nodes.get(id)))))failure('MISSING_OSM_NODE','Incomplete drivable way '+way.id+'; refusing to bridge a missing node');
    const indices=new Set();
    for(let i=1;i<refs.length;i++)for(const index of query(point(nodes.get(refs[i-1])),point(nodes.get(refs[i]))))indices.add(index);
    for(const index of indices) {
      const best=nearestSegment(candidates[index],way,nodes);
      if(best&&best.distanceM<=RADIUS_METRES+1e-8)matching[index].set(way.id,{id:way.id,tags:filterRoadTags(way.tags),...info(way),sharedNode:best.sharedNode,segment:best.segment});
    }
  }
  candidates.forEach((candidate,index)=>{
    const rawId=candidateNodeId(candidate),raw=rawId!==null?nodes.get(rawId):null;
    if(raw&&isPosition(point(raw)))candidate.node={id:rawId,position:point(raw),tags:safeTags(raw.tags),...info(raw)};
    candidate.roads=[...matching[index].values()].sort((a,b)=>a.id-b.id);
    if(candidate.roads.length>MAX_ROADS)failure('ROAD_OBSERVATIONS_OVERFLOW',candidate.id+' has '+candidate.roads.length+' drivable ways within '+RADIUS_METRES+' m; maximum is '+MAX_ROADS+'; output not written');
  });
  if(!isTimestamp(metadata.sourceTimestamp)||
    !/^[a-f0-9]{64}$/.test(metadata.inputSha256||'')||!/^[a-f0-9]{32}$/.test(metadata.inputMd5||''))failure('INVALID_SOURCE_METADATA');
  return{schema:1,region:'RU-KLU',source:'OpenStreetMap',sourceTimestamp:metadata.sourceTimestamp,inputSha256:metadata.inputSha256,inputMd5:metadata.inputMd5,basePbfMd5:base.pbfMd5,candidates};
}
async function inputHashes(file) {
  const sha=crypto.createHash('sha256'),md5=crypto.createHash('md5');
  for await(const chunk of fs.createReadStream(file)){sha.update(chunk);md5.update(chunk);}
  return{inputSha256:sha.digest('hex'),inputMd5:md5.digest('hex')};
}
export async function extractObservations(file,base) {
  validateBase(base);
  const{createOSMStream}=require('osm-pbf-parser-node'),nodes=new Map(),ways=[],candidateIds=new Set(base.records.map(candidateNodeId).filter(id=>id!==null));let timestamp=null;
  for await(const element of createOSMStream(file,{withTags:true,withInfo:true})) {
    if(element.osmosis_replication_timestamp)timestamp=new Date(element.osmosis_replication_timestamp*1000).toISOString();
    if(element.type==='node'&&isPosition(element))nodes.set(element.id,candidateIds.has(element.id)?{lat:element.lat,lon:element.lon,tags:safeTags(element.tags),...info(element)}:[element.lat,element.lon]);
    else if(element.type==='way'&&isMotorDrivableWay(element))ways.push({id:element.id,type:'way',refs:element.refs||element.nodes,tags:filterRoadTags(element.tags),...info(element)});
  }
  if(!timestamp)failure('PBF_TIMESTAMP_MISSING');
  const hashes=await inputHashes(file);
  return buildObservations(base,nodes,ways,{sourceTimestamp:timestamp,...hashes});
}
async function main() {
  const args=process.argv.slice(2),opts={};
  for(let i=0;i<args.length;i+=2) { if(!['--pbf','--base','--output'].includes(args[i])||!args[i+1]||opts[args[i]])failure('USAGE','Usage: --pbf FILE --base JSON --output NEW_FILE');opts[args[i]]=args[i+1]; }
  if(!opts['--pbf']||!opts['--base']||!opts['--output'])failure('USAGE','Usage: --pbf FILE --base JSON --output NEW_FILE');
  const input=path.resolve(opts['--pbf']),baseFile=path.resolve(opts['--base']),output=path.resolve(opts['--output']);
  for(const file of [input,baseFile]) {const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())failure('INPUT_NOT_REGULAR');}
  if(fs.existsSync(output))failure('OUTPUT_EXISTS','Refusing to overwrite '+output);
  const base=JSON.parse(fs.readFileSync(baseFile,'utf8')),observations=await extractObservations(input,base),bytes=JSON.stringify(observations,null,2)+'\n';
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,bytes,{flag:'wx'});
  console.log(JSON.stringify({output,sourceTimestamp:observations.sourceTimestamp,inputSha256:observations.inputSha256,inputMd5:observations.inputMd5,basePbfMd5:observations.basePbfMd5,candidates:observations.candidates.length,
    cameraNodes:observations.candidates.filter(c=>c.node).length,roadObservations:observations.candidates.reduce((count,c)=>count+c.roads.length,0),maxRoads:Math.max(...observations.candidates.map(c=>c.roads.length)),bytes:Buffer.byteLength(bytes),sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error((error.code?error.code+': ':'')+error.message);process.exitCode=1;});
