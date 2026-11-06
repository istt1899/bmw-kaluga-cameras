// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Host-only: source package + native kit, then the official Store USB generator.
// No head-unit connection and no SDK donor is used by this build.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { packSource, readManifest, untar } = require('./upstream/oap_link');
const canonicalBytes = require('./canonical-bytes');
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
    if (m.id !== 'marku_kaluga_cameras' || component.id !== 'marku-kaluga-cameras') {
        throw new Error('unexpected component identity');
    }
    const minimum = release.requires[component.id];
    if (!/^\d+\.\d+\.\d+$/.test(minimum) || !/^\d+\.\d+\.\d+$/.test(component.version)) throw new Error('invalid service dependency');
    const parts = component.version.split('.').map(Number), needed = minimum.split('.').map(Number);
    const different = parts.findIndex((value, i) => value !== needed[i]);
    if (different >= 0 && parts[different] < needed[different]) throw new Error('packaged service is older than the app requires');
    const uiDir = path.join(APP, m.tree, 'rhmiData', 'uiDescriptions', 'ID7');
    require('./test_rhmi_graph').checkGraph(fs.readFileSync(path.join(uiDir, 'application.xml'), 'utf8'),
        JSON.parse(fs.readFileSync(path.join(uiDir, 'uiDescription.json'), 'utf8')));
    fs.mkdirSync(PUBLISH, { recursive: true });
    fs.mkdirSync(USB, { recursive: true });
    const appName = m.id + '@' + m.version + '.tgz';
    const appFile = path.join(PUBLISH, appName);
    const members = packSource(APP, appFile);
    fs.writeFileSync(appFile, tgz(untar(fs.readFileSync(appFile)).map(entry => ({
        name: entry.name, data: canonicalBytes(entry.name, entry.data), mode: 0o644
    })), MTIME));
    if (members.some((n) => /(?:^|\/)(?:oap-sdk|node_modules)(?:\/|$)|javascript\/app\.js$/.test(n))) {
        throw new Error('source artifact contains a bundled SDK or linked app');
    }

    const entries = [];
    component.files.forEach((f) => {
        if (!/^[A-Za-z0-9._/-]+$/.test(f.path) || f.path.split('/').indexOf('..') >= 0 || f.path[0] === '/') {
            throw new Error('unsafe component path');
        }
        const data = canonicalBytes(f.path, fs.readFileSync(path.join(TOOL, 'files', f.path)));
        f.sha256 = sha(data);
        entries.push({ name: 'files/' + f.path, data, mode: parseInt(f.mode || '0644', 8) });
    });
    (component.units || []).forEach((u) => {
        if (!/^[A-Za-z0-9._-]+$/.test(u.name)) throw new Error('unsafe unit name');
        entries.push({ name: 'units/' + u.name, data: canonicalBytes(u.name, fs.readFileSync(path.join(TOOL, 'units', u.name))), mode: 0o644 });
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
        { id: m.id, kind: 'app', version: m.version, title: 'Waze Стрелка',
            description: 'Waze on Cluster с настройками карты, HUD, CarPlay, Android Auto и дополнительным разделом камер',
            build: 'unit', requires: release.requires, uninstallable: true, mguHmi: ['ID7'], artifact: artifact(appName) },
        toolEntry
    ] });
    cp.execFileSync(process.execPath, [path.join(__dirname, 'upstream', 'mgu-install.js'), 'usb-repo', USB, PUBLISH],
        { stdio: 'inherit', windowsHide: true });
    console.log('Candidate source package: ' + appFile);
    console.log('USB directory prepared on PC: ' + USB);
}

try { main(); } catch (err) { console.error('build: ' + err.message); process.exitCode = 1; }
