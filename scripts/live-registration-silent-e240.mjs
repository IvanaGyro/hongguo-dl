// SPDX-License-Identifier: GPL-3.0-only
// E240: independently trigger zero-ID responses, then remain silent for 240 seconds.
// No playback, source, CDN or simulated upstream. All completion times retained.
// Exact upstream IDs are stored in an expiring artifact, NEVER printed to logs.
import { mkdir, writeFile } from 'node:fs/promises';
const BASE='http://127.0.0.1:8787';
const OUT='/tmp/registration-policy-e240';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const start=performance.now();
const elapsed=()=>Math.round(performance.now()-start);
const rows=[];
let nextSequence=0;
const failure=(r)=>r.registrationFailure||'UNEXPECTED';
const compactFields=(r)=>Object.fromEntries(
  Object.entries(r.responseSnapshot?.fields||{}).map(([name,v])=>[name,{
    present:v.present, jsonType:v.jsonType, length:typeof v.exactValue==='string'?v.exactValue.length:null,
    zero:v.exactValue==='0'||v.exactValue===0,
    precisionChanged:v.precisionChanged,
    validParsed:v.validAsCurrentlyParsed,
    validLossless:v.validLosslessly
  }])
);
const overview=r=>({
  number:r.number,phase:r.phase,ordinal:r.ordinal,
  sentMs:r.sentMs,finishedMs:r.finishedMs,durationMs:r.durationMs,
  success:r.ok,upstreamHttp:r.upstreamStatus,
  failure:r.ok?null:failure(r),upstreamCalls:r.upstreamCalls,
  fields:compactFields(r)
});
async function save(){
  await mkdir(OUT,{recursive:true});
  const sorted=rows.slice().sort((a,b)=>a.number-b.number);
  await writeFile(OUT+'/full-records.json',JSON.stringify({
    notice:'Contains full anonymous registration IDs. Restrict access and remove after inspection.',
    createdAt:new Date().toISOString(),rows:sorted
  },null,2),{mode:0o600});
  const publicRows=sorted.map(overview);
  const summary={
    count:publicRows.length,
    success:publicRows.filter(r=>r.success).length,
    failures:publicRows.filter(r=>!r.success).length,
    failureReasons:Object.fromEntries(
      [...new Set(publicRows.filter(r=>!r.success).map(r=>r.failure))]
        .map(x=>[x,publicRows.filter(r=>r.failure===x).length])),
    firstFailure:publicRows.find(r=>!r.success)||null,
    firstZeroId:publicRows.find(r=>Object.values(r.fields).some(x=>x.zero))||null,
    lastFinishedMs:Math.max(0,...publicRows.map(r=>r.finishedMs)),
    phases:Object.fromEntries([...new Set(publicRows.map(r=>r.phase))].map(p=>[p,{
      count:publicRows.filter(r=>r.phase===p).length,
      successes:publicRows.filter(r=>r.phase===p&&r.success).length
    }]))
  };
  await writeFile(OUT+'/redacted-records.json',JSON.stringify({summary,rows:publicRows},null,2),{mode:0o600});
  console.log('CHECKPOINT '+JSON.stringify({
    count:summary.count,success:summary.success,failures:summary.failures,
    failureReasons:summary.failureReasons,firstFailureNumber:summary.firstFailure?.number??null
  }));
}
async function send(phase,ordinal){
  const number=++nextSequence,sentMs=elapsed();
  let record={number,phase,ordinal,sentMs,finishedMs:null,durationMs:null,ok:false,
    upstreamStatus:null,upstreamCalls:null,registrationFailure:null,responseSnapshot:null};
  try{
    const response=await fetch(BASE+'/register',{
      method:'POST',
      signal:AbortSignal.timeout(14000),
      cache:'no-store'
    });
    const body=await response.json();
    record={...record,ok:body.ok===true,upstreamStatus:body.upstreamStatus,
      upstreamCalls:body.upstreamCalls,registrationFailure:body.registrationFailure,
      responseSnapshot:body.responseSnapshot,upstreamStart:body.upstreamStart,
      upstreamEnd:body.upstreamEnd,isolate:body.isolate,upstreamError:body.upstreamError,
      captureError:body.captureError,
      transportHttp:response.status
    };
  }catch(err){
    record.registrationFailure=err?.name==='TimeoutError'?'LOCAL_TIMEOUT':'NETWORK_ERROR';
  }
  record.finishedMs=elapsed();record.durationMs=record.finishedMs-sentMs;
  rows.push(record);
  console.log('REG '+JSON.stringify(overview(record)));
  return record;
}
async function fixedRate(phase,count,spacingMs){
  const t0=performance.now();
  const pending=[];
  for(let i=0;i<count;i++){
    const wait=t0+i*spacingMs-performance.now();
    if(wait>0)await sleep(wait);
    pending.push(send(phase,i+1));
  }
  const out=await Promise.all(pending);
  await save();
  const success=out.filter(x=>x.ok).length;
  console.log('PHASE '+JSON.stringify({
    phase,count,spacingMs,success,failed:count-success,
    firstFailure:out.find(x=>!x.ok)?.ordinal??null,
    allFinishedAtMs:Math.max(...out.map(x=>x.finishedMs))
  }));
  return out;
}
async function silence(label,ms){
  console.log('SILENCE '+JSON.stringify({label,ms,startedAtMs:elapsed()}));
  await sleep(ms);
}
const r=await fetch(BASE+'/health');
if(!r.ok||(await r.json()).ok!==true)throw new Error('Registration workerd is unavailable');
console.log('E240 silent recovery: real upstream registration only; no playback/source/CDN.');
const baseline=await fixedRate('A-baseline-10s',3,10000);
if(baseline.some(row=>!row.ok)){
  console.log('HALT: baseline already restricted; cannot establish independent E240 trigger');
}else{
  await silence('baseline-to-trigger',5000);
  const result=await fixedRate('E240-trigger-1s',150,1000);
  if(result.some(row=>!row.ok)){
    // Exactly 240 seconds completely silent AFTER the last actual completion.
    // Do not poll, retry, or issue any other registration during silence.
    await silence('E240-full-silence',240000);
    await send('E240-one-probe',1);
  }else{
    console.log('E240 NOT APPLICABLE: no zero-ID response during trigger.');
  }
}
await save();
console.log('FINAL '+JSON.stringify({
  total:rows.length,success:rows.filter(x=>x.ok).length,
  firstZeroId:rows.find(x=>Object.values(x.responseSnapshot?.fields||{})
    .some(v=>v.exactValue==='0'||v.exactValue===0))?.number??null,
  singleProbe:rows.find(x=>x.phase==='E240-one-probe')?.ok??null,
  lastFinishedMs:Math.max(...rows.map(x=>x.finishedMs))
}));
