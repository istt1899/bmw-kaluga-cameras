// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const net = require('net');
const { CameraControl } = require('../apps/marku_kaluga_cameras/src/control');
const socket = process.platform === 'win32' ? '\\\\.\\pipe\\kaluga-camera-frontend-' + process.pid : '/tmp/kaluga-camera-frontend-' + process.pid + '.sock';
let peer = null, received = '', timer = null;
const client = new CameraControl({ path: socket });
const server = net.createServer((sock) => {
    peer = sock;
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
        received += chunk;
        if (received.indexOf('"cmd":"status"') >= 0 && received.indexOf('"cmd":"outputs"') < 0) {
            sock.write('{"ev":"status","state":{"enabled":false,"outputs":{"cluster":false,');
            sock.write('"hud":false},"capabilities":{"outputs":true,"update":false}}}\n');
        }
        if (received.indexOf('"cmd":"outputs"') >= 0) {
            assert(received.indexOf('"cluster":true') >= 0 && received.indexOf('"hud":false') >= 0);
            clearTimeout(timer); client.close(); sock.destroy(); server.close();
            console.log('PASS: real socket fragmented status and explicit output command');
            missingService().catch((err) => { console.error(err); process.exitCode = 1; });
        }
    });
});
function missingService() {
    return new Promise((resolve, reject) => {
        const offline = new CameraControl({ path: socket + '-missing' });
        const timeout = setTimeout(() => { offline.close(); reject(new Error('missing service timeout')); }, 3000);
        offline.on('change', () => {
            if (!offline.lastError) return;
            try {
                assert(['ENOENT', 'ECONNREFUSED'].includes(offline.lastError));
                assert(offline.diagnostic().includes(offline.lastError));
                assert.strictEqual(offline.state, null);
                clearTimeout(timeout); offline.removeAllListeners('change'); offline.close();
                console.log('PASS missing service: exact socket error remains available for diagnostics'); resolve();
            } catch (err) { clearTimeout(timeout); offline.removeAllListeners('change'); offline.close(); reject(err); }
        });
        offline.open();
    });
}
let sent = false;
client.on('change', () => {
    if (!client.state || sent) return;
    sent = true;
    assert.strictEqual(client.state.capabilities.update, false);
    assert(client.send({ cmd: 'outputs', cluster: true, hud: false }));
});
server.listen(socket, () => {
    timer = setTimeout(() => {
        client.close(); if (peer) peer.destroy(); server.close();
        console.error('FAIL: socket timeout'); process.exitCode = 1;
    }, 5000);
    client.open();
});
