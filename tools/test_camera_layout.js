'use strict';
const assert=require('assert');
const layers=require('../native/marku-kaluga-cameras/files/camera-layers');
const card=require('../native/marku-kaluga-cameras/files/alert-card');
const parsed=layers.parseTargets('map:1088x480,panel:1920x720,hud:800x480');
assert.deepStrictEqual(parsed.hud,{width:800,height:480});
assert.deepStrictEqual(layers.parseTargets('map,hud'),{});
assert.strictEqual(layers.parseTargets('map:1000x400,map:800x400').map,null);
assert.strictEqual(layers.parseTargets('hud:9999x480').hud,null);
for(const size of [{width:1088,height:480},{width:874,height:749},{width:800,height:480},{width:353,height:203},{width:280,height:120}]){
    for(const target of ['map','hud']){
        const layout=layers.layoutFor(target,size,'test'),r=layout.card;
        assert(layout.withinBounds&&r&&r.width<=320&&r.height<=96);
        assert(r.x>=0&&r.y>=0&&r.x+r.width<=size.width&&r.y+r.height<=size.height);
        assert.strictEqual(layout.safeArea.known,false);
    }
}
assert.strictEqual(layers.layoutFor('hud',null,'test').withinBounds,null);
assert.strictEqual(layers.layoutFor('hud',{width:100,height:50},'test').withinBounds,false);
const a={controls:['speed','lane','redlight','belt'],roadConfirmed:true,limitKmh:60,speedKmh:72,overspeed:true,distanceM:233};
assert.deepStrictEqual(card.presentation(a).controls,['speed','lane','redlight']);
assert.strictEqual(card.presentation(a).limit,60);assert.strictEqual(card.presentation(a).overspeed,true);
const nearby=Object.assign({},a,{roadConfirmed:false});
assert.strictEqual(card.presentation(nearby).limit,null);assert.strictEqual(card.presentation(nearby).overspeed,false);
assert.strictEqual(card.presentation(Object.assign({},a,{captureDirection:'rear'})).direction,'unknown');
assert.strictEqual(card.presentation(Object.assign({},a,{captureDirection:'rear',captureDirectionVerified:true})).direction,'rear');
assert.strictEqual(card.presentation({controls:['toString','unknown']}).controls[0],'camera');
const normal=card.card(a,'map'),calibrated=card.card(Object.assign({},a,{test:true,calibration:true}),'map');
assert.strictEqual(normal.length,320*96*4);assert(!normal.equals(calibrated));
for(const [x,y] of [[0,0],[319,0],[0,95],[319,95]])assert.strictEqual(calibrated[(y*320+x)*4+3],255);
assert(!normal.equals(card.card(nearby,'map')),'nearby must hide an unconfirmed road limit');
assert(!normal.equals(card.card(Object.assign({},a,{controls:['speed']}),'map')),'multiple independently known controls have separate squares');
console.log('PASS bounded adaptive card geometry, explicit unknown safe area, three labelled control types, verified-only direction/limit, calibration confined to card');
