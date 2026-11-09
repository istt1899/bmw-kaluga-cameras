// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert=require('assert'),{create}=require('./ui_harness'),view=require('../src/view_model'),diag=require('../src/diagnostics_view');
const policy=require('../../../native/marku-kaluga-cameras/files/action-policy');
const baselineLayouts=require('../../../native/marku-kaluga-cameras/files/card-layout').defaultLayouts();
const {CameraMoveRepeater}=require('../src/camera_move_repeater');
const h=create(),{app,byName:c,commands,rhmi,stats,ui,xml}=h;
const N={hub:'ST_OnlineApps_WazeStrelkaCameras',diag:'ST_OnlineApps_WazeStrelkaDiagnostics',alerts:'ST_OnlineApps_CameraAlerts',
    types:'ST_OnlineApps_CameraTypes',cal:'ST_OnlineApps_CameraCalibration',pos:'ST_OnlineApps_CameraPosition',db:'ST_OnlineApps_CameraDatabase',over:'ST_OnlineApps_CameraOverspeed'};
const tick=()=>new Promise(resolve=>setImmediate(resolve)),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function matches(text,pattern){const result=[];let value;while((value=pattern.exec(text)))result.push(value);return result;}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await sleep(5);}throw new Error('UI condition did not arrive');}
function state(patch){
    const now=Date.now(),types={};view.ALERT_TYPES.forEach(type=>{types[type.key]=type.key!=='lane';});
    const s=Object.assign({enabled:true,observedAtMs:now,capabilities:{outputs:true,displayTest:true,alertPreferences:true,overspeedPreferences:true,gpsReset:true,update:true},
        outputs:{hud:true,cluster:true},gpsFix:{lat:54,lon:36,timeMs:now,motionTimeMs:now,speedKmh:0,accuracyM:19.4},
        alertPreferences:{warningDistanceM:950,cameraTypes:types},overspeedPreferences:{visualFlash:false,visualOffsetKmh:7,soundEnabled:true,soundOffsetKmh:23},
        displayTest:{active:false,pinned:false,target:null},storage:{persistent:true,settingsSaved:true},audio:{available:false,reason:'Канал BMW не подтверждён'},
        cardLayout:{hud:{x:500,y:820,scalePct:100,brightnessPct:70,opacityPct:75},map:{x:260,y:600,scalePct:120,brightnessPct:85,opacityPct:80}},
        databaseUpdate:{canRollback:true},clock:{serviceWallMs:now,serviceWallUtc:new Date(now).toISOString(),sourceUtcMs:null,sourceUtc:null,sourceDeltaMs:null,
            lastPacketAgeMs:null,packetReceiptDeltaMs:null,receiptClockDiscontinuity:null,admissionAfterUtcMs:null,admissionAfterUtc:null,issue:'SOURCE_UTC_UNKNOWN',reason:'Полный RMC UTC неизвестен'}},patch||{});
    s.rendererDetails={connection:'ready'};['hud','map'].forEach(target=>{s.rendererDetails[target]={state:'shown',layout:{canvas:{width:target==='hud'?640:1088,height:target==='hud'?240:480},withinBounds:true,settings:Object.assign({},s.cardLayout[target])}};});
    s.actions=policy.policies(s,s.gpsFix,now);return s;
}
function press(name){app._lastPress[name]=0;assert(c[name].press(),name+' is enabled');}
function ack(message,phase,change){const p=app._cameraPending;assert(p,'pending request');const s=app._cameras.state;
    if(change)change(s);s.commandResult={requestId:p.requestId,command:p.command,phase:phase||'finished',message:message||'Настройка применена'};h.setState(s);}
let count=0;function ok(text){console.log('ok '+(++count)+' - '+text);}
(async()=>{
    await app._setupRhmi();h.setState(state());await h.enter(N.hub);await tick();
    const root=xml.split('<container id="3"')[1].split('</container>')[0],rootComponents=ui.containers['3'].components;
    assert.deepStrictEqual(matches(root,/<component id="(\d+)"/g).map(x=>rootComponents[x[1]]).filter(x=>x.type==='button').map(x=>x.name),
        ['cameraDiagnostics','cameraAlertsLink','cameraTypesLink','cameraHudSetup','cameraMapSetup','cameraDatabaseLink']);
    const ids=matches(xml,/<(?:container|layoutGroup|component) id="(\d+)"/g).map(x=>x[1]);assert.strictEqual(new Set(ids).size,ids.length);
    Object.keys(ui.containers).forEach(id=>{const s=ui.containers[id],controls=Object.values(s.components).filter(x=>['button','checkBox','slider','dropDownMenu'].includes(x.type));
        if(Number(id)>=3)assert(controls.length<=(id==='6'?12:8),s.name+': '+controls.length+' controls');
        assert.strictEqual(c[s.name].resources,1,'every registered state updates resources');
    });
    Object.values(ui.containers['4'].components).filter(x=>/^cameraDiag_/.test(x.name)).forEach(d=>assert.strictEqual(d.properties.Focusable.value,3,'report rows are real reading stops'));
    assert(Object.values(ui.containers['4'].components).some(x=>x.name==='cameraGpsReset'));
    assert(Object.values(ui.containers['11'].components).some(x=>x.name==='cameraDiagAudio'));
    ok('six ordered hub links; native parents, unique IDs, <=8 controls (types 12) and scrollable report');

    // Every actual registered state survives both native event orderings. A
    // timeout left by any old hidden page must not fire after a child is shown.
    const closeAt=stats.cameraCloses,inactiveAt=stats.inactive;
    for(const order of ['hide-first','show-first'])for(const name of Object.values(N)){
        await h.enter(name,order);await tick();assert(app._visible);assert(app._cameras.opened);assert.strictEqual(stats.cameraCloses,closeAt);
        if(c[name].desc.properties&&c[name].desc.properties.ParentState){await h.back();assert(app._visible);}
    }
    await sleep(850);assert(app._visible);assert.strictEqual(stats.cameraCloses,closeAt);assert.strictEqual(stats.gpsStops,0);assert.strictEqual(stats.inactive,inactiveAt);
    await h.enter(N.pos);app.emit('changeVisibility',{visible:false});assert.strictEqual(app._visible,false);assert(app._gpsBridge.shouldHold());await tick();assert.strictEqual(stats.inactive,inactiveAt);
    await h.enter(N.pos);assert(app._pages.position);assert.strictEqual(app._cameraFocusedArrow,null);
    await h.enter(N.hub);c[N.hub].emit('visible',{visible:false});await sleep(850);assert.strictEqual(app._visible,false);assert(stats.cameraCloses>closeAt);assert.strictEqual(stats.gpsStops,0);
    await h.enter(N.hub);ok('all child/back orderings and overlay/reopen keep sockets, GPS/activity and cancel old focus');

    h.reset();const custom=state({cardLayout:{hud:{x:240,y:360,scalePct:85,brightnessPct:45,opacityPct:60},
        map:{x:640,y:720,scalePct:135,brightnessPct:55,opacityPct:80}}});h.setState(custom);
    const customBytes=JSON.stringify(custom.cardLayout),calibrationXml=xml.split('<container id="7"')[1].split('</container>')[0];
    const calibrationOrder=matches(calibrationXml,/<component id="(\d+)"/g).map(x=>ui.containers['7'].components[x[1]].name);
    const resetAt=calibrationOrder.indexOf('cameraCardReset');
    assert.deepStrictEqual(calibrationOrder.slice(resetAt-2,resetAt),['cameraCardBaselinePosition','cameraCardBaselineAppearance'],
        'full proposed baseline is immediately before its apply action');
    for(const target of ['hud','map']){
        await h.enter(N.hub);commands.length=0;press(target==='hud'?'cameraHudSetup':'cameraMapSetup');await tick();
        const base=baselineLayouts[target],name=target==='hud'?'HUD':'Приборы';
        assert.strictEqual(h.current(),N.cal);assert.strictEqual(app._cameraCardTarget,target);
        assert.strictEqual(c.cameraCardBaselinePosition.text(),'Базовый '+name+': X '+base.x/10+' % • Y '+base.y/10+' %');
        assert.strictEqual(c.cameraCardBaselineAppearance.text(),'Размер '+base.scalePct+' % • яркость '+base.brightnessPct+' % • прозрачность '+(100-base.opacityPct)+' %');
        ['cameraCardBaselinePosition','cameraCardBaselineAppearance'].forEach(key=>{
            assert.strictEqual(c[key].desc.properties.Visible.value,1);assert.strictEqual(c[key].desc.properties.Focusable.value,0);
        });
        assert.strictEqual(commands.length,0,'entry and displaying a recommendation never writes');
        assert.strictEqual(JSON.stringify(custom.cardLayout),customBytes,'custom current values remain distinct from the proposed baseline');
        press('cameraCardReset');assert.strictEqual(commands.length,1);assert.strictEqual(commands[0].cmd,'card-layout-reset');assert.strictEqual(commands[0].target,target);
        assert.strictEqual(JSON.stringify(custom.cardLayout),customBytes,'a request does not optimistically replace either confirmed profile');h.reset();
    }
    ok('HUD/map expose all five baseline values before one explicit apply; custom profiles survive entry and pending reset with eight task controls');

    h.reset();const s=state();s.displayTest={active:true,pinned:true,target:'hud'};h.setState(s);const original=JSON.stringify(s.cardLayout),prefs=JSON.stringify([s.alertPreferences,s.overspeedPreferences,s.outputs]);
    commands.length=0;press('cameraMapSetup');assert.strictEqual(h.current(),N.cal);assert.strictEqual(app._cameraCardTarget,'map');assert(c.cameraCalibrationTitle.text().includes('Приборы'));
    assert(c.cameraTestStart.text().includes('Показать тест'));assert.strictEqual(commands.length,0);assert.strictEqual(s.displayTest.target,'hud');
    await h.back();assert.strictEqual(h.current(),N.hub);assert.strictEqual(commands.length,0);
    press('cameraHudSetup');await h.back();press('cameraMapSetup');press('cameraTestStart');assert.strictEqual(commands.length,1);assert.strictEqual(commands[0].cmd,'display-test');assert.strictEqual(commands[0].target,'map');
    ack('Приборы: renderer подтвердил показ','shown',v=>{v.displayTest={active:true,pinned:true,target:'map'};});
    assert.strictEqual(JSON.stringify(s.cardLayout),original);assert.strictEqual(JSON.stringify([s.alertPreferences,s.overspeedPreferences,s.outputs]),prefs);
    press('cameraTestStart');assert.strictEqual(commands[1].cmd,'display-test-stop');ack('Тест скрыт','finished',v=>{v.displayTest.active=false;});
    c.cameraCardScale.propose(10);await tick();assert.strictEqual(commands[2].target,'map');assert.strictEqual(commands[2].scalePct,125);assert.strictEqual(c.cameraCardScale.cells['0:Value'],9,'only confirmed 120% is shown');
    ack('Применено','finished',v=>{v.cardLayout.map.scalePct=125;v.rendererDetails.map.layout.settings.scalePct=125;});
    press('cameraCardReset');assert.strictEqual(commands[3].target,'map');assert.strictEqual(JSON.stringify(s.cardLayout.hud),JSON.stringify(JSON.parse(original).hud));
    h.reset();ok('HUD preview survives map entry/back; explicit target replaces preview, independent profile proposals wait for confirmation');

    h.setState(state());await h.enter(N.cal);press('cameraCardSave');assert.strictEqual(h.current(),N.cal);ack('Сохранено','requested');assert.strictEqual(h.current(),N.cal);
    ack('Тест скрыт; настройки сохранены','finished',v=>{v.displayTest.active=false;v.storage={persistent:true,settingsSaved:true};});assert.strictEqual(h.current(),N.hub);
    for(const scenario of ['temporary','error','still-active']){
        h.reset();h.setState(state());await h.enter(N.cal);press('cameraCardSave');
        ack(scenario,scenario==='error'?'error':'finished',v=>{if(scenario==='temporary')v.storage={persistent:false,settingsSaved:false};if(scenario==='still-active')v.displayTest.active=true;});
        assert.strictEqual(h.current(),N.cal,scenario+' cannot leave calibration');
    }
    h.reset();h.setState(state());await h.enter(N.cal);press('cameraCardSave');await h.back();ack('Позднее сохранение','finished');assert.strictEqual(h.current(),N.hub,'late Done result cannot force navigation');
    h.reset();h.setState(state());await h.enter(N.cal);app._cameraCommand({cmd:'card-layout',target:'hud',x:500});
    const longFailure='Подробный отказ записи настроек '.repeat(34).slice(0,1024).trim();ack(longFailure,'error');
    const reading=[c.cameraCommand.text(),c.cameraCommandMore.text()].concat(Array.from({length:30},(_,i)=>c['cameraCardResultLine'+(i+3)]).filter(row=>row.visible).map(row=>row.text()));
    assert.strictEqual(reading.filter(t=>t.trim()).join(' '),longFailure,'all calibration failure characters have visible, focusable reading rows');
    for(let i=3;i<=32;i++)if(c['cameraCardResultLine'+i].visible)assert.strictEqual(c['cameraCardResultLine'+i].desc.properties.Focusable.value,3);
    ok('Done requires finished + stopped + persistent saved; temporary/error/pending stay and late result cannot navigate');

    for(const scenario of ['missing','stale','future','moving','output-off']){
        h.reset();const v=state();if(scenario==='missing')v.gpsFix=null;if(scenario==='stale')v.gpsFix.motionTimeMs-=3001;
        if(scenario==='future')v.gpsFix.motionTimeMs+=501;if(scenario==='moving')v.gpsFix.speedKmh=2;if(scenario==='output-off')v.outputs.hud=false;
        v.actions=policy.policies(v,v.gpsFix,Date.now());h.setState(v);app._cameraCardTarget='hud';await h.enter(N.diag);const before=commands.length;press('cameraDiagTest');
        assert.strictEqual(h.current(),N.diag,scenario);assert.strictEqual(commands.length,before);assert(c.cameraDiag_command.text().trim().length>0);assert(!c.cameraCardLeft.enabled);
    }
    h.reset();h.setState(state());await h.enter(N.diag);press('cameraDiagCalibration');assert.strictEqual(h.current(),N.cal);assert.strictEqual(commands[commands.length-1].cmd,'calibration-test');
    ack('HUD: отказ TARGET_NOT_AVAILABLE','error');assert(c.cameraCommand.text().includes('отказ'));assert.strictEqual(h.current(),N.cal);await h.back();assert.strictEqual(h.current(),N.hub);
    ok('real motion/output guards keep local diagnostic refusals; allowed request opens canonical calibration and renderer refusal stays visible');

    h.reset();const typed=state();h.setState(typed);await h.enter(N.types);commands.length=0;press('cameraTypesAll');assert.deepStrictEqual(commands[0].cameraTypes,view.ALERT_TYPES.reduce((a,t)=>{a[t.key]=true;return a;},{}));
    assert.strictEqual(c.cameraType_lane.selected,false,'recommendation never replaces confirmed ticks optimistically');h.reset();commands.length=0;
    for(const t of view.ALERT_TYPES){const name='cameraType_'+t.key;press(name);rhmi.emit('userEvent',{eventType:'ACTION',sourceId:c[name].id});}
    assert.strictEqual(commands.length,11);commands.forEach(cmd=>assert.strictEqual(Object.keys(cmd.cameraTypes).length,1));
    ok('all-types is explicit; eleven native/raw duplicate deliveries produce eleven independent partial patches');

    h.reset();h.setState(state());await h.enter(N.diag);
    for(let i=0;i<6;i++){c.cameraDiagSelector.pick(i);assert.strictEqual(app._diagPage,i);assert(c.cameraDiag_page.text().startsWith(diag.PAGE_TITLES[i]));}
    c.cameraDiagSelector.pick(1);assert(c.cameraDiag_row1.text().startsWith('Отказ/статус:'));press('cameraDiagFreeze');const frozen=app._diagFrozen,stamp=c.cameraDiag_stamp.text(),frozenApp=frozen.state.appClock.wallMs;
    const altered=state({clock:{serviceWallMs:Date.parse('2179-06-05T21:03:27.741Z'),serviceWallUtc:'2179-06-05T21:03:27.741Z',sourceUtcMs:Date.parse('2026-11-09T21:03:27Z'),sourceUtc:'2026-11-09T21:03:27.000Z',sourceDeltaMs:4810000000000,lastPacketAgeMs:null,packetReceiptDeltaMs:-1000,receiptClockDiscontinuity:true,admissionAfterUtcMs:6610000000000,admissionAfterUtc:'2179-06-05T21:03:28.241Z',issue:'RESET_BOUNDARY_FUTURE',reason:'После исправления даты явно сбросьте историю GPS'}});
    h.setState(altered);assert.strictEqual(app._diagFrozen.state.appClock.wallMs,frozenApp);assert.strictEqual(c.cameraDiag_stamp.text(),stamp);
    app._cameraCommand({cmd:'database-check'});ack('Живой результат при замороженном GPS');assert(c.cameraDiag_command.text().includes('Живой результат'));assert.strictEqual(c.cameraDiag_stamp.text(),stamp);
    press('cameraDiagFreeze');assert.strictEqual(app._diagFrozen,null);const gpsText=diag.clockRows(app._cameraDiagnosticState()).join('\n');
    ['2179-06-05T21:03:27.741Z','2026-11-09T21:03:27.000Z','2179-06-05T21:03:28.241Z','-1000','неизвестно','Разрыв часов приёма: да'].forEach(t=>assert(gpsText.includes(t),t));
    const unknown=diag.clockRows(state()).join(' ');assert(unknown.includes('Разрыв часов приёма: неизвестно'));assert(!unknown.includes('Разрыв часов приёма: нет'));
    ok('direct six-page selector, frozen appClock, live results and signed/unknown clock diagnostics remain intact');

    // Exercise the actual read-only CCU bridge, source event, native arrow handler
    // and application rollback handling together, rather than assigning held=true.
    h.reset();const heldState=state({displayTest:{active:true,pinned:true,target:'hud'}});h.setState(heldState);app._cameraCardTarget='hud';await h.enter(N.pos);
    app._holdBridge.start();await until(()=>app._holdBridge.subscribed);c.cameraCardLeft.emit('focus',{focus:true});await until(()=>!app._holdBridge.status().requiresNewPress);
    let resolveOld;h.getter(()=>new Promise(resolve=>{resolveOld=resolve;}));const wall=Date.now,late=Date.parse('2179-06-05T21:03:27.741Z');let now=late;Date.now=()=>now;
    try{
        app._observeAppClock();commands.length=0;h.controller(2);await until(()=>!!resolveOld);assert(app._moveRepeater.status().active);assert.strictEqual(commands.length,1);
        h.controller(0);assert(!app._moveRepeater.status().active);assert(app._cameraArrowSuppressed('left'));
        ack('Старый move подтверждён');now=Date.parse('2026-11-09T21:03:27.741Z');assert(!app._cameraArrowSuppressed('left'));assert(!app._holdBridge.status().held);
        resolveOld({frontRotaryEncoderPushButton:2});await tick();const before=commands.length;app._lastPress.cameraCardLeft=late;c.cameraCardLeft.press();assert.strictEqual(commands.length,before+1,'new short press survives old release tail and debounce');
        ack('Новый move');await sleep(190);assert.strictEqual(commands.length,before+1,'late LONG getter and acknowledgement never revive the old hold');
        h.reset();app._lastPress={};commands.length=0;c.cameraGpsReset.press();const id=commands[0].requestId;c.cameraGpsReset.press();now+=399;c.cameraGpsReset.press();assert.strictEqual(commands.length,1);
        now++;c.cameraGpsReset.press();assert.strictEqual(commands.length,2);assert.notStrictEqual(commands[1].requestId,id);
        now=late;c.cameraGpsReset.press();now=Date.parse('2026-11-09T21:03:28.741Z');c.cameraGpsReset.press();assert.strictEqual(commands.length,4);assert.notStrictEqual(commands[2].requestId,commands[3].requestId);
    }finally{Date.now=wall;h.getter(()=>Promise.resolve({frontRotaryEncoderPushButton:0}));}
    ok('LONG/release at 2179 then rollback allows new short; old getter/ACK stay inert; dedupe 0..399/400 and reset IDs remain correct');

    h.reset();h.setState(heldState);await h.enter(N.pos);c.cameraCardLeft.emit('focus',{focus:true});h.controller(0);await until(()=>!app._holdBridge.status().requiresNewPress);
    let backGetter;h.getter(()=>new Promise(resolve=>{backGetter=resolve;}));commands.length=0;h.controller(2);await until(()=>!!backGetter);assert(app._moveRepeater.status().active);
    await h.back();assert.strictEqual(h.current(),N.cal);assert(!app._moveRepeater.status().active);assert(!app._holdBridge.status().held);
    backGetter({frontRotaryEncoderPushButton:2});await tick();ack('Поздний move после Back');await sleep(190);assert.strictEqual(commands.length,1);assert(heldState.displayTest.active&&heldState.displayTest.target==='hud');
    await h.enter(N.pos);h.controller(2);assert(!app._holdBridge.status().held,'reopen cannot restore old focus or LONG');
    ok('active hold stops on native Back; late getter/ACK and reopen do not restart it or change pinned preview');

    h.reset();h.setState(heldState);await h.enter(N.pos);const realTimer=global.setTimeout;let deadline;
    global.setTimeout=(fn,ms)=>{if(ms===6000){deadline={fn,unref(){}};return deadline;}return realTimer(fn,ms);};
    try{app._cameraCommand({cmd:'card-move',target:'hud',direction:'left'});}finally{global.setTimeout=realTimer;}
    assert(deadline);const pendingId=app._cameraPending.requestId;deadline.fn();assert.strictEqual(app._cameraPending,null);assert(app._cameraFeedback.awaiting);assert(!app._moveRepeater.status().active);
    heldState.commandResult={requestId:pendingId,command:'card-move',phase:'finished',message:'Позднее завершение'};h.setState(heldState);assert(app._cameraFeedback.awaiting);
    let fakeNow=1000,task,stopped;const repeater=new CameraMoveRepeater({now:()=>fakeNow,setTimeout:fn=>{task=fn;return 1;},clearTimeout:()=>{},guard:()=>({allowed:true}),pending:()=>({requestId:'p'}),step:()=>true,onStop:r=>{stopped=r;}});
    repeater.start('left','hud');fakeNow=500;task();assert.strictEqual(stopped,'CLOCK_DISCONTINUITY');assert(!repeater.status().active);repeater.close();
    ok('pending move terminal timer releases UI and old results; repeater negative elapsed cancels rather than extending the hold');
    console.log('PASS compact native navigation: '+count+' checks with actual handlers, lifecycle and CCU input');
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).then(()=>h.close());
