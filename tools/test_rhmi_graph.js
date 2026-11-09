// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// RHMI component IDs are application-local, not state-local. Raw user events
// contain sourceId alone; duplicate IDs also overwrite the app's action map.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function checkGraph(xml, ui) {
    const namespaces = { container: new Set(), component: new Set(), layoutGroup: new Set() };
    const containers = new Map();
    let current = null;
    const tags = xml.match(/<\/?(?:container|component|layoutGroup)\b[^>]*>/g) || [];
    tags.forEach((tag) => {
        const match = /^<(\/?)(container|component|layoutGroup)\b/.exec(tag);
        if (match[1]) { if (match[2] === 'container') current = null; return; }
        const kind = match[2], attributes = {};
        tag.replace(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g, (_, key, value) => { attributes[key] = value; return ''; });
        const id = attributes.id;
        assert(/^[1-9][0-9]*$/.test(id || ''), kind + ' needs a positive numeric id');
        assert(!namespaces[kind].has(id), 'Duplicate RHMI ' + kind + ' id ' + id);
        namespaces[kind].add(id);
        if (kind === 'container') {
            assert(current === null, 'Nested RHMI containers');
            current = id; containers.set(id, { type: attributes.type, components: new Map() });
        } else if (kind === 'component') {
            assert(current !== null, 'Component outside a container');
            containers.get(current).components.set(id, attributes.type);
        } else assert(current !== null, 'Layout group outside a container');
    });
    assert.strictEqual(current, null, 'Unclosed RHMI container');
    assert.deepStrictEqual(Array.from(containers.keys()).sort(), Object.keys(ui.containers).sort(), 'XML / JSON container ids');
    const names = new Set();
    Object.keys(ui.containers).forEach((id) => {
        const desc = ui.containers[id], declaration = containers.get(id);
        assert.strictEqual(declaration.type, desc.type, 'Container type ' + id);
        assert(!names.has(desc.name), 'Duplicate RHMI name ' + desc.name); names.add(desc.name);
        const parent = desc.properties && desc.properties.ParentState;
        if (parent) assert(ui.containers[String(parent.value)], 'Missing parent state ' + parent.value);
        const head=xml.split('<container id="'+id+'"')[1].split('<layoutGroup')[0];
        const xmlParent=/<property id="9" value="(\d+)"\s*\/>/.exec(head);
        assert.strictEqual(xmlParent?Number(xmlParent[1]):null,parent?parent.value:null,'Native XML / JSON parent of '+id);
        assert.deepStrictEqual(Array.from(declaration.components.keys()).sort(), Object.keys(desc.components).sort(), 'XML / JSON components of ' + id);
        Object.keys(desc.components).forEach((cid) => {
            const component = desc.components[cid];
            assert.strictEqual(declaration.components.get(cid), component.type, 'Component type ' + cid);
            assert(!names.has(component.name), 'Duplicate RHMI name ' + component.name); names.add(component.name);
        });
    });
    return namespaces;
}

function main() {
    const app = path.join(__dirname, '..', 'apps', 'marku_kaluga_cameras');
    const manifest = JSON.parse(fs.readFileSync(path.join(app, 'mgu-app.json'), 'utf8'));
    const folder = path.join(app, manifest.tree, 'rhmiData', 'uiDescriptions', 'ID7');
    const fixedUi = JSON.parse(fs.readFileSync(path.join(folder, 'uiDescription.json'), 'utf8'));
    const fixedXml = fs.readFileSync(path.join(folder, 'application.xml'), 'utf8');
    checkGraph(fixedXml, fixedUi);
    const bad = JSON.parse(fs.readFileSync(path.join(app, 'tools', 'fixtures', '0.2.0-rhmi-invalid.json'), 'utf8'));
    assert.throws(() => checkGraph(bad.xml, JSON.parse(bad.ui)), /Duplicate RHMI (?:component|layoutGroup) id/,
        'The actually published 0.2.0 package must reproduce the invalid graph');
    // Demonstrate the concrete action collision in the old package even with a
    // forgiving HMI: it reports numeric sourceId, not a page/name pair.
    const badUi = JSON.parse(bad.ui), oldMap = {};
    ['1', '3'].forEach((cid) => Object.keys(badUi.containers[cid].components).forEach((id) => {
        oldMap[id] = badUi.containers[cid].components[id].name;
    }));
    assert.strictEqual(oldMap['32'], 'cameraCluster');
    assert.strictEqual(badUi.containers['1'].components['32'].name, 'wocEnable');
    assert.strictEqual(oldMap['35'], 'cameraDiagnostics');
    assert.strictEqual(badUi.containers['1'].components['35'].name, 'wocGuide');
    console.log('PASS: published 0.2.0 reproduces duplicate RHMI ids and overwritten action routing; fixed graph has unique ids and matching XML/JSON');
}

module.exports = { checkGraph };
if (require.main === module) main();
