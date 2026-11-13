// SPDX-License-Identifier: GPL-3.0-only
// Test-only Worker that reproduces the *same module-scoped queue pattern*
// used by worker/vendor/app-source.js, with a deterministic fake upstream.
// It NEVER contacts Hongguo or any external upstream.
const WORK_MS = 800;
const COOLDOWN_MS = 1000;
let playbackQueue = Promise.resolve();
let playbackReadyAt = 0;
let instanceId = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request) {
    instanceId ||= crypto.randomUUID(); // Only evaluated inside a request.
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, instanceId });
    }
    if (url.pathname !== '/probe') {
      return new Response('Not found', { status: 404 });
    }
    const mode = url.searchParams.get('mode') || 'queue';
    const enteredAt = Date.now();
    const execute = async () => {
      const beforeCooling = Date.now();
      const cooldownMs = mode === 'queue' ? Math.max(0, playbackReadyAt - Date.now()) : 0;
      if (cooldownMs) await sleep(cooldownMs);
      const startedAt = Date.now();
      try {
        await sleep(WORK_MS);
        const doneAt = Date.now();
        return { instanceId, mode, enteredAt, startedAt, doneAt,
          queueWaitMs: startedAt - enteredAt,
          cooldownMs, simulatedUpstreamMs: doneAt - startedAt };
      } finally {
        if (mode === 'queue') playbackReadyAt = Date.now() + COOLDOWN_MS;
      }
    };
    if (mode !== 'queue' && mode !== 'parallel')
      return new Response('Invalid mode', { status: 400 });
    if (mode === 'parallel') return Response.json(await execute());
    const pending = playbackQueue.then(execute);
    playbackQueue = pending.catch(() => {});
    return Response.json(await pending);
  }
};
