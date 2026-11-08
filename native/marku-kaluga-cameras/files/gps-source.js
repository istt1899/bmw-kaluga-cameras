'use strict';
// Node 8. Source UTC and metre accuracy are retained. BMW and external
// NMEA use different decoders: their RMC/GGA/GST parts never mix.
var net = require('net'), dgram = require('dgram'), EventEmitter = require('events');
var MAX_AGE = 3000, DAY = 86400000, MAX_PACKET = 4096, MAX_COUNTER = 1000000000;
var BRIDGE_STATES = ['starting', 'subscribed', 'unavailable', 'error', 'stopped'];
function number(n) { return typeof n === 'number' && isFinite(n); }
function numeric(s) { return typeof s === 'string' && s.trim() !== '' && isFinite(Number(s)) ? Number(s) : null; }
function fresh(time, now) { return number(time) && time >= now - MAX_AGE && time <= now + 500; }
function inc(n) { return Math.min(MAX_COUNTER, n + 1); }
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
function sentence(line) {
  if (typeof line !== 'string' || line.length > 512) return { malformed: true };
  var m = /^\$([A-Z]{2})([A-Z]{3}),([^*]*)\*([0-9A-Fa-f]{2})$/.exec(line.trim());
  if (!m) return { malformed: true };
  var body = m[1] + m[2] + ',' + m[3], sum = 0;
  for (var i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return { kind: m[2], checksum: sum === parseInt(m[4], 16), fields: body.split(',') };
}
function todDelta(a, b) { return (a - b + DAY * 1.5) % DAY - DAY / 2; }
var MOTION_PAIR_MS = 500, ACCURACY_PAIR_MS = 100;
function GpsDecoder(now, nmeaSource) {
  EventEmitter.call(this); this.now = now || Date.now; this.nmeaSource = nmeaSource === 'bmw-nmea' ? nmeaSource : 'nmea';
  this.last = {}; this.complete = {}; this.parts = {}; this.rmc = null; this.gga = null; this.gst = null;
  this.lastParsedUtc = null; this.lastRejectReason = null;
  this.lastRmcUtc = null;
  this.admissionAfterUtc = null;
  this.timing = { RMC: null, GGA: null, GST: null, pairReason: 'MISSING_RMC' };
}
GpsDecoder.prototype = Object.create(EventEmitter.prototype);
GpsDecoder.prototype.constructor = GpsDecoder;
GpsDecoder.prototype.invalidate = function (source, reason) { this.last[source] = null; this.complete[source] = null; if (source === this.nmeaSource) this.lastRejectReason = reason; this.emit('quality', source + ': ' + reason); };
GpsDecoder.prototype.resetEpoch = function (afterUtc) {
  if (!number(afterUtc)) throw new Error('GPS_RESET_TIME_INVALID');
  this.last = {}; this.complete = {}; this.parts = {}; this.rmc = this.gga = this.gst = null;
  this.lastRmcUtc = this.lastParsedUtc = null; this.lastRejectReason = 'manual GPS session reset';
  this.admissionAfterUtc = afterUtc;
  this.timing = { RMC:null, GGA:null, GST:null, pairReason:'MANUAL_RESET_WAITING_SOURCE' };
};
GpsDecoder.prototype.accept = function (fix) {
  var now = this.now();
  if (this.admissionAfterUtc !== null && fix.timeMs <= this.admissionAfterUtc) { this.invalidate(fix.source, 'source UTC precedes manual reset boundary'); return false; }
  if (!fresh(fix.timeMs, now)) { this.invalidate(fix.source, 'stale or future source UTC'); return false; }
  if (!number(fix.lat) || !number(fix.lon) || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return false;
  var previous = this.last[fix.source];
  if (previous && fix.timeMs < previous.timeMs) { this.lastRejectReason = 'out-of-order source UTC'; this.emit('quality', fix.source + ': out-of-order source UTC'); return false; }
  this.last[fix.source] = fix;
  // NMEA sentences arrive separately and at different rates. Retain the last
  // complete measurement, with ITS original UTC, while the next epoch is being
  // assembled. Never attach an old GST's accuracy to newer coordinates.
  if (fix.source === this.nmeaSource && number(fix.accuracyM) && fix.accuracyM > 0) this.complete[fix.source] = fix;
  if (fix.source === this.nmeaSource) this.lastRejectReason = null; this.emit('fix', fix);
  return true;
};
GpsDecoder.prototype.json = function (obj) {
  if (!obj || obj.class !== 'TPV') return;
  if (!(obj.mode === 2 || obj.mode === 3) || [5, 6, 7, 8].indexOf(obj.status) >= 0) { this.parts = {}; this.invalidate('gpsd', 'no usable GNSS fix'); return; }
  if (typeof obj.time !== 'string' || !/Z$/.test(obj.time) || !fresh(Date.parse(obj.time), this.now())) { this.invalidate('gpsd', 'missing/stale source UTC'); return; }
  var timeMs = Date.parse(obj.time), key = String(obj.device || '') + ':' + timeMs;
  if (this.admissionAfterUtc !== null && timeMs <= this.admissionAfterUtc) { this.invalidate('gpsd','source UTC precedes manual reset boundary'); return; }
  if (this.parts.key !== key) this.parts = { key: key, data: {} };
  Object.assign(this.parts.data, obj);
  var p = this.parts.data, accuracy = null;
  if (number(p.eph) && p.eph > 0) accuracy = p.eph;
  else if (number(p.epx) && p.epx > 0 && number(p.epy) && p.epy > 0) accuracy = Math.sqrt(p.epx * p.epx + p.epy * p.epy);
  this.accept({ lat: p.lat, lon: p.lon, speedKmh: number(p.speed) && p.speed >= 0 ? p.speed * 3.6 : null,
    headingDeg: number(p.track) && p.track >= 0 && p.track <= 360 ? p.track % 360 : null,
    accuracyM: accuracy, timeMs: timeMs, source: 'gpsd', quality: p.mode, hdop: null, satellites: null });
};
GpsDecoder.prototype.line = function (line) {
  var parsed = sentence(line);
  if (parsed.malformed || !parsed.checksum) {
    if (parsed.checksum === false) { this.lastRejectReason = 'checksum failed'; this.emit('quality', this.nmeaSource + ': checksum failed'); }
    return parsed;
  }
  var p = parsed.fields, kind = parsed.kind, now = this.now(), t = tod(p[1]), source = this.nmeaSource;
  if (['RMC', 'GGA', 'GST'].indexOf(kind) < 0) return parsed;
  this.timing[kind] = { text: typeof p[1] === 'string' ? p[1].slice(0, 24) : null, tod: t, received: now };
  if (t === null) { this.timing.pairReason = 'INVALID_' + kind; return parsed; }
  if (this.rmc && (!fresh(this.rmc.timeMs, now) || !fresh(this.rmc.received, now))) this.rmc = null;
  if (this.gga && !fresh(this.gga.received, now)) this.gga = null;
  if (this.gst && !fresh(this.gst.received, now)) this.gst = null;
  if (kind === 'RMC') {
    var time = utc(p[9], p[1]);
    if (number(time)) this.lastParsedUtc = time;
    if (this.admissionAfterUtc !== null && number(time) && time <= this.admissionAfterUtc) {
      this.rmc = null; this.timing.pairReason = 'MANUAL_RESET_WAITING_SOURCE'; this.invalidate(source,'source UTC precedes manual reset boundary'); return parsed;
    }
    // The position epoch is GGA's. Compare RMC only with prior RMC, never
    // with a later, valid GGA epoch (e.g. RMC .000 / GGA .200).
    if (this.lastRmcUtc !== null && number(time) && time < this.lastRmcUtc) {
      this.lastRejectReason = 'replayed RMC UTC'; this.timing.pairReason = 'INVALID_RMC';
      this.emit('quality', source + ': replayed RMC UTC'); return parsed;
    }
    if (p[2] !== 'A' || (p[12] && ['A', 'D', 'P', 'R', 'F'].indexOf(p[12]) < 0)) {
      this.rmc = null; this.timing.pairReason = 'INVALID_RMC'; this.invalidate(source, 'RMC invalid or simulated'); return parsed;
    }
    if (!fresh(time, now)) {
      this.rmc = null; this.timing.pairReason = 'INVALID_RMC'; this.invalidate(source, 'stale RMC UTC'); return parsed;
    }
    var lat = coordinate(p[3], p[4], false), lon = coordinate(p[5], p[6], true);
    if (!number(lat) || !number(lon)) {
      this.rmc = null; this.timing.pairReason = 'INVALID_RMC'; this.invalidate(source, 'RMC invalid coordinates'); return parsed;
    }
    this.lastRmcUtc = time;
    this.rmc = { tod: t, received: now, timeMs: time, lat: lat, lon: lon,
      speedKmh: numeric(p[7]) !== null && numeric(p[7]) >= 0 ? numeric(p[7]) * 1.852 : null, headingDeg: numeric(p[8]) };
  } else if (kind === 'GGA') {
    var quality = numeric(p[6]);
    if ([1, 2, 3, 4, 5].indexOf(quality) < 0) {
      this.gga = null; this.timing.pairReason = 'INVALID_GGA'; this.invalidate(source, 'GGA no satellite-quality fix'); return parsed;
    }
    var satellites = numeric(p[7]);
    this.gga = { tod: t, received: now, timeMs: null, quality: quality, hdop: numeric(p[8]),
      satellites: Number.isInteger(satellites) && satellites >= 0 && satellites <= 128 ? satellites : null,
      lat: coordinate(p[2], p[3], false), lon: coordinate(p[4], p[5], true) };
  } else {
    this.gst = { tod: t, received: now, timeMs: null, latSigma: numeric(p[6]), lonSigma: numeric(p[7]) };
  }
  var r = this.rmc, g = this.gga, gst = this.gst;
  if (!r) {
    this.timing.pairReason = this.timing.RMC && now - this.timing.RMC.received > MAX_AGE ? 'STALE_RMC' :
      this.lastRejectReason && /RMC/.test(this.lastRejectReason) ? 'INVALID_RMC' : 'MISSING_RMC'; return parsed;
  }
  if (!g) {
    this.timing.pairReason = this.timing.GGA && now - this.timing.GGA.received > MAX_AGE ? 'STALE_GGA' :
      this.lastRejectReason && /GGA/.test(this.lastRejectReason) ? 'INVALID_GGA' : 'MISSING_GGA'; return parsed;
  }
  var motionDelta = todDelta(g.tod, r.tod);
  if (Math.abs(motionDelta) > MOTION_PAIR_MS) { this.timing.pairReason = 'RMC_GGA_OFFSET'; return parsed; }
  // RMC supplies the date and nearby motion sample, GGA supplies the actual
  // position and its UTC. A GST is usable only at that GGA position epoch.
  if (g.timeMs === null) g.timeMs = r.timeMs + motionDelta;
  if (!fresh(r.timeMs, now) || !fresh(r.received, now)) { this.timing.pairReason = 'STALE_RMC'; return parsed; }
  if (!fresh(g.timeMs, now) || !fresh(g.received, now)) { this.timing.pairReason = 'STALE_GGA'; return parsed; }
  if (!number(g.lat) || !number(g.lon) || distance(r, g) > 50) {
    this.timing.pairReason = 'POSITION_MISMATCH'; return parsed;
  }
  var accuracy = null, accuracyDelta = gst ? todDelta(gst.tod, g.tod) : null;
  this.timing.pairReason = gst ? 'GGA_GST_OFFSET' : 'MISSING_GST';
  if (gst && Math.abs(accuracyDelta) <= ACCURACY_PAIR_MS) {
    if (gst.timeMs === null) gst.timeMs = g.timeMs + accuracyDelta;
    if (fresh(gst.received, now) && fresh(gst.timeMs, now) && Math.abs(gst.timeMs - g.timeMs) <= ACCURACY_PAIR_MS) {
      if (gst.latSigma > 0 && gst.lonSigma > 0) {
        accuracy = 2 * Math.sqrt(gst.latSigma * gst.latSigma + gst.lonSigma * gst.lonSigma);
        this.timing.pairReason = 'READY';
      } else this.timing.pairReason = 'INVALID_GST';
    } else this.timing.pairReason = 'MISSING_GST';
  }
  if (!this.accept({ lat: g.lat, lon: g.lon, speedKmh: r.speedKmh,
    headingDeg: number(r.headingDeg) && r.headingDeg >= 0 && r.headingDeg <= 360 ? r.headingDeg % 360 : null,
    accuracyM: accuracy, timeMs: g.timeMs, motionTimeMs: r.timeMs,
    accuracyTimeMs: accuracy === null ? null : gst.timeMs,
    source: source, quality: g.quality, hdop: g.hdop, satellites: g.satellites })) this.timing.pairReason = 'INVALID_GGA';
  return parsed;
};
GpsDecoder.prototype.timingSnapshot = function (now) {
  var t = this.timing;
  function age(part) { return part ? Math.max(0, now - part.received) : null; }
  return { rmcTime: t.RMC && t.RMC.text, ggaTime: t.GGA && t.GGA.text, gstTime: t.GST && t.GST.text,
    rmcGgaDeltaMs: t.RMC && t.GGA && t.RMC.tod !== null && t.GGA.tod !== null ? todDelta(t.GGA.tod, t.RMC.tod) : null,
    ggaGstDeltaMs: t.GGA && t.GST && t.GGA.tod !== null && t.GST.tod !== null ? todDelta(t.GST.tod, t.GGA.tod) : null,
    pairReason: t.pairReason, lastRmcAgeMs: age(t.RMC), lastGgaAgeMs: age(t.GGA), lastGstAgeMs: age(t.GST) };
};
GpsDecoder.prototype.current = function (now) {
  var self = this, best = null;
  ['gpsd', this.nmeaSource].forEach(function (source) {
    var fix = self.last[source];
    var complete = self.complete[source];
    if (fix && !number(fix.accuracyM) && complete && fresh(complete.timeMs, now)) fix = complete;
    if (fix && fresh(fix.timeMs, now) && (!best || fix.timeMs > best.timeMs || (fix.timeMs === best.timeMs && number(fix.accuracyM) && !number(best.accuracyM)))) best = fix;
  });
  return best;
};
function GpsProvider(options) {
  EventEmitter.call(this); this.options = options || {}; this.now = this.options.now || Date.now;
  this.decoder = new GpsDecoder(this.now); this.bmwDecoder = new GpsDecoder(this.now, 'bmw-nmea');
  this.sock = null; this.udp = null; this.retry = null; this.closed = true;
  this.generation = 0; this.udpMessageHandler = null; this.udpErrorHandler = null;
  this.bridge = { state: 'stopped', errorCode: null, changedAt: null };
  this.input = { packets: 0, badPackets: 0, checksumErrors: 0, sentences: { RMC: 0, GGA: 0, GST: 0 }, lastPacketAt: null, fixUtc: null };
  var self = this;
  this.decoder.on('quality', function () { self.emit('status', 'Внешний GPS: пакет не прошёл проверку качества'); });
  this.decoder.on('fix', function (fix) { self.emit('fix', fix); });
  this.bmwDecoder.on('quality', function () { self.emit('status', 'GPS BMW: пакет не прошёл проверку UTC или качества'); });
  this.bmwDecoder.on('fix', function (fix) { self.input.fixUtc = fix.timeMs; self.emit('fix', fix); });
}
GpsProvider.prototype = Object.create(EventEmitter.prototype);
GpsProvider.prototype.constructor = GpsProvider;
GpsProvider.prototype.setBridgeStatus = function (state, errorCode) {
  if (BRIDGE_STATES.indexOf(state) < 0) throw new Error('GPS_BRIDGE_STATE_INVALID');
  if (errorCode !== undefined && errorCode !== null && (typeof errorCode !== 'string' || !/^[A-Z0-9_.-]{1,48}$/.test(errorCode))) errorCode = 'GPS_BRIDGE_ERROR';
  this.bridge = { state: state, errorCode: state === 'error' || state === 'unavailable' ? errorCode || null : null, changedAt: this.now() };
  if (state !== 'subscribed') {
    this.bmwDecoder.rmc = this.bmwDecoder.gga = this.bmwDecoder.gst = null;
    this.bmwDecoder.last['bmw-nmea'] = null;
    this.bmwDecoder.complete['bmw-nmea'] = null;
    this.bmwDecoder.lastRmcUtc = null;
    this.bmwDecoder.timing = { RMC: null, GGA: null, GST: null, pairReason: 'MISSING_RMC' };
  }
};
GpsProvider.prototype.inputNmea = function (data) {
  this.input.packets = inc(this.input.packets);
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_PACKET || !data.length || /[^\r\n\t\x20-\x7e]/.test(data)) {
    this.input.badPackets = inc(this.input.badPackets); throw new Error('GPS_PACKET_INVALID');
  }
  var lines = data.split(/[\r\n]+/).filter(function (line) { return !!line.trim(); });
  if (!lines.length || lines.length > 64) { this.input.badPackets = inc(this.input.badPackets); throw new Error('GPS_PACKET_INVALID'); }
  this.input.lastPacketAt = this.now();
  var valid = false, self = this;
  lines.forEach(function (line) {
    var parsed = self.bmwDecoder.line(line);
    if (parsed.malformed) { self.input.badPackets = inc(self.input.badPackets); return; }
    if (!parsed.checksum) { self.input.checksumErrors = inc(self.input.checksumErrors); return; }
    var kind = parsed.kind;
    if (Object.prototype.hasOwnProperty.call(self.input.sentences, kind) || Object.keys(self.input.sentences).length < 32)
      self.input.sentences[kind] = inc(self.input.sentences[kind] || 0);
    valid = true;
  });
  if (valid && this.bridge.state !== 'subscribed') this.setBridgeStatus('subscribed', null);
};
GpsProvider.prototype.diagnostics = function (now) {
  now = number(now) ? now : this.now();
  function age(time) { return time === null ? null : Math.max(0, now - time); }
  return {
    gpsBridge: { state: this.bridge.state, errorCode: this.bridge.errorCode, ageMs: age(this.bridge.changedAt) },
    gpsInput: { source: 'bmw-nmea', packets: this.input.packets, badPackets: this.input.badPackets, checksumErrors: this.input.checksumErrors,
      sentences: Object.assign({}, this.input.sentences), lastPacketAgeMs: age(this.input.lastPacketAt), fixUtcAgeMs: age(this.input.fixUtc),
      sourceUtcAgeMs: this.bmwDecoder.lastParsedUtc === null ? null : now - this.bmwDecoder.lastParsedUtc,
      rejectReason: this.bmwDecoder.lastRejectReason, nmeaTiming: this.bmwDecoder.timingSnapshot(now) }
  };
};
GpsProvider.prototype.description = function (fix, now) {
  var d = this.diagnostics(now), kinds = d.gpsInput.sentences, bridge = d.gpsBridge, timing = d.gpsInput.nmeaTiming;
  if (fix) {
    var label = fix.source === 'bmw-nmea' ? 'BMW' : fix.source === 'gpsd' ? 'GPSD' : 'Внешний NMEA';
    if (!number(fix.accuracyM) || fix.accuracyM <= 0) {
      if (fix.source === 'bmw-nmea' && timing.pairReason === 'GGA_GST_OFFSET') return label + ': координаты есть; UTC GST/GGA не совпадает (' + Math.round(timing.ggaGstDeltaMs) + ' мс)';
      return label + ': координаты есть; ' + (fix.source === 'bmw-nmea' && !kinds.GST ? 'нет GST с точностью в метрах' : 'точность в метрах не подтверждена');
    }
    if (fix.accuracyM > 15) return label + ': точность хуже 15 м, предупреждения недоступны';
    if (!number(fix.speedKmh) || !number(fix.headingDeg)) return label + ': координаты есть; скорость или курс не подтверждены';
    return label + ': свежие координаты, скорость, курс и точность получены';
  }
  if (bridge.state === 'unavailable') return 'Мост GPS BMW недоступен' + (bridge.errorCode ? ' (' + bridge.errorCode + ')' : '');
  if (bridge.state === 'error') return 'Ошибка моста GPS BMW' + (bridge.errorCode ? ' (' + bridge.errorCode + ')' : '');
  if (bridge.state === 'stopped') return 'Мост GPS BMW не запущен';
  if (bridge.state === 'starting') return 'Подключение к GPS BMW';
  if (!d.gpsInput.packets) return 'BMW: подписка активна, ожидание NMEA';
  if (!kinds.RMC) return 'BMW: не получено RMC с датой, скоростью и курсом';
  if (!kinds.GGA) return 'BMW: не получено GGA с качеством фиксации';
  if (d.gpsInput.rejectReason === 'GGA no satellite-quality fix') return 'BMW: приёмник не подтвердил спутниковую фиксацию';
  if (d.gpsInput.rejectReason === 'RMC invalid or simulated') return 'BMW: NMEA без достоверной фиксации или в режиме симуляции';
  if (d.gpsInput.sourceUtcAgeMs !== null && (d.gpsInput.sourceUtcAgeMs > MAX_AGE || d.gpsInput.sourceUtcAgeMs < -500))
    return 'BMW: UTC NMEA устарело или отличается от часов машины';
  if (timing.pairReason === 'RMC_GGA_OFFSET') return 'BMW: UTC RMC/GGA не совпадает (' + Math.round(timing.rmcGgaDeltaMs) + ' мс; максимум 500 мс)';
  if (timing.pairReason === 'POSITION_MISMATCH') return 'BMW: координаты RMC/GGA расходятся больше чем на 50 м';
  if (timing.pairReason === 'STALE_GGA') return 'BMW: UTC позиции GGA устарело или отличается от часов машины';
  if (timing.lastRmcAgeMs !== null && timing.lastRmcAgeMs > MAX_AGE) return 'BMW: сообщения RMC не обновляются';
  if (timing.lastGgaAgeMs !== null && timing.lastGgaAgeMs > MAX_AGE) return 'BMW: сообщения GGA не обновляются';
  return 'BMW: нет свежей достоверной фиксации UTC (максимум 3 с)';
};
GpsProvider.prototype.bindUdpHandlers = function () {
  var self=this,udp=this.udp,gen=this.generation;
  if(!udp)return;
  if(this.udpMessageHandler)udp.removeListener('message',this.udpMessageHandler);
  if(this.udpErrorHandler)udp.removeListener('error',this.udpErrorHandler);
  this.udpMessageHandler=function(data){if(self.closed||self.udp!==udp||self.generation!==gen)return;if(data.length<=8192)String(data).split(/\r?\n/).forEach(function(line){self.decoder.line(line);});};
  this.udpErrorHandler=function(err){if(!self.closed&&self.udp===udp&&self.generation===gen)self.emit('status','Внешний NMEA UDP: '+err.code);};
  udp.on('message',this.udpMessageHandler);udp.on('error',this.udpErrorHandler);
};
GpsProvider.prototype.resetEpoch = function (now) {
  if(!number(now))throw new Error('GPS_RESET_TIME_INVALID');
  this.generation++;
  this.decoder.resetEpoch(now+500);this.bmwDecoder.resetEpoch(now+500);
  this.input.fixUtc=null;this.input.lastPacketAt=null;
  clearTimeout(this.retry);this.retry=null;
  var old=this.sock;this.sock=null;if(old)old.destroy();
  this.bindUdpHandlers();
  if(!this.closed)this.connect();
  this.emit('status','История GPS очищена; ожидание новых UTC после ручного сброса');
  return {phase:'waiting-new-fix',generation:this.generation,afterUtc:now+500};
};
GpsProvider.prototype.start = function () {
  var self = this; this.closed = false; this.connect();
  if (this.options.nmeaPort === 0) return;
  this.udp = dgram.createSocket('udp4');
  this.bindUdpHandlers();
  var udp=this.udp;
  this.udp.bind(this.options.nmeaPort || 5001, this.options.nmeaHost || '127.0.0.1', function () { if(!self.closed&&self.udp===udp)self.emit('status', 'Внешний NMEA UDP: ожидание пакетов'); });
};
GpsProvider.prototype.connect = function () {
  if (this.closed || this.sock) return;
  var self = this, gen=this.generation, buffer = '', sock = net.connect(this.options.port || 2947, this.options.host || '127.0.0.1');
  this.sock = sock; sock.setEncoding('utf8'); sock.setTimeout(15000);
  sock.on('connect', function () { if(self.closed||self.generation!==gen||self.sock!==sock)return;self.emit('status', 'Внешний GPSD подключён; ожидание UTC'); sock.write('?WATCH={"enable":true,"json":true};\n'); });
  sock.on('data', function (chunk) {
    if(self.closed||self.generation!==gen||self.sock!==sock)return;
    buffer += chunk; if (buffer.length > 65536) { sock.destroy(); return; }
    var nl; while ((nl = buffer.indexOf('\n')) >= 0) { var line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1); try { self.decoder.json(JSON.parse(line)); } catch (err) {} }
  });
  sock.on('timeout', function () { sock.destroy(); });
  sock.on('error', function (err) { if(!self.closed&&self.generation===gen&&self.sock===sock)self.emit('status', 'Внешний GPSD: ' + err.code); });
  sock.on('close', function () {
    if (self.sock !== sock) return; self.sock = null;
    if (!self.closed) self.retry = setTimeout(function () { self.retry = null; self.connect(); }, self.options.retryMs || 5000);
  });
};
GpsProvider.prototype.current = function (now) {
  var a = this.decoder.current(now), b = this.bmwDecoder.current(now);
  if (!a) return b; if (!b) return a;
  return b.timeMs > a.timeMs || (b.timeMs === a.timeMs && number(b.accuracyM) && !number(a.accuracyM)) ? b : a;
};
GpsProvider.prototype.close = function () {
  this.closed = true; this.generation++; clearTimeout(this.retry); if (this.sock) this.sock.destroy();
  if (this.udp) { try { this.udp.close(); } catch (err) {} }
  this.sock = null; this.udp = null;
};
module.exports = { GpsProvider: GpsProvider, GpsDecoder: GpsDecoder, coordinate: coordinate, fresh: fresh, sentence: sentence, BRIDGE_STATES: BRIDGE_STATES };
