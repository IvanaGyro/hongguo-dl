// SPDX-License-Identifier: GPL-3.0-only
// Real registration-only observation. Do not disclose device IDs, signed URLs,
// response bodies, identity seeds, requests, tokens or personal data.
import { mkdir, writeFile } from 'node:fs/promises';
const BASE='http://127.0.0.1:8787';
const OUT='/tmp/hongguo-registration-experiment';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rows=[];
let sequence=0;
const now=()=>performance.now();
const expStart=now();
const elapsed=()=>Math.round(now()-expStart);
const classify=r=>r.ok?'SUCCESS':
  r.registrationFailure==='HTTP_429'?'UPSTREAM_429':
  r.registrationFailure==='HTTP_403'?'UPSTREAM_403':
  r.registrationFailure||r.upstreamErrorCode||'UNKNOWN';

async function probe(group, ordinal) {
  const sentMs=elapsed();
  try {
    const response=await fetch(BASE+'/register',{
      method:'POST',signal:AbortSignal.timeout(14000),headers:{'content-type':'application/json'}
    });
    const data=await response.json();
    const row={
      number:++sequence,group,ordinal,sentMs,
      completedMs:elapsed(),durationMs:elapsed()-sentMs,
      success:data.ok===true,upstreamHttp:data.upstreamHttp,
      category:classify(data),upstreamCalls:data.upstreamCalls,
      upstreamDurationMs:data.upstreamFinishedAt!=null&&data.upstreamStartedAt!=null
        ? data.upstreamFinishedAt-data.upstreamStartedAt:null,
      isolate:String(data.isolate||'').slice(0,8)
    };
    rows.push(row);
    console.log('REG '+JSON.stringify(row));
    return row;
  } catch (error) {
    const row={number:++sequence,group,ordinal,sentMs,
      completedMs:elapsed(),durationMs:elapsed()-sentMs,
      success:false,upstreamHttp:null,
      category:error?.name==='TimeoutError'?'LOCAL_TIMEOUT':'LOCAL_TRANSPORT_ERROR',
      upstreamCalls:null,upstreamDurationMs:null,isolate:null};
    rows.push(row);
    console.log('REG '+JSON.stringify(row));
    return row;
  }
}
async function persist() {
  await mkdir(OUT,{recursive:true});
  const counts=Object.fromEntries([...new Set(rows.map(x=>x.category))]
    .map(cat=>[cat,rows.filter(x=>x.category===cat).length]));
  await writeFile(OUT+'/results.json',JSON.stringify({
    durationMs:elapsed(),count:rows.length,counts,rows
  },null,2));
}
async function series(group,n,gapMs) {
  const start=now();
  const tasks=[];
  for(let i=0;i<n;i++) {
    const due=start+i*gapMs;
    const remain=due-now();
    if(remain>0)await sleep(remain);
    tasks.push(probe(group,i+1));
  }
  const result=await Promise.all(tasks);
  await persist();
  console.log('GROUP '+group+' '+JSON.stringify({
    sent:n,finished:result.length,success:result.filter(x=>x.success).length,
    firstFailure:result.find(x=>!x.success)||null,lastCompletedMs:Math.max(...result.map(x=>x.completedMs))
  }));
  return result;
}
async function rest(label,ms) {
  console.log('SILENCE '+label+' '+ms+'ms starts '+elapsed());
  await sleep(ms);
}
async function recoveryD() {
  // Timings relative to the END of the trigger group. End of each real
  // registration request is observed and no outstanding calls remain.
  const start=now(),checkpoints=[5,15,30,60,120,300];
  for(const checkpoint of checkpoints) {
    const remaining=start+checkpoint*1000-now();
    if(remaining>0)await rest('D-until-'+checkpoint+'s',remaining);
    const row=await probe('D-polling',checkpoint);
    await persist();
    if(row.success){console.log('RECOVERED D at '+checkpoint+'s');return true;}
  }
  return false;
}

console.log('REGISTRATION ONLY: upstream real, queue=off; no App source, no CDN');
const health=await (await fetch(BASE+'/health')).json();
if(!health.ok)throw Error('Local workerd probe unavailable');

// A. 8 low-rate baseline requests. All 8 complete before next experiment.
await series('A-baseline-10s',8,10000);
await rest('A-to-B',5000);

// B. 150 registration calls, one per second, with full response collection.
const b=await series('B-1s',150,1000);
const rejected=b.some(x=>!x.success);
if(rejected){
  await rest('B-to-D',5000);
  const recovered=await recoveryD();
  if(recovered){
    // E. Independent second trigger: wait >5s after recovery, re-trigger
    // with identical pattern, then remain COMPLETELY SILENT for 120s
    // before ONE probe. Unlike D, no intermediate polling.
    await rest('D-to-E-trigger',5000);
    const second=await series('E-trigger-1s',150,1000);
    if(second.some(x=>!x.success)){
      await rest('E-silent-120s',120000);
      await probe('E-single-probe',1);
      await persist();
    }else{
      console.log('E SKIPPED: second trigger did not reproduce any failure');
    }
  }else{
    console.log('E SKIPPED: upstream did not recover within 300 seconds under D polling');
  }
}else{
  console.log('D/E SKIPPED: no registration failure during 150-request trigger');
}
await persist();
console.log('FINAL '+JSON.stringify({count:rows.length,success:rows.filter(x=>x.success).length,
  firstRegistrationFailure:rows.find(x=>!x.success)||null,lastCompletedMs:Math.max(...rows.map(x=>x.completedMs))}));
