'use strict';
// One server-owned policy for the UI and command handler. Position accuracy is
// relevant to road matching, not to a stationary renderer check.
function stationary(fix, now) {
    const time = fix && (Number.isFinite(fix.motionTimeMs) ? fix.motionTimeMs : fix.timeMs);
    if (!fix || !Number.isFinite(time) || now - time > 3000 || time > now + 500 ||
        !Number.isFinite(fix.speedKmh) || fix.speedKmh < 0)
        return { allowed: false, code: 'STATIONARY_UNKNOWN', reason: 'Для теста остановитесь и дождитесь свежего измерения скорости' };
    if (fix.speedKmh > 1) return { allowed: false, code: 'MOVING', reason: 'Для теста остановитесь: скорость ' + fix.speedKmh.toFixed(1) + ' км/ч' };
    return { allowed: true, code: 'READY', reason: 'Свежая скорость не выше 1 км/ч' };
}
function policies(state, fix, now) {
    const stop = stationary(fix, now), caps = state.capabilities || {}, outputs = state.outputs || {};
    const no = (code, reason) => ({ allowed: false, code, reason });
    const test = !caps.displayTest ? no('DISPLAY_UNAVAILABLE', 'Вывод уведомлений недоступен') :
        !stop.allowed ? stop : !outputs.cluster && !outputs.hud ? no('OUTPUTS_OFF', 'Для теста включите приборы или HUD') : stop;
    const update = state.databaseUpdate || {};
    const check = !caps.update ? no('UPDATE_UNAVAILABLE', 'Обновление базы недоступно') : update.busy ? no('UPDATE_BUSY', 'Проверка базы уже выполняется') :
        state.storage && !state.storage.persistent ? no('STORAGE_UNAVAILABLE', 'Хранилище недоступно; новая база не может быть сохранена') : { allowed: true, code: 'READY', reason: 'Проверить опубликованный источник базы' };
    const move = !stop.allowed ? stop : !state.displayTest || !state.displayTest.active ? no('PREVIEW_REQUIRED', 'Для перемещения включите тест выбранного экрана') :
        !state.rendererDetails || state.rendererDetails.connection !== 'ready' ? no('RENDERER_NOT_READY', 'Дождитесь подключения выбранного экрана') : stop;
    return { displayTest: test, calibrationTest: test, cardLayout: stop, cardMove: move,
        displayTestStop: { allowed: true, code: 'READY', reason: 'Скрыть тест и сохранить настройки' },
        audioTest: state.audio && state.audio.available ? stop : no('AUDIO_UNAVAILABLE', state.audio && state.audio.reason || 'Безопасный канал звуковых уведомлений не подтверждён'),
        databaseCheck: check,
        databaseRollback: check.allowed && update.canRollback ? { allowed: true, code: 'READY', reason: 'Вернуть предыдущую проверенную базу' } : no('ROLLBACK_UNAVAILABLE', update.busy ? 'Дождитесь завершения проверки базы' : 'Предыдущая версия базы недоступна'),
        diagnosticExport: { allowed: true, code: 'READY', reason: 'Сохранить локальный отчёт по отдельному действию' } };
}
module.exports = { stationary, policies };
