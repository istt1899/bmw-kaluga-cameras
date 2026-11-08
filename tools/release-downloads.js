'use strict';
// Host publication only. Mirrors never change package bytes or their identity.
function create(table) {
    const entries = Object.create(null), allowed = ['marku_kaluga_cameras','marku-kaluga-cameras','marku_kaluga_cameras-icon'];
    if (table === null || table === undefined) table = {schema:1,entries:[]};
    if (!table || table.schema !== 1 || !Array.isArray(table.entries)) throw Error('Invalid download mirror table');
    table.entries.forEach(entry => {
        if (!entry || allowed.indexOf(entry.id) < 0 || !/^\d+\.\d+\.\d+$/.test(entry.version) ||
            typeof entry.name !== 'string' || !/^[A-Za-z0-9_@.\-]+$/.test(entry.name) ||
            !Number.isSafeInteger(entry.size) || entry.size <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid mirror identity');
        const prefix = 'https://raw.githubusercontent.com/istt1899/bmw-kaluga-cameras/';
        const path = typeof entry.url === 'string' && entry.url.indexOf(prefix) === 0 ? entry.url.slice(prefix.length) : '';
        if (!/^[a-f0-9]{40}\//.test(path) || path.slice(41) !== encodeURIComponent(entry.name)) throw Error('Mirror needs an owner-bound immutable commit URL');
        const key = entry.id+'@'+entry.version;
        if (entries[key]) throw Error('Duplicate mirror identity');
        entries[key] = Object.assign({},entry);
    });
    return {
        url: function(id,version,name,size,sha256,fallback) {
            const entry = entries[id+'@'+version];
            if (!entry) return fallback;
            if (entry.name !== name || entry.size !== size || entry.sha256 !== sha256) throw Error('Mirror differs from prepared package: '+id);
            return entry.url;
        }
    };
}
module.exports = {create};
