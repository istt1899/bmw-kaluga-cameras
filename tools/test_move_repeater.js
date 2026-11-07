'use strict';
const assert=require('assert'),{CameraMoveRepeater}=require('../apps/marku_kaluga_cameras/src/camera_move_repeater');
let now=0,id=0,tasks=new Map(),moves=[],pending=null,allowed=true,stops=[];
function tick(ms){const end=now+ms;while(true){let next=null;for(const e of tasks)if(e[1].at<=end&&(!next||e[1].at<next[1].at))next=e;if(!next)break;now=next[1].at;tasks.delete(next[0]);next[1].fn();}now=end;}
const o={now:()=>now,setTimeout:(fn,ms)=>{const n=++id;tasks.set(n,{at:now+ms,fn});return n;},clearTimeout:id=>tasks.delete(id),
 guard:()=>({allowed,reason:'GUARD_REFUSED'}),pending:()=>pending,step:c=>{moves.push({direction:c.direction,target:c.target});pending={requestId:'move-'+moves.length};return true;},onStop:r=>stops.push(r)};
const r=new CameraMoveRepeater(o);assert(r.start('right','hud'));assert.strictEqual(moves.length,1);tick(1000);assert.strictEqual(moves.length,1,'No command queue while first move is unacknowledged');pending=null;tick(200);assert.strictEqual(moves.length,2);
r.stop('RELEASED');pending=null;tick(1000);assert.strictEqual(moves.length,2,'Release cancels all later moves');
assert(r.start('up','map'));pending=null;allowed=false;tick(200);assert.strictEqual(r.status().active,false);assert(stops.includes('GUARD_REFUSED'));allowed=true;pending=null;
assert(r.start('left','hud'));tick(1500);assert.strictEqual(r.status().active,false);assert(stops.includes('MOVE_ACK_TIMEOUT'));
pending=null;r.start('down','hud');pending=null;r.start('left','map');const count=moves.length;r.stop('FOCUS_LOST');tick(1000);assert.strictEqual(moves.length,count,'Retired generation cannot move a replaced target');
r.close();assert.strictEqual(r.start('right','hud'),false);assert.strictEqual(tasks.size,0);assert.strictEqual(moves[moves.length-1].target,'map');
console.log('PASS hold repeater single-flight, confirmed-ACK pacing, release/focus/guard cancellation, lost ACK bound, target replacement and shutdown; no queued moves after release');
