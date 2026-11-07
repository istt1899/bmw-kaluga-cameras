'use strict';
// User filters only. A disabled type never changes the source camera record,
// the claimed speed limit, or any of the GPS/road validity checks.
var cameraInfo=require('./camera-info');
var TYPES=['speed','redlight','average','stopline','belt','phone','lane','pedestrian','signs_marking','road_position','other'];
var flags={};TYPES.forEach(function(type){flags[type]=true;});
var DEFAULTS=Object.freeze({warningDistanceM:1000,cameraTypes:Object.freeze(flags)});
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function own(value,key){return Object.prototype.hasOwnProperty.call(value,key);}
function distance(value){return typeof value==='number'&&Number.isInteger(value)&&value>=50&&value<=1000&&value%50===0;}
function invalid(message){var error=new Error('Некорректные настройки предупреждений: '+message);error.code='ALERT_PREFERENCES_INVALID';throw error;}
function normalize(raw){
 var result={warningDistanceM:DEFAULTS.warningDistanceM,cameraTypes:{}};
 TYPES.forEach(function(type){result.cameraTypes[type]=DEFAULTS.cameraTypes[type];});
 if(!object(raw))return result;
 if(own(raw,'warningDistanceM')&&distance(raw.warningDistanceM))result.warningDistanceM=raw.warningDistanceM;
 if(own(raw,'cameraTypes')&&object(raw.cameraTypes))TYPES.forEach(function(type){if(own(raw.cameraTypes,type)&&typeof raw.cameraTypes[type]==='boolean')result.cameraTypes[type]=raw.cameraTypes[type];});
 return result;
}
function patch(previous,partial){
 if(!object(partial))invalid('ожидается объект изменяемых параметров');
 Object.keys(partial).forEach(function(key){if(key!=='warningDistanceM'&&key!=='cameraTypes')invalid('неизвестный параметр '+key);});
 if(own(partial,'warningDistanceM')&&!distance(partial.warningDistanceM))invalid('дальность должна быть от 50 до 1000 м с шагом 50 м');
 if(own(partial,'cameraTypes')){
  if(!object(partial.cameraTypes))invalid('типы камер должны быть объектом переключателей');
  Object.keys(partial.cameraTypes).forEach(function(type){
   if(TYPES.indexOf(type)<0)invalid('неизвестный тип камеры '+type);
   if(typeof partial.cameraTypes[type]!=='boolean')invalid('переключатель типа камеры '+type+' должен быть логическим значением');
  });
 }
 var next=normalize(previous);
 if(own(partial,'warningDistanceM'))next.warningDistanceM=partial.warningDistanceM;
 if(own(partial,'cameraTypes'))Object.keys(partial.cameraTypes).forEach(function(type){next.cameraTypes[type]=partial.cameraTypes[type];});
 return next;
}
function matches(record,preferences){
 if(!object(record))return false;
 var prefs=normalize(preferences),safe={type:record.type};
 if(own(record,'controls'))safe.controls=Array.isArray(record.controls)?record.controls.filter(function(value){return typeof value==='string';}):[];
 if(object(record.officialSiteContext)&&record.officialSiteContext.scope==='enforcement-location'&&Array.isArray(record.officialSiteContext.controls))safe.officialSiteContext={scope:'enforcement-location',controls:record.officialSiteContext.controls.filter(function(value){return typeof value==='string';})};
 var controls=cameraInfo.controls(safe).filter(function(type){return type!=='other'&&TYPES.indexOf(type)>=0;});
 // "Other" represents an unclassified/generic source object. An unknown
 // additional tag cannot bypass an explicitly disabled, already known type.
 return controls.length?controls.some(function(type){return prefs.cameraTypes[type]===true;}):prefs.cameraTypes.other===true;
}
module.exports={DEFAULTS:DEFAULTS,normalize:normalize,patch:patch,matches:matches};
