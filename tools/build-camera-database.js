'use strict';
// Host-only reproducible full data bundle. No code, SDK or vehicle data is
// exported; source facts and geometry come from the declared OSM snapshots.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const files=path.join(__dirname,'../native/marku-kaluga-cameras/files');
const service=require(path.join(files,'marku-kaluga-cameras'));
const info=require(path.join(files,'camera-info')),store=require(path.join(files,'database-store'));
const official=require(path.join(files,'official-camera-data')),version=require(path.join(files,'database-version.json'));
function bundle(){
 let db=service.loadDatabase(path.join(files,'kaluga-speed.json'));
 db=info.enrich(db,path.join(files,'camera-details.json'));
 db=info.supplement(db,path.join(files,'reported-cameras.json'));
 db=store.mergeRelations(db,JSON.parse(fs.readFileSync(path.join(files,'enforcement-relations.json'),'utf8')));
 db=official.augment(db,JSON.parse(fs.readFileSync(path.join(files,'gibdd-kaluga.json'),'utf8')),
  JSON.parse(fs.readFileSync(path.join(files,'official-camera-quality.json'),'utf8')));
 db=require(path.join(files,'speed-limits')).augment(db,JSON.parse(fs.readFileSync(path.join(files,'speed-limit-data.json'),'utf8')));
 const zones=JSON.parse(fs.readFileSync(path.join(files,'road-zones.json'),'utf8'));
 return store.validateBundle(Object.assign({},db,{schema:1,version:version.version,generatedAt:version.generatedAt,source:db.displaySource||db.source,
  records:db.records.map(r=>Object.assign({},r,{controls:info.controls(Object.assign({},r,{officialSiteContext:null}))})),zones:zones.zones}));
}
if(require.main===module){
 const db=bundle(),data=Buffer.from(JSON.stringify(db)+'\n'),out=path.join(__dirname,'../data/camera-database-'+db.version+'.json');
 if(fs.existsSync(out)&&!Buffer.from(fs.readFileSync(out,'utf8').replace(/\r\n/g,'\n')).equals(data))throw Error('Refusing to replace an existing data version with different bytes');
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,data);
 console.log(JSON.stringify({file:path.basename(out),version:db.version,records:db.records.length,zones:db.zones.length,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')}));
}
module.exports={bundle};
