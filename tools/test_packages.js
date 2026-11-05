// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Read-only checks against the upstream validators. The upstream CLI main is
// not executed: no install, systemctl, vehicle discovery, SDK donor or SSH.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const assert = require('assert');
const { untar } = require('./upstream/oap_link');

const ROOT = path.join(__dirname, '..');
const PUBLISH = path.join(ROOT, 'dist', 'publish', 'kaluga-cameras');
const USB = path.resolve(ROOT, '..', 'output', 'kaluga-cameras-usb', 'mgu-repo', 'kaluga-cameras');
const QA = fs.mkdtempSync(path.join(ROOT, 'dist', 'package-check-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function mkdirp(dir) { if (!fs.existsSync(dir)) { mkdirp(path.dirname(dir)); fs.mkdirSync(dir); } }

const deployFile = path.join(__dirname, 'upstream', 'mgu-deploy.js');
const text = fs.readFileSync(deployFile, 'utf8');
assert(/process\.exit\(main\(\)\);\s*$/.test(text), 'unexpected upstream entry point');
const source = text.replace(/^#![^\n]*\n/, '').replace(/process\.exit\(main\(\)\);\s*$/, '');
const sandbox = { require, process, console, Buffer, __dirname: path.dirname(deployFile), __filename: deployFile,
    setTimeout, clearTimeout, setInterval, clearInterval };
vm.createContext(sandbox);
new vm.Script(source, { filename: deployFile }).runInContext(sandbox);
assert.strictEqual(typeof sandbox.validateTool, 'function');
assert.strictEqual(typeof sandbox.validateSource, 'function');

const published = JSON.parse(fs.readFileSync(path.join(PUBLISH, 'catalog.json'), 'utf8'));
const usb = JSON.parse(fs.readFileSync(path.join(USB, 'catalog.json'), 'utf8'));
assert.strictEqual(published.schema, 2);
assert.strictEqual(usb.schema, 2);
assert.strictEqual(published.components.length, 2);
published.components.forEach((c) => {
    const b = fs.readFileSync(path.join(PUBLISH, c.artifact.name));
    assert.strictEqual(b.length, c.artifact.size);
    assert.strictEqual(sha(b), c.artifact.sha256);
    const onUsb = usb.components.find((x) => x.id === c.id);
    assert(onUsb);
    assert.strictEqual(sha(fs.readFileSync(path.join(USB, onUsb.artifact.url))), c.artifact.sha256);
    assert.strictEqual(JSON.stringify(onUsb.requires), JSON.stringify(c.requires));
    const dir = path.join(QA, c.id); mkdirp(dir);
    const members = untar(b);
    members.forEach((m) => {
        assert(!path.isAbsolute(m.name) && m.name.indexOf('\\') < 0 && m.name.split('/').indexOf('..') < 0);
        const dest = path.join(dir, m.name); mkdirp(path.dirname(dest)); fs.writeFileSync(dest, m.data);
    });
    let result;
    if (c.kind === 'tool') {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8'));
        result = sandbox.validateTool(c.artifact.name, dir, manifest);
        assert.strictEqual(manifest.internet, undefined);
        assert(members.some((m) => m.name === 'files/NOTICE-data.txt'));
    } else {
        result = sandbox.validateSource(c.artifact.name, dir);
        assert.strictEqual(result.prepare, 'build');
        assert.strictEqual(c.build, 'unit');
        assert(!members.some((m) => /node_modules\/oap-sdk|javascript\/app\.js/.test(m.name)));
    }
    assert.strictEqual(result.id, c.id);
    assert.strictEqual(result.version, '0.1.0');
    console.log('PASS: upstream ' + c.kind + ' validator + catalog SHA/size/requires/USB: ' + c.id);
});
console.log('PASS: upstream validators only; SDK link, systemd and RHMI on head unit remain untested');
