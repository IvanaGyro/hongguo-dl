// Bounded, per-tab, shared media cache for both playback and downloading.
// Browsers manage direct <video src=url> buffering privately; only byte buffers
// explicitly fetched by this app can be shared across the two modes.
export class MediaCache {
  constructor(limit = 96 * 1024 * 1024) { this.limit = limit; this.items = new Map(); this.size = 0; }
  get(key) {
    const value = this.items.get(key);
    if (value) { this.items.delete(key); this.items.set(key, value); }
    return value?.blob || null;
  }
  put(key, blob) {
    if (!(blob instanceof Blob) || blob.size <= 0 || blob.size > this.limit) return false;
    const old = this.items.get(key);
    if (old) { this.size -= old.blob.size; this.items.delete(key); }
    while (this.size + blob.size > this.limit) {
      const oldest = this.items.keys().next().value;
      if (!oldest) break;
      this.size -= this.items.get(oldest).blob.size;
      this.items.delete(oldest);
    }
    this.items.set(key, { blob }); this.size += blob.size;
    return true;
  }
  clear() { this.items.clear(); this.size = 0; }
}
export function episodeCacheKey(seriesId, vid, quality = 'auto', codec = 'auto') {
  return [String(seriesId || 'direct'), String(vid), quality, codec].join(':');
}
