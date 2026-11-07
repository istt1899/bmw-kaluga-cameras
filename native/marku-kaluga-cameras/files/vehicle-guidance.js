'use strict';
const pack = require('./road-zones.json');
const database = require('./kaluga-speed.json');
const info = require('./camera-info');
const preferences = require('./alert-preferences');
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
function candidate(z, fix, range, diagnostic, tracking) {
    const x = (fix.lon - z.lon) * 111320 * Math.cos(z.lat * Math.PI / 180), y = (fix.lat - z.lat) * 111320;
    const reject = reason => { if (diagnostic) diagnostic.reason = reason; return null; };
    if (x * x + y * y > (range + 20) * (range + 20)) return reject('OUT_OF_RANGE');
    const hits = z.roads.map(r => project(r, x, y)).filter(Boolean).sort((a, b) => a.error - b.error), hit = hits[0];
    if (diagnostic && hit) { diagnostic.way = hit.road.id; diagnostic.lateralErrorM = hit.error; }
    // Retention never expands the source road corridor or its heading gates.
    if (!hit || hit.error > Math.min(12, Math.max(6, fix.accuracyM))) return reject('OFF_ROAD');
    if (hit.road.cam === null) return reject('CAMERA_WAY_MISSING');
    if (hits.slice(1).some(other => other.error - hit.error < Math.max(8, fix.accuracyM + 3))) return reject('AMBIGUOUS_ROAD');
    if (tracking && hit.road.id !== tracking.way) return reject('ROAD_CHANGED');
    const offset = hit.road.cam - hit.s, sign = tracking ? tracking.sign : offset > 0 ? 1 : -1;
    const signedDistance = offset * sign, distanceM = Math.max(0, signedDistance);
    if (tracking && signedDistance < -0.000001) return reject('CAMERA_PASSED');
    // A confirmed approach continues up to the actual point. Admission still
    // needs a camera at least eight metres ahead, not a just-passed point.
    if ((!tracking && distanceM < 8) || distanceM > range + 0.000001) return reject('OUT_OF_RANGE');
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
function key(item) { return item.id + ':' + item.way + ':' + item.sign; }
function mode(item) { return !item ? 'none' : item.roadConfirmed ? 'road' : 'nearby'; }
function jitter(fix) { return Math.max(6, Math.min(15, fix.accuracyM * 2)); }
function plausible(previous, next, fix, dt) {
    return previous && dt > 0 && dt <= 3 && Math.abs(previous.distanceM - next.distanceM) <= fix.speedKmh / 3.6 * dt * 2 + 6;
}
function approaches(previous, next, fix, dt) {
    return plausible(previous, next, fix, dt) && previous.distanceM - next.distanceM > .5;
}
function createGuidance(data) {
    const zones = (data || pack).zones.map(prepare);
    const records = data && data.records || (data ? data.zones.map(z => ({ id: z.id, position: { lat: z.lat, lon: z.lon },
        type: 'speed', controls: ['speed'], limitKmh: z.limit })) : database.records);
    const byId = {}, zoneById = {}; records.forEach(r => { byId[r.id] = r; }); zones.forEach(z => { zoneById[z.id] = z; });
    const describeCamera = info.createDescriber(records);
    let prior = {}, priorNearby = {}, active = null, anchor = null, closest = null, heading = null, lastTime = null, lastSource = null, settingsKey = null;
    // A passed or wrong-road camera cannot instantly return via proximity.
    let passed = {}, lastTransition = null, lastClear = null;
    let state = { mode: 'none', reason: 'WAITING_GPS', zoneCount: zones.length, cameraCount: records.length };
    function transition(previous, reason, f, gpsReason) {
        const changed = mode(previous) !== mode(active) || previous && active && previous.id !== active.id;
        const code = active ? !previous ? 'ENTERED' : 'SWITCHED' : previous ? 'CLEARED_' + reason : 'WAITING';
        if (changed || !lastTransition) lastTransition = { from: mode(previous), to: mode(active), reason: code,
            cameraId: active ? active.id : previous ? previous.id : null, timeMs: f && Number.isFinite(f.timeMs) ? f.timeMs : null };
        if (previous && !active) {
            lastClear = { reason, cameraId: previous.id, timeMs: f && Number.isFinite(f.timeMs) ? f.timeMs : null };
            if (gpsReason) lastClear.gpsReason = gpsReason;
        }
        // Routine 1 Hz ticks must not overwrite the explanation of a withdrawal.
        state.transition = Object.assign({}, lastTransition);
        state.lastClear = lastClear && Object.assign({}, lastClear);
    }
    function clear(reason, f, restart, gpsReason) {
        const previous = active;
        prior = {}; priorNearby = {}; active = anchor = closest = heading = null;
        if (restart) { lastTime = lastSource = null; settingsKey = null; passed = {}; lastTransition = lastClear = null; }
        state = { mode: 'none', reason, zoneCount: zones.length, cameraCount: records.length };
        if (f && Number.isFinite(f.timeMs)) state.fixTimeMs = f.timeMs;
        transition(previous, reason, f, gpsReason); return null;
    }
    return { evaluate(f, now, enabled, rawPreferences) {
        if (!enabled) return clear('DISABLED', f);
        if (!validPosition(f, now)) {
            const why = !f ? 'FIX_MISSING' : !Number.isFinite(f.accuracyM) || f.accuracyM <= 0 ? 'ACCURACY_MISSING' : f.accuracyM > 15 ? 'ACCURACY_EXCEEDS_15M' :
                !Number.isFinite(f.timeMs) || !Number.isFinite(now) ? 'UTC_MISSING' : now - f.timeMs > 3000 ? 'UTC_EXPIRED' : f.timeMs > now + 500 ? 'UTC_FUTURE' : 'POSITION_INVALID';
            clear('GPS_INVALID', f, false, why); state.gpsReason = why;
            return null;
        }
        if (lastTime !== null && f.timeMs < lastTime) return clear('GPS_REPLAY', f);
        const prefs = preferences.normalize(rawPreferences), signature = JSON.stringify(prefs);
        const changedSettings = settingsKey !== null && signature !== settingsKey;
        if (changedSettings) { prior = {}; priorNearby = {}; }
        settingsKey = signature;
        const fresh = lastTime === null || f.timeMs > lastTime, dt = lastTime === null ? 0 : (f.timeMs - lastTime) / 1000;
        if (!fresh && lastSource && distance(f, lastSource) > jitter(f)) {
            clear('GPS_REPLAY', f, false, 'SOURCE_CHANGED'); state.gpsReason = 'SOURCE_CHANGED';
            return null;
        }
        if (fresh) { lastTime = f.timeMs; lastSource = { lat: f.lat, lon: f.lon }; }
        const previous = active, range = prefs.warningDistanceM;
        const moving = Number.isFinite(f.speedKmh) && f.speedKmh >= 8 && Number.isFinite(f.headingDeg) && f.headingDeg >= 0 && f.headingDeg < 360;
        const trackingMoving = Number.isFinite(f.speedKmh) && f.speedKmh >= 3 && Number.isFinite(f.headingDeg) && f.headingDeg >= 0 && f.headingDeg < 360;
        const stopped = Number.isFinite(f.speedKmh) && f.speedKmh >= 0 && f.speedKmh < 3;
        const nearby = records.map(r => ({ record: r, distanceM: distance(f, r.position) })).sort((a, b) => a.distanceM - b.distanceM);
        const enabledRecords = nearby.filter(item => preferences.matches(item.record, prefs));
        const nearest = enabledRecords[0] || nearby[0] || null, debug = {};
        const ownZone = nearest && zoneById[nearest.record.id];
        if (moving && ownZone) candidate(ownZone, f, range, debug);
        state = { mode: 'none', reason: !enabledRecords.length && nearby.length ? 'TYPE_DISABLED' : !moving ? 'WAITING_MOTION' : debug.reason || (ownZone ? 'WAITING_APPROACH' : 'NO_ROAD_ZONE'),
            zoneCount: zones.length, cameraCount: records.length, cameraId: nearest && nearest.record.id,
            distanceM: nearest && nearest.distanceM, way: debug.way || null, lateralErrorM: debug.lateralErrorM,
            fixTimeMs: f.timeMs, observedAtMs: now, approachSamples: 0, warningDistanceM: range };
        state.roadReason = state.reason;
        state.candidates = nearby.slice(0, 3).map(item => {
            const zone = zoneById[item.record.id], detail = {};
            if (moving && zone) candidate(zone, f, range, detail);
            return { id: item.record.id, distanceM: Math.round(item.distanceM), reason: !preferences.matches(item.record, prefs) ? 'TYPE_DISABLED' :
                item.distanceM > range + 0.000001 ? 'OUT_OF_RANGE' : !moving ? 'WAITING_MOTION' : zone ? detail.reason || 'WAITING_APPROACH' : 'NO_ROAD_ZONE',
                way: detail.way || null, lateralErrorM: detail.lateralErrorM === undefined ? null : detail.lateralErrorM };
        });
        const roadCandidates = moving ? zones.filter(z => byId[z.id] && preferences.matches(byId[z.id], prefs)).map(z => candidate(z, f, range)).filter(Boolean).sort((a, b) => a.distanceM - b.distanceM) : [];
        let selected = null, retained = false, clearReason = null;
        if (previous && !preferences.matches(byId[previous.id], prefs)) clearReason = 'TYPE_DISABLED';
        else if (previous && previous.distanceM > range + 0.000001 && !fresh) clearReason = 'OUT_OF_RANGE';
        if (previous && previous.roadConfirmed && !clearReason) {
            const detail = {}, zone = zoneById[previous.id];
            let tracking = null;
            if (trackingMoving && zone) tracking = candidate(zone, f, range, detail, previous);
            else if (stopped && zone && anchor && Number.isFinite(heading) && distance(f, anchor) <= Math.max(15, f.accuracyM * 2)) {
                tracking = candidate(zone, Object.assign({}, f, { headingDeg: heading }), range, detail, previous);
                if (tracking) tracking.stopped = true;
            } else detail.reason = 'WAITING_MOTION';
            if (tracking && closest !== null && tracking.distanceM > closest + jitter(f)) detail.reason = 'APPROACH_LOST';
            else if (tracking && fresh && trackingMoving && dt > 0 && !plausible(previous, tracking, f, dt)) detail.reason = 'POSITION_JUMP';
            else if (tracking) { selected = tracking; retained = true; state.approachSamples = 2; }
            if (!selected) {
                clearReason = detail.reason || 'APPROACH_LOST';
                if (['CAMERA_PASSED', 'ROAD_CHANGED', 'CAMERA_WAY_MISSING', 'ONEWAY_MISMATCH', 'HEADING_MISMATCH', 'CAMERA_DIRECTION'].indexOf(clearReason) >= 0) {
                    passed[previous.id] = true; delete priorNearby[previous.id];
                }
            }
        }
        // Independent histories avoid nearest-camera switching resetting entry.
        const confirmed = fresh ? roadCandidates.filter(next => approaches(prior[key(next)], next, f, dt)) : [];
        const nextRoad = confirmed[0] || null;
        if (nextRoad && (!selected || nextRoad.id !== selected.id && nextRoad.distanceM + jitter(f) < selected.distanceM)) {
            selected = nextRoad; retained = false; state.approachSamples = 2; delete passed[nextRoad.id];
        } else if (!selected && roadCandidates.length) state.approachSamples = fresh && prior[key(roadCandidates[0])] ? 2 : 1;
        const nearbyCandidates = [];
        for (const item of enabledRecords) {
            const r = item.record, d = item.distanceM;
            if (d > range + 0.000001) continue;
            const dx = (r.position.lon - f.lon) * Math.cos(f.lat * Math.PI / 180), dy = r.position.lat - f.lat;
            const anchoredStop = stopped && anchor && distance(f, anchor) <= Math.max(15, f.accuracyM * 2);
            const trackingCourse = trackingMoving ? f.headingDeg : anchoredStop && Number.isFinite(heading) ? heading : null;
            const delta = trackingCourse === null ? null : diff(angle(dx, dy), trackingCourse);
            const immediate = d <= 120 && (stopped || moving && (d <= 0.000001 || delta <= 100));
            const entry = moving && delta <= 25 && d * Math.sin(delta * Math.PI / 180) <= Math.max(18, f.accuracyM * 1.5);
            const tracked = previous && !previous.roadConfirmed && previous.id === r.id;
            // Bounded exit margins apply only to honest proximity notices.
            const continuation = tracked && trackingCourse !== null && delta <= 32 && d * Math.sin(delta * Math.PI / 180) <= Math.max(18, f.accuracyM * 1.5) + Math.min(10, f.accuracyM);
            const next = { id: r.id, distanceM: d, confidence: 'nearby', roadConfirmed: false, limitKmh: null };
            const approaching = fresh && entry && approaches(priorNearby[r.id], next, f, dt);
            if (entry) nearbyCandidates.push(next);
            const closeTracking = d <= 120 && (d <= 0.000001 || trackingCourse === null && stopped || trackingCourse !== null && delta <= 100);
            const stable = tracked && !clearReason && closest !== null && d <= closest + jitter(f) &&
                (closeTracking || continuation) && (!fresh || anchoredStop || plausible(previous, next, f, dt));
            if (stable) { next.retained = true; nearbyCandidates.push({ selected: next }); }
            else if ((!tracked && immediate && !passed[r.id] || approaching) && !(previous && previous.roadConfirmed && previous.id === r.id && clearReason)) {
                if (approaching) delete passed[r.id];
                nearbyCandidates.push({ selected: next });
            } else if (tracked && !clearReason) {
                clearReason = d > (closest === null ? d : closest) + jitter(f) ? 'APPROACH_LOST' : 'BEARING_CHANGED'; passed[r.id] = true;
            }
            if (tracked && trackingCourse !== null && delta > 100) passed[r.id] = true;
        }
        if (!selected && (!data || data.nearby !== false)) {
            const possible = nearbyCandidates.filter(item => item.selected).map(item => item.selected);
            const old = possible.find(item => previous && !previous.roadConfirmed && item.id === previous.id && item.retained);
            const first = possible[0] || null;
            const sameControls = first && old && info.controls(byId[first.id]).filter(type => prefs.cameraTypes[type]).sort().join(',') ===
                info.controls(byId[old.id]).filter(type => prefs.cameraTypes[type]).sort().join(',');
            // Distinct controls must not be hidden by ID hysteresis: a closer
            // red-light record still supersedes a nearby speed-only record.
            selected = old && (!first || sameControls && first.distanceM + jitter(f) >= old.distanceM) ? old : first;
            if (selected) { retained = !!selected.retained; delete selected.retained; }
        }
        if (fresh) {
            prior = {}; roadCandidates.forEach(item => { prior[key(item)] = item; });
            priorNearby = {}; nearbyCandidates.filter(item => !item.selected).forEach(item => { priorNearby[item.id] = item; });
        }
        active = selected ? Object.assign({}, describeCamera(byId[selected.id]), selected) : null;
        if (active) {
            const same = previous && previous.id === active.id && mode(previous) === mode(active);
            closest = same && closest !== null ? Math.min(closest, active.distanceM) : active.distanceM;
            state.mode = mode(active);
            state.reason = active.stopped ? 'STOPPED_APPROACH' : active.roadConfirmed ? retained ? 'TRACKING_APPROACH' : 'ROAD_APPROACH' : retained ? 'NEARBY_TRACKING' : 'NEARBY_ONLY';
            if (active.roadConfirmed) state.roadReason = state.reason;
            else if (previous && previous.roadConfirmed && clearReason) state.roadReason = clearReason;
            state.cameraId = active.id; state.distanceM = active.distanceM;
            if (active.roadConfirmed) {
                state.way = active.way;
            }
            if (trackingMoving && fresh) { anchor = { lat: f.lat, lon: f.lon }; heading = f.headingDeg; }
            else if (!same) { anchor = { lat: f.lat, lon: f.lon }; heading = null; }
            state.candidates.forEach(c => { if (c.id === active.id) c.reason = state.reason; });
        } else {
            anchor = closest = heading = null;
            if (previous) state.reason = state.roadReason = clearReason || (nearest && nearest.distanceM > range ? 'OUT_OF_RANGE' : state.reason);
        }
        transition(previous, clearReason || state.reason, f);
        return active;
    }, reset: () => clear('RESET', null, true), diagnostic: () => Object.assign({}, state), count: zones.length };
}
module.exports = { createGuidance, validPosition };
