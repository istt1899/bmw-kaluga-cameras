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
        assert.strictEqual(manifest.internet, true);
        assert.deepStrictEqual(manifest.uids, [5000]);
        assert(/User=hmi_5000(?:\r?\n|$)/.test(fs.readFileSync(path.join(dir, 'units', 'marku-kaluga-cameras.service'), 'utf8')));
        // Run the actual upstream deployment sync against an isolated /var/opt.
        // No CLI main, unit start or head-unit connection is executed.
        const varOpt = path.join(QA, 'var-opt');
        const uplink = path.join(varOpt, 'mgu-uplink'); mkdirp(path.join(uplink, 'current'));
        const oldVarOpt = sandbox.CFG.varOpt, oldTools = sandbox.installedTools, oldApps = sandbox.installedApps, oldFsyncDir = sandbox.fsyncDir;
        try {
            sandbox.CFG.varOpt = varOpt;
            sandbox.installedTools = () => [{ id: c.id, component: manifest }];
            sandbox.installedApps = () => [];
            // Windows cannot fsync a directory handle. All upstream content,
            // paths, atomic file writes and uninstall cleanup still run.
            if (process.platform === 'win32') sandbox.fsyncDir = () => {};
            sandbox.syncDropIns();
            assert.strictEqual(fs.readFileSync(path.join(uplink, 'uids.d', c.id), 'utf8'), '5000\n');
            sandbox.installedTools = () => [];
            sandbox.syncDropIns();
            assert(!fs.existsSync(path.join(uplink, 'uids.d', c.id)), 'uninstall removes stale network UID');
        } finally { sandbox.CFG.varOpt = oldVarOpt; sandbox.installedTools = oldTools; sandbox.installedApps = oldApps; sandbox.fsyncDir = oldFsyncDir; }
        assert(members.some((m) => m.name === 'files/NOTICE-data.txt'));
    } else {
        result = sandbox.validateSource(c.artifact.name, dir);
        assert.strictEqual(result.prepare, 'build');
        assert.strictEqual(c.build, 'unit');
        assert(!members.some((m) => /node_modules\/oap-sdk|javascript\/app\.js/.test(m.name)));
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mgu-app.json'), 'utf8'));
        const uiDir = path.join(dir, manifest.tree, 'rhmiData', 'uiDescriptions', 'ID7');
        require('./test_rhmi_graph').checkGraph(fs.readFileSync(path.join(uiDir, 'application.xml'), 'utf8'),
            JSON.parse(fs.readFileSync(path.join(uiDir, 'uiDescription.json'), 'utf8')));
    }
    assert.strictEqual(result.id, c.id);
    const expectedVersion = c.kind === 'app' ? JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'marku_kaluga_cameras', 'mgu-app.json'), 'utf8')).version :
        JSON.parse(fs.readFileSync(path.join(ROOT, 'native', 'marku-kaluga-cameras', 'component.json'), 'utf8')).version;
    assert.strictEqual(result.version, expectedVersion);
    console.log('PASS: upstream ' + c.kind + ' validator + catalog SHA/size/requires/USB: ' + c.id);
});
console.log('PASS: upstream validators only; SDK link, systemd and RHMI on head unit remain untested');
