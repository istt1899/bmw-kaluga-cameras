'use strict';
const KEYS = ['stamp','versions','service','position','fixUtc','age','accuracy','motion','gnss','bridge','counts','reject','gpsStatus','gpsStatusMore','rejectReason',
    'nearest','type','description','descriptionMore','limit','mode','reason','way','samples','alert','outputs','map','hud','test','dimmer','database','error','errorMore'];
const REASONS = { WAITING_GPS:'Ожидание GPS', GPS_INVALID:'Нет свежей точной позиции', DISABLED:'Предупреждения выключены', GPS_REPLAY:'UTC пришёл в обратном порядке',
    WAITING_MOTION:'Ожидание движения', WAITING_APPROACH:'Нужны две позиции подъезда', NO_ROAD_ZONE:'Для объекта нет дорожной зоны',
    OUT_OF_RANGE:'Вне дистанции предупреждения', OFF_ROAD:'Позиция вне дорожного коридора', CAMERA_WAY_MISSING:'Ближайшая дорога не связана с камерой',
    AMBIGUOUS_ROAD:'Несколько возможных дорог', ONEWAY_MISMATCH:'Против направления дороги', HEADING_MISMATCH:'Курс не совпадает с дорогой',
    CAMERA_DIRECTION:'Направление камеры не совпало', ROAD_APPROACH:'Подъезд по дороге подтверждён', STOPPED_APPROACH:'Подъезд сохранён на остановке', NEARBY_ONLY:'Камера рядом; дорога не подтверждена' };
const TYPES = {speed:'Контроль скорости',redlight:'Контроль светофора',average:'Средняя скорость'};
const clean = v => v === null || v === undefined || v === '' ? '—' : String(v).replace(/[\r\n\t]/g,' ');
const n = (v, digits) => Number.isFinite(v) ? v.toFixed(digits === undefined ? 1 : digits) : '—';
const utc = v => Number.isFinite(v) ? new Date(v).toISOString() : '—';
function values(state, version, frozen) {
    const s = state || {}, f = s.gpsFix || {}, input = s.gpsInput || {}, kinds = input.sentences || {}, b = s.gpsBridge || {};
    const g = s.guidance || {}, a = s.alert, c = a || s.nearest || {}, r = s.rendererDetails || {}, o = s.outputs || {};
    const now = s.observedAtMs, error = clean(s.controlError || s.error), on = x => x ? 'вкл' : 'выкл';
    const layer = key => r[key] ? clean(r[key].state) + (r[key].target ? ' / '+clean(r[key].target) : '') +
        (r[key].reason || r[key].targetReason ? ' • ' + clean(r[key].reason || r[key].targetReason) : '') : clean(s.renderer);
    const text = {
        stamp: (frozen ? 'Снимок зафиксирован: ' : 'Живые данные: ') + utc(now),
        versions:'Приложение ' + version + ' • сервис ' + clean(s.serviceVersion),
        service:'Сервис: ' + (state ? 'отвечает' : 'нет связи') + ' • предупреждения ' + on(s.enabled),
        position:'Широта ' + n(f.lat,6) + ' • долгота ' + n(f.lon,6), fixUtc:'UTC позиции: ' + utc(f.timeMs),
        age:'Возраст позиции ' + n(Number.isFinite(now) && Number.isFinite(f.timeMs) ? (now-f.timeMs)/1000 : null,2) + ' с • пакета ' + n(Number.isFinite(input.lastPacketAgeMs)?input.lastPacketAgeMs/1000:null,2) + ' с',
        accuracy:'Оценка точности: ' + n(f.accuracyM) + ' м • ' + clean(f.source),
        motion:'Скорость ' + n(f.speedKmh) + ' км/ч • курс ' + n(f.headingDeg) + '°',
        gnss:'GGA ' + clean(f.quality) + ' • спутники ' + clean(f.satellites) + ' • HDOP ' + n(f.hdop,2),
        bridge:'GPS-интерфейс: ' + clean(b.state) + (b.errorCode ? ' • '+clean(b.errorCode) : ''),
        counts:'RMC ' + clean(kinds.RMC) + ' • GGA ' + clean(kinds.GGA) + ' • GST ' + clean(kinds.GST),
        reject:'Ошибки checksum ' + clean(input.checksumErrors) + ' • пакетов ' + clean(input.badPackets),
        gpsStatus:'GPS: ' + clean(s.gps).slice(0,60), gpsStatusMore:clean(s.gps).length>60?'GPS далее: '+clean(s.gps).slice(60,120):'GPS далее: —',
        rejectReason:'Отброшен GPS: '+clean(input.rejectReason),
        nearest:'Объект: ' + clean(c.id) + ' • ' + n(c.distanceM === undefined ? c.distance : c.distanceM,0) + ' м',
        type:'Тип: ' + clean(c.title || TYPES[c.type]), description:'Описание OSM: ' + clean(c.description).slice(0,50),
        descriptionMore:clean(c.description).length>50?'Описание далее: '+clean(c.description).slice(50,100):'Описание далее: —',
        limit:'Лимит объекта: ' + n(c.cameraLimitKmh === undefined ? (c.limitKmh === undefined ? c.limit : c.limitKmh) : c.cameraLimitKmh,0) + ' км/ч',
        mode:'Режим: ' + clean(g.mode) + ' • UTC NMEA: ' + n(Number.isFinite(input.sourceUtcAgeMs)?input.sourceUtcAgeMs/1000:null,2) + ' с',
        reason:'Дорожный фильтр: ' + clean(REASONS[g.roadReason || g.reason] || g.roadReason || g.reason),
        way:'Дорога OSM: ' + clean(g.way) + ' • отклонение ' + n(g.lateralErrorM) + ' м',
        samples:'Подъезд: ' + clean(g.approachSamples) + ' позиции • зоны ' + clean(g.zoneCount) + '/' + clean(g.cameraCount),
        alert:'Уведомление: ' + (a ? clean(a.title) + ' • ' + clean(a.confidence) : 'нет активного'),
        outputs:'Выходы: приборы ' + on(o.cluster) + ' • HUD ' + on(o.hud), map:'Приборы: '+layer('map'), hud:'HUD: '+layer('hud'),
        test:'Тест вывода: ' + (s.displayTest && s.displayTest.active ? 'идёт • ТЕСТ на 5 секунд' : 'не запущен'),
        dimmer:'Прозрачность карты: ' + n(Number.isFinite(s.hudOpacityPct)?100-s.hudOpacityPct:null,0) + ' %',
        database:'База: ' + clean((s.database||{}).source) + ' • ' + clean((s.database||{}).count) + ' объектов',
        error:'Ошибка: ' + error.slice(0,60), errorMore:error.length>60?'Продолжение: '+error.slice(60,120):'Продолжение ошибки: —'
    };
    return text;
}
module.exports = { KEYS, values, REASONS };
