'use strict';
// Source facts only. An OSM speed-camera tag is not evidence of belt/lane
// enforcement or of a particular hardware model.
const fs = require('fs');
const orientation = require('./camera-orientation');
const LABELS = { speed: 'Контроль скорости', redlight: 'Контроль светофора', average: 'Средняя скорость',
    stopline: 'Стоп-линия', belt: 'Контроль ремня', pedestrian: 'Пешеходный переход', lane: 'Контроль полосы', phone: 'Контроль телефона',
    signs_marking: 'Знаки и разметка', road_position: 'Расположение ТС / встречный разъезд / обгон' };
function controls(camera) {
    const context = camera && camera.officialSiteContext;
    const source = (camera && camera.controls || [camera && camera.type]).concat(
        context && context.scope === 'enforcement-location' && Array.isArray(context.controls) ? context.controls : []);
    return source.filter((c, i) => LABELS[c] && source.indexOf(c) === i);
}
function title(camera) {
    if (camera && camera.provenance === 'owner-report') return 'Камера: тип не подтверждён';
    const c = controls(camera);
    if (c.length === 2 && c.indexOf('redlight') >= 0 && c.indexOf('speed') >= 0) return 'Светофор и скорость';
    return c.map(k => LABELS[k]).join(' / ') || 'Камера';
}
function describe(camera) {
    const context = camera.officialSiteContext && camera.officialSiteContext.scope === 'enforcement-location' ? camera.officialSiteContext : null;
    const side = ['front','rear'].indexOf(camera.captureSide)>=0 && typeof camera.captureSideSourceUrl==='string' &&
        /^https:\/\/(?:www\.)?openstreetmap\.org\/(?:node|way|relation)\/\d+$/.test(camera.captureSideSourceUrl) &&
        Number.isFinite(Date.parse(camera.captureSideVerifiedAt)) ? camera.captureSide : null;
    return { type: controls(camera).indexOf('redlight') >= 0 ? 'redlight' : camera.type || 'speed', controls: controls(camera), controlLabels: controls(camera).map(k=>LABELS[k]), title: title(camera),
        cameraLimitKmh: camera.limitKmh === undefined ? null : camera.limitKmh,
        description: camera.description || null, sourceUrl: camera.sourceUrl || null,
        provenance: camera.provenance || 'OpenStreetMap', positionKind: camera.positionKind || 'camera-node',
        positionSourceUrl: camera.positionSourceUrl || camera.sourceUrl || null,
        reportStatus: camera.reportStatus || null,
        sourcePublishedAt: context && context.sourcePublishedAt || camera.sourcePublishedAt || null, sourceRow: context && context.sourceRow || camera.sourceRow || null,
        operatingConditions: context && context.operatingConditions || camera.operatingConditions || null, rawControls: context && context.rawControls || camera.rawControls || null,
        unmappedControls: camera.unmappedControls || null,
        controlScope: context || camera.positionKind === 'official-location' ? 'enforcement-location' : 'mapped-source-object',
        officialSourceUrl: context && context.sourceUrl || (camera.provenance === 'Госавтоинспекция' ? camera.sourceUrl : null),
        officialSourceRecordId: context && context.sourceRecordId || (camera.provenance === 'Госавтоинспекция' ? camera.id : null),
        captureDirection: side,
        captureDirectionVerified: !!side,
        captureDirectionSource: side ? camera.captureSideSourceUrl : null,
        cameraFacing: orientation.describe(camera),
        enforcementRelations: camera.enforcementRelations ? camera.enforcementRelations.map(r => ({id:r.id,sourceUrl:r.sourceUrl})) : null };
}
function validLimit(value) { return Number.isFinite(value) && value > 0 && value <= 300; }
function limitEvidence(record) {
    return record && /^osm:(?:node|way|relation):[0-9]+$/.test(record.id || '') &&
        typeof record.sourceUrl === 'string' && /^https:\/\/(?:www\.)?openstreetmap\.org\/(?:node|way|relation)\/[0-9]+$/.test(record.sourceUrl) && validLimit(record.limitKmh) ?
        { id: record.id, url: record.sourceUrl, valueKmh: record.limitKmh } : null;
}
function createDescriber(records) {
    // Only explicit, already reviewed location links can share a reference.
    // No radius merge, city default, or mutation of an official camera record.
    const links = Object.create(null);
    records.forEach(record => {
        const context = record.officialSiteContext, evidence = limitEvidence(record);
        if (evidence && context && context.scope === 'enforcement-location' &&
            /^gibdd:ru-klu:[a-f0-9]{16}$/.test(context.sourceRecordId || '')) {
            (links[context.sourceRecordId] || (links[context.sourceRecordId] = [])).push(evidence);
        }
    });
    return camera => {
        const result = describe(camera), own = limitEvidence(camera), evidence=camera.speedLimitEvidence;
        if(evidence)result.speedLimitEvidence=JSON.parse(JSON.stringify(evidence));
        if(evidence)result.limitReference={valueKmh:evidence.valueKmh,state:'known',kind:evidence.kind,source:'OpenStreetMap',records:evidence.sources.map(f=>({id:'osm:'+f.kind+':'+f.id,url:f.sourceUrl,valueKmh:evidence.valueKmh,rawTags:f.tags}))};
        else if (own) result.limitReference = { valueKmh: own.valueKmh, state: 'known', kind: 'camera-record', source: 'OpenStreetMap', records: [own] };
        else if (camera.providerId === 'gibdd-official' && links[camera.id]) {
            const evidence = links[camera.id], value = evidence[0].valueKmh, consistent = evidence.every(e => e.valueKmh === value);
            result.limitReference = { valueKmh: consistent ? value : null, state: consistent ? 'known' : 'conflict',
                kind: 'reviewed-location-links', source: 'OpenStreetMap', records: evidence.map(e => Object.assign({},e)) };
        } else result.limitReference = null;
        return result;
    };
}
function enrich(database, file) {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (meta.schema !== 1 || meta.source !== 'OpenStreetMap' || meta.region !== database.region ||
        meta.basePbfMd5 !== database.pbfMd5 || !meta.records) throw new Error('Camera metadata does not match the snapshot');
    database.records = database.records.map(r => {
        const d = meta.records[r.id];
        if (!d || !d.position || d.position.lat !== r.position.lat || d.position.lon !== r.position.lon) return r;
        const description = typeof d.description === 'string' ? d.description.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 100) : null;
        return Object.assign({}, r, { controls: controls(d), description,
            sourceUrl: typeof d.sourceUrl === 'string' && /^https:\/\/www\.openstreetmap\.org\/node\/\d+$/.test(d.sourceUrl) ? d.sourceUrl : null });
    });
    database.metadataRetrievedAt = meta.retrievedAt;
    return database;
}
function supplement(database, file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!database || database.source !== 'OpenStreetMap' || !Array.isArray(database.records) ||
        data.schema !== 1 || data.source !== 'owner-report' || data.region !== database.region ||
        data.basePbfMd5 !== database.pbfMd5 || !Array.isArray(data.records) || data.records.length > 100)
        throw new Error('Reported cameras do not match the regional snapshot');
    const ids = Object.create(null);
    database.records.forEach(r => { ids[r.id] = true; });
    // Validate and canonicalize the entire supplement before touching the DB.
    // An intersection is a reference location, never the measured device point.
    const added = data.records.map(r => {
        if (!r || typeof r.id !== 'string' || !/^reported:[a-z0-9][a-z0-9:-]{0,90}$/.test(r.id) || ids[r.id] ||
            r.type !== 'camera' || !Array.isArray(r.controls) || r.controls.length !== 0 || r.limitKmh !== null ||
            r.provenance !== 'owner-report' || r.positionKind !== 'intersection' || r.reportStatus !== 'unverified' ||
            !r.position || !Number.isFinite(r.position.lat) || !Number.isFinite(r.position.lon) ||
            r.position.lat < 53 || r.position.lat > 56 || r.position.lon < 33 || r.position.lon > 38 ||
            typeof r.description !== 'string' || !r.description.trim() || r.description.length > 100 || /[\x00-\x1f]/.test(r.description) ||
            typeof r.inKalugaCity !== 'boolean' || typeof r.positionSourceUrl !== 'string' ||
            !/^https:\/\/www\.openstreetmap\.org\/node\/\d+$/.test(r.positionSourceUrl) ||
            (r.sourceUrl !== undefined && r.sourceUrl !== null)) throw new Error('Invalid reported intersection camera');
        ids[r.id] = true;
        return { id: r.id, type: 'camera', controls: [], limitKmh: null,
            description: r.description.trim(), provenance: 'owner-report', positionKind: 'intersection',
            position: { lat: r.position.lat, lon: r.position.lon }, positionSourceUrl: r.positionSourceUrl,
            inKalugaCity: r.inKalugaCity, reportStatus: 'unverified', sourceUrl: null };
    });
    const osmCount = database.records.filter(r => r.provenance !== 'owner-report').length;
    database.records = database.records.concat(added);
    database.osmCount = osmCount;
    database.reportedCount = database.records.length - osmCount;
    database.displaySource = database.reportedCount ? 'OpenStreetMap + сообщения владельца' : 'OpenStreetMap';
    return database;
}
module.exports = { controls, title, describe, createDescriber, enrich, supplement };
