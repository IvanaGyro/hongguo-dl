// SPDX-License-Identifier: GPL-3.0-only
// Local workerd experiment: test module-scoped queue vs unconstrained async fetch.
// No real upstream requests, signatures, media or credentials.
const ORIGIN = 'http://127.0.0.1:8787';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function exercise({ label, mode, intervalMs, count = 3 }) {
  const originTime = performance.now();
  const promises = Array.from({ length: count }, (_, i) => (async () => {
    await sleep(i * intervalMs);
    const sent = performance.now();
    const response = await fetch(ORIGIN + '/probe?mode=' + mode);
    if (!response.ok) throw new Error('Worker HTTP ' + response.status);
    const data = await response.json();
    return {
      request: i + 1, instance: data.instanceId.slice(0, 8),
      sentMs: Math.round(sent - originTime),
      doneMs: Math.round(performance.now() - originTime),
      clientDurationMs: Math.round(performance.now() - sent),
      queueWaitMs: data.queueWaitMs, cooldownMs: data.cooldownMs,
      upstreamMs: data.simulatedUpstreamMs
    };
  })());
  const result = await Promise.all(promises);
  console.log('\n' + label);
  console.table(result);
  if (new Set(result.map(x => x.instance)).size > 1)
    console.log('Requests reached different isolates, not a shared queue.');
  await sleep(1200); // Clear global 1 s cooldown before the next scenario.
  return result;
}

const probe = await fetch(ORIGIN + '/health');
if (!probe.ok || !(await probe.json()).ok) throw new Error('Not running on workerd');
console.log('Local Cloudflare workerd; upstream simulated as 800 ms async wait; cooldown 1000 ms');
const parallel = await exercise({ label: 'No queue: simultaneous requests', mode: 'parallel', intervalMs: 0 });
const simultaneous = await exercise({ label: 'Current app-source queue: simultaneous requests', mode: 'queue', intervalMs: 0 });
const halfSecond = await exercise({ label: 'Current app-source queue: 0.5 second spacing', mode: 'queue', intervalMs: 500 });
const twoSeconds = await exercise({ label: 'Current app-source queue: 2 second spacing', mode: 'queue', intervalMs: 2000 });
if (Math.max(...parallel.map(r => r.clientDurationMs)) > 2400)
  throw new Error('Unexpected >2.4 second latency without queue');
if (simultaneous[2].clientDurationMs <= simultaneous[0].clientDurationMs + 1300)
  throw new Error('Expected head-of-line blocking was not reproduced');
if (Math.max(...twoSeconds.map(r => r.queueWaitMs)) > 350)
  throw new Error('Two-second spacing unexpectedly queued');
console.log('\nPASS: The one-second post-completion cooldown and per-isolate promise queue reproduce the user-observed spacing threshold in actual workerd.');
