// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const EventEmitter = require('events');
const net = require('net');

class CameraControl extends EventEmitter {
    constructor(options) {
        super();
        const o = options || {};
        this.path = o.path || '/dev/shm/marku-kaluga-cameras/ctl.sock';
        this.retryMs = o.retryMs || 1000;
        this.statusTimeoutMs = o.statusTimeoutMs || 5000;
        this.state = null; this.link = 'down'; this.sock = null; this.lastError = null;
        this.opened = false; this.buffer = ''; this.timer = null;
        this.statusTimer = null;
        this.commandError = null; this.commandErrorRequestId = null;
    }
    open() {
        if (this.opened) return;
        this.opened = true;
        this.connect();
    }
    close() {
        this.opened = false;
        clearTimeout(this.timer); this.timer = null;
        clearTimeout(this.statusTimer); this.statusTimer = null;
        const sock = this.sock;
        this.sock = null; this.state = null; this.link = 'down';
        if (sock) sock.destroy();
        this.emit('change');
    }
    connect() {
        if (!this.opened || this.sock) return;
        const sock = net.connect(this.path);
        this.sock = sock; this.buffer = '';
        sock.setEncoding('utf8');
        sock.on('error', (err) => {
            if (this.sock !== sock) return;
            this.lastError = err.code || 'UNKNOWN';
            this.link = err.code === 'ENOENT' ? 'absent' : 'failed';
            this.state = null; this.emit('change');
        });
        sock.on('connect', () => {
            if (this.sock !== sock) return;
            this.lastError = null; this.link = 'up'; this.emit('change'); this.send({ cmd: 'status' });
            this.statusTimer = setTimeout(() => {
                this.statusTimer = null;
                if (this.sock !== sock || this.state) return;
                this.lastError = 'ETIMEDOUT'; this.emit('change'); sock.destroy();
            }, this.statusTimeoutMs);
        });
        sock.on('data', (chunk) => {
            if (this.sock !== sock) return;
            this.buffer += chunk;
            if (this.buffer.length > 131072) { sock.destroy(); return; }
            let nl;
            while ((nl = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, nl).trim(); this.buffer = this.buffer.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (err) { continue; }
                if (msg.ev === 'status' && msg.state && typeof msg.state === 'object') {
                    clearTimeout(this.statusTimer); this.statusTimer = null;
                    this.state = msg.state; this.emit('change');
                }
                if (msg.ev === 'error' && typeof msg.error === 'string') {
                    this.commandError = msg.error.replace(/[\r\n\t]/g, ' ').slice(0,1024);
                    this.commandErrorRequestId = typeof msg.requestId === 'string' ? msg.requestId : null;
                    this.emit('change');
                }
            }
        });
        sock.on('close', () => {
            if (this.sock !== sock) return;
            this.sock = null; this.state = null; this.link = 'down'; this.emit('change');
            clearTimeout(this.statusTimer); this.statusTimer = null;
            if (this.opened) this.timer = setTimeout(() => { this.timer = null; this.connect(); }, this.retryMs);
        });
    }
    send(message) {
        if (!this.sock || this.link !== 'up') return false;
        if (message.cmd !== 'status') { this.commandError = null; this.commandErrorRequestId = null; }
        this.sock.write(JSON.stringify(message) + '\n');
        return true;
    }
    diagnostic() {
        const reasons = { ENOENT: 'Сокет сервиса отсутствует', EACCES: 'Нет доступа к сокету сервиса',
            ECONNREFUSED: 'Сервис не принимает соединение', ECONNRESET: 'Сервис разорвал соединение',
            ETIMEDOUT: 'Сервис подключён, но не отвечает на запрос состояния' };
        return this.lastError ? (reasons[this.lastError] || 'Ошибка соединения') + ' (' + this.lastError + ')' :
            this.link === 'up' ? 'Соединение есть; ожидание ответа сервиса' : 'Ожидание соединения с сервисом';
    }
}

module.exports = { CameraControl };
