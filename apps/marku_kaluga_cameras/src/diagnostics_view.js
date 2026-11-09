'use strict';
const cameraView = require('./view_model.js');
const KEYS = ['stamp','versions','service','health','nmeaPair','nmeaRmc','nmeaGga','nmeaGst','nmeaRmcGga','nmeaGgaGst',
    'position','fixUtc','age','accuracy','motion','gnss','bridge','counts','reject','gpsStatus','gpsStatusMore','rejectReason',
    'nearest','type','description','descriptionMore','limit','mode','reason','way','samples','alert','outputs','map','hud','test','dimmer','database','error','errorMore'];
const REASONS = { WAITING_GPS:'Ожидание GPS', GPS_INVALID:'Нет свежей точной позиции', DISABLED:'Предупреждения выключены', GPS_REPLAY:'UTC пришёл в обратном порядке',
    WAITING_MOTION:'Ожидание движения', WAITING_APPROACH:'Нужны две позиции подъезда', NO_ROAD_ZONE:'Для объекта нет дорожной зоны',
    OUT_OF_RANGE:'Вне дистанции предупреждения', OFF_ROAD:'Позиция вне дорожного коридора', CAMERA_WAY_MISSING:'Ближайшая дорога не связана с камерой',
    AMBIGUOUS_ROAD:'Несколько возможных дорог', ONEWAY_MISMATCH:'Против направления дороги', HEADING_MISMATCH:'Курс не совпадает с дорогой',
    CAMERA_DIRECTION:'Направление камеры не совпало', ROAD_APPROACH:'Подъезд по дороге подтверждён', STOPPED_APPROACH:'Подъезд сохранён на остановке', NEARBY_ONLY:'Камера рядом; дорога не подтверждена',
    TRACKING_APPROACH:'Подтверждённый подъезд сопровождается', NEARBY_TRACKING:'Сопровождение камеры рядом; дорога не подтверждена',
    TYPE_FILTERED:'Тип камеры выключен в настройках', TYPE_DISABLED:'Тип камеры выключен в настройках', ALL_TYPES_DISABLED:'Все типы камер выключены',
    CAMERA_PASSED:'Камера пройдена', ROAD_CHANGED:'Выбрана другая дорога', APPROACH_LOST:'Подъезд больше не подтверждается',
    POSITION_JUMP:'Скачок расстояния несовместим с движением', BEARING_CHANGED:'Направление на камеру изменилось' };
const TYPES = {speed:'Контроль скорости',redlight:'Контроль светофора',average:'Средняя скорость'};
const clean = v => v === null || v === undefined || v === '' ? '—' : String(v).replace(/[\r\n\t]/g,' ');
const n = (v, digits) => Number.isFinite(v) ? v.toFixed(digits === undefined ? 1 : digits) : '—';
const utc = v => Number.isFinite(v) ? new Date(v).toISOString() : '—';
function values(state, version, frozen) {
    const s = state || {}, f = s.gpsFix || {}, input = s.gpsInput || {}, timing = input.nmeaTiming || {}, kinds = input.sentences || {}, b = s.gpsBridge || {};
    const g = s.guidance || {}, a = s.alert, c = a || s.nearest || {}, r = s.rendererDetails || {}, o = s.outputs || {};
    const now = s.observedAtMs, error = clean(s.controlError || s.error), on = x => x ? 'вкл' : 'выкл';
    const layer = key => r[key] ? clean(r[key].state) + (r[key].target ? ' / '+clean(r[key].target) : '') +
        (r[key].reason || r[key].targetReason ? ' • ' + clean(r[key].reason || r[key].targetReason) : '') : clean(s.renderer);
    const text = {
        stamp: (frozen ? 'Снимок зафиксирован: ' : 'Живые данные: ') + utc(now),
        versions:'Приложение ' + version + ' • сервис ' + clean(s.serviceVersion),
        service:'Сервис: ' + (state ? 'отвечает' : 'нет связи') + ' • предупреждения ' + on(s.enabled),
        health:'GPS: ' + (Number.isFinite(f.lat) && Number.isFinite(f.lon) ? 'позиция принята' : 'нет позиции') +
            ' • ' + clean(timing.pairReason),
        nmeaPair:'Сопряжение NMEA: ' + clean(timing.pairReason),
        nmeaRmc:'RMC UTC ' + clean(timing.rmcTime) + ' • возраст ' + n(Number.isFinite(timing.lastRmcAgeMs)?timing.lastRmcAgeMs/1000:null,2) + ' с',
        nmeaGga:'GGA UTC ' + clean(timing.ggaTime) + ' • возраст ' + n(Number.isFinite(timing.lastGgaAgeMs)?timing.lastGgaAgeMs/1000:null,2) + ' с',
        nmeaGst:'GST UTC ' + clean(timing.gstTime) + ' • возраст ' + n(Number.isFinite(timing.lastGstAgeMs)?timing.lastGstAgeMs/1000:null,2) + ' с',
        nmeaRmcGga:'Разница UTC (GGA − RMC): ' + n(timing.rmcGgaDeltaMs,0) + ' мс',
        nmeaGgaGst:'Разница UTC (GST − GGA): ' + n(timing.ggaGstDeltaMs,0) + ' мс',
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
        type:'Тип: ' + clean(c.title || TYPES[c.type]), description:(c.provenance === 'owner-report' ? 'Сообщение владельца: ' : 'Описание OSM: ') + clean(c.description).slice(0,50),
        descriptionMore:clean(c.description).length>50?'Описание далее: '+clean(c.description).slice(50,100):'Описание далее: —',
        limit:'Лимит объекта: ' + n(c.cameraLimitKmh === undefined ? (c.limitKmh === undefined ? c.limit : c.limitKmh) : c.cameraLimitKmh,0) + ' км/ч',
        mode:'Режим: ' + (c.positionKind === 'intersection' ? 'ориентир перекрёстка' : clean(g.mode)) + ' • UTC NMEA: ' + n(Number.isFinite(input.sourceUtcAgeMs)?input.sourceUtcAgeMs/1000:null,2) + ' с',
        reason:'Дорожный фильтр: ' + clean(REASONS[g.roadReason || g.reason] || g.roadReason || g.reason),
        way:'Дорога OSM: ' + clean(g.way) + ' • отклонение ' + n(g.lateralErrorM) + ' м',
        samples:'Подъезд: ' + clean(g.approachSamples) + ' позиции • зоны ' + clean(g.zoneCount) + '/' + clean(g.cameraCount),
        alert:'Уведомление: ' + (a ? clean(a.title) + ' • ' + clean(a.confidence) : 'нет активного'),
        outputs:'Выходы: приборы ' + on(o.cluster) + ' • HUD ' + on(o.hud), map:'Приборы: '+layer('map'), hud:'HUD: '+layer('hud'),
        test:'Тест вывода: ' + (s.displayTest && s.displayTest.active ? s.displayTest.pinned?
            'закреплён • '+(s.displayTest.target==='hud'?'HUD':s.displayTest.target==='map'?'приборы':'цель неизвестна'):
            'идёт • ТЕСТ на 5 секунд' : 'не запущен'),
        dimmer:'Прозрачность карты: ' + n(Number.isFinite(s.hudOpacityPct)?100-s.hudOpacityPct:null,0) + ' %',
        database:'База: ' + clean((s.database||{}).source) + ' • ' + clean((s.database||{}).count) + ' объектов',
        error:'Ошибка: ' + error.slice(0,60), errorMore:error.length>60?'Продолжение: '+error.slice(60,120):'Продолжение ошибки: —'
    };
    return text;
}
const PAGE_TITLES = ['Сводка','GPS','Камера','Вывод','Размеры','База'];
const PAGE_ROWS = 10, ROW_CHARS = 66;
const PAGE_KEYS = ['stamp','versions','page','command','commandMore'].concat(Array.from({length:PAGE_ROWS},(_,i)=>'row'+(i+1)));
let snapshotSequence = 0;
function capture(state, version, now) {
    const at = Number.isFinite(now) ? now : Date.now();
    const captured=JSON.parse(JSON.stringify(state||{}));
    if(!captured.appClock){
        const wallMs=Date.now();captured.appClock={wallMs,wallUtc:utc(wallMs),clockDiscontinuity:null,lastRollback:null};
    }
    // Only the service's public state is captured, never a transport/client or SDK object.
    return {schema:1,id:'S'+at.toString(36).toUpperCase()+'-'+(++snapshotSequence),capturedAtMs:at,
        appVersion:version,state:captured};
}
function clockRows(state) {
    const s=state||{},clock=s.clock||{},app=s.appClock||{},fix=s.gpsFix||{},input=s.gpsInput||{};
    const motionUtc=Number.isFinite(fix.motionTimeMs)?fix.motionTimeMs:fix.timeMs;
    const motionAge=Number.isFinite(clock.serviceWallMs)&&Number.isFinite(motionUtc)?clock.serviceWallMs-motionUtc:null;
    const ms=value=>Number.isFinite(value)?(value>0?'+':'')+value+' мс':'неизвестно';
    const flag=value=>value===true?'да':value===false?'нет':'неизвестно';
    const knownUtc=(text,value)=>typeof text==='string'&&text?text:Number.isFinite(value)?utc(value):'неизвестно';
    return ['Отказ/статус: '+clean(action(s,'displayTest').code)+' • часы '+clean(clock.issue),
        'Часы приложения: '+knownUtc(app.wallUtc,app.wallMs),
        'Часы сервиса: '+knownUtc(clock.serviceWallUtc,clock.serviceWallMs),
        'Полный RMC UTC BMW: '+knownUtc(clock.sourceUtc,clock.sourceUtcMs),
        'Δ сервис − RMC: '+ms(clock.sourceDeltaMs),
        'Ручной cutoff UTC: '+knownUtc(clock.admissionAfterUtc,clock.admissionAfterUtcMs),
        'Пакет: возраст '+(Number.isFinite(clock.lastPacketAgeMs)?clock.lastPacketAgeMs+' мс':'неизвестно')+
            ' • receipt Δ '+ms(clock.packetReceiptDeltaMs),
        'Разрыв часов приёма: '+flag(clock.receiptClockDiscontinuity),
        'Скорость: '+clean(fix.speedKmh)+' км/ч • возраст '+(Number.isFinite(motionAge)&&motionAge>=0?motionAge+' мс':'неизвестно'),
        'Сброс GPS: '+clean((s.gpsReset||{}).phase),
        'Причина часов: '+clean(clock.reason),
        'Причина теста: '+clean(action(s,'displayTest').reason),
        'Отказ GPS: '+clean(input.rejectReason),
        'Откат часов приложения замечен: '+flag(app.clockDiscontinuity),
        'При расхождении проверьте дату BMW; после исправления явно сбросьте историю GPS и дождитесь свежей серии',
        'Тест: скорость не выше 1 км/ч, свежесть 3 с, будущее до +500 мс; точность 15 м нужна дорожным предупреждениям',
        'Приложение не устанавливает, какие часы истинные'];
}
function parts(text) {
    let remaining = clean(text), rows = [];
    while (remaining.length > ROW_CHARS) {
        let cut = remaining.lastIndexOf(' ',ROW_CHARS);
        if (cut < Math.floor(ROW_CHARS/2)) cut = ROW_CHARS;
        rows.push(remaining.slice(0,cut)); remaining = remaining.slice(cut).trim();
    }
    rows.push(remaining); return rows;
}
function action(state, name) {
    const s=state||{}, a=s.actions&&s.actions[name];
    if (!state) return {allowed:false,code:'SERVICE_UNAVAILABLE',reason:'Сервис недоступен'};
    return a && typeof a.allowed === 'boolean' ? a : {allowed:false,code:'ACTION_UNAVAILABLE',reason:'Сервис не подтвердил доступность действия'};
}
function commandText(state, local) {
    if (local) return local;
    const s=state||{}, c=s.commandResult;
    if(s.controlError) return 'Ошибка команды: '+clean(s.controlError);
    return c ? clean(c.message || c.phase || c.command) : 'Команды: ожидают действия';
}
function commandPage(state, local, blockIndex) {
    const text=commandText(state,local), lines=parts(text), blocks=Math.max(1,Math.ceil(lines.length/2));
    const block=Math.max(0,Math.min(blocks-1,blockIndex||0)), start=block*2;
    return {text,block,blocks,command:lines[start],commandMore:lines[start+1]||' ',
        label:blocks>1?'Результат • строки '+(start+1)+'–'+Math.min(lines.length,start+2)+'/'+lines.length+' • далее →':'Результат • показан полностью'};
}
function reportPage(report, live, version, pageIndex, blockIndex, localResult, commandBlockIndex) {
    const snap=report||capture(live,version,((live||{}).appClock||{}).wallMs), s=snap.state||{}, frozen=!!report;
    const p=Math.max(0,Math.min(5,pageIndex||0)), f=s.gpsFix||{}, input=s.gpsInput||{}, timing=input.nmeaTiming||{};
    const g=s.guidance||{}, c=s.alert||s.nearest||{}, db=s.database||{}, update=s.databaseUpdate||{},
        recovery=update.recovery||{}, durability=update.durability||{}, r=s.rendererDetails||{}, layout=r.layout||r.geometry||{};
    const existing=values(s,snap.appVersion||version,frozen), on=v=>v?'вкл':'выкл';
    const measurement=(v,unit)=>Number.isFinite(v)?n(v,0)+(unit||''):'неизвестно';
    const renderTarget=name=>{
        const t=r[name]||{}; return (name==='map'?'Приборы':'HUD')+': '+clean(t.state||s.renderer)+
            ' • цель '+clean(t.target)+' • '+clean(t.reason||t.targetReason||'нет причины отказа');
    };
    const rawTargets=layout.targets||r.targets||{};
    const targetLayout=name=>(r[name]||{}).layout||{};
    const targetRow=name=>{
        const target=Array.isArray(rawTargets)?rawTargets.find(t=>t.name===name||t.id===name):rawTargets[name];
        const own=targetLayout(name), t=target||{}, size=own.canvas||t.size||t.viewport||t;
        return name+': '+measurement(size.w===undefined?size.width:size.w)+'×'+measurement(size.h===undefined?size.height:size.h)+
            ' • safe area '+clean(own.safeArea&&own.safeArea.known?JSON.stringify(own.safeArea):'не подтверждена');
    };
    const rectRow=name=>{
        const t=r[name]||{}, rect=targetLayout(name).card||t.rect||t.rectangle||(layout.layers||{})[name]||{};
        return (name==='map'?'Приборы':'HUD')+' x/y '+measurement(rect.x)+'/'+measurement(rect.y)+
            ' • w/h '+measurement(rect.w===undefined?rect.width:rect.w)+'/'+measurement(rect.h===undefined?rect.height:rect.h);
    };
    const layoutRow=name=>{
        const own=targetLayout(name), card=own.card||{};
        return name+': масштаб '+n(card.scale,3)+' • границы '+(own.withinBounds===true?'в пределах':own.withinBounds===false?'выход за экран':'не проверены')+
            ' • профиль '+clean(own.profile)+' • backend '+clean(own.backend);
    };
    const cardProfile=name=>{
        const profile=(s.cardLayout||{})[name]||{};
        return (name==='map'?'Приборы':'HUD')+' профиль: X/Y '+n(profile.x,0)+'/'+n(profile.y,0)+
            ' • размер '+n(profile.scalePct,0)+' % • яркость '+n(profile.brightnessPct,0)+' % • прозрачность '+
            n(Number.isFinite(profile.opacityPct)?100-profile.opacityPct:null,0)+' %';
    };
    const candidates=Array.isArray(s.nearestCandidates)?s.nearestCandidates:[];
    const prefs=cameraView.alertPreferences(s);
    const preferenceSummary=prefs.available?'Настроенная дистанция: '+prefs.warningDistanceM+' м • типы '+prefs.enabledCount+'/'+cameraView.ALERT_TYPES.length:
        'Настройки предупреждений: '+prefs.reason;
    const preferenceRows=cameraView.ALERT_TYPES.map(type=>type.label+': '+(prefs.available?on(prefs.cameraTypes[type.key]):'нет подтверждённых данных'));
    const overspeed=cameraView.overspeedPreferences(s), warning=s.speedWarning||{};
    const overspeedSummary=overspeed.available?'Превышение: мигание '+on(overspeed.visualFlash)+' +'+overspeed.visualOffsetKmh+
        ' км/ч • звук выбран '+on(overspeed.soundEnabled)+' +'+overspeed.soundOffsetKmh+' км/ч':'Превышение: '+overspeed.reason;
    const warningSummary='Политика превышения: '+(typeof warning.eligible==='boolean'?(warning.eligible?'доступна':'недоступна'):'не подтверждена')+' • '+clean(warning.reason||warning.code);
    const transition=g.transition||{};
    const pages=[
        [existing.service,existing.health,'GPS: '+clean(s.gps),existing.outputs,existing.alert,preferenceSummary,
            overspeedSummary,warningSummary,
            prefs.available&&prefs.enabledCount===0?'Все типы выключены — реальных предупреждений не будет':'Фильтр комплекса: достаточно любого включённого типа',
            'Тест: '+clean(action(s,'displayTest').reason||'доступен'),
            'Улица '+clean((s.street||{}).name)+' • '+clean((s.street||{}).source||'BMW')+' • '+clean((s.street||{}).reason),
            existing.database,'База: '+clean((s.databaseUpdate||{}).message|| (s.databaseUpdate||{}).phase),'Ошибка: '+clean(s.controlError||s.error)],
        clockRows(s).concat([existing.position,existing.fixUtc,existing.age,existing.accuracy,existing.motion,existing.gnss,
            'RMC UTC '+clean(timing.rmcTime)+' • возраст '+n(timing.lastRmcAgeMs,0)+' мс',
            'GGA UTC '+clean(timing.ggaTime)+' • возраст '+n(timing.lastGgaAgeMs,0)+' мс',
            'GST UTC '+clean(timing.gstTime)+' • возраст '+n(timing.lastGstAgeMs,0)+' мс',
            existing.nmeaRmcGga,existing.nmeaGgaGst,existing.nmeaPair,existing.counts,existing.reject,
            existing.bridge,'GPS: '+clean(s.gps),existing.rejectReason,
            'Точная скорость GPS: '+clean(f.speedKmh)+' км/ч',
            'Ручной сброс GPS: '+JSON.stringify(s.gpsReset||null),
            'После сброса история не используется; ожидаются новые пригодные координаты']),
        ['Объект: '+clean(c.id), 'Расстояние: '+n(c.distanceM===undefined?c.distance:c.distanceM,0)+' м • '+clean(c.positionKind),
            'Совпадение с выбранными типами: '+(typeof c.filterMatched==='boolean'?(c.filterMatched?'да':'нет'):'не сообщается'),
            'Источник: '+clean(c.provenance||c.source)+' • '+clean(c.sourceUrl||c.positionSourceUrl),
            'Типы: '+clean(Array.isArray(c.controlLabels)&&c.controlLabels.length?c.controlLabels.join(', '):Array.isArray(c.controls)&&c.controls.length?c.controls.join(', '):c.title||c.type||'тип не подтверждён'),
            'Область сведений: '+(c.controlScope==='enforcement-location'?'официальный рубеж; не параметры отдельного устройства':'объект карты'),
            'Официальный источник: '+clean(c.officialSourceUrl)+' • строка '+clean(c.sourceRow)+' • дата '+clean(c.sourcePublishedAt),
            'Условия из перечня: '+clean(c.operatingConditions), 'Нарушения из перечня: '+clean(c.rawControls),
            'Не классифицировано: '+clean(c.unmappedControls),
            'Описание: '+clean(c.description),existing.limit,
            'Справочный лимит: '+n((c.limitReference||{}).valueKmh,0)+' км/ч • '+clean((c.limitReference||{}).state)+' • '+clean((c.limitReference||{}).kind),
            'Лимит по подтверждённой дороге: '+n(c.roadConfirmed?c.limitKmh:null,0)+' км/ч',
            'Основание лимита: '+clean((c.speedLimitEvidence||{}).kind)+' • OSM '+clean((c.speedLimitEvidence||{}).sourceTimestamp),
            'Исходные ограничения: '+(Array.isArray((c.speedLimitEvidence||{}).sources)?c.speedLimitEvidence.sources.map(f=>clean(f.sourceUrl)+' • '+JSON.stringify(f.tags)).join('; '):'—'),
            'Источники справочного лимита: '+(Array.isArray((c.limitReference||{}).records)?c.limitReference.records.map(e=>clean(e.id)+' = '+n(e.valueKmh,0)+' • '+clean(e.url)).join('; '):'—'),
            'Контроль: '+clean(c.captureDirectionVerified?{front:'спереди',rear:'сзади',both:'спереди и сзади'}[c.captureDirection]||'направление неизвестно':'направление неизвестно')+' • источник '+clean(c.captureDirectionSource),
            cameraView.cameraFacing(c),
            'Ориентация объектива — полные данные: '+JSON.stringify(c.cameraFacing||null),
            existing.mode,existing.reason,existing.way,existing.samples,
            'Переход: '+clean(transition.from)+' → '+clean(transition.to)+' • '+clean(transition.reason),
            'Объект перехода: '+clean(transition.cameraId)+' • UTC '+utc(transition.timeMs),
            'Переход — полные данные: '+JSON.stringify(g.transition||null),
            'Причина GPS: '+clean(g.gpsReason),
            'Последнее снятие предупреждения: '+JSON.stringify(g.lastClear||null),
            preferenceSummary,overspeedSummary,warningSummary,
            'Настройки превышения — полные данные: '+JSON.stringify(s.overspeedPreferences||null),
            'Точная скорость: '+clean(f.speedKmh)+' км/ч',
            'Превышение — полные данные: '+JSON.stringify(s.speedWarning||null)].concat(preferenceRows,candidates.map((v,i)=>
                'Кандидат '+(i+1)+': '+clean(v.id)+' • '+n(v.distanceM,0)+' м • '+clean(v.reason)+
                    ' • фильтр '+(typeof v.filterMatched==='boolean'?(v.filterMatched?'да':'нет'):'не сообщается'))),
        [existing.outputs,renderTarget('map'),renderTarget('hud'),
            'Renderer: '+(r.versionReported===false?'версия renderer не сообщается протоколом':
                layout.rendererVersion||r.version?'версия '+clean(layout.rendererVersion||r.version):'версия renderer не сообщается протоколом'),
            'Соединение renderer: '+clean(r.connection||layout.connection||'неизвестно')+
                ' • backend '+clean(r.backend)+' • протокол '+clean(r.protocol),
            'Держатель приборов: '+clean((r.map||{}).holder), 'Держатель HUD: '+clean((r.hud||{}).holder),
            existing.test,'Тест изображения: '+clean(action(s,'displayTest').reason||'доступен'),
            'Калибровка: '+clean(action(s,'calibrationTest').reason||'доступна'),
            'Звук: '+((s.audio||{}).available?'доступен':'недоступен')+' • '+clean((s.audio||{}).reason),
            'Звук — полные данные и последний исход: '+JSON.stringify(s.audio||null),
            'Слышимость и физическое отображение в автомобиле не подтверждены программным статусом',
            'Последняя команда: '+commandText(s), 'Ошибка: '+clean(s.controlError||s.error)],
        ['Геометрия целей: приборы '+(targetLayout('map').canvas?'получена':'неизвестна')+' • HUD '+(targetLayout('hud').canvas?'получена':'неизвестна'),
            targetRow('map'),targetRow('panel'),targetRow('hud'),rectRow('map'),rectRow('hud'),layoutRow('map'),layoutRow('hud'),
            cardProfile('map'),cardProfile('hud'),
            existing.dimmer,'Калибровка: '+clean(layout.calibration||layout.calibrationState||'не подтверждена'),
             'Размеры viewport логические; физический размер экрана не измерен',
            'Удержание контроллера: '+clean(((s.calibrationInput||{}).controller||{}).state)+' • '+clean(((s.calibrationInput||{}).controller||{}).reason),
            'Источник ввода: '+clean(((s.calibrationInput||{}).controller||{}).input)+' • PB '+clean(((s.calibrationInput||{}).controller||{}).button)+' • ошибка '+clean(((s.calibrationInput||{}).controller||{}).errorCode),
            'Фокус стрелки: '+clean((s.calibrationInput||{}).focusedDirection)+' • повтор '+clean(((s.calibrationInput||{}).repeat||{}).active)+' • стоп '+clean((s.calibrationInput||{}).stopReason),
            'Удержание сенсорной стрелки: контракт отпускания не подтверждён; доступны ползунки X/Y',
            'Последние события стрелок: '+JSON.stringify((s.calibrationInput||{}).events||[])],
        [existing.database,'Версия: '+clean(db.version)+' • регион '+clean(db.region)].concat(cameraView.coverageRows(s),[
            'Покрытие — полные данные: '+JSON.stringify(db.coverage||null),
            'Сборка источников: '+clean((s.sourceAssembly||{}).state)+' • выбрана '+clean((s.sourceAssembly||{}).selectedVersion)+' • нужна '+clean((s.sourceAssembly||{}).wantedVersion),
            'Ошибка сборки источников: '+clean((s.sourceAssembly||{}).errorCode)+' • '+clean((s.sourceAssembly||{}).reason),
            'UTC базы: '+clean(db.updated||db.generatedAt||db.sourceTimestamp),
            'Хеш: '+clean(db.sha256||db.digest||db.pbfMd5),
            'OSM '+clean(db.osmCount)+' • сообщения владельца '+clean(db.reportedCount)+' • отношения '+clean(db.relationCount)+' • ГИБДД '+clean(db.officialCount),
            'Количество — записи источников, не число физических камер; совпадения автоматически не склеиваются',
            'Лимиты: известно '+clean((db.speedLimitCoverage||{}).known)+' из '+clean((db.speedLimitCoverage||{}).total)+' • неизвестно '+clean((db.speedLimitCoverage||{}).unknown),
            'Дополненные лимиты: '+JSON.stringify((db.speedLimitMetadata||{}).counts||{})+' • источник '+clean((db.speedLimitMetadata||{}).sourceTimestamp),
            'Проверка: '+clean((s.databaseUpdate||{}).phase)+' • '+clean((s.databaseUpdate||{}).message),
            'Источник обновления: '+clean((s.databaseUpdate||{}).source||(s.databaseUpdate||{}).url),
            'Предыдущая база: '+clean(db.previousVersion||(s.databaseUpdate||{}).previousVersion),
            'Восстановление базы: '+clean(recovery.source||recovery.mode||update.phase)+' • причина '+clean(recovery.reasonCode),
            'До восстановления: '+clean(recovery.originalVersion)+' • загружена '+clean(recovery.recoveredVersion),
            'База нового пакета: '+clean(update.bundledUpgrade&&update.bundledUpgrade.phase)+' • '+
                clean(update.bundledUpgrade&&update.bundledUpgrade.fromVersion)+' → '+clean(update.bundledUpgrade&&update.bundledUpgrade.toVersion),
            'Закреплённый откат: '+clean(update.rollbackPin&&update.rollbackPin.state)+' • версия '+clean(update.rollbackPin&&update.rollbackPin.pinnedVersion)+
                ' • ошибка '+clean(update.rollbackPin&&update.rollbackPin.errorCode),
            'Сохранность записи: '+clean(durability.mode)+' • каталог '+
                (durability.directorySynced===true?'синхронизирован':durability.directorySynced===false?'не синхронизирован':'не проверен')+
                ' • '+clean(durability.reasonCode),
            'Пропущено: '+clean(db.skippedCount)+' • '+clean(db.coverageReason),
            'Экспорт JSON — отдельное действие; данные GPS не отправляются автоматически']).concat(
                db.sourceMetadata&&Array.isArray(db.sourceMetadata.providers)?db.sourceMetadata.providers.reduce((rows,provider)=>rows.concat([
                    'Поставщик: '+clean(provider.title||provider.id)+' • дата публикации '+clean(provider.publishedAt),
                    'Позиции источника: '+clean(provider.positionRecords)+' • включено '+clean(provider.acceptedPositionRecords)+' • строк с ошибками '+clean(provider.rejectedRows),
                    'Маршрутов парковочных патрулей вне стационарных предупреждений: '+clean(provider.mobileRoutesExcluded),
                    'Отложено геопроверкой: '+clean(provider.qualityExclusions&&provider.qualityExclusions.length)+' • '+clean(provider.countUnit),
                    'Ссылка поставщика: '+clean(provider.sourceUrl)+' • SHA исходника '+clean(provider.sourceSha256||provider.pbfMd5)
                ]),[]):[])
    ];
    const lines=[]; pages[p].forEach(line=>parts(line).forEach(row=>lines.push(row)));
    const blocks=Math.max(1,Math.ceil(lines.length/PAGE_ROWS)), block=Math.max(0,Math.min(blocks-1,blockIndex||0));
    const result=commandPage(live,localResult,commandBlockIndex);
    const rows={stamp:(frozen?'Снимок ':'Живые ')+snap.id+' • '+utc(snap.capturedAtMs),
        versions:'Приложение '+clean(snap.appVersion||version)+' • сервис '+clean(s.serviceVersion),
        page:PAGE_TITLES[p]+' '+(p+1)+'/6 • строки '+(block*PAGE_ROWS+1)+'–'+Math.min(lines.length,(block+1)*PAGE_ROWS)+'/'+lines.length,
        command:result.command,commandMore:result.commandMore};
    for(let i=0;i<PAGE_ROWS;i++) rows['row'+(i+1)]=lines[block*PAGE_ROWS+i]||' ';
    return {rows,page:p,block,blocks,title:PAGE_TITLES[p],report:snap,command:result};
}
module.exports = { KEYS, values, REASONS, PAGE_KEYS, PAGE_TITLES, PAGE_ROWS, capture, reportPage, action, commandText, commandPage, clockRows, commandLines:parts };
