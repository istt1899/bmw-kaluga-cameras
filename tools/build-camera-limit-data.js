'use strict';
// Host-only: compile source-bound limits; immutable base avoids a build cycle.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const api=require('../native/marku-kaluga-cameras/files/speed-limits');
function compile(observations,base,reviewedAt){return api.buildSupplement(observations,base.records,reviewedAt);}
if(require.main===module){
 const args=process.argv.slice(2),o={};for(let i=0;i<args.length;i+=2){if(!['--observations','--base','--reviewed-at','--output'].includes(args[i])||!args[i+1])throw Error('Usage: --observations JSON --base JSON --reviewed-at ISO --output NEW_JSON');o[args[i]]=args[i+1];}
 for(const key of ['--observations','--base','--reviewed-at','--output'])if(!o[key])throw Error('Missing '+key);
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 const base=read(o['--base']),observations=read(o['--observations']);if(base.pbfMd5!==observations.basePbfMd5)throw Error('Base PBF hash differs');
 const supplement=compile(observations,base,o['--reviewed-at']),bytes=Buffer.from(JSON.stringify(supplement,null,2)+'\n'),output=path.resolve(o['--output']);
 if(fs.existsSync(output)&&!fs.readFileSync(output).equals(bytes))throw Error('Use a new output path for changed observations');
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,bytes);console.log(JSON.stringify({file:output,counts:supplement.counts,sourceRecords:supplement.records.length,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));
}
module.exports={compile};
