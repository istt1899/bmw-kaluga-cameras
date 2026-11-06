'use strict';
// Adapter boundary: production never guesses BMW gong identifiers, priorities,
// sinks or volume. A confirmed adapter may be supplied after vehicle validation.
function createAudio(adapter) {
    adapter=adapter&&typeof adapter.play==='function'?adapter:null;
    let enabled = false, threshold = 0, lastKey = null, lastTime = 0, lastSeenTime = 0, pending = false, closed = false;
    let cancelPending=null;
    let state = { available: !!adapter, enabled: false, thresholdKmh: 0,
        phase: adapter ? 'ready' : 'unavailable', reason: adapter ? null : 'Звуковой канал BMW не подтверждён; радио и системная громкость не меняются' };
    function play(test, now) {
        if (!adapter || closed) return Promise.reject(new Error(state.reason || 'Звук недоступен'));
        if (pending) return Promise.reject(new Error('Звуковой сигнал уже выполняется'));
        pending = true; state.phase = 'requested';
        let timer;
        return Promise.resolve().then(() => {
            if(closed)throw new Error('Звуковой канал закрыт');
            return new Promise((resolve,reject)=>{
                cancelPending=()=>reject(new Error('Звуковой канал закрыт'));
                timer=setTimeout(()=>reject(new Error('Подтверждение звука не получено вовремя')),1500);
                Promise.resolve().then(()=>{if(closed)throw new Error('Звуковой канал закрыт');return adapter.play({test:!!test,durationMs:250});}).then(resolve,reject);
            });
        }).then(result => {
            pending = false;
            // Sent/accepted is not proof of playback. Require the adapter's
            // explicit completion acknowledgement before reporting success.
            if(closed)throw new Error('Звуковой канал закрыт');
            if (!result || result.played !== true) throw new Error('Воспроизведение звука не подтверждено');
            clearTimeout(timer);cancelPending=null;
            state.phase = 'played'; state.reason = null; lastTime = now; return state;
        }).catch(error => { clearTimeout(timer);cancelPending=null;pending = false; state.phase = closed?'closed':'error'; state.reason = String(error.message).slice(0,160); throw error; });
    }
    return { status: () => Object.assign({}, state),
        configure(on, delta) { enabled = !!on; threshold = delta; state.enabled = enabled; state.thresholdKmh = delta; },
        update(alert, fix, now) {
            if (!alert) { if(now-lastSeenTime>30000)lastKey=null; return; }
            lastSeenTime=now;
            if (!enabled || !adapter || pending || closed || !alert || alert.test || !alert.roadConfirmed ||
                !Number.isFinite(alert.limitKmh) || !fix || !Number.isFinite(fix.speedKmh) ||
                !Number.isFinite(fix.timeMs) || now-fix.timeMs>3000 || fix.timeMs>now+500) return;
            const key = alert.id + ':' + (alert.sign || 'road');
            if (fix.speedKmh <= alert.limitKmh + threshold || key === lastKey || now-lastTime<12000) return;
            lastKey = key; play(false,now).catch(() => {});
        }, test: now => play(true, now), close() { closed = true; state.available=false;state.phase='closed';if(cancelPending)cancelPending();if(adapter && typeof adapter.close==='function')adapter.close(); } };
}
module.exports = { createAudio };
