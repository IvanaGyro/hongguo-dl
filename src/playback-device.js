import { createPlaybackAttempts } from './playback-attempts.js';
// Persist one anonymous browser installation independently of proxy routing. No accounts, cookies or signed URLs.
export function createPlaybackDeviceStore({ storage, fetchImpl = fetch, cryptoImpl = crypto,
  locks = globalThis.navigator?.locks, now = Date.now, background = () => globalThis.document?.hidden === true, onEvent = () => {} } = {}) {
  const states = new Map(), pending = new Map();
  let attempts = createPlaybackAttempts();
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  function valid(value, profile) {
    return typeof profile === 'string' && value?.profile === profile && uuid.test(value.clientId || '') && uuid.test(value.cdid || '') &&
      uuid.test(value.clientudid || '') && /^[a-f0-9]{16}$/i.test(value.openudid || '') &&
      Number.isSafeInteger(value.firstInstallAt) && value.firstInstallAt > 0 && value.firstInstallAt <= now() + 60000 &&
      (value.device_id === undefined && value.iid === undefined ||
        typeof value.device_id === 'string' && /^[0-9]{1,30}$/.test(value.device_id) && /[1-9]/.test(value.device_id) &&
        typeof value.iid === 'string' && /^[0-9]{1,30}$/.test(value.iid) && /[1-9]/.test(value.iid) &&
        Number.isSafeInteger(value.registeredAt) && value.registeredAt > 0 && value.registeredAt <= now() + 60000);
  }
  async function ensure(apiUrl, profile, onStage = () => {}) {
    const origin = new URL(apiUrl, globalThis.location?.href).origin;
    const key = 'hongguo-playback-device-v1';
    const read = () => {
      let identity = states.get(key);
      try {
        const stored = JSON.parse(storage?.getItem(key) || 'null');
        if (stored && valid(stored, stored.profile)) identity = stored;
      } catch { /* Private-mode/storage failures use this page's memory. */ }
      if (identity?.profile !== profile && valid({ ...identity, profile }, profile)) {
        // Profile updates preserve the installation and existing registered IDs.
        identity = { ...identity, profile, ...(identity.device_id ? { registeredAt: 1 } : {}) };
        states.delete(key + ':retry');
      }
      return valid(identity, profile) ? identity : null;
    };
    const existing = read();
    if (!existing?.device_id) onStage('device-register', { attempt: attempts.count('device-register') + (pending.has(key) ? 0 : 1) || 1 });
    if (pending.has(key)) return existing?.device_id ? existing : pending.get(key);
    const run = async () => {
      let identity = read();
      if (!valid(identity, profile)) {
        identity = { profile, clientId: cryptoImpl.randomUUID(), cdid: cryptoImpl.randomUUID(),
          clientudid: cryptoImpl.randomUUID(),
          openudid: Array.from(cryptoImpl.getRandomValues(new Uint8Array(8)), x => x.toString(16).padStart(2, '0')).join(''),
          firstInstallAt: now() };
      }
      const save = value => {
        states.set(key, value);
        try { storage?.setItem(key, JSON.stringify(value)); } catch { /* Memory fallback. */ }
      };
      save(identity); // Keep seeds even when the initial registration fails.
      const interval = (background() ? 12 : 6) * 3600000;
      const retryAt = states.get(key + ':retry') || 0;
      if (identity.device_id && (now() - identity.registeredAt < interval || now() < retryAt)) return identity;
      try {
        const attempt = attempts.begin('device-register');
        onEvent('register.begin', { attempt, background: Boolean(identity.device_id) });
        const response = await fetchImpl(new URL('/api/device', origin), { method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ installation: identity, background: background() }), signal: AbortSignal.timeout(10000) });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data?.error?.message || '播放裝置初始化失敗'), {
          code: data?.error?.code || 'DEVICE_REGISTRATION_FAILED', status: response.status, stage: 'source-api',
          ...(Number.isFinite(data?.error?.retryAfterMs) ? { retryAfterMs: data.error.retryAfterMs } : {}) });
        if (!valid(data, profile) || !data.device_id || ['clientId', 'cdid', 'clientudid', 'openudid', 'firstInstallAt']
          .some(field => data[field] !== identity[field])) throw Object.assign(new Error('播放裝置資料無效'), { code: 'INVALID_DEVICE', stage: 'source-api' });
        save(data);
        onEvent('register.ready', { attempt, background: Boolean(identity.device_id) });
        // A failed scheduled update may return the existing identity. Avoid a refresh loop.
        states.set(key + ':retry', now() + 60000);
        return data;
      } catch (error) {
        states.set(key + ':retry', now() + 60000);
        onEvent('register.failed', { attempt: attempts.count('device-register'), background: Boolean(identity.device_id), code: error.code || 'ERR_NETWORK' });
        if (identity.device_id) return identity; // Update scheduling is not ID expiry.
        throw attempts.decorate(error, 'device-register');
      }
    };
    const job = (locks ? locks.request(key, run) : run()).finally(() => pending.delete(key));
    pending.set(key, job);
    // Scheduled registration updates run independently; normal source reads keep using the IDs.
    return existing?.device_id ? existing : job;
  }
  async function renew(apiUrl, profile, onStage) {
    // Recovery creates a fresh installation, rather than scheduling an update
    // with the potentially rejected did/iid (which may return the same IDs).
    await pending.get('hongguo-playback-device-v1')?.catch(() => {});
    attempts = createPlaybackAttempts();
    const identity = { profile, clientId: cryptoImpl.randomUUID(), cdid: cryptoImpl.randomUUID(),
      clientudid: cryptoImpl.randomUUID(),
      openudid: Array.from(cryptoImpl.getRandomValues(new Uint8Array(8)), x => x.toString(16).padStart(2, '0')).join(''),
      firstInstallAt: now() };
    states.set('hongguo-playback-device-v1', identity);
    states.delete('hongguo-playback-device-v1:retry');
    try { storage?.setItem('hongguo-playback-device-v1', JSON.stringify(identity)); } catch { /* Memory fallback. */ }
    return ensure(apiUrl, profile, onStage);
  }
  return { ensure, renew };
}
