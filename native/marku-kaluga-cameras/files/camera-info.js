'use strict';
// Source facts only. An OSM speed-camera tag is not evidence of belt/lane
// enforcement or of a particular hardware model.
const fs = require('fs');
const LABELS = { speed: 'Контроль скорости', redlight: 'Контроль светофора', average: 'Средняя скорость',
    stopline: 'Стоп-линия', belt: 'Контроль ремня', pedestrian: 'Пешеходный переход' };
function controls(camera) {
    const source = camera && camera.controls || [camera && camera.type];
    return source.filter((c, i) => LABELS[c] && source.indexOf(c) === i);
}
function title(camera) {
    const c = controls(camera);
    if (c.indexOf('redlight') >= 0 && c.indexOf('speed') >= 0) return 'Светофор и скорость';
    return c.map(k => LABELS[k]).join(' / ') || 'Камера';
}
function describe(camera) {
    return { type: controls(camera).indexOf('redlight') >= 0 ? 'redlight' : camera.type || 'speed', controls: controls(camera), title: title(camera),
        cameraLimitKmh: camera.limitKmh === undefined ? null : camera.limitKmh,
        description: camera.description || null, sourceUrl: camera.sourceUrl || null };
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
module.exports = { controls, title, describe, enrich };
