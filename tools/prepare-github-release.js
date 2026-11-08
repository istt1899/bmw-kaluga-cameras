// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/* Host-only preparation. No network, gh, authentication, git or remote writes.
 * node tools/build.js
 * node tools/prepare-github-release.js [--output <new-empty-directory>]
 * Produces clean source/, assets/, release-notes.md and reviewable commands.ps1.
 * Publication is a separate, explicit action by the operator.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const canonicalBytes = require('./canonical-bytes');
const releaseDownloads = require('./release-downloads');
const ROOT = path.resolve(__dirname, '..');
const REPOSITORY = 'istt1899/bmw-kaluga-cameras';
const INPUT = path.join(ROOT, 'dist', 'publish', 'kaluga-cameras');
const MAX_FILE = 32 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function assert(condition, message) { if (!condition) throw new Error(message); }
function argumentsForRun() {
  const args = process.argv.slice(2);
  let output = path.resolve(ROOT, '..', 'output', 'github-bmw-kaluga-cameras');
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--output' && args[i + 1]) output = path.resolve(args[++i]);
    else throw new Error('Usage: node tools/prepare-github-release.js [--output <new-empty-directory>]');
  }
  return output;
}
function safeName(name) {
  return name.length > 0 && !name.startsWith('/') && !name.includes('\\') && !name.includes(':') &&
    name.split('/').every(part => part !== '..' && part !== '.' && part.length > 0);
}
function inspectName(name) {
  assert(safeName(name), 'Unsafe path: ' + name);
  assert(!/(?:^|\/)(?:\.git|node_modules|oap-sdk|credentials|backups|screenshots|qa)(?:\/|$)/i.test(name), 'Private/SDK path: ' + name);
  assert(!/\.(?:pem|key|p12|pfx|bup|ncd|cafd|log|pbf|zip|exe|dll)$/i.test(name), 'Forbidden public file type: ' + name);
  assert(!/(?:^|\/)(?:\.env(?:\.|$)|known_hosts|id_rsa|id_ed25519|codex-clipboard)/i.test(name), 'Private file: ' + name);
  if (/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(name)) {
    assert(/\/rhmiData\/variantGroups\/Common\/images\/[a-z0-9_]+\.png$/.test(name), 'Only packaged app icons are allowed: ' + name);
  }
}
function inspectContent(name, bytes) {
  inspectName(name);
  if (/\.png$/i.test(name)) return;
  const text = bytes.toString('utf8');
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text), 'Private key content in ' + name);
  assert(!/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text), 'GitHub credential in ' + name);
  assert(!/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text), 'Cloud credential in ' + name);
  assert(!/\b[A-HJ-NPR-Z0-9]{17}\b/.test(text), 'Possible full VIN in ' + name);
  assert(!/[A-Za-z]:\\(?:Users|agents|BMW)\\/i.test(text), 'Private machine path in ' + name);
}
function readPublicFile(file, name) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected regular file: ' + name);
  assert(stat.size <= MAX_FILE, 'Public source file too large: ' + name);
  const bytes = canonicalBytes(name, fs.readFileSync(file)); inspectContent(name, bytes); return bytes;
}
function tarMembers(file, expectedKind) {
  const tar = zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: 96 * 1024 * 1024 });
  const names = [];
  const contents = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const read = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const prefix = read(345, 155);
    const name = (prefix ? prefix + '/' : '') + read(0, 100);
    const kind = read(156, 1) || '0';
    assert(kind === '0' || kind === '5', 'Archive contains link or special member: ' + name);
    const sizeText = read(124, 12).trim();
    assert(/^[0-7]+$/.test(sizeText), 'Unsupported tar size: ' + name);
    const size = parseInt(sizeText, 8);
    assert(size <= MAX_FILE && offset + 512 + size <= tar.length, 'Invalid tar member size: ' + name);
    if (kind === '0') {
      const content = tar.subarray(offset + 512, offset + 512 + size);
      inspectContent(name, content); names.push(name); contents.set(name, content);
    } else inspectName(name.replace(/\/$/, ''));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(names.length > 0, 'Empty archive');
  assert(names.includes(expectedKind === 'app' ? 'mgu-app.json' : 'component.json'), 'Wrong artifact layout: ' + file);
  assert(!names.some(name => /(?:^|\/)javascript\/app\.js$/.test(name)), 'Unexpected linked bundle in source package');
  return contents;
}
function compareSource(contents, component) {
  if (component.kind === 'app') {
    contents.forEach((bytes, name) => {
      const source = path.join(ROOT, 'apps', component.id, name);
      assert(fs.existsSync(source) && bytes.equals(canonicalBytes(name, fs.readFileSync(source))), 'Source changed since app build: ' + name);
    });
  } else {
    const directory = path.join(ROOT, 'native', component.id);
    const source = JSON.parse(fs.readFileSync(path.join(directory, 'component.json'), 'utf8'));
    const expected = new Set(['component.json']);
    source.files.forEach(file => expected.add('files/' + file.path));
    (source.units || []).forEach(unit => expected.add('units/' + unit.name));
    assert(contents.size === expected.size, 'Unexpected native archive members');
    contents.forEach((bytes, name) => {
      assert(expected.has(name), 'Undeclared native archive member: ' + name);
      if (name !== 'component.json') assert(bytes.equals(canonicalBytes(name, fs.readFileSync(path.join(directory, name)))), 'Source changed since service build: ' + name);
    });
    const packed = JSON.parse(contents.get('component.json').toString('utf8'));
    packed.files.forEach(file => { delete file.sha256; });
    assert(JSON.stringify(packed) === JSON.stringify(source), 'Native manifest changed since build');
  }
}
function collectSource() {
  const files = new Map();
  function add(relative) {
    const bytes = readPublicFile(path.join(ROOT, relative), relative); files.set(relative, bytes);
  }
  function tree(relative) {
    const directory = path.join(ROOT, relative);
    if (!fs.existsSync(directory)) return;
    fs.readdirSync(directory).sort().forEach(name => {
      const nested = relative + '/' + name;
      const info = fs.lstatSync(path.join(ROOT, nested));
      assert(!info.isSymbolicLink(), 'No symlinks in public source: ' + nested);
      if (info.isDirectory()) { inspectName(nested); tree(nested); } else add(nested);
    });
  }
  ['README.md', 'LICENSE'].forEach(add);
  ['NOTICE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes', 'catalog-providers.json', 'store-downloads.json', 'tools/canonical-bytes.js', 'tools/release-downloads.js'].forEach(name => {
    if (fs.existsSync(path.join(ROOT, name))) add(name);
  });
  ['apps', 'native', 'data', 'docs', 'specs', 'tools/fixtures', '.github'].forEach(tree);
  fs.readdirSync(path.join(ROOT, 'tools')).sort().forEach(name => {
    if (/^(?:build\.js|build-road-zones\.mjs|build-enforcement-relations\.mjs|build-osm-camera-snapshot\.mjs|build-camera-database\.js|build-camera-limit-data\.js|build-regional-coverage\.js|build-camera-limit-observations\.mjs|build-camera-font\.py|camera-source-policy\.js|import-gibdd-kaluga\.py|check-camera-source-updates\.py|test_[A-Za-z0-9_]+\.py|prepare-github-release\.js|test[-_][A-Za-z0-9_-]+\.js|[A-Za-z0-9_-]+\.test\.js)$/.test(name)) add('tools/' + name);
  });
  ['oap_link.js', 'oap_pack.js', 'mgu-install.js', 'mgu-deploy.js', 'LICENSE'].forEach(name => add('tools/upstream/' + name));
  if (fs.existsSync(path.join(ROOT, 'tools', 'upstream', 'UPSTREAM.json'))) add('tools/upstream/UPSTREAM.json');
  assert(!Array.from(files.keys()).some(name => name.startsWith('dist/')), 'Generated archives cannot be source files');
  return files;
}
function quotePowerShell(value) { return "'" + value.replace(/'/g, "''") + "'"; }
function main() {
  assert(Number(process.versions.node.split('.')[0]) >= 18, 'Preparation requires host Node 18+');
  const output = argumentsForRun();
  assert(output !== ROOT && !ROOT.startsWith(output + path.sep), 'Output must not contain the source project');
  assert(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'Output must be a new or empty directory; use --output for another run');
  const catalog = JSON.parse(fs.readFileSync(path.join(INPUT, 'catalog.json'), 'utf8'));
  assert(catalog.schema === 2 && Array.isArray(catalog.components) && catalog.components.length === 2, 'Expected two schema-2 components');
  const expected = { marku_kaluga_cameras: 'app', 'marku-kaluga-cameras': 'tool' };
  const archives = new Map();
  const names = new Set();
  const version = catalog.components[0].version;
  const mirrorsFile = path.join(ROOT,'store-downloads.json');
  const mirrors = releaseDownloads.create(fs.existsSync(mirrorsFile) ? JSON.parse(fs.readFileSync(mirrorsFile,'utf8')) : null);
  catalog.components.forEach(component => {
    assert(expected[component.id] === component.kind && !names.has(component.id), 'Unexpected or duplicate component');
    assert(/^\d+\.\d+\.\d+$/.test(component.version), 'Invalid component version');
    assert(JSON.stringify(component.mguHmi) === '["ID7"]', 'Expected explicit ID7 target');
    if (component.kind === 'app') assert(component.build === 'unit', 'App must be SDK-free source package');
    const artifact = component.artifact;
    assert(artifact && artifact.name === component.id + '@' + component.version + '.tgz', 'Wrong artifact name');
    const target = path.join(INPUT, artifact.name);
    const info = fs.lstatSync(target);
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_FILE, 'Unsafe artifact file');
    const bytes = fs.readFileSync(target);
    assert(bytes.length === artifact.size && sha256(bytes) === artifact.sha256, 'Artifact checksum/size mismatch: ' + artifact.name);
    compareSource(tarMembers(target, component.kind), component); archives.set(artifact.name, bytes); names.add(component.id);
    artifact.url = mirrors.url(component.id,component.version,artifact.name,artifact.size,artifact.sha256,
      'https://github.com/' + REPOSITORY + '/releases/download/' + component.id + '@' + component.version + '/' + artifact.name);
  });
  const ownComponents = catalog.components.slice();
  const appComponent = ownComponents.find(component => component.kind === 'app');
  const appManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', appComponent.id, 'mgu-app.json'), 'utf8'));
  const iconBytes = readPublicFile(path.join(ROOT, 'apps', appComponent.id, appManifest.tree,
    'rhmiData', 'variantGroups', 'Common', 'images', 'kaluga_camera.png'),
    'apps/' + appComponent.id + '/' + appManifest.tree + '/rhmiData/variantGroups/Common/images/kaluga_camera.png');
  const iconName = appComponent.id + '.png';
  appComponent.icon = mirrors.url(appComponent.id+'-icon',version,iconName,iconBytes.length,sha256(iconBytes),
    'https://github.com/' + REPOSITORY + '/releases/download/' + appComponent.id + '@' + version + '/' + iconName);
  appComponent.iconSha256 = sha256(iconBytes);
  const providers = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog-providers.json'), 'utf8'));
  assert(providers.length === 2, 'Expected shared Waze service and cluster renderer');
  providers.forEach(component => {
    assert(['waze-on-cluster', 'cluster-render'].includes(component.id) && component.kind === 'tool', 'Unexpected shared component');
    assert(component.artifact && component.artifact.url.startsWith('https://github.com/robertnisipeanu/idrive-apps/releases/download/'), 'Shared tool must retain its official release');
    assert(!catalog.components.some(c => c.id === component.id), 'Duplicate shared component');
    catalog.components.push(component);
  });
  const source = collectSource();
  // A fresh HTTPS path can be used when a car cannot refresh its GitHub
  // release source. Artifact URLs above already point at immutable releases.
  const directCatalog = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
  inspectContent('catalog.json', directCatalog);
  source.set('catalog.json', directCatalog);
  const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'native', 'marku-kaluga-cameras', 'files', 'kaluga-speed.json'), 'utf8'));
  const roadZones = JSON.parse(fs.readFileSync(path.join(ROOT, 'native', 'marku-kaluga-cameras', 'files', 'road-zones.json'), 'utf8'));
  assert(snapshot.region === 'RU-KLU' && roadZones.region === snapshot.region && roadZones.sourceTimestamp === snapshot.sourceTimestamp &&
    roadZones.pbfMd5 === snapshot.pbfMd5, 'Camera snapshot and road geometry must share the same regional source');
  const reported = JSON.parse(fs.readFileSync(path.join(ROOT, 'native', 'marku-kaluga-cameras', 'files', 'reported-cameras.json'), 'utf8'));
  assert(reported.source === 'owner-report' && reported.region === snapshot.region && reported.basePbfMd5 === snapshot.pbfMd5, 'Reported reference must match base region');
  const relations = JSON.parse(fs.readFileSync(path.join(ROOT, 'native', 'marku-kaluga-cameras', 'files', 'enforcement-relations.json'), 'utf8'));
  const fullData = require('./build-camera-database').bundle();
  const dataCounts = { total: fullData.records.length, relations: relations.records.length, osm: snapshot.records.length, reported: reported.records.length, official: fullData.officialCount||0,
    city: snapshot.records.filter(record => record.inKalugaCity).length,
    withLimit: snapshot.records.filter(record => typeof record.limitKmh === 'number').length, zones: roadZones.zones.length };
  const assets = path.join(output, 'assets'); const exported = path.join(output, 'source');
  fs.mkdirSync(assets, { recursive: true }); fs.mkdirSync(exported, { recursive: true });
  source.forEach((bytes, name) => {
    const destination = path.join(exported, name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
  });
  archives.forEach((bytes, name) => fs.writeFileSync(path.join(assets, name), bytes));
  fs.writeFileSync(path.join(assets, iconName), iconBytes);
  fs.writeFileSync(path.join(assets, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  fs.writeFileSync(path.join(exported, '.gitignore'), 'dist/\nnode_modules/\n*.pbf\n*.osm.pbf\n.env\n.env.*\n');
  const notes = '# Waze Стрелка ' + version + '\n\n' +
    'В разделе «Камеры» добавлены отдельные настройки мигания и звука, пороги 0–30 км/ч с шагом 1 и явная кнопка рекомендованного профиля. По умолчанию цифры скорости мигают при превышении знака; знак, расстояние и карточка остаются видимыми. Звук по умолчанию выключен, порог +20. При ограничении 60 скорость 80 не пересекает звуковой порог, 80.1/81/82 пересекает; дробная граница не маскируется округлением — показано «>80». Порог уведомления не меняет разрешённую скорость.\n\n' +
    'Реальный звуковой канал BMW ещё не подтверждён: настройка сохраняет желание владельца, интерфейс показывает недоступность, ложный played не выдаётся. Адаптерный код исправлен: один фактически незавершённый запрос, карантин после timeout, дедупликация подхода, не более трёх попыток и общая пауза 12 с. Визуальный режим работает независимо.\n\n' +
    'Добавлен явный ручной перезапуск GPS после отката времени: очищаются все NMEA/GPSD-части и guidance, старые callbacks/UTC отсекаются, ожидаются новые пригодные отсчёты. Настройки, база и калибровки сохраняются. Диагностика содержит точную скорость, причины, пороги, состояние звука и полный отчёт покрытия.\n\n' +
    'База остаётся 2026.11.7.2: ' + dataCounts.total + ' записей источников; 106 прямых и 97 справочных лимитов, 105 неизвестных. 19 дорожных зон, 18 числовых; 289 записей без дорожной зоны. Показаны 20 известных ориентаций OSM как ориентация объектива, а не направление фиксации. Свежие загрузки МВД/OSM 08.11.2026 не дали новых сведений. Полная база всех работающих камер, все лимиты, стороны съёмки и получение закрытой базы Яндекса не заявляются.\n\n' +
    'ТЗ: specs/overspeed-and-regional-coverage-0.7.0.md; совет и исследование источников: docs/council-2026-11-08.md и docs/camera-source-audit-2026-11-08.md. Проверены Node 8.17/24, реальные локальные IPC/GPSD/NMEA, raster 320×96, RHMI, сохранение, пакеты и LF/CRLF. Автомобиль не подключался; физическая видимость и звук требуют проверки на машине. Обновить приложение и сервис до ' + version + '.\n';
  fs.writeFileSync(path.join(output, 'release-notes.md'), notes);
  const commands = [
    '# Review source/ and assets/ before running. This file has NOT been executed.',
    '# Prerequisite: gh is already signed in to the intended GitHub account.',
    '$ErrorActionPreference = \'Stop\'',
    '$source = ' + quotePowerShell(exported),
    '$assets = ' + quotePowerShell(assets),
    '$notes = ' + quotePowerShell(path.join(output, 'release-notes.md')),
    '',
    '# First publication only. Existing repo/release makes create fail; do not overwrite immutable version assets.',
    'git -C $source init -b main',
    'git -C $source add -- .',
    'git -C $source commit -m ' + quotePowerShell('Add Kaluga camera app ' + version),
    'gh repo create ' + quotePowerShell(REPOSITORY) + ' --public --source $source --remote origin --push',
    ''
  ];
  ownComponents.forEach(component => {
    commands.push('gh release create ' + quotePowerShell(component.id + '@' + component.version) +
      ' (Join-Path $assets ' + quotePowerShell(component.artifact.name) + ')' +
      (component.kind === 'app' ? ' (Join-Path $assets ' + quotePowerShell(iconName) + ')' : '') + ' --repo ' + quotePowerShell(REPOSITORY) +
      ' --target main --title ' + quotePowerShell(component.id + ' ' + component.version) + ' --notes-file $notes');
  });
  commands.push('', '# Publish catalog LAST, after both version assets exist.',
    'gh release create catalog (Join-Path $assets \'catalog.json\') --repo ' + quotePowerShell(REPOSITORY) +
    ' --target main --title \'MGU Store catalog\' --notes \'Install source: istt1899/bmw-kaluga-cameras, channel Releases.\'',
    '', '# Subsequent versions: publish new immutable component releases first; only then upload catalog.json to catalog.',
    '# gh release upload catalog (Join-Path $assets \'catalog.json\') --repo ' + quotePowerShell(REPOSITORY) + ' --clobber', '');
  const checkedCommands = [];
  commands.forEach(line => {
    checkedCommands.push(line);
    if (/^(?:git|gh)\s/.test(line)) checkedCommands.push("if ($LASTEXITCODE -ne 0) { throw 'Command failed. Stop before publishing later steps.' }");
  });
  fs.writeFileSync(path.join(output, 'commands.ps1'), checkedCommands.join('\n'));
  const manifest = { repository: REPOSITORY, version, dataCounts, sourceTimestamp: snapshot.sourceTimestamp, sourceFiles: Array.from(source.keys()).sort(),
    assets: ownComponents.map(component => ({ name: component.artifact.name, size: component.artifact.size, sha256: component.artifact.sha256 })),
    icon: { name: iconName, size: iconBytes.length, sha256: sha256(iconBytes) },
    catalogSha256: sha256(fs.readFileSync(path.join(assets, 'catalog.json'))), published: false };
  fs.writeFileSync(path.join(output, 'prepared.json'), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write('Prepared only; nothing published or authenticated.\n' + output + '\n' +
    source.size + ' reviewed-path source files; ' + archives.size + ' verified artifacts; catalog release must be uploaded last.\n');
}
try { main(); } catch (error) { process.stderr.write('prepare-github-release: ' + error.message + '\n'); process.exitCode = 1; }
