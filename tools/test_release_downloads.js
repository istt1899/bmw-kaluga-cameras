'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),api=require('./release-downloads');
const table=JSON.parse(fs.readFileSync(path.join(__dirname,'../store-downloads.json'),'utf8')),mirrors=api.create(table);
table.entries.forEach(entry=>{
    assert.strictEqual(mirrors.url(entry.id,entry.version,entry.name,entry.size,entry.sha256,'fallback'),entry.url);
    assert.throws(()=>mirrors.url(entry.id,entry.version,entry.name,entry.size+1,entry.sha256,'fallback'),/differs/);
    assert.throws(()=>mirrors.url(entry.id,entry.version,entry.name,entry.size,'0'.repeat(64),'fallback'),/differs/);
    assert.strictEqual(mirrors.url(entry.id,'99.0.0',entry.name,entry.size,entry.sha256,'future'),'future');
});
function rejected(change){const copy=JSON.parse(JSON.stringify(table));change(copy);assert.throws(()=>api.create(copy));}
rejected(t=>t.entries.push(t.entries[0]));
rejected(t=>t.entries[0].id='cluster-render');
rejected(t=>t.entries[0].url=t.entries[0].url.replace('istt1899','other-owner'));
rejected(t=>t.entries[0].url=t.entries[0].url.replace(/[a-f0-9]{40}\//,'main/'));
rejected(t=>t.entries[0].url+='?token=anything');
rejected(t=>t.entries[0].url=t.entries[0].url.replace('https://','https://user:password@'));
rejected(t=>t.entries[0].name='../other.tgz');
assert.strictEqual(api.create(null).url('any','1.0.0','f',1,'f','original'),'original');
console.log('PASS immutable owner/version/name/SHA/size-bound mirrors, strict rejection and future-version fallback; package bytes never changed');
