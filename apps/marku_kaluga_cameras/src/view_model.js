// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

function clean(value, fallback) {
    return value == null || value === '' ? fallback : String(value).replace(/[\r\n\t]/g, ' ').slice(0, 220);
}
function date(value) {
    if (!value) return 'дата не указана';
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return 'дата не указана';
    const pad = (n) => String(n).length < 2 ? '0' + n : String(n);
    return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
}
function distance(value) {
    if (!Number.isFinite(value) || value < 0) return 'расстояние неизвестно';
    return value >= 1000 ? (value / 1000).toFixed(1) + ' км' : Math.round(value / 10) * 10 + ' м';
}
const TYPES = {
    speed: 'Контроль скорости', fixed: 'Контроль скорости', camera: 'Камера',
    average: 'Контроль средней скорости', redlight: 'Контроль светофора',
    'SPEED CAM': 'Контроль скорости', CAMERA: 'Камера', 'RED LIGHT': 'Контроль светофора',
    'AVG SPEED': 'Контроль средней скорости', 'BUS LANE': 'Контроль полосы'
};
function model(state) {
    const s = state || {}, db = s.database || {}, outputs = s.outputs || {};
    const connected = !!state;
    const a = s.alert;
    const count = Number.isFinite(db.count) ? db.count : 0;
    const text = {
        cameraStatus: connected ? (s.enabled ? 'Предупреждения включены' : 'Предупреждения выключены') : 'Сервис недоступен',
        cameraAlert: a ? clean(a.title || TYPES[a.type] || a.type, 'Камера') + ' • ' + distance(a.distance) + (a.limit ? ' • лимит ' + a.limit : '') :
            s.nearest ? 'Объект рядом: ' + distance(s.nearest.distanceM) + ' • дорога не подтверждена' : 'Активных предупреждений нет',
        cameraDatabase: connected ? 'База: ' + clean(db.source, 'нет источника') + ' • ' + count + ' объектов' : 'База: ожидание ответа сервиса',
        cameraDate: connected ? 'Дата базы: ' + date(db.updated || db.generatedAt || db.sourceUpdated) : 'Дата базы: ожидание ответа сервиса',
        cameraGps: 'Положение: ' + clean(s.gps, 'нет подтверждённых координат'),
        cameraCluster: 'Приборная панель: ' + (outputs.cluster === true ? 'вкл' : 'выкл'),
        cameraHud: 'Проекция HUD: ' + (outputs.hud === true ? 'вкл' : 'выкл'),
        cameraInfo: s.storage && s.storage.persistent === false ? 'Настройки временные: хранилище недоступно' : 'Калужская область',
        cameraDiagnostics: 'Диагностика'
    };
    if (db.error) text.cameraDate += ' • ошибка базы';
    return { text, enabled: {
        cameraEnable: connected && !s.enabled,
        cameraDisable: connected && !!s.enabled,
        cameraCluster: connected && !!(s.capabilities && s.capabilities.outputs),
        cameraHud: connected && !!(s.capabilities && s.capabilities.outputs),
        cameraDiagnostics: true
    } };
}
function outputCommand(state, target) {
    if (!state || !state.capabilities || !state.capabilities.outputs || (target !== 'cluster' && target !== 'hud')) return null;
    const o = state.outputs || {};
    return { cmd: 'outputs', cluster: target === 'cluster' ? !o.cluster : !!o.cluster,
        hud: target === 'hud' ? !o.hud : !!o.hud };
}
function diagnostics(state) {
    if (!state) return 'Сервис не отвечает';
    const r = state.renderer;
    const rendering = typeof r === 'string' ? r : r ? JSON.stringify(r) : 'состояние неизвестно';
    return 'Вывод: ' + clean(rendering, 'неизвестно') + (state.error ? ' • ' + clean(state.error, '') : '');
}

module.exports = { model, outputCommand, diagnostics, date, distance };
