// SPDX-License-Identifier: GPL-3.0-only
// Keep source metadata for the active browser session without guessing expiry.
// Signed URLs are never persisted to localStorage, logs or IndexedDB.
// In-flight fetches are shared across quality changes, playback and downloads.
const canceled = () => Object.assign(new Error('Canceled'), { code: 'CANCELED' });
function abortable(task, signal) {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(canceled());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(canceled()); };
    signal.addEventListener('abort', abort, { once: true });
    task.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export function createEpisodeSourceStore(fetchSource, onUpdate = () => {}, limit = 32) {
  const entries = new Map(), controllers = new Set();
  const keyFor = (sid, vid) => String(sid) + ':' + String(vid);
  const get = async (sid, vid, { signal, refresh = false, complete = false } = {}) => {
    const key = keyFor(sid, vid);
    if (refresh) entries.delete(key);
    let entry = entries.get(key);
    const fromCache = Boolean(entry?.resolved), shared = Boolean(entry && !entry.resolved);
    if (!entry) {
      entry = { variants: [], later: Promise.resolve([]), channel: '', controller: new AbortController() };
      controllers.add(entry.controller);
      entries.set(key, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      const active = entry;
      entry.first = Promise.resolve().then(() => fetchSource(sid, vid, { signal: active.controller.signal }))
        .then(data => {
          active.resolved = true;
          active.channel = data.sourceChannel || '';
          active.winnerVariants = [...(data.variants || [])];
          active.variants = [...active.winnerVariants];
          const merge = extras => {
            if (entries.get(key) !== active) return [];
            const seen = new Set(active.variants.map(v => v.url));
            const added = [];
            for (const v of extras || []) {
              if (!v?.url || seen.has(v.url)) continue;
              seen.add(v.url);
              active.variants.push(v); added.push(v);
            }
            if (added.length) onUpdate(sid, vid, [...active.variants]);
            return added;
          };
          active.later = Promise.resolve(data.lateVariants || []).then(merge, () => [])
            .finally(() => controllers.delete(active.controller));
          if (entries.get(key) === active) onUpdate(sid, vid, [...active.variants]);
          return active;
        }, error => {
          controllers.delete(active.controller);
          if (entries.get(key) === active) entries.delete(key);
          throw error;
        });
    }
    entry = await abortable(entry.first, signal);
    if (complete) await abortable(entry.later, signal);
    return { variants: [...entry.variants], winnerVariants: [...entry.winnerVariants],
      sourceChannel: entry.channel, fromCache, shared,
      lateVariants: complete ? null : entry.later };
  };
  return { get, abortAll() { for (const controller of controllers) controller.abort(); controllers.clear(); entries.clear(); }, invalidate(sid, vid) { entries.delete(keyFor(sid, vid)); },
    peek(sid, vid) { return entries.get(keyFor(sid, vid))?.variants || null; } };
}
