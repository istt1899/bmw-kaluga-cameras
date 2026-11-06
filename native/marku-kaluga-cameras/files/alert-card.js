'use strict';
const zlib = require('zlib');
const fonts = require('./camera-font.json').sizes.map(s => Object.assign({}, s, { pixels: zlib.inflateSync(Buffer.from(s.alpha,'base64')) }));
const width = 320, height = 96;
function card(alert, target) {
    const px = Buffer.alloc(width*height*4), white=[244,247,250], amber=[255,190,94], red=[255,90,88];
    function put(x,y,color,alpha) {
        x=Math.round(x);y=Math.round(y);if(x<0||x>=width||y<0||y>=height||alpha<=0)return;
        const off=(y*width+x)*4,a=alpha/255,b=px[off+3]/255,out=a+b*(1-a);
        for(let c=0;c<3;c++)px[off+c]=Math.round((color[c]*a+px[off+c]*b*(1-a))/out);
        px[off+3]=Math.round(out*255);
    }
    function rect(x,y,w,h,color,alpha){for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)put(i,j,color,alpha===undefined?255:alpha);}
    function circle(x,y,r,color){for(let j=-r;j<=r;j++)for(let i=-r;i<=r;i++)if(i*i+j*j<=r*r)put(x+i,y+j,color,255);}
    if(target==='map')rect(0,0,width,height,[10,16,24],232);
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
    const signal=alert.controls&&alert.controls.indexOf('redlight')>=0;
    if(signal) {
        rect(14,5,19,31,[30,34,38]);circle(23,11,4,red);circle(23,20,4,amber);circle(23,29,4,[62,197,115]);
    } else {
        rect(8,12,28,19,amber);rect(12,7,10,5,amber);circle(25,21,6,[20,25,32]);circle(25,21,3,white);
    }
    text(alert.test?'ТЕСТ УВЕДОМЛЕНИЯ':alert.title||'Камера',45,25,18,signal?red:amber,270);
    text(alert.description||'Описание камеры не указано',10,47,18,white,300);
    text(alert.test?'Тест':alert.roadConfirmed?'По дороге':'Рядом',10,85,18,white,102);
    if(alert.roadConfirmed&&Number.isFinite(alert.limitKmh)) {
        circle(142,76,18,red);circle(142,76,14,[244,247,250]);
        const number=String(alert.limitKmh),font=f(18),w=Array.from(number).reduce((v,c)=>v+(font.glyphs[c.codePointAt(0)]||font.glyphs[63])[6],0);
        text(number,142-w/2,83,18,[12,17,24],40);
    }
    text(String(Math.max(0,Math.round(alert.distanceM/10)*10))+' м',194,86,32,white,124);
    return px;
}
module.exports={card,width,height};
