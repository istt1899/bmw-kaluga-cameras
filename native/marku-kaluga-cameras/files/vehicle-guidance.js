'use strict';
const pack = require('./road-zones.json');
const database = require('./kaluga-speed.json');
const info = require('./camera-info');
function angle(x, y) { return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360; }
function diff(a, b) { return Math.abs((a - b + 540) % 360 - 180); }
function distance(a, b) {
    const x = (b.lon - a.lon) * 111320 * Math.cos((a.lat + b.lat) * Math.PI / 360), y = (b.lat - a.lat) * 111320;
    return Math.hypot(x, y);
}
function prepare(z) {
    return Object.assign({}, z, { roads: z.roads.map(r => {
        const lengths = [0], segments = [];
        for (let i = 1; i < r.pts.length; i++) {
            const a = r.pts[i - 1], b = r.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
            lengths.push(lengths[i - 1] + len);
            if (len) segments.push({ x: a[0], y: a[1], dx, dy, len, s: lengths[i - 1], bearing: angle(dx, dy) });
        }
        return { segments, id: r.id, cam: r.cam < 0 ? null : lengths[r.cam], dir: r.dir };
    }) });
}
function project(road, x, y) {
    let nearest = null;
    for (const seg of road.segments) {
        const t = Math.max(0, Math.min(1, ((x - seg.x) * seg.dx + (y - seg.y) * seg.dy) / (seg.len * seg.len)));
        const error = Math.hypot(x - seg.x - t * seg.dx, y - seg.y - t * seg.dy);
        if (!nearest || error < nearest.error) nearest = { road, error, s: seg.s + t * seg.len, bearing: seg.bearing };
    }
    return nearest;
}
function candidate(z, fix, diagnostic) {
    const x = (fix.lon - z.lon) * 111320 * Math.cos(z.lat * Math.PI / 180), y = (fix.lat - z.lat) * 111320;
    const range = Math.max(220, Math.min(600, fix.speedKmh / 3.6 * 24));
    const reject = reason => { if (diagnostic) diagnostic.reason = reason; return null; };
    if (x * x + y * y > (range + 20) * (range + 20)) return reject('OUT_OF_RANGE');
    const hits = z.roads.map(r => project(r, x, y)).filter(Boolean).sort((a, b) => a.error - b.error), hit = hits[0];
    if (diagnostic && hit) { diagnostic.way = hit.road.id; diagnostic.lateralErrorM = hit.error; }
    if (!hit || hit.error > Math.min(12, Math.max(6, fix.accuracyM))) return reject('OFF_ROAD');
    if (hit.road.cam === null) return reject('CAMERA_WAY_MISSING');
    if (hits.slice(1).some(other => other.error - hit.error < Math.max(8, fix.accuracyM + 3))) return reject('AMBIGUOUS_ROAD');
    const offset = hit.road.cam - hit.s, sign = offset > 0 ? 1 : -1, distanceM = Math.abs(offset);
    if (distanceM < 8 || distanceM > range) return reject('OUT_OF_RANGE');
    if (hit.road.dir && hit.road.dir !== sign) return reject('ONEWAY_MISMATCH');
    if (diff((hit.bearing + (sign < 0 ? 180 : 0)) % 360, fix.headingDeg) > 32) return reject('HEADING_MISMATCH');
    const end = hit.road.cam - sign;
    const at = hit.road.segments.find(s => s.s <= end && end <= s.s + s.len);
    if (!at || !z.travel.some(h => diff(h, (at.bearing + (sign < 0 ? 180 : 0)) % 360) <= 35)) return reject('CAMERA_DIRECTION');
    return { id: z.id, way: hit.road.id, sign, distanceM, limitKmh: z.limit, confidence: 'road', roadConfirmed: true };
}
function validPosition(f, now) {
    return f && [f.timeMs, f.lat, f.lon, f.accuracyM, now].every(Number.isFinite) &&
        Math.abs(f.lat) <= 90 && Math.abs(f.lon) <= 180 && f.accuracyM > 0 && f.accuracyM <= 15 &&
        now - f.timeMs <= 3000 && f.timeMs <= now + 500;
}
function createGuidance(data) {
    const zones = (data || pack).zones.map(prepare);
    const records = data && data.records || (data ? data.zones.map(z => ({ id: z.id, position: { lat: z.lat, lon: z.lon },
        type: 'speed', controls: ['speed'], limitKmh: z.limit })) : database.records);
    const byId = {}; records.forEach(r => { byId[r.id] = r; });
    let prior = null, priorNearby = null, active = null, anchor = null, lastTime = 0;
    let state = { mode: 'none', reason: 'WAITING_GPS', zoneCount: zones.length, cameraCount: records.length };
    function reset(reason) {
        prior = priorNearby = active = anchor = null; lastTime = 0;
        state = { mode: 'none', reason, zoneCount: zones.length, cameraCount: records.length }; return null;
    }
    return { evaluate(f, now, enabled) {
        if (!enabled) return reset('DISABLED');
        if (!validPosition(f, now)) return reset('GPS_INVALID');
        if (f.timeMs < lastTime) return reset('GPS_REPLAY');
        if (lastTime === f.timeMs) return active;
        const dt = (f.timeMs - lastTime) / 1000; lastTime = f.timeMs;
        const moving = Number.isFinite(f.speedKmh) && f.speedKmh >= 8 && Number.isFinite(f.headingDeg) && f.headingDeg >= 0 && f.headingDeg < 360;
        const nearby = records.map(r => ({ record: r, distanceM: distance(f, r.position) })).sort((a, b) => a.distanceM - b.distanceM);
        const nearest = nearby[0] || null, debug = {};
        const ownZone = nearest && zones.find(z => z.id === nearest.record.id);
        if (moving && ownZone) candidate(ownZone, f, debug);
        state = { mode: 'none', reason: !moving ? 'WAITING_MOTION' : debug.reason || (ownZone ? 'WAITING_APPROACH' : 'NO_ROAD_ZONE'),
            zoneCount: zones.length, cameraCount: records.length, cameraId: nearest && nearest.record.id,
            distanceM: nearest && nearest.distanceM, way: debug.way || null, lateralErrorM: debug.lateralErrorM,
            fixTimeMs: f.timeMs, observedAtMs: now, approachSamples: 0 };
        state.roadReason = state.reason;
        state.candidates = nearby.slice(0,3).map(item => {
            const zone=zones.find(z=>z.id===item.record.id), detail={};
            if(moving&&zone)candidate(zone,f,detail);
            return {id:item.record.id,distanceM:Math.round(item.distanceM),reason:!moving?'WAITING_MOTION':zone?detail.reason||'WAITING_APPROACH':'NO_ROAD_ZONE',
                way:detail.way||null,lateralErrorM:detail.lateralErrorM===undefined?null:detail.lateralErrorM};
        });
        const next = moving ? zones.map(z => candidate(z, f)).filter(Boolean).sort((a, b) => a.distanceM - b.distanceM)[0] || null : null;
        let selected = null;
        if (next && prior && dt > 0 && dt <= 3 && prior.id === next.id && prior.way === next.way && prior.sign === next.sign) {
            const gain = prior.distanceM - next.distanceM;
            state.approachSamples = 2;
            if (gain > .5 && gain <= f.speedKmh / 3.6 * dt * 2 + 6) selected = next;
        } else if (next) state.approachSamples = 1;
        // Fresh coordinates at a red-light stop keep a previously matched approach.
        if (!moving && Number.isFinite(f.speedKmh) && f.speedKmh < 3 && active && active.roadConfirmed && anchor &&
            distance(f, anchor) <= Math.max(15, f.accuracyM * 2)) {
            selected = Object.assign({}, active, { distanceM: distance(f, byId[active.id].position), stopped: true });
        }
        prior = next;
        // A nearby notice describes proximity only, never a confirmed driving lane.
        let vicinity = null;
        for (const item of nearby) {
            const r = item.record, d = item.distanceM;
            const dx = (r.position.lon - f.lon) * Math.cos(f.lat * Math.PI / 180), dy = r.position.lat - f.lat;
            const delta = moving ? diff(angle(dx, dy), f.headingDeg) : null;
            if (d <= 120 && (!moving || d <= 25 || delta <= 100)) { vicinity = { id: r.id, distanceM: d }; break; }
            if (!moving || d > Math.max(220, Math.min(600, f.speedKmh / 3.6 * 24)) || delta > 25 ||
                d * Math.sin(delta * Math.PI / 180) > Math.max(18, f.accuracyM * 1.5)) continue;
            if (priorNearby && priorNearby.id === r.id && dt > 0 && dt <= 3 &&
                priorNearby.distanceM - d > .5 && priorNearby.distanceM - d <= f.speedKmh / 3.6 * dt * 2 + 6) {
                vicinity = { id: r.id, distanceM: d }; break;
            }
        }
        const tracking = nearby.find(item => {
            if (!moving) return false;
            const p = item.record.position, delta = diff(angle((p.lon - f.lon) * Math.cos(f.lat * Math.PI / 180), p.lat - f.lat), f.headingDeg);
            return delta <= 25 && item.distanceM * Math.sin(delta * Math.PI / 180) <= Math.max(18, f.accuracyM * 1.5);
        });
        priorNearby = tracking ? { id: tracking.record.id, distanceM: tracking.distanceM } : null;
        if (!selected && vicinity && (!data || data.nearby !== false)) selected = Object.assign({}, vicinity, { confidence: 'nearby', roadConfirmed: false, limitKmh: null });
        active = selected ? Object.assign({}, info.describe(byId[selected.id]), selected) : null;
        if (active) {
            state.mode = active.roadConfirmed ? 'road' : 'nearby';
            state.reason = active.stopped ? 'STOPPED_APPROACH' : active.roadConfirmed ? 'ROAD_APPROACH' : 'NEARBY_ONLY';
            if (active.roadConfirmed) state.roadReason = state.reason;
            state.cameraId = active.id; state.distanceM = active.distanceM;
            if (active.roadConfirmed) { state.way = active.way; if (!active.stopped) anchor = { lat: f.lat, lon: f.lon }; }
            state.candidates.forEach(c=>{if(c.id===active.id)c.reason=state.reason;});
        } else anchor = null;
        return active;
    }, reset: () => reset('RESET'), diagnostic: () => Object.assign({}, state), count: zones.length };
}
module.exports = { createGuidance, validPosition };
