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
const defaultHud=layers.layoutFor('hud',{width:800,height:480},'test'),defaultMap=layers.layoutFor('map',{width:1088,height:480},'test');
assert.strictEqual(defaultHud.settings.x,500);assert.strictEqual(defaultHud.settings.y,820);
assert.strictEqual(defaultMap.settings.x,500);assert.strictEqual(defaultMap.settings.y,880);
for(const target of ['hud','map']){
    for(const scalePct of [75,100,150])for(const x of [0,500,1000])for(const y of [0,820,1000]){
        const size={width:800,height:480},profile={x,y,scalePct,brightnessPct:60,opacityPct:50};
        const layout=layers.layoutFor(target,size,'test',profile),r=layout.card,range=layout.positionRange;
        assert(layout.withinBounds&&r&&range);
        assert.strictEqual(r.width,320*scalePct/100);assert.strictEqual(r.height,96*scalePct/100);
        assert.strictEqual(r.x,range.minX+Math.round((range.maxX-range.minX)*x/1000),'x is normalized top-left travel, not absolute pixels or card centre');
        assert.strictEqual(r.y,range.minY+Math.round((range.maxY-range.minY)*y/1000),'y is normalized top-left travel');
        assert(range.minX>=8&&range.minY>=8&&r.x+r.width<=size.width-8&&r.y+r.height<=size.height-8,'scaled card retains a margin at every travel endpoint');
        assert.strictEqual(layout.settings.scalePct,scalePct);assert.strictEqual(layout.settings.brightnessPct,60);assert.strictEqual(layout.settings.opacityPct,50);
        assert.strictEqual(layout.safeArea.known,false,'geometric fitting cannot certify BMW safe area');
    }
}
const fitted=layers.layoutFor('hud',{width:353,height:203},'test',{x:1000,y:1000,scalePct:150,brightnessPct:100,opacityPct:100});
assert.strictEqual(fitted.settings.scalePct,150,'diagnostics preserve requested scale after auto-fit');
assert(fitted.withinBounds&&fitted.card.scale>=.75&&fitted.card.scale<1.5,'large profile auto-fits actual runtime canvas');
assert(fitted.card.x+fitted.card.width<=353-8&&fitted.card.y+fitted.card.height<=203-8);
assert(layers.layoutFor('hud',{width:256,height:88},'test',{scalePct:150}).withinBounds,'minimum readable 75% raster fits exactly');
assert.strictEqual(layers.layoutFor('hud',{width:255,height:88},'test',{scalePct:150}).withinBounds,false,'a target below 75% cannot silently shrink text further');
const a={controls:['speed','lane','redlight','belt'],roadConfirmed:true,limitKmh:60,speedKmh:72,overspeed:true,distanceM:233};
assert.deepStrictEqual(card.presentation(a).controls,['speed','lane','redlight']);
assert.strictEqual(card.presentation(a).limit,60);assert.strictEqual(card.presentation(a).overspeed,true);
const nearby=Object.assign({},a,{roadConfirmed:false});
assert.strictEqual(card.presentation(nearby).limit,null);assert.strictEqual(card.presentation(nearby).overspeed,false);
assert.strictEqual(card.presentation(Object.assign({},a,{captureDirection:'rear'})).direction,'unknown');
assert.strictEqual(card.presentation(Object.assign({},a,{captureDirection:'rear',captureDirectionVerified:true})).direction,'rear');
assert.strictEqual(card.presentation({controls:['toString','unknown']}).controls[0],'camera');
const info=require('../native/marku-kaluga-cameras/files/camera-info');
const phone={type:'camera',controls:['phone'],distanceM:210};
assert.deepStrictEqual(info.describe(phone).controls,['phone']);
assert.strictEqual(info.describe(phone).title,'Контроль телефона');
assert.deepStrictEqual(card.presentation(phone).controls,['phone']);
assert(!card.card(phone,'map').equals(card.card({controls:['camera'],distanceM:210},'map')),'phone has a dedicated label and icon');
const normal=card.card(a,'map'),calibrated=card.card(Object.assign({},a,{test:true,calibration:true}),'map');
assert.strictEqual(normal.length,320*96*4);assert(!normal.equals(calibrated));
for(const [x,y] of [[0,0],[319,0],[0,95],[319,95]])assert.strictEqual(calibrated[(y*320+x)*4+3],255);
assert(!normal.equals(card.card(nearby,'map')),'nearby must hide an unconfirmed road limit');
assert(!normal.equals(card.card(Object.assign({},a,{controls:['speed']}),'map')),'multiple independently known controls have separate squares');
const dimmed=layers.styledPixels(a,'map',{brightnessPct:40,opacityPct:100});
const translucent=layers.styledPixels(a,'map',{brightnessPct:100,opacityPct:50});
const minimum=layers.styledPixels(a,'map',{brightnessPct:10,opacityPct:10});
for(let i=0;i<normal.length;i++){
    if(i%4===3){assert.strictEqual(dimmed[i],normal[i],'brightness preserves alpha');assert(Math.abs(translucent[i]-normal[i]*.5)<=.5,'opacity affects alpha');}
    else{assert(Math.abs(dimmed[i]-normal[i]*.4)<=.5,'brightness scales the card RGB');assert.strictEqual(translucent[i],normal[i],'opacity preserves hue/brightness');}
    assert(Math.abs(minimum[i]-normal[i]*.1)<=.5,'minimum supported style retains ten percent rather than disappearing');
}
assert(normal.equals(card.card(a,'map')),'styling does not mutate the base raster');
console.log('PASS normalized card travel/scale fitting, readable minimum, independent RGB/alpha style, unknown safe area, verified-only camera facts and calibration confined to card');
