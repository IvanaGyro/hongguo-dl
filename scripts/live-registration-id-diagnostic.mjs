// SPDX-License-Identifier: GPL-3.0-only
// Real Hongguo registration only; full IDs saved to short-lived artifact ONLY.
// NEVER print IDs or raw responses in CI logs.
import { mkdir,writeFile } from 'node:fs/promises';
const BASE='http://127.0.0.1:8787';
const OUT='/tmp/hongguo-registration-id-diagnostic';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const T0=performance.now(), t=()=>Math.round(performance.now()-T0);
let seq=0;
const rows=[];
const summaryOf=row=>({
  n:row.n,phase:row.phase,index:row.index,sentMs:row.sentMs,
  completedMs:row.completedMs,durationMs:row.durationMs,success:row.ok,
  upstreamHttp:row.upstreamStatus,upstreamCalls:row.upstreamCalls,
  registrationFailure:row.registrationFailure,
  captureError:row.captureError,
  fieldStructure:Object.fromEntries(Object.entries(row.responseSnapshot?.fields||{})
    .map(([k,v])=>[k,{
      present:v.present,jsonType:v.jsonType,
      digits:typeof v.exactValue==='string'?v.exactValue.length:null,
      precisionChanged:v.precisionChanged,
      validAsCurrentlyParsed:v.validAsCurrentlyParsed,
      validLosslessly:v.validLosslessly
    }]))
});
async function persist() {
  await mkdir(OUT,{recursive:true});
  const sorted=rows.slice().sort((a,b)=>a.n-b.n);
  await writeFile(OUT+'/registration-ids.json',JSON.stringify({
    warning:'Contains exact anonymous device registration identifiers. Do not publish.',
    count:sorted.length,rows:sorted
  },null,2),{mode:0o600});
  const metrics={
    count:sorted.length,success:sorted.filter(x=>x.ok).length,
    errors:Object.fromEntries([...new Set(sorted.filter(x=>!x.ok).map(x=>x.registrationFailure))]
      .map(e=>[e,sorted.filter(x=>x.registrationFailure===e).length])),
    firstFailure:sorted.find(x=>!x.ok)?.n||null
  };
  await writeFile(OUT+'/summary.json',JSON.stringify(metrics,null,2));
  console.log('CHECKPOINT '+JSON.stringify(metrics));
}
async function probe(phase,index) {
  const n=++seq,sentMs=t();
  let row={n,phase,index,sentMs,completedMs:null,durationMs:null,
    ok:false,upstreamStatus:null,upstreamCalls:null,
    registrationFailure:null,captureError:null,responseSnapshot:null};
  try{
    const response=await fetch(BASE+'/register',{
      method:'POST',signal:AbortSignal.timeout(14000),cache:'no-store'
    });
    const data=await response.json();
    row={...row,ok:data.ok===true,upstreamStatus:data.upstreamStatus,
      upstreamCalls:data.upstreamCalls,registrationFailure:data.registrationFailure,
      captureError:data.captureError,responseSnapshot:data.responseSnapshot,
      upstreamStart:data.upstreamStart,upstreamEnd:data.upstreamEnd,
      isolate:data.isolate};
  }catch(e){row.registrationFailure=e?.name==='TimeoutError'?'LOCAL_TIMEOUT':'NETWORK_FAILURE';}
  row.completedMs=t();row.durationMs=row.completedMs-sentMs;
  rows.push(row);
  // Console receives strictly non-identifying data; exact IDs only in artifact.
  console.log('REG '+JSON.stringify(summaryOf(row)));
  return row;
}
async function group(phase,n,intervalMs) {
  const starts=performance.now();
  const pending=[];
  for(let i=0;i<n;i++){
    const delay=starts+i*intervalMs-performance.now();
    if(delay>0)await sleep(delay);
    pending.push(probe(phase,i+1));
  }
  const out=await Promise.all(pending);
  await persist();
  return out;
}
const health=await(await fetch(BASE+'/health')).json();
if(!health.ok)throw Error('Local registration probe unavailable');
console.log('START: real registration, exact IDs artifact-only, no playback, no media, no local throttles');
// Take 3 independent baseline responses; allow 10 seconds between launches.
const baseline=await group('baseline-10s',3,10000);
if(baseline.some(r=>!r.ok)){
  console.log('BASELINE FAILED: preserved exact IDs, not running additional stress load');
  await persist();
}else{
  // Respect >=5s between separate experiments.
  console.log('SILENCE: 5 seconds after ALL baseline requests complete');
  await sleep(5000);
  // Reproduce prior ~100-registration anomaly and preserve 150 raw ID sets.
  await group('repro-1s',150,1000);
}
console.log('FINISHED: '+JSON.stringify({
  total:rows.length,ok:rows.filter(r=>r.ok).length,
  rejected:rows.filter(r=>!r.ok).length,
  firstRejected:rows.find(r=>!r.ok)?.n||null
}));
