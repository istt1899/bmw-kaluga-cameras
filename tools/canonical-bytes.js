'use strict';
// Host packaging only. Binary resources must retain their exact bytes.
function canonicalBytes(name, bytes) {
    if (!/(?:\.(?:js|cjs|mjs|json|xml|md|txt|py|yml|yaml|csv|toml|sh|service|socket|target)|(?:^|\/)(?:LICENSE(?:\.[A-Za-z0-9.-]+)?|NOTICE))$/i.test(name)) return bytes;
    if (bytes.indexOf(0) >= 0) return bytes;
    const value = bytes.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error('Invalid UTF-8 text: ' + name);
    return Buffer.from(value.replace(/\r\n/g, '\n'), 'utf8');
}
module.exports = canonicalBytes;
