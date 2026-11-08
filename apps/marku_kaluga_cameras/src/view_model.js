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
const ALERT_TYPES = [
    {key:'speed',label:'Контроль скорости'}, {key:'average',label:'Средняя скорость'},
    {key:'redlight',label:'Контроль светофора'}, {key:'stopline',label:'Стоп-линия'},
    {key:'belt',label:'Контроль ремня'}, {key:'pedestrian',label:'Пешеходный переход'},
    {key:'lane',label:'Контроль полосы'}, {key:'phone',label:'Контроль телефона'},
    {key:'signs_marking',label:'Знаки и разметка'},
    {key:'road_position',label:'Расположение ТС / обгон'}, {key:'other',label:'Другие и неизвестные типы'}
];
function alertPreferences(state) {
    const s=state||{}, p=s.alertPreferences||{}, types=p.cameraTypes;
    const supported=!!(s.capabilities&&s.capabilities.alertPreferences===true);
    const available=supported&&Number.isInteger(p.warningDistanceM)&&p.warningDistanceM>=50&&p.warningDistanceM<=1000&&p.warningDistanceM%50===0&&
        !!types&&ALERT_TYPES.every(type=>typeof types[type.key]==='boolean');
    return {available,warningDistanceM:available?p.warningDistanceM:null,cameraTypes:available?types:null,
        enabledCount:available?ALERT_TYPES.filter(type=>types[type.key]).length:null,
        reason:!state?'Сервис недоступен':!supported?'Для настройки дистанции и типов обновите сервис камер':
            !available?'Ожидание подтверждённых настроек сервиса':null};
}
const OVERSPEED_RECOMMENDED = Object.freeze({visualFlash:true,visualOffsetKmh:0,soundEnabled:false,soundOffsetKmh:20});
function overspeedPreferences(state) {
    const s=state||{}, p=s.overspeedPreferences||{}, audio=s.audio||{};
    const supported=!!(s.capabilities&&s.capabilities.overspeedPreferences===true);
    const offset=value=>Number.isInteger(value)&&value>=0&&value<=30;
    const available=supported&&typeof p.visualFlash==='boolean'&&typeof p.soundEnabled==='boolean'&&
        offset(p.visualOffsetKmh)&&offset(p.soundOffsetKmh);
    return {available,visualFlash:available?p.visualFlash:null,visualOffsetKmh:available?p.visualOffsetKmh:null,
        soundEnabled:available?p.soundEnabled:null,soundOffsetKmh:available?p.soundOffsetKmh:null,
        audioAvailable:audio.available===true,audioReason:clean(audio.reason,audio.available===true?
            'Канал подтверждён; слышимость проверяется на стоянке':'Звуковой канал BMW не подтверждён'),
        reason:!state?'Сервис недоступен':!supported?'Для настройки превышения обновите сервис камер':
            !available?'Ожидание подтверждённых настроек превышения':null};
}
function coverageRows(state) {
    const coverage=((state||{}).database||{}).coverage||{}, value=key=>Number.isInteger(coverage[key])&&coverage[key]>=0?coverage[key]:'—';
    return [coverage.complete===false?'Покрытие неполное • '+value('sourceRecords')+' записей источников':'Полнота базы не подтверждена',
        'Лимиты: прямые '+value('directLimit')+' • справочные '+value('referenceLimit')+' • неизвестные '+value('unknownLimit'),
        'Дорожные зоны '+value('roadZones')+' • с лимитом '+value('numericRoadZones')+' • без зоны '+value('recordsWithoutRoadZone'),
        'Объектив OSM: известно '+value('facingKnown')+' • сторона фиксации: '+value('captureSideKnown')];
}
function cameraFacing(camera) {
    const facing=(camera||{}).cameraFacing||{}, bearings=facing.bearingsDeg;
    const known=facing.state==='mapped'&&facing.interpretation==='camera-facing'&&Array.isArray(bearings)&&bearings.length>0&&
        bearings.every(value=>Number.isFinite(value)&&value>=0&&value<360);
    return 'Куда смотрит объектив OSM: '+(known?bearings.map(value=>value+'°').join(' / ')+
        ' • '+clean(facing.sourceUrl,'источник не указан'):'неизвестно');
}
function gpsSummary(state) {
    const input = state && state.gpsInput;
    if (!input) return null;
    const kinds = input.sentences || {};
    const count = (name) => Number.isFinite(kinds[name]) ? kinds[name] : 0;
    const age = Number.isFinite(input.lastPacketAgeMs) ? Math.max(0, Math.floor(input.lastPacketAgeMs / 1000)) + ' с назад' : 'ещё нет';
    return 'GPS BMW: RMC ' + count('RMC') + ' • GGA ' + count('GGA') + ' • GST ' + count('GST') + ' • пакет: ' + age;
}
function model(state) {
    const s = state || {}, db = s.database || {}, outputs = s.outputs || {};
    const connected = !!state;
    const a = s.alert;
    const count = Number.isFinite(db.count) ? db.count : 0;
    const fix=s.gpsFix||{}, street=s.street||{}, c=a||s.nearest||{}, result=s.commandResult||{}, update=s.databaseUpdate||{};
    const fixAge=Number.isFinite(s.observedAtMs)&&Number.isFinite(fix.timeMs)?s.observedAtMs-fix.timeMs:null;
    const fresh=Number.isFinite(fixAge)&&fixAge>=-500&&fixAge<=3000;
    const reference=c.limitReference&&c.limitReference.state==='known'?c.limitReference.valueKmh:null;
    const limit=a&&a.roadConfirmed&&Number.isFinite(a.limitKmh)?a.limitKmh:Number.isFinite(c.cameraLimitKmh)?c.cameraLimitKmh:Number.isFinite(reference)?reference:Number.isFinite(c.limitKmh)?c.limitKmh:c.limit;
    const capture=c.captureDirectionVerified===true?{front:'спереди',rear:'сзади',both:'спереди и сзади'}[c.captureDirection]||'направление неизвестно':'направление неизвестно';
    const coverage=coverageRows(s);
    const providers=db.sourceMetadata&&Array.isArray(db.sourceMetadata.providers)?db.sourceMetadata.providers:[],
        official=providers.find(p=>p.id==='gibdd-official');
    const text = {
        cameraStatus: connected ? (s.enabled ? 'Предупреждения включены' : 'Предупреждения выключены') : 'Сервис недоступен',
        cameraAlert: a ? clean(a.title || TYPES[a.type] || a.type, 'Камера') + ' • ' + distance(a.distanceM===undefined?a.distance:a.distanceM) +
            (a.positionKind === 'intersection' ? ' • до перекрёстка' : a.confidence === 'nearby' ? ' • рядом' : ' • по дороге') + (a.limit ? ' • лимит ' + a.limit : '') :
            s.nearest ? (s.nearest.filterMatched===false?'Ближайшая: ':'')+clean(s.nearest.title || TYPES[s.nearest.type], 'Камера') + ' • ' + distance(s.nearest.distanceM) +
                (s.nearest.filterMatched===false?' • тип отключён':s.nearest.positionKind === 'intersection' ? ' • до перекрёстка' : ' • рядом') : 'Активных предупреждений нет',
        cameraDescription: 'Описание камеры: ' + clean((a || s.nearest || {}).description, 'не указано в базе'),
        cameraDatabase: connected ? db.officialCount?'База: OSM '+((db.osmCount||0)+(db.relationCount||0))+' • ГИБДД '+db.officialCount+' • всего '+count+' записей':
            'База: ' + clean(db.source, 'нет источника') + ' • ' + count + ' объектов' : 'База: ожидание ответа сервиса',
        cameraDate: connected ? official?'Сборка: '+date(db.generatedAt)+' • перечень ГИБДД: '+date(official.publishedAt):
            'Дата базы: ' + date(db.updated || db.generatedAt || db.sourceUpdated) : 'Дата базы: ожидание ответа сервиса',
        cameraGps: 'Положение: ' + clean(s.gps, 'нет подтверждённых координат'),
        cameraMotion:'Скорость: '+(fresh&&Number.isFinite(fix.speedKmh)?fix.speedKmh+' км/ч':'нет свежих данных'),
        cameraStreet:street.name?'Улица: '+clean(street.name,'—')+' • '+clean(street.source,'BMW'):
            'Улица BMW: '+clean(street.reason,'недоступна'),
        cameraCommand:result.message?'Команда: '+clean(result.message,'—'):'Команды: ожидают действия',
        cameraCommandMore:' ',
        cameraLimit:(a&&a.roadConfirmed&&Number.isFinite(a.limitKmh)?'Лимит по дороге: ':'Лимит по базе: ')+(Number.isFinite(limit)?limit+' км/ч':'неизвестен')+
            (a&&a.roadConfirmed?' • дорога подтверждена':' • применимость к дороге не подтверждена'),
        cameraDirection:'Контроль: '+capture,
        cameraFacing:cameraFacing(c),
        cameraCoverage:coverage[0],cameraCoverageLimits:coverage[1],cameraCoverageRoad:coverage[2],cameraCoverageDirection:coverage[3],
        cameraEnable:!connected?'Предупреждения: сервис недоступен':s.enabled?'Выключить предупреждения':'Включить предупреждения',
        cameraCluster: 'Приборная панель: ' + (!(s.capabilities||{}).outputs?'вывод недоступен':outputs.cluster === true ? 'вкл' : 'выкл'),
        cameraHud: 'Проекция HUD: ' + (!(s.capabilities||{}).outputs?'вывод недоступен':outputs.hud === true ? 'вкл' : 'выкл'),
        cameraInfo: s.storage && s.storage.persistent === false ? 'Настройки временные: хранилище недоступно' : update.message?'Проверка базы: '+clean(update.message,'—'):(gpsSummary(s) || 'Калужская область'),
        cameraDiagnostics: 'Диагностика • 6 страниц',
        cameraUpdate:'Проверить базу', cameraRollback:'Вернуть предыдущую базу'
    };
    if (db.error) text.cameraDate += ' • ошибка базы';
    return { text, enabled: {
        cameraEnable: connected,
        cameraCluster: connected && !!(s.capabilities && s.capabilities.outputs),
        cameraHud: connected && !!(s.capabilities && s.capabilities.outputs),
        cameraDiagnostics: true,
        cameraUpdate:true, cameraRollback:true
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
    if (state.gpsInput) {
        const b = state.gpsBridge || {};
        const input = state.gpsInput;
        return gpsSummary(state) + ' • интерфейс: ' + clean(b.state, 'ожидание') +
            (b.errorCode ? ' (' + clean(b.errorCode, '') + ')' : '') +
            (Number.isFinite(input.sourceUtcAgeMs) ? ' • возраст UTC: ' + (input.sourceUtcAgeMs / 1000).toFixed(1) + ' с' : '') +
            ' • ошибок checksum: ' + (Number.isFinite(input.checksumErrors) ? input.checksumErrors : 0) +
            (state.error ? ' • ' + clean(state.error, '') : '');
    }
    const r = state.renderer;
    const rendering = typeof r === 'string' ? r : r ? JSON.stringify(r) : 'состояние неизвестно';
    return 'Вывод: ' + clean(rendering, 'неизвестно') + (state.error ? ' • ' + clean(state.error, '') : '');
}

module.exports = { model, outputCommand, diagnostics, date, distance, ALERT_TYPES, alertPreferences,
    OVERSPEED_RECOMMENDED, overspeedPreferences, coverageRows, cameraFacing };
