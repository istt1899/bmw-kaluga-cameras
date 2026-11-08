'use strict';
const zlib = require('zlib');
const fonts = require('./camera-font.json').sizes.map(s => Object.assign({}, s, { pixels: zlib.inflateSync(Buffer.from(s.alpha,'base64')) }));
const width = 320, height = 96;
const types = {
    speed:'Скор.', lane:'Полоса', redlight:'Свет.', average:'Средн.', belt:'Ремень',
    stopline:'Стоп', pedestrian:'Пешех.', phone:'Телеф.', signs_marking:'Размет.', road_position:'Расп.ТС', camera:'Камера'
};
function presentation(alert) {
    alert = alert || {};
    const supported = value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(types,value);
    const known = Array.isArray(alert.controls) ? alert.controls.filter((v,i,a) => supported(v) && a.indexOf(v) === i) : [];
    const controls = known.length ? known.slice(0,3) : [supported(alert.type) ? alert.type : 'camera'];
    const validLimit = value => Number.isFinite(value) && value > 0 && value <= 300;
    const roadLimit = alert.roadConfirmed === true && validLimit(alert.limitKmh) ? Math.round(alert.limitKmh) : null;
    const reference = alert.limitReference && alert.limitReference.state === 'known' ? alert.limitReference.valueKmh : null;
    const databaseLimit = validLimit(alert.cameraLimitKmh) ? Math.round(alert.cameraLimitKmh) : validLimit(reference) ? Math.round(reference) : null;
    const limit = roadLimit === null ? databaseLimit : roadLimit, limitScope = roadLimit !== null ? 'road' : databaseLimit !== null ? 'reference' : 'unknown';
    const rawSpeed = Number.isFinite(alert.speedKmh) && alert.speedKmh >= 0 && alert.speedKmh <= 400 ? alert.speedKmh : null;
    const speed = rawSpeed === null ? null : Math.round(rawSpeed), warning = alert.speedWarning || {};
    const overspeed = alert.roadConfirmed === true && alert.overspeed === true && roadLimit !== null && rawSpeed !== null && rawSpeed > roadLimit;
    const hiddenBoundary = Number.isFinite(warning.displayBoundaryKmh) && rawSpeed > warning.displayBoundaryKmh && speed <= warning.displayBoundaryKmh ? warning.displayBoundaryKmh :
        overspeed && speed <= roadLimit ? roadLimit : null;
    const direction = alert.captureDirectionVerified === true && ['front','rear'].indexOf(alert.captureDirection) >= 0 ? alert.captureDirection : 'unknown';
    return { controls, extraControls: Math.max(0,known.length-controls.length), limit, limitScope, speed,
        speedText:speed===null?'—':hiddenBoundary===null?String(speed):'>'+hiddenBoundary, direction,
        distance: Number.isFinite(alert.distanceM) && alert.distanceM >= 0 ? Math.round(alert.distanceM/10)*10 : null,
        mode: alert.positionKind === 'intersection' ? 'Ориентир' : alert.roadConfirmed === true ? (alert.controlScope === 'enforcement-location' ? 'Рубеж' : 'По дороге') : 'Рядом',
        test: alert.test === true, calibration: alert.calibration === true, decoy: !!(alert.decoyReport && alert.decoyReport.state === 'reported'),
        overspeed, flashActive:overspeed&&warning.flashActive===true, flashPhase:overspeed&&warning.flashActive===true&&warning.flashPhase===true };
}
function card(alert, target) {
    const model=presentation(alert), px=Buffer.alloc(width*height*4);
    const white=[244,247,250], amber=[255,190,94], red=[255,90,88], muted=[184,194,204], ink=[12,17,24];
    function put(x,y,color,alpha) {
        x=Math.round(x);y=Math.round(y);if(x<0||x>=width||y<0||y>=height||alpha<=0)return;
        const off=(y*width+x)*4,a=alpha/255,b=px[off+3]/255,out=a+b*(1-a);
        for(let c=0;c<3;c++)px[off+c]=Math.round((color[c]*a+px[off+c]*b*(1-a))/out);
        px[off+3]=Math.round(out*255);
    }
    function rect(x,y,w,h,color,alpha){for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)put(i,j,color,alpha===undefined?255:alpha);}
    function circle(x,y,r,color){for(let j=-r;j<=r;j++)for(let i=-r;i<=r;i++)if(i*i+j*j<=r*r)put(x+i,y+j,color,255);}
    const f = size => fonts.find(v=>v.size===size);
    function text(value,x,baseline,size,color,maxWidth) {
        const font=f(size), start=x;
        for(const ch of String(value)) {
            const g=font.glyphs[ch.codePointAt(0)]||font.glyphs[63];if(!g)continue;
            if(maxWidth && x-start+g[6]>maxWidth)break;
            for(let j=0;j<g[3];j++)for(let i=0;i<g[2];i++)put(x+g[4]+i,baseline+g[5]+j,color,font.pixels[(g[1]+j)*font.atlasW+g[0]+i]);
            x+=g[6];
        }
    }
    function centered(value,x,baseline,size,color,maxWidth) {
        const font=f(size), w=Array.from(String(value)).reduce((n,c)=>n+(font.glyphs[c.codePointAt(0)]||font.glyphs[63])[6],0);
        text(value,x-w/2,baseline,size,color,maxWidth);
    }
    function outline(x,y,w,h,color){rect(x,y,w,1,color);rect(x,y+h-1,w,1,color);rect(x,y,1,h,color);rect(x+w-1,y,1,h,color);}
    function icon(type,x,y) {
        outline(x,y,22,22,amber);
        if(type==='redlight') {circle(x+11,y+5,2,red);circle(x+11,y+11,2,amber);circle(x+11,y+17,2,white);}
        else if(type==='lane') {rect(x+5,y+4,2,14,white);rect(x+15,y+4,2,14,white);rect(x+10,y+4,2,4,amber);rect(x+10,y+12,2,5,amber);}
        else if(type==='belt') {for(let k=4;k<18;k++)rect(x+k,y+21-k,2,2,white);rect(x+9,y+8,5,5,amber);}
        else if(type==='phone') {outline(x+6,y+3,10,16,white);rect(x+8,y+5,6,9,amber);rect(x+10,y+16,2,1,white);}
        else if(type==='average') {circle(x+11,y+11,7,white);circle(x+11,y+11,5,ink);rect(x+10,y+6,2,6,amber);rect(x+11,y+10,5,2,amber);}
        else if(type==='stopline') {rect(x+4,y+15,14,3,white);rect(x+10,y+4,2,8,amber);}
        else if(type==='pedestrian') {circle(x+11,y+5,2,white);rect(x+10,y+9,2,8,white);rect(x+6,y+12,10,2,amber);}
        else {rect(x+4,y+7,14,10,white);rect(x+6,y+4,6,3,white);circle(x+12,y+12,4,ink);circle(x+12,y+12,2,amber);}
    }
    // A fixed intrinsic raster is fitted to the actual runtime target by the
    // layer adapter. No blur, animated glass or full-screen takeover.
    if(target==='map')rect(0,0,width,height,[10,16,24],232);
    circle(28,27,23,model.limitScope === 'road' ? red : model.limitScope === 'reference' ? amber : muted);
    circle(28,27,19,white);
    centered(model.limit === null ? '—' : model.limit,28,34,18,ink,48);
    if(model.test || model.calibration)text(model.calibration?'КАЛИБРОВКА':'ТЕСТ',63,17,18,amber,244);
    else if(model.decoy){rect(63,1,86,20,[36,30,20],255);text('Муляж',70,17,18,amber,72);}
    const distanceText=model.distance === null ? '— м' : model.distance >= 1000 ? (model.distance/1000).toFixed(1)+' км' : model.distance+' м';
    text(distanceText,63,46,32,white,166);
    // Units have their own line, so a truthful fractional boundary such as
    // >180 fits without dropping the km/h suffix or hiding the distance.
    text('км/ч',271,17,18,muted,45);
    text(model.speedText,231,42,18,model.overspeed&&(!model.flashActive||model.flashPhase)?red:white,86);
    model.controls.forEach((type,index)=>{const x=6+index*106;icon(type,x,53);text(types[type],x+27,71,18,white,73);});
    text(model.test||model.calibration?'ТЕСТ':model.limitScope==='reference'?model.mode+' • база':model.mode,7,90,18,muted,150);
    if(model.extraControls)text('+'+model.extraControls,158,90,18,amber,38);
    text(model.direction==='front'?'В лоб':model.direction==='rear'?'Сзади':'Напр. ?',202,90,18,muted,111);
    if(model.calibration) {
        // Mark only this card's boundary. It cannot obscure the whole panel.
        outline(0,0,width,height,amber);
        [[0,0],[width-9,0],[0,height-9],[width-9,height-9]].forEach(p=>{rect(p[0],p[1],9,2,white);rect(p[0],p[1],2,9,white);});
    }
    return px;
}
module.exports={card,width,height,presentation};
