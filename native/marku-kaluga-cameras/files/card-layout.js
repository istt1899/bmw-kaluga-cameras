'use strict';
// Shared persisted contract. Coordinates are thousandths of the renderer's
// actual available travel, never guessed head-unit pixel dimensions.
var FIELDS = ['x', 'y', 'scalePct', 'brightnessPct', 'opacityPct'];
function defaultLayouts() {
  return { hud: { x: 500, y: 820, scalePct: 100, brightnessPct: 100, opacityPct: 100 },
    map: { x: 500, y: 880, scalePct: 100, brightnessPct: 100, opacityPct: 100 } };
}
function invalid(message) { var e = new Error(message || 'Некорректные настройки карточки'); e.code = 'CARD_LAYOUT_INVALID'; throw e; }
function validateTarget(target) { if (target !== 'hud' && target !== 'map') invalid('Выберите приборы или HUD'); return target; }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validField(name, value) {
  if (!Number.isInteger(value)) return false;
  if (name === 'x' || name === 'y') return value >= 0 && value <= 1000;
  if (name === 'scalePct') return value >= 75 && value <= 150 && value % 5 === 0;
  return (name === 'brightnessPct' || name === 'opacityPct') && value >= 10 && value <= 100;
}
function validateProfile(value, partial) {
  if (!object(value)) invalid();
  var keys = Object.keys(value), result = {};
  if (!keys.length || keys.some(function (key) { return FIELDS.indexOf(key) < 0; })) invalid();
  FIELDS.forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) { if (!partial) invalid('Неполный профиль карточки'); return; }
    if (!validField(key, value[key])) invalid('Некорректное поле карточки: ' + key);
    result[key] = value[key];
  });
  return result;
}
function normalizeLayouts(value) {
  var layouts = defaultLayouts();
  ['hud', 'map'].forEach(function (target) {
    var profile = object(value) && object(value[target]) ? value[target] : null;
    if (!profile) return;
    FIELDS.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(profile, key) && validField(key, profile[key])) layouts[target][key] = profile[key]; });
  });
  return layouts;
}
module.exports = { defaultLayouts: defaultLayouts, normalizeLayouts: normalizeLayouts, validateProfile: validateProfile, validateTarget: validateTarget };
