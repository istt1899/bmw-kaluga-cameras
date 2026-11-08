'use strict';
// The adapter must be validated on the vehicle; no native sound is guessed here.
var policy=require('./warning-policy');
function createAudio(adapter,options){
 adapter=adapter&&typeof adapter.play==='function'?adapter:null; options=options||{};
 var timeoutMs=options.timeoutMs||1500,enabled=false,threshold=0,closed=false,generation=0,flight=null,records=Object.create(null),lastNow=null,admittedKey=null,globalLastAttempt=null;
 var state={available:!!adapter,enabled:false,thresholdKmh:0,phase:adapter?'ready':'unavailable',reason:adapter?null:'Звуковой канал BMW не подтверждён; радио и системная громкость не меняются'};
 function reject(message){return Promise.reject(new Error(message));}
 function play(test,now,key,record){
  if(!adapter||closed)return reject(state.reason||'Звук недоступен');
  if(flight)return reject('Звуковой запрос ещё не завершён');
  var gen=generation,settled=false,finishPublic,timer;
  var result=new Promise(function(resolve,rejectPublic){finishPublic={resolve:resolve,reject:rejectPublic};});
  var f={cancel:function(){if(!settled){settled=true;clearTimeout(timer);finishPublic.reject(new Error('Звуковой канал закрыт'));}}};flight=f;
  state.phase='requested';state.reason=null;
  timer=setTimeout(function(){
   if(settled)return;settled=true;
   if(!closed&&gen===generation){state.phase='outcome-unknown';state.reason='Подтверждение звука не получено; канал занят до завершения запроса';}
   finishPublic.reject(new Error('Результат звука неизвестен; канал занят'));
  },timeoutMs);
  Promise.resolve().then(function(){
   if(closed)throw new Error('Звуковой канал закрыт');
   if(!test&&(!enabled||gen!==generation||admittedKey!==key))throw new Error('Допуск к звуку отозван');
   globalLastAttempt=now;return adapter.play({test:!!test,durationMs:250});
  }).then(function(value){
   var success=!!value&&value.played===true;
   if(record&&success){record.success=true;if(records[key])records[key].success=true;}
   if(flight===f)flight=null;
   if(!settled){settled=true;clearTimeout(timer);if(success)finishPublic.resolve(value);else finishPublic.reject(new Error('Воспроизведение звука не подтверждено'));}
   if(!closed&&gen===generation){state.phase=success?'played':'error';state.reason=success?null:'Воспроизведение звука не подтверждено';}
  },function(error){
   if(flight===f)flight=null;
   if(!settled){settled=true;clearTimeout(timer);finishPublic.reject(error);}
   if(!closed&&gen===generation){state.phase='error';state.reason=String(error&&error.message||error).slice(0,160);}
  });
  return result;
 }
 function tickClock(now){if(!Number.isFinite(now))return false;if(lastNow!==null&&now<lastNow)return false;lastNow=now;return true;}
 return {
  status:function(){var snapshot=Object.assign({},state,{pending:!!flight});if(!flight&&snapshot.phase==='outcome-unknown')snapshot.reason='Результат предыдущего запроса не относится к текущей сессии';return snapshot;},
  configure:function(on,delta){
   if(typeof on!=='boolean'||!Number.isInteger(delta)||delta<0||delta>30)throw new Error('Некорректные настройки звука');
   if(enabled===on&&threshold===delta)return;
   generation++;
   enabled=on;if(!on)admittedKey=null;threshold=delta;state.enabled=on;state.thresholdKmh=delta;
   if(flight&&enabled) {state.phase='outcome-unknown';state.reason='Предыдущий звуковой запрос ещё не завершён';}
   else if(!flight&&adapter&&!closed){state.phase='ready';state.reason=null;}
  },
  update:function(alert,fix,now){
   if(!tickClock(now)){admittedKey=null;return;}
   Object.keys(records).forEach(function(k){if((!alert||k!==alert.id+':'+(alert.sign||'road'))&&now-records[k].lastSeen>30000)delete records[k];});
   if(!alert){admittedKey=null;return;}
   var key=alert.id+':'+(alert.sign||'road'),record=records[key];
   if(record&&now-record.lastSeen>30000){delete records[key];record=null;}
   if(!record)record=records[key]={lastSeen:now,success:false,attempts:0,lastAttempt:null};
   record.lastSeen=now;
   var decision=policy.evaluate(alert,fix,now,{soundOffsetKmh:threshold});
   admittedKey=enabled&&decision.eligible&&decision.soundExceeded?key:null;
   if(!enabled||!adapter||closed||flight||!decision.eligible||!decision.soundExceeded||record.success||record.attempts>=3||globalLastAttempt!==null&&now-globalLastAttempt<12000||record.lastAttempt!==null&&now-record.lastAttempt<12000)return;
   record.attempts++;record.lastAttempt=now;play(false,now,key,record).catch(function(){});
  },
  resetEpoch:function(now){
   if(!Number.isFinite(now))throw new Error('Некорректное время сброса звука');
   var shift=lastNow!==null&&now<lastNow?now-lastNow:0;
   if(shift){Object.keys(records).forEach(function(k){records[k].lastSeen+=shift;if(records[k].lastAttempt!==null)records[k].lastAttempt+=shift;});if(globalLastAttempt!==null)globalLastAttempt+=shift;}
   lastNow=now;generation++;admittedKey=null;
   if(!closed&&adapter){state.phase=flight?'outcome-unknown':'ready';state.reason=flight?'Предыдущий звуковой запрос ещё не завершён':null;}
  },
  test:function(now){if(!tickClock(now))return reject('Некорректное время звукового теста');return play(true,now,null,null);},
  close:function(){if(closed)return;closed=true;generation++;state.available=false;state.phase='closed';if(flight)flight.cancel();if(adapter&&typeof adapter.close==='function')adapter.close();}
 };
}
module.exports={createAudio:createAudio};
