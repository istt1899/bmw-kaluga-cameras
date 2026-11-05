'use strict';
// Node 8. Source UTC, quality and metre-valued error estimates are retained.
// HDOP is dimensionless: it is NEVER copied into accuracyM.
var net = require('net');
var dgram = require('dgram');
var EventEmitter = require('events');
var MAX_AGE = 3000;
function number(n) { return typeof n === 'number' && isFinite(n); }
function numeric(s) { return typeof s === 'string' && s.trim() !== '' && isFinite(Number(s)) ? Number(s) : null; }
function fresh(time, now) { return number(time) && time >= now - MAX_AGE && time <= now + 1000; }
function coordinate(s, hemisphere, longitude) {
  var n = numeric(s), allowed = longitude ? /^[EW]$/ : /^[NS]$/;
  if (n === null || n < 0 || !allowed.test(hemisphere)) return null;
  var deg = Math.floor(n / 100), minutes = n % 100, out = deg + minutes / 60;
  if (minutes >= 60 || out > (longitude ? 180 : 90)) return null;
  return hemisphere === 'S' || hemisphere === 'W' ? -out : out;
}
function tod(s) {
  if (!/^\d{6}(\.\d+)?$/.test(s || '')) return null;
  var h = Number(s.slice(0, 2)), m = Number(s.slice(2, 4)), sec = Number(s.slice(4));
  return h < 24 && m < 60 && sec < 60 ? ((h * 60 + m) * 60 + sec) * 1000 : null;
}
function utc(date, time) {
  var t = tod(time);
  if (!/^\d{6}$/.test(date || '') || t === null) return null;
  var year = Number(date.slice(4, 6)); year += year >= 80 ? 1900 : 2000;
  var month = Number(date.slice(2, 4)), day = Number(date.slice(0, 2));
  var midnight = Date.UTC(year, month - 1, day), d = new Date(midnight);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? midnight + t : null;
}
function distance(a, b) {
  var rad = Math.PI / 180, x = (b.lon - a.lon) * Math.cos((a.lat + b.lat) * rad / 2), y = b.lat - a.lat;
  return Math.sqrt(x * x + y * y) * rad * 6371008.8;
}
function GpsDecoder(now) {
  EventEmitter.call(this); this.now = now || Date.now; this.last = {}; this.parts = {}; this.rmc = null; this.gga = null; this.gst = null;
}
GpsDecoder.prototype = Object.create(EventEmitter.prototype);
GpsDecoder.prototype.constructor = GpsDecoder;
GpsDecoder.prototype.invalidate = function (source, reason) {
  this.last[source] = null; this.emit('quality', source + ': ' + reason);
};
GpsDecoder.prototype.accept = function (fix) {
  var now = this.now();
  if (!fresh(fix.timeMs, now)) { this.invalidate(fix.source, 'stale or future source UTC'); return; }
  if (!number(fix.lat) || !number(fix.lon) || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return;
  var previous = this.last[fix.source];
  if (previous && fix.timeMs < previous.timeMs) { this.emit('quality', fix.source + ': out-of-order source UTC'); return; }
  this.last[fix.source] = fix;
  this.emit('fix', fix);
};
GpsDecoder.prototype.json = function (obj) {
  if (!obj || obj.class !== 'TPV') return;
  if (!(obj.mode === 2 || obj.mode === 3) || [5, 6, 7, 8].indexOf(obj.status) >= 0) {
    this.parts = {}; this.invalidate('gpsd', 'no usable GNSS fix'); return;
  }
  if (typeof obj.time !== 'string' || !/Z$/.test(obj.time) || !fresh(Date.parse(obj.time), this.now())) {
    this.invalidate('gpsd', 'missing/stale source UTC'); return;
  }
  var timeMs = Date.parse(obj.time), key = String(obj.device || '') + ':' + timeMs;
  if (this.parts.key !== key) this.parts = { key: key, data: {} };
  Object.assign(this.parts.data, obj);
  var p = this.parts.data, accuracy = null;
  if (number(p.eph) && p.eph > 0) accuracy = p.eph;
  else if (number(p.epx) && p.epx > 0 && number(p.epy) && p.epy > 0) accuracy = Math.sqrt(p.epx * p.epx + p.epy * p.epy);
  this.accept({ lat: p.lat, lon: p.lon, speedKmh: number(p.speed) && p.speed >= 0 ? p.speed * 3.6 : null,
    headingDeg: number(p.track) && p.track >= 0 && p.track <= 360 ? p.track % 360 : null,
    accuracyM: accuracy, timeMs: timeMs, source: 'gpsd', quality: p.mode, hdop: null });
};
GpsDecoder.prototype.line = function (line) {
  line = String(line).trim();
  var match = /^\$([A-Z]{2}(RMC|GGA|GST),[^*]*)\*([0-9A-Fa-f]{2})$/.exec(line);
  if (!match) return;
  var sum = 0, j; for (j = 0; j < match[1].length; j++) sum ^= match[1].charCodeAt(j);
  if (sum !== parseInt(match[3], 16)) { this.emit('quality', 'nmea: checksum failed'); return; }
  var p = match[1].split(','), kind = match[2], now = this.now(), t = tod(p[1]);
  if (t === null) return;
  if (kind === 'RMC') {
    if (p[2] !== 'A' || (p[12] && ['A', 'D', 'P', 'R', 'F'].indexOf(p[12]) < 0)) {
      this.rmc = null; this.invalidate('nmea', 'RMC invalid or simulated'); return;
    }
    var time = utc(p[9], p[1]);
    if (!fresh(time, now)) { this.rmc = null; this.invalidate('nmea', 'stale RMC UTC'); return; }
    this.rmc = { tod: t, received: now, timeMs: time, lat: coordinate(p[3], p[4], false), lon: coordinate(p[5], p[6], true),
      speedKmh: numeric(p[7]) === null ? null : numeric(p[7]) * 1.852, headingDeg: numeric(p[8]) };
  } else if (kind === 'GGA') {
    var quality = numeric(p[6]);
    if ([1, 2, 3, 4, 5].indexOf(quality) < 0) { this.gga = null; this.invalidate('nmea', 'GGA no satellite-quality fix'); return; }
    this.gga = { tod: t, received: now, quality: quality, hdop: numeric(p[8]), lat: coordinate(p[2], p[3], false), lon: coordinate(p[4], p[5], true) };
  } else {
    this.gst = { tod: t, received: now, latSigma: numeric(p[6]), lonSigma: numeric(p[7]) };
  }
  var r = this.rmc, g = this.gga, gst = this.gst;
  if (!r || !g || now - g.received > MAX_AGE || Math.abs(r.tod - g.tod) > 500 ||
      !number(r.lat) || !number(r.lon) || !number(g.lat) || !number(g.lon) || distance(r, g) > 50) return;
  var accuracy = null;
  if (gst && now - gst.received <= MAX_AGE && Math.abs(r.tod - gst.tod) <= 500 &&
      gst.latSigma > 0 && gst.lonSigma > 0) accuracy = 2 * Math.sqrt(gst.latSigma * gst.latSigma + gst.lonSigma * gst.lonSigma);
  this.accept({ lat: r.lat, lon: r.lon, speedKmh: r.speedKmh,
    headingDeg: number(r.headingDeg) && r.headingDeg >= 0 && r.headingDeg <= 360 ? r.headingDeg % 360 : null,
    accuracyM: accuracy, timeMs: r.timeMs, source: 'nmea', quality: g.quality, hdop: g.hdop });
};
GpsDecoder.prototype.current = function (now) {
  var self = this, best = null;
  ['gpsd', 'nmea'].forEach(function (source) {
    var fix = self.last[source];
    if (fix && fresh(fix.timeMs, now) && (!best || fix.timeMs > best.timeMs ||
        (fix.timeMs === best.timeMs && number(fix.accuracyM) && !number(best.accuracyM)))) best = fix;
  });
  return best;
};
function GpsProvider(options) {
  EventEmitter.call(this); this.options = options || {}; this.decoder = new GpsDecoder(); this.sock = null; this.udp = null; this.retry = null; this.closed = true;
  var self = this;
  this.decoder.on('quality', function (text) { self.emit('status', text); });
  this.decoder.on('fix', function (fix) { self.emit('fix', fix); });
}
GpsProvider.prototype = Object.create(EventEmitter.prototype);
GpsProvider.prototype.constructor = GpsProvider;
GpsProvider.prototype.start = function () {
  var self = this; this.closed = false; this.connect();
  if (this.options.nmeaPort === 0) return;
  this.udp = dgram.createSocket('udp4');
  this.udp.on('message', function (data) {
    if (data.length <= 8192) String(data).split(/\r?\n/).forEach(function (line) { self.decoder.line(line); });
  });
  this.udp.on('error', function (err) { self.emit('status', 'NMEA UDP: ' + err.code); });
  this.udp.bind(this.options.nmeaPort || 5001, this.options.nmeaHost || '127.0.0.1', function () { self.emit('status', 'NMEA UDP listening'); });
};
GpsProvider.prototype.connect = function () {
  if (this.closed || this.sock) return;
  var self = this, buffer = '', sock = net.connect(this.options.port || 2947, this.options.host || '127.0.0.1');
  this.sock = sock; sock.setEncoding('utf8'); sock.setTimeout(15000);
  sock.on('connect', function () { self.emit('status', 'GPSD connected; waiting for source UTC'); sock.write('?WATCH={"enable":true,"json":true};\n'); });
  sock.on('data', function (chunk) {
    buffer += chunk;
    if (buffer.length > 65536) { sock.destroy(); return; }
    var nl; while ((nl = buffer.indexOf('\n')) >= 0) {
      var line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
      try { self.decoder.json(JSON.parse(line)); } catch (err) { /* Skip non-JSON greeting/partial lines. */ }
    }
  });
  sock.on('timeout', function () { sock.destroy(); });
  sock.on('error', function (err) { self.emit('status', 'GPSD: ' + err.code); });
  sock.on('close', function () {
    if (self.sock !== sock) return;
    self.sock = null;
    if (!self.closed) self.retry = setTimeout(function () { self.retry = null; self.connect(); }, self.options.retryMs || 5000);
  });
};
GpsProvider.prototype.current = function (now) { return this.decoder.current(now); };
GpsProvider.prototype.close = function () {
  this.closed = true; clearTimeout(this.retry); if (this.sock) this.sock.destroy();
  if (this.udp) { try { this.udp.close(); } catch (err) {} }
  this.sock = null; this.udp = null;
};
module.exports = { GpsProvider: GpsProvider, GpsDecoder: GpsDecoder, coordinate: coordinate, fresh: fresh };
