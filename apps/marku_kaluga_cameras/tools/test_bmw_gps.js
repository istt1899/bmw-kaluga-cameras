// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Real local IPC, fake read-only SOME/IP provider. No vehicle or internet.
const assert = require('assert');
const net = require('net');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { BmwGpsBridge, INTERFACE, INSTANCE, validPayload } = require('../src/bmw_gps_bridge.js');
const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bmw-gps-bridge-' + process.pid : path.join(os.tmpdir(), 'bmw-gps-bridge-' + process.pid + '.sock');
const peers = new Set(), commands = [];
let enabled = true;
function status() { peers.forEach((s) => s.write(JSON.stringify({ ev: 'status', state: { enabled } }) + '\n')); }
const server = net.createServer((s) => {
    peers.add(s); s.setEncoding('utf8'); let buffer = '';
    s.on('error', () => {}); s.on('close', () => peers.delete(s));
    s.on('data', (chunk) => {
        buffer += chunk; let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); commands.push(message);
            if (message.cmd === 'status') status();
        }
    });
});
function sentence(body) { let c = 0; for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i); return '$' + body + '*' + ('0' + c.toString(16)).slice(-2); }
const nmea = sentence('GNRMC,120000.00,A,5400.000,N,03600.000,E,1,90,061126,,,A') + '\r\n';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() > deadline) throw new Error('GPS bridge test timeout'); await sleep(5); } }

(async () => {
    await new Promise((resolve) => server.listen(socket, resolve));
    let event, builds = 0, subscriptions = 0, now = 1000;
    const builders = { buildAndInitTypedProxy(iface, instance, options) {
        assert.strictEqual(iface, INTERFACE); assert.strictEqual(instance, INSTANCE); assert(options.timeoutMs > 0); builds++;
        if (builds === 1) return Promise.reject(Object.assign(new Error('do not expose coordinates or this message'), { code: 'invalid private error text' }));
        return Promise.resolve({ updatePosition: { subscribe(cb) { subscriptions++; event = cb; return Promise.resolve(); } } });
    } };
    const bridge = new BmwGpsBridge({ builders, controlOptions: { path: socket, retryMs: 10 }, retryMs: 10, timeoutMs: 50,
        heartbeatMs: 10, staleMs: 100, now: () => now });
    try {
        bridge.start();
        await until(() => bridge.subscribed && bridge.control.state);
        assert.strictEqual(builds, 2); assert.strictEqual(subscriptions, 1); assert.strictEqual(bridge.shouldHold(), true);
        assert(commands.filter((c) => c.cmd === 'gps-bridge').every((c) => !c.errorCode || /^[A-Z0-9_.-]{1,48}$/.test(c.errorCode)));
        event({ nmeaString: nmea, delayCounter: 0 });
        await until(() => commands.some((c) => c.cmd === 'vehicle-nmea'));
        assert.strictEqual(commands.find((c) => c.cmd === 'vehicle-nmea').data, nmea);
        const before = commands.filter((c) => c.cmd === 'vehicle-nmea').length;
        [null, { nmeaString: 1 }, { nmeaString: 'x'.repeat(4097) }, { nmeaString: '$GNRMC,raw\u0000*00' }, { nmeaString: '{"lat":54}' }].forEach(event);
        await sleep(20);
        assert.strictEqual(commands.filter((c) => c.cmd === 'vehicle-nmea').length, before);
        assert.strictEqual(bridge.invalidPayloads, 5);
        enabled = false; status(); await until(() => !bridge.shouldHold());
        enabled = true; status(); await until(() => bridge.shouldHold());
        const oldEvent = event;
        now = 2000; await until(() => subscriptions === 2 && bridge.subscribed);
        const beforeLate = commands.filter((c) => c.cmd === 'vehicle-nmea').length;
        oldEvent({ nmeaString: nmea }); await sleep(10);
        assert.strictEqual(commands.filter((c) => c.cmd === 'vehicle-nmea').length, beforeLate, 'retired subscription cannot replay data after recovery');
        event({ nmeaString: nmea }); await until(() => commands.filter((c) => c.cmd === 'vehicle-nmea').length > beforeLate);
        assert.strictEqual(subscriptions, 2, 'silent subscription gets one replacement with one active callback');
        bridge.stop(); await until(() => peers.size === 0);
        const stopped = commands.length; event({ nmeaString: nmea }); await sleep(30);
        assert.strictEqual(commands.length, stopped, 'late data and timers are inert after shutdown');
        assert.strictEqual(bridge.shouldHold(), false);
    } finally { bridge.stop(); peers.forEach((s) => s.destroy()); }

    let resolveAvailability, fallbackBuilds = 0, fallbackSubscriptions = 0;
    const pending = new BmwGpsBridge({
        builders: { buildTypedProxy() { const build = ++fallbackBuilds; return Promise.resolve({ init: () => Promise.resolve(),
            waitUntilAvailable: () => build === 1 ? new Promise((resolve) => { resolveAvailability = resolve; }) : Promise.resolve(),
            updatePosition: { subscribe() { fallbackSubscriptions++; return Promise.resolve(); } } }); } },
        controlOptions: { path: socket, retryMs: 10 }, timeoutMs: 15, retryMs: 5, heartbeatMs: 10
    });
    try {
        pending.start(); await until(() => pending.subscribed);
        assert.strictEqual(fallbackBuilds, 2, 'timed-out availability permits a bounded replacement');
        resolveAvailability(); await sleep(20); assert.strictEqual(fallbackSubscriptions, 1, 'late old availability never subscribes');
    } finally { pending.stop(); }
    let resolveLate, lateSubscriptions = 0;
    const late = new BmwGpsBridge({ builders: { buildAndInitTypedProxy: () => new Promise((resolve) => { resolveLate = resolve; }) },
        controlOptions: { path: socket, retryMs: 10 }, heartbeatMs: 10 });
    late.start(); await until(() => !!resolveLate); late.stop();
    resolveLate({ updatePosition: { subscribe() { lateSubscriptions++; return Promise.resolve(); } } });
    await sleep(20); assert.strictEqual(lateSubscriptions, 0, 'no late subscription after shutdown');

    function localControl() {
        const control = new EventEmitter(); control.link = 'up'; control.messages = [];
        control.open = control.close = () => {}; control.send = (message) => { control.messages.push(message); return true; }; return control;
    }
    // Audit P1-2: an unresolved SDK Promise must not permanently lock
    // connecting, nor create an unbounded collection of native requests.
    const unresolved = []; let cappedBuilds = 0, cappedSubscriptions = 0;
    const capped = new BmwGpsBridge({ control: localControl(), timeoutMs: 8, retryMs: 4, retryMaxMs: 8, heartbeatMs: 100,
        builders: { buildAndInitTypedProxy() {
            cappedBuilds++;
            if (cappedBuilds <= 3) return new Promise((resolve) => unresolved.push(resolve));
            return Promise.resolve({ updatePosition: { subscribe() { cappedSubscriptions++; return Promise.resolve(); } } });
        } } });
    try {
        capped.start(); await until(() => capped.errorCode === 'GPS_RETRY_CAPACITY_LIMIT');
        assert.strictEqual(cappedBuilds, 3); assert.strictEqual(capped.connecting, false);
        await sleep(30); assert.strictEqual(cappedBuilds, 3, 'circuit prevents unbounded unresolved builds');
        unresolved[0]({ updatePosition: { subscribe() { throw new Error('retired builder must never subscribe'); } } });
        await until(() => capped.subscribed);
        assert.strictEqual(cappedBuilds, 4); assert.strictEqual(cappedSubscriptions, 1);
        assert(capped.attempts.size <= capped.maxAttempts);
    } finally { capped.stop(); }

    let subscribeResolve, subscribedBuilds = 0; const callbacks = [], subscriptionControl = localControl();
    const subscribing = new BmwGpsBridge({ control: subscriptionControl, timeoutMs: 8, retryMs: 4, heartbeatMs: 100,
        builders: { buildAndInitTypedProxy() {
            const index = ++subscribedBuilds;
            return Promise.resolve({ updatePosition: { subscribe(callback) {
                callbacks.push(callback); return index === 1 ? new Promise((resolve) => { subscribeResolve = resolve; }) : Promise.resolve();
            } } });
        } } });
    try {
        subscribing.start(); await until(() => subscribing.subscribed && subscribedBuilds === 2);
        const before = subscriptionControl.messages.length;
        callbacks[0]({ nmeaString: nmea }); subscribeResolve(); await sleep(15);
        assert.strictEqual(subscriptionControl.messages.length, before, 'late subscription result/callback is inert');
        callbacks[1]({ nmeaString: nmea });
        assert(subscriptionControl.messages.some((message) => message.cmd === 'vehicle-nmea'));
    } finally { subscribing.stop(); }

    let stoppedBuilds = 0;
    const stoppedRetry = new BmwGpsBridge({ control: localControl(), retryMs: 30, heartbeatMs: 100,
        builders: { buildAndInitTypedProxy() { stoppedBuilds++; return Promise.reject(new Error('temporary')); } } });
    stoppedRetry.start(); await until(() => stoppedRetry.state === 'error'); stoppedRetry.stop();
    await sleep(50); assert.strictEqual(stoppedBuilds, 1, 'shutdown cancels pending retries');
    assert(validPayload({ nmeaString: nmea }));
    assert(validPayload({ nmeaString: nmea + '$PUBX,00,unsupported*00\r' }));
    // A daemon can stay connected without reading. Neither NMEA events nor
    // heartbeats may append more messages to an already backed-up socket.
    const blockedControl = new EventEmitter(); let sent = 0;
    blockedControl.link = 'up'; blockedControl.sock = { writableLength: 20000 };
    blockedControl.send = () => { sent++; return true; };
    const blocked = new BmwGpsBridge({ control: blockedControl });
    blocked.running = true; blocked.generation = 1;
    for (let i = 0; i < 1000; i++) { blocked.event({ nmeaString: nmea }, 1); blocked.publishState(true); }
    assert.strictEqual(sent, 0, 'stalled modern socket has no additional queued writes');
    blockedControl.sock = { bufferSize: 20000 };
    blocked.event({ nmeaString: nmea }, 1); blocked.publishState(true);
    assert.strictEqual(sent, 0, 'Node 8 bufferSize also bounds writes');
    blockedControl.sock.bufferSize = 0;
    blocked.event({ nmeaString: nmea }, 1);
    assert.strictEqual(sent, 2, 'next live event resumes after pressure drains, with no replay');
    peers.forEach((s) => s.destroy()); await new Promise((resolve) => server.close(resolve));
    console.log('PASS BMW GPS bridge: live IPC, bounded build/subscribe recovery, late-attempt isolation, stale replacement, retry circuit and shutdown cancellation');
})().catch((error) => { peers.forEach((s) => s.destroy()); server.close(); console.error(error); process.exitCode = 1; });
