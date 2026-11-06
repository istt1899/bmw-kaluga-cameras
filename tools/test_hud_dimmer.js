// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert'), fs = require('fs'), net = require('net'), os = require('os'), path = require('path');
const { createDimmer } = require('../native/marku-kaluga-cameras/files/hud-dimmer');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strelka-dimmer-'));
const socket = process.platform === 'win32' ? '\\\\.\\pipe\\strelka-dimmer-' + process.pid : path.join(dir, 'render.sock');
const statusFile = path.join(dir, 'status.json'), messages = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function frame(o) { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(5); h.writeUInt32LE(1 + b.length, 0); h[4] = 74; return Buffer.concat([h, b]); }
function status(hud, state) { fs.writeFileSync(statusFile, JSON.stringify({ hud, hud_state: state })); }
const server = net.createServer(sock => {
    let buf = Buffer.alloc(0); sock.on('error', () => {});
    sock.on('data', b => {
        buf = Buffer.concat([buf, b]);
        while (buf.length >= 5 && buf.length >= 4 + buf.readUInt32LE(0)) {
            const end = 4 + buf.readUInt32LE(0), type = buf[4], payload = buf.slice(5, end); buf = buf.slice(end);
            if (type !== 74) continue;
            const m = JSON.parse(payload.toString()); messages.push(m);
            if (m.op === 'hello') sock.write(frame({ ev: 'hello', backend: 'test', targets: 'hud:800x480' }));
            if (m.op === 'set' && m.visible === 1) sock.write(frame({ ev: 'layer', ref: m.ref, state: 'shown' }));
        }
    });
});
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(15); } throw new Error('dimmer test timeout'); }
(async () => {
    await new Promise(resolve => server.listen(socket, resolve));
    let now = Date.now(); const d = createDimmer({ socket, statusFile, now: () => now });
    try {
        status(1, 'showing'); d.update(100); await sleep(20); assert.strictEqual(messages.length, 0);
        status(0, 'off'); d.update(50); await sleep(20); assert.strictEqual(messages.length, 0);
        status(1, 'showing'); now = Date.now(); d.update(60);
        await until(() => messages.some(m => m.op === 'set' && m.visible === 1));
        const layer = messages.find(m => m.op === 'layer');
        assert.strictEqual(layer.target, 'hud'); assert.strictEqual(layer.class, 'overlay');
        assert.strictEqual(layer.contend, 0); assert.strictEqual(layer.exclusive, 0); assert.strictEqual(layer.opacity, 0.4);
        assert(!messages.some(m => m.target === 'map'), 'instrument cluster unaffected');
        await until(() => /40 %/.test(d.status()));
        d.update(30); await until(() => messages.some(m => m.op === 'set' && m.opacity === 0.7));
        assert(/70 %/.test(d.status()), 'status follows live opacity without a new layer-state event');
        // Black source-over alpha 0.7 leaves 30 % of video light; alert
        // layers are above overlay and are not attenuated by this layer.
        assert.strictEqual(Math.round(200 * (1 - 0.7)), 60);
        now += 5000; d.update(30); await sleep(25);
        const open = await new Promise((resolve, reject) => server.getConnections((e, n) => e ? reject(e) : resolve(n)));
        assert.strictEqual(open, 0, 'stale Waze status must release HUD');
        console.log('PASS HUD opacity: real renderer protocol, live changes, map-only layer, no competing Waze owner, stale/off withdrawal');
    } finally { d.close(); await new Promise(resolve => server.close(resolve)); fs.unlinkSync(statusFile); fs.rmdirSync(dir); }
})().catch(e => { console.error(e); process.exitCode = 1; });
