// SPDX-License-Identifier: GPL-3.0-only
// REAL Hongguo App source API via local workerd. No simulated upstream.
// Records completion and HTTP status for ALL 30 requests in every experiment.
// Never print any returned signed video URL, device identity, headers or keys.
import { writeFile, mkdir } from 'node:fs/promises';
const ORIGIN = 'http://127.0.0.1:8787';
const SID = '7699513062054710296';
const VIDS = [
  '7699522762213182488', '7699522764142562328', '7699522704516336664',
  '7699522727450774552', '7699522710145076248', '7699522740675415064',
  '7699522737227697176', '7699522732500716568', '7699522730814606360',
  '7699522706915478552', '7699522711613099032', '7699522755309341720',
  '7699522716981808152', '7699522733930990616', '7699522742286044184',
  '7699522724418292760', '7699522699206331416', '7699522767657389080',
  '7699522720995740696', '7699522766097107992', '7699522695922207768',
  '7699522713185946648', '7699522697717353496', '7699522749303098392',
  '7699522753791003672', '7699522743909223448', '7699522750636903448',
  '7699522747591822360', '7699522719355767832', '7699522701060213784'
];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const mode = process.argv[2];
const intervalMs = Number(process.argv[3]);
if (!['queue','parallel'].includes(mode) || ![0,500,1000,2000].includes(intervalMs))
  throw new Error('Usage: node scripts/live-app-interval-bench.mjs queue|parallel 0|500|1000|2000');
const perfStart = performance.now();
const settled = await Promise.all(VIDS.map(async (vid, i) => {
  if (intervalMs) await wait(i * intervalMs);
  const sentAt = performance.now();
  let response;
  try {
    response = await fetch(ORIGIN + '/api/source?' + new URLSearchParams({
      sid: SID, vid, channel: 'app', benchmark: mode
    }), { signal: AbortSignal.timeout(180000), cache: 'no-store' });
    // Parse *all* responses fully, including failures; suppress any signed URLs.
    const data = await response.json();
    const finishedAt = performance.now();
    return {
      episode: i+1, sentMs: Math.round(sentAt-perfStart),
      finishedMs: Math.round(finishedAt-perfStart),
      durationMs: Math.round(finishedAt-sentAt), http: response.status,
      result: response.ok ? 'ok' : String(data?.error?.code || 'HTTP_ERROR').slice(0,64),
      variantCount: response.ok ? (data?.variants?.length||0) : 0,
      isolate: (response.headers.get('X-Benchmark-Isolate') || '').slice(0,8),
      queueWaitMs: Number.isFinite(Number(response.headers.get('X-Benchmark-Queue-Wait-Ms')))
        ? Number(response.headers.get('X-Benchmark-Queue-Wait-Ms')) : null
    };
  } catch (error) {
    const finishedAt=performance.now();
    return {
      episode:i+1, sentMs:Math.round(sentAt-perfStart),
      finishedMs:Math.round(finishedAt-perfStart),
      durationMs:Math.round(finishedAt-sentAt), http:0,
      result:error?.name==='TimeoutError'?'TIMEOUT':'NETWORK_ERROR',
      variantCount:0, isolate:null, queueWaitMs:null
    };
  } finally {
    await response?.body?.cancel().catch(()=>{});
  }
}));
const sort = numbers => numbers.slice().sort((a,b)=>a-b);
const percentile = (nums, p) => {
  if (!nums.length) return null;
  const s = sort(nums);
  const i = (s.length-1)*p, lo=Math.floor(i),hi=Math.ceil(i);
  return Math.round(s[lo]+(s[hi]-s[lo])*(i-lo));
};
const durations = settled.map(x=>x.durationMs);
const successes = settled.filter(x=>x.http===200);
const summary = {
  mode, intervalMs, count:settled.length,
  success:successes.length, failed:settled.length-successes.length,
  statusCounts: Object.fromEntries([...new Set(settled.map(x=>x.http))].map(s=>[s,settled.filter(x=>x.http===s).length])),
  errors: Object.fromEntries([...new Set(settled.filter(x=>x.http!==200).map(x=>x.result))].map(s=>[s,settled.filter(x=>x.result===s).length])),
  observedIsolates:[...new Set(settled.map(x=>x.isolate).filter(Boolean))],
  allDurationsMs:{min:Math.min(...durations),p50:percentile(durations,.5),p90:percentile(durations,.9),p95:percentile(durations,.95),max:Math.max(...durations)},
  successfulDurationsMs:{p50:percentile(successes.map(x=>x.durationMs),.5),p95:percentile(successes.map(x=>x.durationMs),.95)},
  fullExperimentWallMs: Math.max(...settled.map(x=>x.finishedMs))
};
const label=mode+'-'+intervalMs+'ms';
console.log('\n==== REAL APP SOURCE '+label+' (30 episodes) ====');
console.log('Requests all fully settled (including failed responses), sorted by episode/send order:');
console.table(settled);
console.log('SUMMARY '+JSON.stringify(summary));
await mkdir('/tmp/hongguo-live-app-probe',{recursive:true});
await writeFile('/tmp/hongguo-live-app-probe/'+label+'.json',JSON.stringify({summary,requests:settled},null,2));
if (settled.length!==30) throw new Error('Experiment missing request rows');
