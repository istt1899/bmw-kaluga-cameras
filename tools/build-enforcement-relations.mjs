// Host-only OSM importer. Never runs on a vehicle and never fetches a network URL.
// Usage: node tools/build-enforcement-relations.mjs --pbf region.osm.pbf --output supplement.json
// Or:    node tools/build-enforcement-relations.mjs --input overpass.json --output supplement.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PBF = 'https://download.openstreetmap.fr/extracts/russia/central_federal_district/kaluga_oblast.osm.pbf';
const CONTROLS = { maxspeed: 'speed', traffic_signals: 'redlight', average_speed: 'average', seatbelt: 'belt', mobile_phone: 'phone', stop_line: 'stopline', bus_lane: 'lane', pedestrian_crossing: 'pedestrian' };
const safePosition = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat >= 53 && p.lat <= 56 && p.lon >= 33 && p.lon <= 38;
const point = n => ({ lat: n.lat, lon: n.lon });
const link = e => 'https://www.openstreetmap.org/' + e.type + '/' + e.id;
const cleanTags = tags => Object.fromEntries(Object.entries(tags || {}).filter(([k, v]) => typeof v === 'string' && k.length <= 100 && v.length <= 1000 && !['__proto__', 'prototype', 'constructor'].includes(k)));
function iso(value) { const t = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
function numericLimit(value) { return typeof value === 'string' && /^\d{1,3}$/.test(value) && +value >= 5 && +value <= 180 ? +value : null; }
function summaryElement(e, nodes, ways) {
  const m = { type: e.type, ref: e.ref, role: e.role || '' };
  if (e.type === 'node' && safePosition(nodes.get(e.ref))) m.position = point(nodes.get(e.ref));
  if (e.type === 'way' && ways.has(e.ref)) {
    const w = ways.get(e.ref), positions = (w.nodes || w.refs || []).map(id => nodes.get(id)).filter(safePosition).map(point);
    if (positions.length) m.positions = positions;
  }
  return m;
}
export function buildRelations(elements, metadata = {}) {
  const nodes = new Map(elements.filter(e => e.type === 'node').map(e => [e.id, e]));
  const ways = new Map(elements.filter(e => e.type === 'way').map(e => [e.id, e]));
  const relations = elements.filter(e => e.type === 'relation' && e.tags?.type === 'enforcement').sort((a, b) => a.id - b.id);
  const devices = new Map(), unsupported = [], raw = [];
  const audit = { scannedRelations: relations.length, eligibleRelations: 0, uniqueDevices: 0, duplicateDevicesMerged: 0, explicitNumericLimits: 0, nonnumericLimits: 0,
    unknownCaptureSide: 0, unsupported: [], origin: metadata.origin || 'saved-osm-response', coverage: 'Available enforcement relations in the source extract; not a complete inventory of operating cameras.' };
  for (const relation of relations) {
    const tags = cleanTags(relation.tags), controls = (tags.enforcement || '').split(';').map(s => s.trim()).map(k => CONTROLS[k]).filter((c, i, all) => c && all.indexOf(c) === i);
    const original = { id: relation.id, version: relation.version || relation.info?.version || null,
      timestamp: iso(relation.timestamp || relation.info?.timestamp), tags,
      sourceUrl: link(relation), members: (relation.members || []).map(m => summaryElement(m, nodes, ways)) };
    raw.push(original);
    const reason = code => { unsupported.push({ relationId: relation.id, reason: code, sourceUrl: original.sourceUrl }); };
    if (!controls.length) { reason('UNSUPPORTED_ENFORCEMENT_KIND'); continue; }
    const members = original.members.filter(m => m.role === 'device');
    if (!members.length) { reason('NO_DEVICE_MEMBER'); continue; }
    let accepted = false;
    for (const device of members) {
      if (device.type !== 'node') { reason('NON_NODE_DEVICE'); continue; }
      const entity = nodes.get(device.ref);
      if (!safePosition(entity)) { reason('DEVICE_COORDINATES_UNAVAILABLE'); continue; }
      accepted = true;
      const id = 'osm:node:' + device.ref, limit = controls.includes('speed') ? numericLimit(tags.maxspeed) : null;
      if (tags.maxspeed && limit === null) audit.nonnumericLimits++;
      let item = devices.get(id);
      if (!item) {
        item = { id, type: controls.includes('redlight') ? 'redlight' : controls.includes('speed') ? 'speed' : controls.includes('average') ? 'average' : 'camera',
          controls: [], position: point(entity), limitKmh: null, rawLimits: [], provenance: 'OpenStreetMap', positionKind: 'camera-node',
          captureSide: 'unknown', description: null, inKalugaCity: null, sourceUrl: original.sourceUrl,
          positionSourceUrl: link(entity), sourceUrls: [link(entity)], relationSourceTimestamp: metadata.sourceTimestamp,
          enforcementRelations: [], deviceTags: cleanTags(entity.tags) };
        devices.set(id, item);
      } else audit.duplicateDevicesMerged++;
      item.controls = [...new Set(item.controls.concat(controls))];
      item.type = item.controls.includes('redlight') ? 'redlight' : item.controls.includes('speed') ? 'speed' : item.controls.includes('average') ? 'average' : 'camera';
      if (tags.maxspeed && !item.rawLimits.includes(tags.maxspeed)) item.rawLimits.push(tags.maxspeed);
      item.enforcementRelations.push(original); item.sourceUrls.push(original.sourceUrl);
      // Numeric conflicts are unknown, not whichever relation happened to parse last.
      const limits = item.rawLimits.map(numericLimit).filter(v => v !== null);
      item.limitKmh = limits.length && limits.every(v => v === limits[0]) ? limits[0] : null;
      const description = tags.description || entity.tags?.description || tags.name || null;
      if (description && !item.description) item.description = description.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 250);
    }
    if (accepted) audit.eligibleRelations++;
  }
  const records = [...devices.values()].sort((a, b) => a.id.localeCompare(b.id));
  audit.uniqueDevices = records.length; audit.explicitNumericLimits = records.filter(r => r.limitKmh !== null).length;
  audit.unknownCaptureSide = records.length; audit.unsupported = unsupported;
  return { schema: 1, source: 'OpenStreetMap', region: 'RU-KLU', sourceTimestamp: metadata.sourceTimestamp,
    retrievedAt: metadata.retrievedAt || metadata.sourceTimestamp, origin: metadata.origin || 'saved-osm-response',
    inputSha256: metadata.inputSha256, sourcePbfMd5: metadata.sourcePbfMd5 || null,
    licence: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    notes: 'Relation facts preserve their original source dates. A mapped device is not proof of current operation. Camera orientation and capture side remain unknown unless independently verified.',
    audit, records, relations: raw };
}
async function pbfElements(file) {
  const { createOSMStream } = require('osm-pbf-parser-node');
  const relations = [], requiredWays = new Set(), requiredNodes = new Set(); let sourceTimestamp;
  for await (const e of createOSMStream(file, { withTags: true, withInfo: true })) {
    if (e.osmosis_replication_timestamp) sourceTimestamp = new Date(e.osmosis_replication_timestamp * 1000).toISOString();
    if (e.type === 'relation' && e.tags?.type === 'enforcement') {
      relations.push(e);
      for (const m of e.members) { if (m.type === 'node') requiredNodes.add(m.ref); else if (m.type === 'way') requiredWays.add(m.ref); }
    }
  }
  const ways = [];
  for await (const e of createOSMStream(file)) if (e.type === 'way' && requiredWays.has(e.id)) { ways.push(e); for (const ref of e.refs) requiredNodes.add(ref); }
  const nodes = [];
  for await (const e of createOSMStream(file)) if (e.type === 'node' && requiredNodes.has(e.id)) nodes.push(e);
  return { elements: [...nodes, ...ways, ...relations], sourceTimestamp };
}
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--pbf', '--input', '--output'].includes(args[i]) || !args[i + 1]) throw Error('Expected --pbf/--input and --output'); options[args[i]] = args[i + 1]; }
  if (!!options['--pbf'] === !!options['--input']) throw Error('Choose exactly one --pbf or --input');
  const input = path.resolve(options['--pbf'] || options['--input']), output = path.resolve(options['--output'] || path.join(ROOT, 'native/marku-kaluga-cameras/files/enforcement-relations.json'));
  const raw = fs.readFileSync(input); if (raw.length > 64 * 1024 * 1024) throw Error('Input too large');
  let result, origin;
  if (options['--pbf']) { result = await pbfElements(input); origin = SOURCE_PBF; }
  else { const data = JSON.parse(raw.toString('utf8')); if (!Array.isArray(data.elements) || data.remark) throw Error('Incomplete OSM response'); result = { elements: data.elements, sourceTimestamp: data.osm3s?.timestamp_osm_base || data.sourceTimestamp }; origin = 'https://overpass-api.de/api/interpreter'; }
  if (!iso(result.sourceTimestamp)) throw Error('Source timestamp is required');
  const supplement = buildRelations(result.elements, { origin, sourceTimestamp: iso(result.sourceTimestamp),
    inputSha256: crypto.createHash('sha256').update(raw).digest('hex'), sourcePbfMd5: options['--pbf'] ? crypto.createHash('md5').update(raw).digest('hex') : null });
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(supplement, null, 2) + '\n');
  console.log(JSON.stringify({ sourceTimestamp: supplement.sourceTimestamp, sourcePbfMd5: supplement.sourcePbfMd5, audit: supplement.audit }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
