// Offline build input: the exact regional PBF used for the bundled camera snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createOSMStream} from 'osm-pbf-parser-node';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
const files=path.join(project,'native/marku-kaluga-cameras/files');
const db = JSON.parse(fs.readFileSync(path.join(files,'kaluga-speed.json'),'utf8'));
const digest=crypto.createHash('md5');
for await(const chunk of fs.createReadStream(file))digest.update(chunk);
if(digest.digest('hex')!==db.pbfMd5)throw Error('PBF does not match the bundled camera snapshot');
const eligible = db.records.filter(r=>typeof r.rawDirection==='string' &&
  r.rawDirection.split(';').every(s=>/^\d{1,3}$/.test(s.trim()) && Number(s)<=360));
const carRoad=/^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(unclassified|residential|service|living_street|road|track)$/;
const cells=new Set();
for(const c of eligible){
  const {lat,lon}=c.position;
  for(let y=Math.floor((lat-.025)*100);y<=Math.floor((lat+.025)*100);y++)
    for(let x=Math.floor((lon-.043)*100);x<=Math.floor((lon+.043)*100);x++)cells.add(y*100000+x);
}
const nodes=new Map(),ways=[];
for await(const item of createOSMStream(file)){
  if(item.type==='node' && cells.has(Math.floor(item.lat*100)*100000+Math.floor(item.lon*100))){
    nodes.set(item.id,[item.lon,item.lat]);
  }else if(item.type==='way'&&carRoad.test(item.tags?.highway) && item.refs.some(id=>nodes.has(id))){
    ways.push(item);
  }
}
const zones=[];
for(const c of eligible){
  const device=Number(c.id.split(':').pop());
  const {lat,lon}=c.position, dx=111320*Math.cos(lat*Math.PI/180);
  const roads=[];
  for(const way of ways){
    let points=[],cam=-1;
    const finish=()=>{
      if(points.length>=2)roads.push({id:way.id,pts:points,cam,
        dir:way.tags.oneway==='-1'?-1:way.tags.oneway==='yes'||way.tags.oneway==='1'?1:0});
      points=[];cam=-1;
    };
    for(const ref of way.refs){
      const ll=nodes.get(ref);
      if(!ll || Math.abs((ll[0]-lon)*dx)>1500 || Math.abs((ll[1]-lat)*111320)>1500){finish();continue;}
      if(ref===device)cam=points.length;
      points.push([Math.round((ll[0]-lon)*dx),Math.round((ll[1]-lat)*111320)]);
    }
    finish();
  }
  if(roads.some(r=>r.cam>=0)){
    zones.push({id:c.id,lat,lon,limit:c.limitKmh,roads,
      travel:c.rawDirection.split(';').map(value=>(Number(value)+180)%360)});
  }
}
const out=path.join(files,'road-zones.json');
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify({region:db.region,sourceTimestamp:db.sourceTimestamp,pbfMd5:db.pbfMd5,zones}));
console.log(zones.length+' camera zones with an explicit numeric facing direction and a shared OSM road node');
