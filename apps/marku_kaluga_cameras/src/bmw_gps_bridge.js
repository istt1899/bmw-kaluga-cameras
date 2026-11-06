// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Read-only BMW NMEA event -> local camera daemon. No internet, no recording,
// no coordinate/unit assumptions. The native decoder validates every sentence.
const EventEmitter = require('events');
const { CameraControl } = require('./control.js');
const INTERFACE = 'de.bmw.infotainment.SatellitePositioning';
const INSTANCE = '1';

function codeOf(error, fallback) {
    const code = error && error.code;
    return typeof code === 'string' && /^[A-Z0-9_.-]{1,48}$/.test(code) ? code : fallback;
}
function validPayload(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.nmeaString !== 'string') return false;
    const text = payload.nmeaString;
    if (!text.length || Buffer.byteLength(text, 'utf8') > 4096 || /[^\x20-\x7e\r\n]/.test(text)) return false;
    // Proprietary sentences such as $PUBX may accompany standard RMC/GGA.
    // Keep their framing without interpreting them or discarding good fixes.
    const lines = text.split(/[\r\n]+/).filter((line) => line.length);
    return lines.length > 0 && lines.every((line) => /^\$[A-Z0-9]{3,12},.*\*[0-9a-fA-F]{2}$/.test(line)) &&
        Buffer.byteLength(JSON.stringify({ cmd: 'vehicle-nmea', data: text }) + '\n', 'utf8') <= 8192;
}

class BmwGpsBridge extends EventEmitter {
    constructor(options) {
        super();
        const o = options || {};
        this.builders = o.builders;
        this.control = o.control || new CameraControl(o.controlOptions);
        this.retryMs = o.retryMs || 10000;
        this.retryMaxMs = Math.max(this.retryMs, o.retryMaxMs || 60000);
        this.timeoutMs = o.timeoutMs || 10000;
        this.staleMs = o.staleMs || 15000;
        this.heartbeatMs = o.heartbeatMs || 5000;
        this.now = o.now || Date.now;
        this.running = false; this.enabled = true; this.state = 'stopped'; this.errorCode = null;
        this.generation = 0; this.connecting = false; this.subscribed = false;
        this.attemptId = 0; this.attempt = null; this.attempts = new Set(); this.failures = 0;
        // The SDK exposes no verified cancellation for a pending builder or
        // native subscription. Bound both unresolved work and retained native
        // registrations across start/stop cycles; never retry indefinitely.
        this.maxAttempts = 3;
        this.lastEventAt = null; this.eventsReceived = 0; this.invalidPayloads = 0;
        this.retry = null; this.deadline = null; this.heartbeat = null;
        this.sent = null; this.linkUp = false;
        this.control.on('change', () => this.controlChanged());
    }
    shouldHold() { return this.running && this.enabled; }
    hasWriteCapacity() {
        const socket = this.control.sock;
        if (!socket) return true; // injectable control may not expose a socket
        const pending = typeof socket.writableLength === 'number' ? socket.writableLength : socket.bufferSize;
        return typeof pending !== 'number' || pending <= 16384;
    }
    setState(state, errorCode) {
        const changed = state !== this.state || errorCode !== this.errorCode;
        this.state = state; this.errorCode = errorCode || null;
        this.publishState(false);
        if (changed) this.emit('change');
    }
    publishState(force) {
        if (this.control.link !== 'up' || !this.hasWriteCapacity()) return;
        const key = this.state + ':' + (this.errorCode || '');
        if (!force && this.sent === key) return;
        this.sent = key;
        try {
            if (!this.control.send({ cmd: 'gps-bridge', state: this.state, errorCode: this.errorCode })) this.sent = null;
        } catch (error) { this.sent = null; }
    }
    controlChanged() {
        const up = this.control.link === 'up';
        if (up && !this.linkUp) this.sent = null;
        this.linkUp = up;
        const state = this.control.state;
        if (state && typeof state.enabled === 'boolean' && state.enabled !== this.enabled) {
            this.enabled = state.enabled; this.emit('change');
        }
        this.publishState(false);
    }
    start() {
        if (this.running) return;
        this.running = true; this.generation++; this.sent = null;
        this.setState('starting', null);
        this.control.open();
        this.connect(this.generation);
        this.heartbeat = setInterval(() => {
            if (!this.running) return;
            if (this.subscribed && this.now() - this.lastEventAt > this.staleMs) {
                this.retire(this.attempt);
                this.setState('unavailable', 'GPS_EVENT_TIMEOUT');
                this.scheduleRetry(this.generation);
            }
            this.publishState(true);
        }, this.heartbeatMs);
        this.emit('change');
    }
    current(generation) { return this.running && this.generation === generation; }
    active(attempt) { return !!attempt && this.current(attempt.generation) && this.attempt === attempt; }
    retire(attempt) {
        if (!attempt) return;
        clearTimeout(attempt.deadline);
        if (this.attempt !== attempt) return;
        this.attempt = null; this.deadline = null; this.connecting = false; this.subscribed = false;
    }
    scheduleRetry(generation) {
        if (!this.current(generation) || this.retry || this.connecting || this.subscribed) return;
        const delay = Math.min(this.retryMaxMs, this.retryMs * Math.pow(2, Math.min(this.failures++, 10)));
        this.retry = setTimeout(() => { this.retry = null; this.connect(generation); }, delay);
    }
    settled(attempt) {
        attempt.pending = false;
        // A timed-out builder cannot subscribe when it finally resolves.
        // Invoked subscriptions keep a slot because rejecting/resolving the
        // Promise does not prove that its native registration was removed.
        if (!attempt.subscriptionStarted) this.attempts.delete(attempt);
        if (!this.active(attempt) && this.running && this.attempts.size < this.maxAttempts) this.scheduleRetry(this.generation);
    }
    connect(generation) {
        if (!this.current(generation) || this.connecting || this.subscribed) return;
        if (this.attempts.size >= this.maxAttempts) {
            this.setState('unavailable', 'GPS_RETRY_CAPACITY_LIMIT');
            return; // A late pending builder settling can free a slot.
        }
        const attempt = { id: ++this.attemptId, generation, pending: true, subscriptionStarted: false, deadline: null };
        this.attempt = attempt; this.attempts.add(attempt);
        this.connecting = true;
        this.setState('starting', null);
        attempt.deadline = this.deadline = setTimeout(() => {
            if (!this.active(attempt)) return;
            this.retire(attempt);
            this.setState('unavailable', attempt.subscriptionStarted ? 'GPS_SUBSCRIPTION_TIMEOUT' : 'GPS_PROXY_TIMEOUT');
            this.scheduleRetry(generation);
        }, this.timeoutMs);
        let proxy;
        Promise.resolve().then(() => {
            if (!this.active(attempt)) return null;
            if (!this.builders) throw Object.assign(new Error('no builder'), { code: 'GPS_PROXY_UNAVAILABLE' });
            if (typeof this.builders.buildAndInitTypedProxy === 'function') {
                return this.builders.buildAndInitTypedProxy(INTERFACE, INSTANCE, { timeoutMs: this.timeoutMs });
            }
            return Promise.resolve(this.builders.buildTypedProxy(INTERFACE, INSTANCE))
                .then((p) => { if (!this.active(attempt)) return; proxy = p; return p.init(); })
                .then(() => this.active(attempt) ? proxy.waitUntilAvailable() : null)
                .then(() => this.active(attempt) ? proxy : null);
        }).then((p) => {
            if (!this.active(attempt)) return null;
            proxy = p;
            if (!proxy || !proxy.updatePosition || typeof proxy.updatePosition.subscribe !== 'function') {
                throw Object.assign(new Error('no event'), { code: 'GPS_EVENT_UNAVAILABLE' });
            }
            attempt.subscriptionStarted = true;
            return Promise.resolve(proxy.updatePosition.subscribe((payload) => this.event(payload, generation, attempt))).then(() => proxy);
        }).then((p) => {
            this.settled(attempt);
            if (!this.active(attempt)) return;
            clearTimeout(attempt.deadline); this.deadline = null; this.connecting = false;
            if (!p) return;
            this.subscribed = true; this.failures = 0;
            this.lastEventAt = this.now();
            this.setState('subscribed', null);
        }).catch((error) => {
            this.settled(attempt);
            if (!this.active(attempt)) return;
            this.retire(attempt);
            this.setState('error', codeOf(error, 'GPS_BRIDGE_ERROR'));
            this.scheduleRetry(generation);
        });
    }
    event(payload, generation, attempt) {
        if (!this.current(generation) || (attempt && !this.active(attempt))) return;
        if (!validPayload(payload)) {
            this.invalidPayloads++;
            this.setState('error', 'NMEA_PAYLOAD_INVALID');
            return;
        }
        this.eventsReceived++; this.lastEventAt = this.now();
        this.setState('subscribed', null);
        // Never replay buffered coordinates when the daemon comes back. Its
        // next live event supplies a fresh sentence with the original UTC.
        // Bound the stream even if a connected daemon stops consuming. Drop
        // this frame and use the next live event; never queue stale positions.
        if (!this.hasWriteCapacity()) return;
        try { this.control.send({ cmd: 'vehicle-nmea', data: payload.nmeaString }); } catch (error) { /* local link will retry */ }
    }
    stop() {
        if (!this.running) return;
        this.retire(this.attempt);
        this.running = false; this.generation++;
        this.connecting = false; this.subscribed = false;
        clearTimeout(this.retry); clearTimeout(this.deadline); clearInterval(this.heartbeat);
        this.retry = this.deadline = this.heartbeat = null;
        this.setState('stopped', null);
        this.control.close();
        // No unverified unsubscribe API is invoked. Retained registrations
        // stay bounded, and only the current attempt can deliver live data.
        this.emit('change');
    }
}

module.exports = { BmwGpsBridge, INTERFACE, INSTANCE, validPayload };
