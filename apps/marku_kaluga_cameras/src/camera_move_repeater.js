'use strict';
function monotonicNow(){if(typeof process.hrtime==='function'){const t=process.hrtime();return t[0]*1000+t[1]/1e6;}return Date.now();}
// Schedules bounded, single-flight camera moves only while a verified input
// bridge says the selected button remains held. No event guessing here.
class CameraMoveRepeater {
    constructor(options) {
        const o=options||{};
        this.guard=o.guard; this.pending=o.pending; this.step=o.step; this.onStop=o.onStop||(()=>{});
        this.now=o.now||monotonicNow; this.setTimer=o.setTimeout||setTimeout; this.clearTimer=o.clearTimeout||clearTimeout;
        this.intervalMs=o.intervalMs||170; this.pendingTimeoutMs=o.pendingTimeoutMs||1200;
        this.current=null; this.timer=null; this.generation=0; this.closed=false; this.waitSince=null;
    }
    start(direction,target) {
        if(this.closed||!['up','down','left','right'].includes(direction)||!['hud','map'].includes(target))return false;
        this.stop('REPLACED'); const generation=++this.generation;
        this.current={direction,target,generation};this.waitSince=null;this.pump(generation);return !!this.current;
    }
    pump(generation) {
        if(this.closed||!this.current||generation!==this.generation)return;
        this.timer=null;const context=this.current,guard=this.guard(context);
        if(!guard||!guard.allowed&&!guard.waiting){this.stop(guard&&guard.reason||'MOVE_UNAVAILABLE');return;}
        const pending=this.pending();
        if(pending||guard.waiting){
            if(this.waitSince===null)this.waitSince=this.now();
            const elapsed=this.now()-this.waitSince;
            if(elapsed<0){this.stop('CLOCK_DISCONTINUITY');return;}
            if(pending&&pending.awaiting||elapsed>=this.pendingTimeoutMs){this.stop('MOVE_ACK_TIMEOUT');return;}
        }else{
            this.waitSince=null;
            this.waitSince=this.now();
            if(this.step(context)===false){this.stop('MOVE_SEND_FAILED');return;}
        }
        if(this.current&&generation===this.generation)this.timer=this.setTimer(()=>this.pump(generation),this.intervalMs);
    }
    stop(reason) {
        this.generation++;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;this.waitSince=null;
        const was=this.current;this.current=null;if(was)this.onStop(reason||'RELEASED',was);
    }
    status(){return this.current?Object.assign({active:true},this.current):{active:false};}
    close(){if(this.closed)return;this.stop('CLOSED');this.closed=true;}
}
module.exports={CameraMoveRepeater};
