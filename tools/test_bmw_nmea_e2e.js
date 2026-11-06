// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Real local control socket -> BMW NMEA decoder -> shipped road geometry ->
// camera display boundary, followed by stale-fix withdrawal. No SDK/hardware mock
// is presented as proof of receiving a real vehicle's SatellitePositioning event.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const base = '../native/marku-kaluga-cameras/files/';
const service = require(base + 'marku-kaluga-cameras');
const { GpsProvider } = require(base + 'gps-source');
const { createGuidance } = require(base + 'vehicle-guidance');
const zones = require(base + 'road-zones.json').zones;
const { CameraControl } = require('../apps/marku_kaluga_cameras/src/control');
function until(test, timeout) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            try {
                if (test()) { clearInterval(timer); resolve(); }
                else if (Date.now() - start > (timeout || 4000)) { clearInterval(timer); reject(new Error('BMW NMEA replay timed out')); }
            } catch (e) { clearInterval(timer); reject(e); }
        }, 10);
    });
}
function approach() {
    for (const zone of zones) for (const road of zone.roads.filter(r => r.cam >= 0)) for (const d of [-1, 1]) {
        let travelled = 0;
        for (let i = road.cam; i + d >= 0 && i + d < road.pts.length; i += d) {
            const a = road.pts[i], b = road.pts[i + d], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
            travelled += len;
            if (len < 30 || travelled > 410) continue;
            const one = { lat: zone.lat + (a[1] + dy * .75) / 111320,
                lon: zone.lon + (a[0] + dx * .75) / (111320 * Math.cos(zone.lat * Math.PI / 180)),
                speedKmh: 72, headingDeg: (Math.atan2(-dx, -dy) * 180 / Math.PI + 360) % 360, accuracyM: 10, timeMs: 1000 };
            const two = Object.assign({}, one, { lat: one.lat - dy / len * 8 / 111320,
                lon: one.lon - dx / len * 8 / (111320 * Math.cos(zone.lat * Math.PI / 180)), timeMs: 1500 });
            const g = createGuidance({ zones: [zone] }); g.evaluate(one, 1000, true);
            if (g.evaluate(two, 1500, true)) return [one, two];
        }
    }
    throw new Error('No verified approach fixture in the actual shipped road geometry');
}
function sentence(body) {
    let crc = 0; for (let i = 0; i < body.length; i++) crc ^= body.charCodeAt(i);
    return '$' + body + '*' + ('0' + crc.toString(16)).slice(-2);
}
function coordinate(value, longitude) {
    const degrees = Math.floor(Math.abs(value));
    return ('000' + degrees).slice(longitude ? -3 : -2) + ('0' + ((Math.abs(value) - degrees) * 60).toFixed(7)).slice(-10);
}
function packet(fix, utc) {
    const date = new Date(utc), pad = n => ('0' + n).slice(-2);
    const tod = pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + '.' + ('00' + date.getUTCMilliseconds()).slice(-3);
    const day = pad(date.getUTCDate()) + pad(date.getUTCMonth() + 1) + String(date.getUTCFullYear()).slice(-2);
    const lat = coordinate(fix.lat, false), lon = coordinate(fix.lon, true);
    const h1 = fix.lat < 0 ? 'S' : 'N', h2 = fix.lon < 0 ? 'W' : 'E';
    return [sentence('GNRMC,' + tod + ',A,' + lat + ',' + h1 + ',' + lon + ',' + h2 + ',' + (fix.speedKmh / 1.852) + ',' + fix.headingDeg + ',' + day + ',,,A'),
        sentence('GNGGA,' + tod + ',' + lat + ',' + h1 + ',' + lon + ',' + h2 + ',1,10,0.8,150,M,0,M,,'),
        sentence('GNGST,' + tod + ',1,1,1,0,3,4,6')].join('\r\n');
}
async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-gps-e2e-'));
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bmw-gps-e2e-' + process.pid : path.join(dir, 'ctl.sock');
    const gps = new GpsProvider({ nmeaPort: 0, port: 1 });
    let app, client, shown = null;
    try {
        await new Promise((resolve, reject) => {
            app = service.start({ dataDir: dir, socket, gps, onListening: resolve, onError: reject,
                display: { update: alert => { shown = alert; }, status: () => 'test display boundary', close: () => {} },
                dimmer: { update: () => {}, status: () => 'unused', close: () => {} } });
        });
        client = new CameraControl({ path: socket, retryMs: 50 }); client.open();
        await until(() => client.state);
        client.send({ cmd: 'gps-bridge', state: 'subscribed' });
        client.send({ cmd: 'outputs', cluster: true, hud: true });
        const fixes = approach(), now = Date.now();
        client.send({ cmd: 'vehicle-nmea', data: packet(fixes[0], now - 1200) });
        await until(() => app.state().gpsFix && app.state().gpsFix.source === 'bmw-nmea');
        assert(!app.state().alert || !app.state().alert.roadConfirmed, 'One fix must not create a road-verified approach alert');
        client.send({ cmd: 'vehicle-nmea', data: packet(fixes[1], now - 700) });
        await until(() => app.state().alert && app.state().alert.roadConfirmed && shown);
        assert.strictEqual(app.state().gpsFix.accuracyM, 10);
        assert.strictEqual(app.state().gpsFix.timeMs, now - 700, 'Source UTC must survive IPC');
        assert.strictEqual(app.state().gpsInput.sentences.RMC, 2);
        assert(app.state().alert.distance > 0 && app.state().alert.distance < 600);
        assert.deepStrictEqual(app.state().outputs, { cluster: true, hud: true });
        await until(() => app.state().gpsFix === null && app.state().alert === null && shown === null, 5000);
        assert(/UTC|устарел|свеж/i.test(app.state().gps));
        console.log('PASS actual BMW NMEA control IPC -> source UTC -> shipped road approach -> alert boundary -> stale withdrawal');
    } finally {
        if (client) client.close(); if (app) app.close(); else gps.close();
        fs.readdirSync(dir).forEach(n => fs.unlinkSync(path.join(dir, n))); fs.rmdirSync(dir);
    }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
