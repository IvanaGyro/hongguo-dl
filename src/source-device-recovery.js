// Empty upstream 200s are evidence for trying a new anonymous installation,
// not proof of a device ban. Ordinary HTTP 502s do not rotate identities.
export function createSourceDeviceRecovery({ devices, storage, now = Date.now, onEvent = () => {} }) {
  const key = 'hongguo-source-device-recovery-v1';
  let state = {}, renewing = null, progress = null;
  const listeners = new Set();
  try { state = JSON.parse(storage?.getItem(key) || '{}') || {}; } catch { /* Memory fallback. */ }
  if (typeof state !== 'object' || Array.isArray(state)) state = {};
  const save = () => { try { storage?.setItem(key, JSON.stringify(state)); } catch { /* Memory fallback. */ } };
  const canceled = () => Object.assign(new Error('Canceled'), { code: 'CANCELED' });
  const check = signal => { if (signal?.aborted) throw canceled(); };
  const cooldown = onWait => {
    const remaining = Math.max(0, (state.cooldownUntil || 0) - now());
    if (!remaining) return;
    onWait('device-cooldown', { remainingSeconds: Math.ceil(remaining / 1000) });
    throw Object.assign(new Error('更新播放裝置連續失敗 3 次，請等一分鐘後再試'), {
      code: 'DEVICE_RECOVERY_COOLDOWN', stage: 'source-api', retryStep: 'device-register', retryAfterMs: remaining
    });
  };
  async function renew(options) {
    if (renewing) return renewing;
    const { apiUrl, profile, signal, onWait } = options;
    cooldown(onWait);
    renewing = (async () => {
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        check(signal);
        progress = ['device-renew', { attempt, limit: 3 }];
        for (const listener of new Set([onWait, ...listeners])) listener(...progress);
        onEvent('recovery.register', { attempt });
        try {
          const identity = await devices.renew(apiUrl, profile);
          state = { clientId: identity.clientId, emptyStreak: 0 };
          save(); onEvent('recovery.ready', { attempt });
          return identity;
        } catch (error) {
          check(signal); lastError = error;
        }
      }
      state.needsRenew = true; state.cooldownUntil = now() + 60000;
      save(); onEvent('recovery.cooldown', { failures: 3, seconds: 60, code: lastError?.code });
      cooldown(onWait);
    })().finally(() => { renewing = null; progress = null; });
    return renewing;
  }
  // Detach canceled consumers promptly; one shared registration can still
  // finish and persist its result for other consumers of this browser.
  function observe(task, signal) {
    if (!signal) return task;
    check(signal);
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(canceled()); };
      signal.addEventListener('abort', abort, { once: true });
      task.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  async function followRenew(task, options) {
    listeners.add(options.onWait);
    if (progress) options.onWait(...progress);
    try { return await observe(task, options.signal); }
    finally { listeners.delete(options.onWait); }
  }
  return {
    async request({ apiUrl, profile, signal, onWait = () => {}, run }) {
      const options = { apiUrl, profile, signal, onWait };
      check(signal); cooldown(onWait);
      let identity = renewing || state.needsRenew
        ? await followRenew(renewing || renew(options), options)
        : await observe(devices.ensure(apiUrl, profile, onWait), signal);
      for (;;) {
        check(signal);
        try {
          const data = await run(identity);
          if (state.clientId === identity.clientId) { state.emptyStreak = 0; save(); }
          return data;
        } catch (error) {
          check(signal);
          // Ignore late results belonging to an identity already replaced.
          if (state.clientId && state.clientId !== identity.clientId) throw error;
          state.clientId = identity.clientId;
          const empty = error?.code === 'EMPTY_RESPONSE';
          const count = error.upstreamStatus === 200 && Number.isInteger(error.emptyResponseCount)
            ? Math.max(1, Math.min(3, error.emptyResponseCount)) : 1;
          state.emptyStreak = empty ? (state.emptyStreak || 0) + count : 0;
          save();
          if (!empty || state.emptyStreak < 3) throw error;
          state.needsRenew = true; save();
          onEvent('recovery.begin', { emptyResponses: state.emptyStreak });
          identity = await followRenew(renew(options), options);
        }
      }
    }
  };
}
