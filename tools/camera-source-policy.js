'use strict';
// Host-only publication policy for normalized, per-field observations. This
// checks documented source permission and semantics, not the truth of a camera
// claim. It neither downloads a feed nor changes the runtime camera database.
const URL = require('url').URL;
const STATUSES = ['approved', 'reference-only', 'not-established'];
const ACCESS = ['public-data', 'owner-supplied', 'public-reference', 'restricted-service', 'javascript-required', 'public-documentation', 'partner-sdk', 'unavailable'];
const FIELDS = ['position', 'controls', 'limitKmh', 'approachBearing', 'cameraFacingBearing', 'captureSide',
    'model', 'description', 'status', 'street', 'roadName', 'roadRef', 'lane', 'lanes', 'mobility', 'recordKind',
    'type', 'title', 'positionKind', 'averageSpeedSection'];
const MAX_MOBILE_TTL_MS = 24 * 60 * 60 * 1000;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function timestamp(value) {
    if (typeof value !== 'string') return false;
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    return new Date(value).toISOString() === match[1] + '.' + (match[2] || '').padEnd(3, '0') + 'Z';
}
function url(value) {
    if (!text(value, 2048)) return null;
    try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port ? parsed : null; }
    catch (ignored) { return null; }
}
function bounded(value, depth, budget) {
    budget = budget || { nodes: 0, chars: 0 };
    if (++budget.nodes > 4096) fail('POLICY_INPUT_SIZE');
    if (typeof value === 'string') { budget.chars += value.length; if (budget.chars > 131072) fail('POLICY_INPUT_SIZE'); }
    if (depth > 8) fail('POLICY_INPUT_DEPTH');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && value.length <= 4096 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return;
    if (Array.isArray(value) && value.length <= 64) { value.forEach(item => bounded(item, depth + 1, budget)); return; }
    if (object(value)) {
        const keys = Object.keys(value);
        if (keys.length > 64 || keys.some(key => key.length > 128 || ['__proto__', 'prototype', 'constructor'].indexOf(key) >= 0)) fail('POLICY_INPUT_KEYS');
        keys.forEach(key => bounded(value[key], depth + 1, budget)); return;
    }
    fail('POLICY_INPUT_VALUE');
}
function validateRegistry(registry) {
    bounded(registry, 0);
    if (!object(registry) || registry.schema !== 1 || registry.region !== 'RU-KLU' || !timestamp(registry.checkedAt) ||
        !Array.isArray(registry.sources) || !registry.sources.length || registry.sources.length > 64) fail('SOURCE_REGISTRY_INVALID');
    const ids = new Set();
    registry.sources.forEach(source => {
        if (!object(source) || !/^[a-z][a-z0-9-]{0,63}$/.test(source.id || '') || ids.has(source.id) ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(source.family || '') || STATUSES.indexOf(source.redistribution) < 0 ||
            !text(source.rightsBasis, 1600) || !text(source.attribution, 1000) || !Array.isArray(source.urls) ||
            !source.urls.length || source.urls.length > 16 || source.urls.some(value => !url(value)) ||
            !object(source.access) || ACCESS.indexOf(source.access.status) < 0 || !timestamp(source.access.checkedAt) ||
            source.requiresConsent !== undefined && typeof source.requiresConsent !== 'boolean') fail('SOURCE_ENTRY_INVALID');
        ids.add(source.id);
    });
    return JSON.parse(JSON.stringify(registry));
}
function semanticReasons(name, fact) {
    const reasons = [];
    if (name === 'position' && (!object(fact.value) || !Number.isFinite(fact.value.lat) || !Number.isFinite(fact.value.lon) ||
        Math.abs(fact.value.lat) > 90 || Math.abs(fact.value.lon) > 180)) reasons.push('POSITION_VALUE_INVALID');
    if (name === 'limitKmh') {
        if (fact.value !== null && (!Number.isInteger(fact.value) || fact.value < 5 || fact.value > 300)) reasons.push('LIMIT_VALUE_INVALID');
        if (fact.value !== null && fact.basis !== 'explicit') reasons.push('LIMIT_NOT_EXPLICIT');
    }
    if (name === 'approachBearing' || name === 'cameraFacingBearing') {
        if (!Number.isFinite(fact.value) || fact.value < 0 || fact.value >= 360) reasons.push('DIRECTION_VALUE_INVALID');
        const required = name === 'approachBearing' ? 'vehicle-travel' : 'camera-facing';
        if (fact.semantics !== required) reasons.push('DIRECTION_SEMANTICS_MISMATCH');
    }
    if (name === 'captureSide') {
        if (['front', 'rear', 'both', 'unknown'].indexOf(fact.value) < 0) reasons.push('CAPTURE_SIDE_INVALID');
        if (fact.value !== 'unknown' && fact.basis !== 'explicit') reasons.push('CAPTURE_SIDE_NOT_EXPLICIT');
    }
    if (name === 'controls') {
        if (!Array.isArray(fact.value) || fact.value.length > 16 || fact.value.some(value => !text(value, 64))) reasons.push('CONTROLS_VALUE_INVALID');
        if (Array.isArray(fact.value) && fact.value.length && fact.basis !== 'explicit') reasons.push('CONTROLS_NOT_EXPLICIT');
    }
    return reasons;
}
function assessObservation(observation, registry, options) {
    const valid = validateRegistry(registry), sources = Object.create(null);
    valid.sources.forEach(source => { sources[source.id] = source; });
    bounded(observation, 0);
    if (!object(observation) || !text(observation.id, 160) || !object(observation.facts) ||
        !Object.keys(observation.facts).length || Object.keys(observation.facts).length > 24) fail('OBSERVATION_INVALID');
    options = options || {};
    const now = options.nowMs === undefined ? Date.now() : options.nowMs;
    if (!Number.isFinite(now)) fail('POLICY_NOW_INVALID');
    const mobile = observation.mobility === 'mobile' || observation.facts.mobility && observation.facts.mobility.value === 'mobile';
    const result = { id: observation.id, eligibleForPublication: false, acceptedFacts: {}, rejectedFacts: {},
        factEvidence: {}, reasons: [], independentFamilies: [], independentFamilyCount: 0, verification: 'not-assessed' };
    const allFamilies = new Set();
    Object.keys(observation.facts).forEach(name => {
        const fact = observation.facts[name], rejected = [], evidence = [], families = new Set();
        if (FIELDS.indexOf(name) < 0) rejected.push('FACT_NAME_UNSUPPORTED');
        if (!object(fact) || !Object.prototype.hasOwnProperty.call(fact, 'value')) rejected.push('FACT_VALUE_MISSING');
        if (!object(fact) || !Array.isArray(fact.evidence) || !fact.evidence.length || fact.evidence.length > 16) rejected.push('FIELD_PROVENANCE_REQUIRED');
        else fact.evidence.forEach(item => {
            const reasons = [], source = object(item) && sources[item.sourceId];
            if (!source) reasons.push('SOURCE_UNKNOWN');
            else {
                if (source.redistribution !== 'approved') reasons.push('SOURCE_NOT_APPROVED');
                if (source.requiresConsent && item.consentToRedistribute !== true) reasons.push('OWNER_CONSENT_REQUIRED');
                if (item.sourceUrl !== undefined) {
                    const link = url(item.sourceUrl);
                    if (!link || !source.urls.some(value => new URL(value).origin === link.origin)) reasons.push('SOURCE_URL_UNREGISTERED');
                }
            }
            if (object(item)) {
                const observed = item.observedAt === undefined ? observation.observedAt : item.observedAt;
                const expires = item.expiresAt === undefined ? observation.expiresAt : item.expiresAt;
                if (observed !== undefined && (!timestamp(observed) || Date.parse(observed) > now + 300000)) reasons.push('EVIDENCE_TIME_INVALID');
                if (expires !== undefined && (!timestamp(expires) || Date.parse(expires) <= now)) reasons.push('EVIDENCE_EXPIRED');
                if (mobile && (!timestamp(observed) || !timestamp(expires) || Date.parse(expires) <= Date.parse(observed) ||
                    Date.parse(expires) - Date.parse(observed) > MAX_MOBILE_TTL_MS || now - Date.parse(observed) > MAX_MOBILE_TTL_MS)) reasons.push('MOBILE_FRESHNESS_REQUIRED');
            }
            if (reasons.length) evidence.push({ sourceId: object(item) && item.sourceId || null, accepted: false, reasons });
            else { evidence.push({ sourceId: source.id, family: source.family, accepted: true }); families.add(source.family); }
        });
        if (object(fact)) semanticReasons(name, fact).forEach(reason => rejected.push(reason));
        // A field may have an approved independent origin plus an unlicensed
        // copied citation, but that does not prove that the value was derived
        // independently. Require every supplied provenance item to pass.
        evidence.forEach(item => { if (!item.accepted) item.reasons.forEach(reason => rejected.push(reason)); });
        if (!families.size && !rejected.length) rejected.push('FIELD_PROVENANCE_REQUIRED');
        result.factEvidence[name] = { evidence, independentFamilies: Array.from(families).sort(), independentFamilyCount: families.size };
        if (rejected.length) {
            result.rejectedFacts[name] = Array.from(new Set(rejected));
            rejected.forEach(reason => { if (result.reasons.indexOf(reason) < 0) result.reasons.push(reason); });
        } else {
            result.acceptedFacts[name] = JSON.parse(JSON.stringify(fact));
            families.forEach(family => allFamilies.add(family));
        }
    });
    result.independentFamilies = Array.from(allFamilies).sort(); result.independentFamilyCount = allFamilies.size;
    result.eligibleForPublication = Object.keys(result.acceptedFacts).length > 0 && Object.keys(result.rejectedFacts).length === 0;
    return result;
}
module.exports = { validateRegistry, assessObservation, MAX_MOBILE_TTL_MS };
