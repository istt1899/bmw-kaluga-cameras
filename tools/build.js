// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Host-only: source package + native kit, then the official Store USB generator.
// No head-unit connection and no SDK donor is used by this build.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { packSource, readManifest } = require('./upstream/oap_link');
const { tgz, MTIME } = require('./upstream/oap_pack');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'marku_kaluga_cameras');
const TOOL = path.join(ROOT, 'native', 'marku-kaluga-cameras');
const PUBLISH = path.join(ROOT, 'dist', 'publish', 'kaluga-cameras');
const USB = path.resolve(ROOT, '..', 'output', 'kaluga-cameras-usb');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function main() {
    const m = readManifest(APP);
    const release = JSON.parse(fs.readFileSync(path.join(APP, 'release.json'), 'utf8'));
    const component = JSON.parse(fs.readFileSync(path.join(TOOL, 'component.json'), 'utf8'));
    if (m.id !== 'marku_kaluga_cameras' || component.id !== 'marku-kaluga-cameras' || m.version !== component.version) {
        throw new Error('unexpected identity or mismatched component versions');
    }
    fs.mkdirSync(PUBLISH, { recursive: true });
    fs.mkdirSync(USB, { recursive: true });
    const appName = m.id + '@' + m.version + '.tgz';
    const appFile = path.join(PUBLISH, appName);
    const members = packSource(APP, appFile);
    if (members.some((n) => /(?:^|\/)(?:oap-sdk|node_modules)(?:\/|$)|javascript\/app\.js$/.test(n))) {
        throw new Error('source artifact contains a bundled SDK or linked app');
    }

    const entries = [];
    component.files.forEach((f) => {
        if (!/^[A-Za-z0-9._/-]+$/.test(f.path) || f.path.split('/').indexOf('..') >= 0 || f.path[0] === '/') {
            throw new Error('unsafe component path');
        }
        const data = fs.readFileSync(path.join(TOOL, 'files', f.path));
        f.sha256 = sha(data);
        entries.push({ name: 'files/' + f.path, data, mode: parseInt(f.mode || '0644', 8) });
    });
    (component.units || []).forEach((u) => {
        if (!/^[A-Za-z0-9._-]+$/.test(u.name)) throw new Error('unsafe unit name');
        entries.push({ name: 'units/' + u.name, data: fs.readFileSync(path.join(TOOL, 'units', u.name)), mode: 0o644 });
    });
    entries.unshift({ name: 'component.json', data: Buffer.from(JSON.stringify(component, null, 2) + '\n'), mode: 0o644 });
    const toolName = component.id + '@' + component.version + '.tgz';
    fs.writeFileSync(path.join(PUBLISH, toolName), tgz(entries, MTIME));

    const artifact = (name) => {
        const data = fs.readFileSync(path.join(PUBLISH, name));
        return { name, size: data.length, sha256: sha(data), url: name };
    };
    const toolEntry = {};
    ['id', 'kind', 'version', 'title', 'description', 'optional', 'uninstallable', 'requires', 'mguHmi', 'internet', 'uids'].forEach((k) => {
        if (component[k] !== undefined) toolEntry[k] = component[k];
    });
    toolEntry.artifact = artifact(toolName);
    json(path.join(PUBLISH, 'catalog.json'), { schema: 2, components: [
        { id: m.id, kind: 'app', version: m.version, title: 'Камеры • Калуга',
            description: 'Стендовый кандидат ID7: офлайн-база Калужской области и диагностика положения',
            build: 'unit', requires: release.requires, uninstallable: true, mguHmi: ['ID7'], artifact: artifact(appName) },
        toolEntry
    ] });
    cp.execFileSync(process.execPath, [path.join(__dirname, 'upstream', 'mgu-install.js'), 'usb-repo', USB, PUBLISH],
        { stdio: 'inherit', windowsHide: true });
    console.log('Candidate source package: ' + appFile);
    console.log('USB directory prepared on PC: ' + USB);
}

try { main(); } catch (err) { console.error('build: ' + err.message); process.exitCode = 1; }
