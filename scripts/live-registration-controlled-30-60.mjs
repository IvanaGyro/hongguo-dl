// SPDX-License-Identifier: GPL-3.0-only
// Adaptive E experiment (real anonymous device registration, local workerd).
// Continuation after a validated 180s silent recovery: first probe 150s.
// After failure, wait ONLY the remaining time to the known base (180s).
// Confirm recovery BEFORE any new trigger. Short triggers are recorded, not dropped.
// Exact device IDs: short-retention artifact only, NEVER stdout.
import {mkdir,writeFile} from 'node:fs/promises';

const ROOT='http://127.0.0.1:8787', OUT='/tmp/registration-adaptive-e';
const MAX_ROUNDS=3, MAX_TRIGGER_REQUESTS=160;
const epoch=performance.now(), elapsed=()=>Math.round(performance.now()-epoch);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rows=[], events=[];
let seq=0;
const zeroIds=s=>{
  const f=s?.fields;
  return !!f && ['device_id_str','device_id','install_id_str','install_id']
    .every(k=>f[k]?.exactValue==='0' || f[k]?.exactValue===0);
};
const publicRow=r=>({
  number:r.number,round:r.round,phase:r.phase,ordinal:r.ordinal,
  sentMs:r.sentMs,finishedMs:r.finishedMs,durationMs:r.durationMs,
  ok:r.ok,zeroId:r.zeroId,upstreamStatus:r.upstreamStatus,
  failure:r.registrationFailure,upstreamCalls:r.upstreamCalls,
  serverTime:r.responseSnapshot?.serverTime ?? null,
  newUser:r.responseSnapshot?.newUser ?? null,
  idTypes:Object.fromEntries(Object.entries(r.responseSnapshot?.fields||{})
    .map(([k,v])=>[k,{
      jsonType:v.jsonType,zero:v.exactValue==='0'||v.exactValue===0,
      length:typeof v.exactValue==='string'?v.exactValue.length:null,
      validParsed:v.validAsCurrentlyParsed
    }]))
});
const mark=(kind,detail={})=>{
  const event={kind,atMs:elapsed(),...detail};
  events.push(event);
  console.log('EVENT '+JSON.stringify(event));
};
async function persist(){
  await mkdir(OUT,{recursive:true});
  await writeFile(OUT+'/full-records.json',JSON.stringify({
    notice:'Exact anonymous IDs; do not publish or commit. One-day retention.',
    rows,events
  },null,2),{mode:0o600});
  await writeFile(OUT+'/redacted-records.json',JSON.stringify({
    rows:rows.map(publicRow),events
  },null,2),{mode:0o600});
}
async function send(round,phase,ordinal){
  const number=++seq,sentMs=elapsed();
  let r={number,round,phase,ordinal,sentMs,finishedMs:null,durationMs:null,ok:false,
    registrationFailure:null,responseSnapshot:null,upstreamStatus:null,upstreamCalls:null};
  try{
    const response=await fetch(ROOT+'/register',{
      method:'POST',signal:AbortSignal.timeout(14000),cache:'no-store'
    });
    const d=await response.json();
    r={...r,ok:d.ok===true,registrationFailure:d.registrationFailure,
      responseSnapshot:d.responseSnapshot,
      upstreamStatus:d.upstreamStatus,upstreamCalls:d.upstreamCalls,
      upstreamError:d.upstreamError,captureError:d.captureError,
      isolate:d.isolate,transportHttp:response.status};
  }catch(e){
    r.registrationFailure=e?.name==='TimeoutError'?'LOCAL_TIMEOUT':'LOCAL_TRANSPORT_ERROR';
  }
  r.zeroId=zeroIds(r.responseSnapshot);
  r.finishedMs=elapsed();r.durationMs=r.finishedMs-r.sentMs;
  rows.push(r);
  console.log('REG '+JSON.stringify(publicRow(r)));
  return r;
}
function classify(r){
  // Do NOT mistake transport failures or malformed JSON for a quota refusal.
  if(r.ok && !r.zeroId)return 'success';
  if(r.upstreamStatus===200 && r.zeroId)return 'zero';
  return 'other';
}
async function sleepUntil(t0Ms, targetSeconds, label){
  const target=t0Ms+targetSeconds*1000;
  const remaining=Math.max(0,target-elapsed());
  mark('silence',{label,targetSeconds,remainingMs:remaining});
  if(remaining)await sleep(remaining);
}
async function trigger(round){
  const gap=round===1?0:600000;
  if(gap){mark('inter-round-silence',{round,ms:gap});await sleep(gap);}
  mark('baseline-start',{round});
  for(let i=1;i<=3;i++){
    if(i>1)await sleep(10000);
    const result=await send(round,'baseline-10s',i);
    if(classify(result)!=='success') {
      mark('baseline-not-healthy',{round,code:result.registrationFailure,zero:result.zeroId});
      return null;
    }
  }
  mark('baseline-to-trigger-silence',{round,ms:5000});
  await sleep(5000);
  mark('trigger-start',{round,intervalMs:1000,max:MAX_TRIGGER_REQUESTS});
  let nSuccess=0;
  const triggerStart=performance.now();
  for(let i=1;i<=MAX_TRIGGER_REQUESTS;i++){
    // Match prior runs: one launch at each integer-second boundary.
    const remaining=triggerStart+(i-1)*1000-performance.now();
    if(remaining>0)await sleep(remaining);
    const r=await send(round,'trigger-1s',i);
    const type=classify(r);
    if(type==='zero'){
      // Time zero is the FIRST zero-ID response completion, not the last
      // request of a fixed 150-request burst.
      const t0=r.finishedMs;
      mark('first-zero',{round,atMs:t0,ordinal:i,cumulativeNumber:r.number,
        countOfSuccessfulRegistrationsSinceRoundStart:nSuccess+3,
        serverTime:r.responseSnapshot?.serverTime??null});
      await persist();
      // Do not abort on earlier-than-120 zero IDs: recovery is the actual
      // measurement here. Report the residual quota as a confounder.
      if(nSuccess<100){
        mark('early-trigger-observed',{round,successfulBurst:nSuccess,
          interpretation:'possible residual window/quota; trial remains usable for recovery observation'});
      }
      return {t0,ordinal:i,successes:nSuccess+3,serverTime:r.responseSnapshot?.serverTime??null};
    }
    if(type!=='success'){
      mark('unrelated-registration-error',{round,ordinal:i,
        upstreamStatus:r.upstreamStatus,failure:r.registrationFailure});
      await persist();
      return null;
    }
    nSuccess++;
  }
  mark('no-zero-within-trigger-limit',{round,n:MAX_TRIGGER_REQUESTS});
  await persist();
  return null;
}
async function waitForRecovery(round,t0,trial,base){
  if(round>=2){const sec=round===2?30:60;await sleepUntil(t0,sec,'intermediate-probe');const p=await send(round,'intermediate-probe',sec);mark('intermediate-result',{round,atSeconds:sec,classification:classify(p)});if(classify(p)==='other')return null;}

  let trialResult=null, recoveryResult=null, recoveredAt=null;
  // There is no registration request between first zero ID and the trial probe.
  await sleepUntil(t0,trial,'E-first-trial');
  trialResult=await send(round,'E-first-trial',trial);
  const trialType=classify(trialResult);
  mark('trial-result',{round,trial,classification:trialType,baseAtStart:base,
    elapsedFromT0Ms:trialResult.sentMs-t0});
  if(trialType==='other')return null;
  if(trialType==='success'){
    recoveredAt=trial;
    recoveryResult=trialResult;
  }else{
    // User-requested base semantics: if trial 150s fails while base=180s,
    // WAIT ONLY 30 MORE seconds and probe at 180s.
    const checks=[base,120,150,180,240,300,420,540];
    for(const sec of checks){
      if(sec<=trial)continue;
      await sleepUntil(t0,sec,'E-confirm-recovery');
      const r=await send(round,'E-confirm-recovery',sec);
      const t=classify(r);
      mark('confirmation-result',{round,atSeconds:sec,classification:t,
        elapsedFromT0Ms:r.sentMs-t0});
      if(t==='other')return null;
      if(t==='success'){
        recoveredAt=sec; recoveryResult=r; break;
      }
    }
  }
  if(!recoveryResult){
    mark('no-confirmed-recovery',{round,withinSeconds:base+360});
    return null;
  }
  mark('confirmed-recovered',{round,trial,trialClassification:trialType,
    recoveredAtSeconds:recoveredAt,baseAtStart:base,
    intermediateProbeOccurred:round>1});
  await persist();
  return {trialType,recoveredAt};
}
const health=await(await fetch(ROOT+'/health')).json();
if(health.ok!==true)throw Error('Local registration probe not healthy');
mark('begin',{experiment:'A silent 90s; B probe 30s then 90s; C probe 60s then 90s',maxRounds:MAX_ROUNDS,
  zeroDefinition:'HTTP 200 with both ID pairs equal to zero'});
for(let round=1;round<=MAX_ROUNDS;round++){
  mark('round-start',{round,protocol:round===1?'silent-90':round===2?'probe-30-then-90':'probe-60-then-90'});
  const result=await trigger(round);
  if(!result){
    mark('halt',{round,reason:'unhealthy baseline, missing zero ID or unrelated error'});
    break;
  }
  const base=90,probe=90;
  const out=await waitForRecovery(round,result.t0,probe,base);
  if(!out){mark('halt',{round,reason:'recovery not confirmed'});break;}
  mark('round-observation',{round,firstZeroServerTime:result.serverTime??null,firstZeroAtMs:result.t0,successfulRegistrationsBeforeZero:result.successes,probeSeconds:round===1?null:round===2?30:60,confirmationAtSeconds:90,trialClassification:out.trialType,firstConfirmedSuccessAtSeconds:out.recoveredAt});
  await persist();
}
await persist();
mark('final',{total:rows.length,accepted:rows.filter(r=>r.ok).length,
  zero:rows.filter(r=>r.zeroId).length,
  caveat:'Rounds have different registration histories and server clock phases; no shared cooldown bounds are inferred'});
await persist();
