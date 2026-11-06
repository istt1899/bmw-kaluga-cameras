// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Host-only integration regression. Both builds run in disposable copies;
// neither the working checkout nor a vehicle is written to by this test.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

assert(Number(process.versions.node.split('.')[0]) >= 18, 'Host packaging requires Node 18+');
const ROOT = path.resolve(__dirname, '..');
const APP = 'apps/marku_kaluga_cameras';
const TOOL = 'native/marku-kaluga-cameras';
const tempBase = fs.realpathSync(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempBase, 'strelka-build-eol-'));
const snapshots = new Map();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let textFiles = 0, binaryFiles = 0;

function inside(root, name) {
    const file = path.resolve(root, name);
    const relative = path.relative(root, file);
    assert(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'Fixture path escapes its root');
    return file;
}
function readSource(name) {
    const file = inside(ROOT, name), stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Fixture input must be a regular source file: ' + name);
    const bytes = fs.readFileSync(file);
    if (snapshots.has(name)) assert.strictEqual(sha(bytes), snapshots.get(name), 'Source changed while copying: ' + name);
    else snapshots.set(name, sha(bytes));
    return bytes;
}
function sourceFiles() {
    const names = new Set([APP + '/mgu-app.json', APP + '/release.json', TOOL + '/component.json',
        'tools/build.js', 'tools/canonical-bytes.js', 'tools/test_rhmi_graph.js',
        'tools/upstream/oap_link.js', 'tools/upstream/oap_pack.js', 'tools/upstream/mgu-install.js',
        APP + '/tools/gen_locales.js', APP + '/tools/test_i18n.js']);
    const manifest = JSON.parse(readSource(APP + '/mgu-app.json'));
    const component = JSON.parse(readSource(TOOL + '/component.json'));
    manifest.modules.forEach(name => names.add(APP + '/' + name));
    component.files.forEach(file => names.add(TOOL + '/files/' + file.path));
    (component.units || []).forEach(unit => names.add(TOOL + '/units/' + unit.name));
    function tree(name) {
        const file = inside(ROOT, name), stat = fs.lstatSync(file);
        assert(!stat.isSymbolicLink(), 'Symlinks are not fixture inputs: ' + name);
        if (stat.isDirectory()) fs.readdirSync(file).sort().forEach(child => tree(name + '/' + child));
        else { assert(stat.isFile()); names.add(name); }
    }
    tree(APP + '/' + manifest.tree);
    tree(APP + '/locales');
    return Array.from(names).sort();
}
function textInput(name, bytes) {
    // Independent of canonical-bytes.js, so a broken production normalizer
    // cannot silently create two identically broken fixtures. Unknown/binary
    // resources retain their exact source bytes, including embedded CRLF.
    return /(?:\.(?:js|json|xml|md|txt|sh|service|socket|target)|(?:^|\/)(?:LICENSE|NOTICE))$/i.test(name) &&
        bytes.indexOf(0) < 0 && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
}
function copyFixture(directory, names, eol) {
    names.forEach(name => {
        const bytes = readSource(name), isText = textInput(name, bytes);
        let output = bytes;
        if (isText) {
            const lf = bytes.toString('utf8').replace(/\r\n/g, '\n');
            output = Buffer.from(eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
            if (eol === 'crlf' && lf.indexOf('\n') >= 0) assert(output.indexOf(Buffer.from('\r\n')) >= 0);
            textFiles++;
        } else { assert(output.equals(bytes)); binaryFiles++; }
        const target = inside(directory, name);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, output);
    });
}
function run(directory, script) {
    const result = cp.spawnSync(process.execPath, [inside(directory, script)], {
        cwd: directory, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60000
    });
    if (result.error) throw result.error;
    assert.strictEqual(result.status, 0, script + ' failed in ' + path.basename(path.dirname(directory)) + ':\n' + result.stdout + result.stderr);
}
function artifacts(directory) {
    const publish = inside(directory, 'dist/publish/kaluga-cameras');
    const catalog = JSON.parse(fs.readFileSync(path.join(publish, 'catalog.json')));
    assert.strictEqual(catalog.components.length, 2);
    return catalog.components.map(component => {
        assert(['app', 'tool'].includes(component.kind));
        const bytes = fs.readFileSync(inside(publish, component.artifact.name));
        assert.strictEqual(bytes.length, component.artifact.size);
        assert.strictEqual(sha(bytes), component.artifact.sha256);
        return { id: component.id, kind: component.kind, name: component.artifact.name, sha256: sha(bytes), size: bytes.length };
    }).sort((a, b) => a.id.localeCompare(b.id));
}
function main() {
    // Check the actual generator without write(): this catches drift in the
    // checkout while keeping locale generation confined to the two fixtures.
    const actualGenerator = require(path.join(ROOT, APP, 'tools/gen_locales'));
    const generated = actualGenerator.source();
    assert(!generated.includes('\r'), 'Locale generator must emit canonical LF');
    assert.strictEqual(readSource(APP + '/src/locales.js').toString('utf8').replace(/\r\n/g, '\n'), generated);
    const names = sourceFiles();
    const lf = inside(tempRoot, 'lf/project'), crlf = inside(tempRoot, 'crlf/project');
    copyFixture(lf, names, 'lf'); copyFixture(crlf, names, 'crlf');
    assert(textFiles > 0 && binaryFiles > 0, 'Exercise both text and unchanged binary resources');
    run(lf, APP + '/tools/test_i18n.js'); run(crlf, APP + '/tools/test_i18n.js');
    // These are real build.js invocations, including the upstream USB writer.
    // The copies contain only local catalog/artifacts: no network or SSH path.
    run(lf, 'tools/build.js'); run(crlf, 'tools/build.js');
    const canonical = artifacts(lf), windows = artifacts(crlf);
    assert.deepStrictEqual(windows, canonical, 'LF and CRLF builds must produce identical app/service TGZ bytes');
    canonical.forEach(artifact => console.log('PASS LF/CRLF reproducible ' + artifact.kind + ': ' + artifact.name + ' SHA-256 ' + artifact.sha256));
    // Also execute generation on CRLF inputs, after the archive comparison so
    // regeneration cannot hide a missing normalizer in the packaging path.
    run(lf, APP + '/tools/gen_locales.js'); run(crlf, APP + '/tools/gen_locales.js');
    [lf, crlf].forEach(directory => {
        const generator = require(inside(directory, APP + '/tools/gen_locales'));
        const bytes = fs.readFileSync(generator.OUT);
        assert.strictEqual(bytes.toString('utf8'), generated);
        assert(bytes.indexOf(13) < 0, 'Generated locales must contain only LF');
        const tree = JSON.parse(fs.readFileSync(inside(directory, APP + '/mgu-app.json'))).tree;
        Object.keys(generator.texts()).forEach(name => {
            const text = fs.readFileSync(inside(directory, APP + '/' + tree + '/rhmiData/variantGroups/Common/texts/' + name));
            assert.strictEqual(text.toString('utf8'), JSON.stringify(generator.texts()[name], null, 2) + '\n');
        });
    });
    console.log('PASS locale generation and i18n checks on LF/CRLF inputs; binary resources preserved; working checkout unchanged');
}
try { main(); }
finally {
    try {
        snapshots.forEach((digest, name) => assert.strictEqual(sha(fs.readFileSync(inside(ROOT, name))), digest, 'Working source was changed: ' + name));
    } finally {
        // Verify the exact disposable absolute target before recursive removal.
        assert.strictEqual(path.dirname(path.resolve(tempRoot)), tempBase);
        assert(/^strelka-build-eol-/.test(path.basename(tempRoot)));
        assert(!ROOT.startsWith(path.resolve(tempRoot) + path.sep));
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}
