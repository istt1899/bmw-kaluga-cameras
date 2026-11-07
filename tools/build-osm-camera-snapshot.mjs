// Host-only source acquisition/normalisation. Does not publish or activate a
// vehicle database. npm ci supplies the pinned PBF parser when the CLI runs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
export const REGION_RELATION=81995;
export const SOURCE_URL='https://download.openstreetmap.fr/extracts/russia/central_federal_district/kaluga_oblast.osm.pbf';
const ENFORCEMENT={maxspeed:'speed',traffic_signals:'redlight',average_speed:'average',seatbelt:'belt',mobile_phone:'phone',stop_line:'stopline',bus_lane:'lane',pedestrian_crossing:'pedestrian'};
const LIFECYCLE=['removed','demolished','razed','abandoned','disused','construction','proposed'];
const CARDINAL={N:0,NNE:22.5,NE:45,ENE:67.5,E:90,ESE:112.5,SE:135,SSE:157.5,S:180,SSW:202.5,SW:225,WSW:247.5,W:270,WNW:292.5,NW:315,NNW:337.5};
function safeTags(value){const result={};for(const [k,v] of Object.entries(value||{}))if(!['__proto__','prototype','constructor'].includes(k)&&typeof v==='string'&&k.length<=100&&v.length<=4096)result[k]=v;return result;}
function position(node){return node&&Number.isFinite(node.lat)&&Number.isFinite(node.lon)&&Math.abs(node.lat)<=90&&Math.abs(node.lon)<=180?{lat:node.lat,lon:node.lon}:null;}
function objectInfo(e){const info=e.info||{};const value=e.timestamp??info.timestamp;const stamp=typeof value==='number'?value:Date.parse(value);return{osmVersion:e.version??info.version??null,osmTimestamp:Number.isFinite(stamp)?new Date(stamp).toISOString():null,osmChangeset:e.changeset??info.changeset??null};}
function tokens(value){return typeof value==='string'?value.split(';').map(v=>v.trim()).filter(Boolean):[];}
function controls(tags){const result=tags.highway==='speed_camera'?['speed']:[];for(const value of tokens(tags.enforcement))if(ENFORCEMENT[value]&&!result.includes(ENFORCEMENT[value]))result.push(ENFORCEMENT[value]);return result;}
export function parseFacingDirection(value){
    if(typeof value!=='string'||!value.trim())return{raw:null,state:'missing',interpretation:'camera-facing',bearingsDeg:[],captureSide:'unknown'};
    const raw=value.trim(),parts=tokens(raw),bearings=[];
    for(const part of parts){const text=part.toUpperCase();let angle;
        if(Object.hasOwn(CARDINAL,text))angle=CARDINAL[text];
        else if(/^\d{1,3}(?:\.\d+)?$/.test(part)&&+part>=0&&+part<=360)angle=+part%360;
        else return{raw,state:['forward','backward'].includes(part)?'relative-to-way':'unsupported',interpretation:'camera-facing',bearingsDeg:[],captureSide:'unknown'};
        if(!bearings.includes(angle))bearings.push(angle);
    }
    return{raw,state:'mapped',interpretation:'camera-facing',bearingsDeg:bearings,captureSide:'unknown',sourceDefinition:'https://wiki.openstreetmap.org/wiki/Tag:highway%3Dspeed_camera'};
}
export function classifyNode(e,relationDevice=false){
    if(!e||e.type!=='node'||!position(e))return null;
    const tags=safeTags(e.tags);let lifecycle='mapped',kind=null;
    if(tags.highway==='speed_camera'||tokens(tags.enforcement).length||relationDevice)kind='enforcement';
    else if(tags.man_made==='surveillance'||tags['surveillance:zone']==='traffic'||tags['surveillance:type']==='ALPR')kind='surveillance-review-only';
    else if(tags.man_made==='speed_camera')kind='mistag-review-only';
    for(const prefix of LIFECYCLE)if(tags[prefix+':highway']==='speed_camera'||tags[prefix+':enforcement']){kind='enforcement';lifecycle=prefix;break;}
    if(!kind)return null;
    return{kind,lifecycle,tags};
}
function onSegment(p,a,b){const cross=(p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]);return Math.abs(cross)<1e-11&&p[0]>=Math.min(a[0],b[0])-1e-11&&p[0]<=Math.max(a[0],b[0])+1e-11&&p[1]>=Math.min(a[1],b[1])-1e-11&&p[1]<=Math.max(a[1],b[1])+1e-11;}
function ringHit(point,ring){let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if(onSegment(point,a,b))return'boundary';if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;}
export function insideBoundary(point,boundary){
    const geometry=boundary?.type==='Feature'?boundary.geometry:boundary;
    const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:null;
    if(!polygons)throw Error('Boundary must be Polygon/MultiPolygon GeoJSON');
    for(const rings of polygons){const outer=ringHit(point,rings[0]);if(outer==='boundary')return true;if(!outer)continue;
        let hole=false;for(const ring of rings.slice(1)){const hit=ringHit(point,ring);if(hit==='boundary')return true;if(hit)hole=true;}if(!hole)return true;
    }return false;
}
export function boundaryFromElements(elements,relationId=REGION_RELATION){
    const relation=elements.find(e=>e.type==='relation'&&e.id===relationId);if(!relation)throw Error('Region boundary relation missing: '+relationId);
    const ways=new Map(elements.filter(e=>e.type==='way').map(e=>[e.id,e]));const nodes=new Map(elements.filter(e=>e.type==='node').map(e=>[e.id,e]));const rings=[];
    for(const role of ['outer','inner']){
        const members=(relation.members||[]).filter(m=>m.role===role);
        if(members.some(m=>m.type!=='way'))throw Error('Unsupported nested boundary member');
        const pending=members.map(m=>{const way=ways.get(m.ref),refs=way?.refs||way?.nodes;if(!refs||refs.length<2)throw Error('Boundary way missing/incomplete: '+m.ref);return[...refs];});
        while(pending.length){const refs=pending.shift();while(refs[0]!==refs.at(-1)){
            const at=pending.findIndex(p=>p[0]===refs.at(-1)||p.at(-1)===refs.at(-1));if(at<0)throw Error('Region boundary ring is not closed');const part=pending.splice(at,1)[0];
            if(part[0]!==refs.at(-1))part.reverse();refs.push(...part.slice(1));
        }const coordinates=refs.map(id=>{const p=position(nodes.get(id));if(!p)throw Error('Boundary node missing: '+id);return[p.lon,p.lat];});if(coordinates.length<4)throw Error('Degenerate boundary ring');rings.push({role,coordinates});}
    }
    const outers=rings.filter(r=>r.role==='outer'),inners=rings.filter(r=>r.role==='inner');if(!outers.length)throw Error('Region boundary has no outer ring');
    for(const hole of inners)if(outers.filter(o=>ringHit(hole.coordinates[0],o.coordinates)).length!==1)throw Error('Boundary hole cannot be assigned unambiguously');
    return{type:'Feature',properties:{source:'OpenStreetMap',osmRelationId:relationId,...objectInfo(relation),sourceUrl:'https://www.openstreetmap.org/relation/'+relationId},geometry:{type:'MultiPolygon',coordinates:outers.map(o=>[o.coordinates,...inners.filter(h=>ringHit(h.coordinates[0],o.coordinates)).map(h=>h.coordinates)])}};
}
export function buildSnapshot(elements,metadata={}){
    const boundary=metadata.boundary||boundaryFromElements(elements),relations=elements.filter(e=>e.type==='relation'&&e.tags?.type==='enforcement'),nodeMap=new Map(elements.filter(e=>e.type==='node').map(e=>[e.id,e]));
    const relationDevices=new Map();for(const rel of relations)for(const member of rel.members||[])if(member.role==='device'&&member.type==='node'){if(!relationDevices.has(member.ref))relationDevices.set(member.ref,[]);relationDevices.get(member.ref).push(rel);}
    const records=[],reviewCandidates=[],inactiveRecords=[],excluded=[];
    for(const node of nodeMap.values()){
        const classification=classifyNode(node,relationDevices.has(node.id));if(!classification)continue;const{tags,lifecycle,kind}=classification,point=position(node);
        const sourceUrl='https://www.openstreetmap.org/node/'+node.id,related=relationDevices.get(node.id)||[];
        const controlTypes=[...new Set(controls(tags).concat(related.flatMap(r=>controls(safeTags(r.tags)))))];
        const rawLimits=[...new Set([tags.maxspeed,...related.map(r=>r.tags?.maxspeed)].filter(Boolean))];
        const numeric=rawLimits.filter(v=>/^\d{1,3}$/.test(v)&&+v>=5&&+v<=180).map(Number);
        const limitKmh=controlTypes.includes('speed')&&numeric.length&&numeric.every(n=>n===numeric[0])?numeric[0]:null;
        const record={id:'osm:node:'+node.id,position:point,positionKind:'osm-tagged-point',type:controlTypes.includes('redlight')?'redlight':controlTypes.includes('speed')?'speed':controlTypes.includes('average')?'average':'camera',controls:controlTypes,
            limitKmh,rawLimits,limitConflict:new Set(numeric).size>1,description:tags.description||tags.name||null,ref:tags.ref||null,operator:tags.operator||null,
            rawDirection:tags.direction||null,orientation:parseFacingDirection(tags.direction),captureSide:'unknown',lifecycle,operatingStatus:'not-verified',provenance:'OpenStreetMap',sourceUrl,...objectInfo(node),rawTags:tags,
            relationIds:related.map(r=>r.id),mappedSpeedCamera:tags.highway==='speed_camera',lastSeenInSnapshot:metadata.sourceTimestamp||null};
        if(!insideBoundary([point.lon,point.lat],boundary)){excluded.push({...record,excludedReason:'OUTSIDE_REGION_BOUNDARY'});continue;}
        if(lifecycle!=='mapped')inactiveRecords.push(record);else if(kind==='enforcement'&&controlTypes.length)records.push(record);else reviewCandidates.push({...record,reviewReason:kind==='surveillance-review-only'?'SURVEILLANCE_IS_NOT_ENFORCEMENT':kind==='enforcement'?'UNSUPPORTED_ENFORCEMENT_KIND':'POSSIBLE_MISTAG'});
    }
    for(const list of [records,reviewCandidates,inactiveRecords,excluded])list.sort((a,b)=>a.id.localeCompare(b.id));
    const rawRelations=relations.map(r=>({id:'osm:relation:'+r.id,...objectInfo(r),rawTags:safeTags(r.tags),sourceUrl:'https://www.openstreetmap.org/relation/'+r.id,
        members:(r.members||[]).map(m=>({type:m.type,ref:m.ref,role:m.role||'',...(m.type==='node'&&position(nodeMap.get(m.ref))?{position:position(nodeMap.get(m.ref))}:{})}))}));
    return{schema:1,kind:'osm-camera-source',source:'OpenStreetMap',region:'RU-KLU',sourceTimestamp:metadata.sourceTimestamp||null,generatedAt:metadata.generatedAt||null,inputSha256:metadata.inputSha256||null,inputMd5:metadata.inputMd5||null,
        sourceUrl:SOURCE_URL,licence:'ODbL-1.0',licenceUrl:'https://opendatacommons.org/licenses/odbl/1-0/',attribution:'© OpenStreetMap contributors',
        counts:{mappedEnforcementPoints:records.length,mappedSpeedCameraPoints:records.filter(r=>r.mappedSpeedCamera).length,relationDeviceOnlyPoints:records.filter(r=>!r.mappedSpeedCamera&&r.relationIds.length).length,enforcementRelations:rawRelations.length,reviewCandidates:reviewCandidates.length,inactiveRecords:inactiveRecords.length,excludedOutsideBoundary:excluded.length},
        countUnit:'OSM source objects, not a verified count of physical operating camera complexes',boundary:boundary.properties||{},records,reviewCandidates,inactiveRecords,excluded,enforcementRelations:rawRelations};
}
async function extract(file){
    const{createOSMStream}=require('osm-pbf-parser-node'),elements=[],waysWanted=new Set(),nodesWanted=new Set();let header=null;
    for await(const e of createOSMStream(file,{withTags:true,withInfo:true})){
        if(e.osmosis_replication_timestamp)header=e;
        if(classifyNode(e))elements.push(e);
        if(e.type==='relation'&&(e.id===REGION_RELATION||e.tags?.type==='enforcement')){
            elements.push(e);for(const m of e.members||[])if(m.type==='way'&&(e.id!==REGION_RELATION||['outer','inner'].includes(m.role)))waysWanted.add(m.ref);else if(m.type==='node')nodesWanted.add(m.ref);
        }
    }
    if(!header?.osmosis_replication_timestamp)throw Error('PBF replication timestamp missing');
    for await(const e of createOSMStream(file,{withTags:true,withInfo:true}))if(e.type==='way'&&waysWanted.has(e.id)){elements.push(e);for(const id of e.refs||e.nodes||[])nodesWanted.add(id);}
    const existing=new Set(elements.filter(e=>e.type==='node').map(e=>e.id));
    for await(const e of createOSMStream(file,{withTags:true,withInfo:true}))if(e.type==='node'&&nodesWanted.has(e.id)&&!existing.has(e.id))elements.push(e);
    return{elements,header};
}
async function main(){
    const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2){if(!['--pbf','--output-dir'].includes(args[i])||!args[i+1])throw Error('Usage: --pbf file.osm.pbf --output-dir NEW_DIRECTORY');opts[args[i]]=args[i+1];}
    if(!opts['--pbf']||!opts['--output-dir'])throw Error('Usage: --pbf file.osm.pbf --output-dir NEW_DIRECTORY');
    const input=path.resolve(opts['--pbf']),out=path.resolve(opts['--output-dir']);if(!fs.lstatSync(input).isFile())throw Error('PBF must be a regular file');
    if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('Refusing nonempty output directory');
    const sha=crypto.createHash('sha256'),md5=crypto.createHash('md5');for await(const chunk of fs.createReadStream(input)){sha.update(chunk);md5.update(chunk);}
    const{elements,header}=await extract(input),boundary=boundaryFromElements(elements),metadata={sourceTimestamp:new Date(header.osmosis_replication_timestamp*1000).toISOString(),generatedAt:new Date().toISOString(),inputSha256:sha.digest('hex'),inputMd5:md5.digest('hex'),boundary};
    const snapshot=buildSnapshot(elements,metadata);fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'osm-camera-source.json'),JSON.stringify(snapshot,null,2)+'\n');fs.writeFileSync(path.join(out,'kaluga-boundary.geojson'),JSON.stringify(boundary,null,2)+'\n');
    const outputs=['osm-camera-source.json','kaluga-boundary.geojson'].map(name=>{const b=fs.readFileSync(path.join(out,name));return{name,size:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};});
    const report={source:SOURCE_URL,sourceTimestamp:metadata.sourceTimestamp,inputSha256:metadata.inputSha256,inputMd5:metadata.inputMd5,counts:snapshot.counts,outputs};
    fs.writeFileSync(path.join(out,'source-artifacts.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack);process.exitCode=1;});
