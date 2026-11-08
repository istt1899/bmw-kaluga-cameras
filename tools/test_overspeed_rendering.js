'use strict';
var assert=require('assert'),card=require('../native/marku-kaluga-cameras/files/alert-card'),policy=require('../native/marku-kaluga-cameras/files/warning-policy'),font=require('../native/marku-kaluga-cameras/files/camera-font.json').sizes.find(function(f){return f.size===18;});
var now=Date.UTC(2026,10,8,12),alert={id:'render-warning',roadConfirmed:true,limitKmh:60,distanceM:70,controls:['speed','redlight']};
function sample(speed,time,options){var fix={lat:54,lon:36,accuracyM:5,timeMs:time,motionTimeMs:time,speedKmh:speed};var decision=policy.evaluate(alert,fix,time,options);return Object.assign({},alert,{speedKmh:speed,overspeed:decision.overspeed,speedWarning:decision});}
var a=sample(80.1,now),b=sample(80.1,now+500),model=card.presentation(a);
assert.strictEqual(model.limit,60);assert.strictEqual(model.speedText,'>80');assert.strictEqual(model.overspeed,true);assert.strictEqual(model.flashActive,true);
assert.notStrictEqual(card.presentation(a).flashPhase,card.presentation(b).flashPhase);
['map','hud'].forEach(function(target){var on=card.card(a,target),off=card.card(b,target),changes=0;
 for(var y=0;y<96;y++)for(var x=0;x<320;x++)for(var c=0;c<4;c++){var at=(y*320+x)*4+c;if(on[at]!==off[at]){changes++;assert(x>=231&&x<318&&y>=20&&y<=47,'Only the local speed accent may blink');}}
 assert(changes>0);assert.strictEqual(on.length,320*96*4);assert.strictEqual(off.length,on.length);
});
var staticA=sample(81,now,{visualFlash:false}),staticB=sample(81,now+500,{visualFlash:false});assert(card.card(staticA,'map').equals(card.card(staticB,'map')));assert(card.presentation(staticA).overspeed);
assert.strictEqual(card.presentation(sample(60.1,now)).speedText,'>60');assert.strictEqual(card.presentation(sample(80,now)).speedText,'80');assert.strictEqual(card.presentation(sample(81,now)).speedText,'81');
var ref=Object.assign({},a,{roadConfirmed:false,limitKmh:null,cameraLimitKmh:60});assert.strictEqual(card.presentation(ref).overspeed,false);assert.strictEqual(card.presentation(ref).flashActive,false);
function advance(text){return Array.from(text).reduce(function(total,ch){return total+(font.glyphs[ch.codePointAt(0)]||font.glyphs[63])[6];},0);}
['>60','>80','>180','>330','400','—'].forEach(function(text){assert(advance(text)<=86);});assert(advance('км/ч')<=45);
console.log('PASS real 320x96 raster: raw fractional boundaries remain visible, 1Hz local speed-only blink, static fallback, reference suppression, unchanged distance/sign/types/alpha and complete units with actual font metrics');
