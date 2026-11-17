// SPDX-License-Identifier: GPL-3.0-only
// Declarative media demands: the main thread states "I need ..." (upsert)
// or "I no longer need ..." (remove). The media Worker reconciles this table
// against its sources, byte caches, metadata and engine; nothing here starts
// a step. Pure and DOM-free so the lifecycle can be unit tested.

export const DEMAND_OUTPUTS = Object.freeze(['metadata', 'playable-media']);
const BRIDGES = ['cenc', 'bvc2'];
const PRIORITIES = ['active', 'speculative'];
const MAX_DEMANDS = 8;
const invalid = reason => Object.assign(new Error('Invalid media demand: ' + reason),
  { code: 'MEDIA_DEMAND_INVALID' });
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

// Two demands share download/cache/metadata state only when they name the
// same resource and need the same byte interpretation (ByteVC2 overlays).
export function sourceKeyOf(source) {
  return source.bridge + '\n' + source.url;
}

export function normalizeDemand(input) {
  if (!input || typeof input !== 'object') throw invalid('shape');
  const { id, revision, source, output } = input;
  if (typeof id !== 'string' || !/^[\w.:-]{1,64}$/.test(id)) throw invalid('id');
  if (!Number.isSafeInteger(revision) || revision < 0) throw invalid('revision');
  if (!source || typeof source.url !== 'string' || !source.url || source.url.length > 8192)
    throw invalid('source');
  if (source.proxyUrl != null && (typeof source.proxyUrl !== 'string' || source.proxyUrl.length > 8192))
    throw invalid('proxy');
  const bridge = source.bridge ?? 'cenc';
  if (!BRIDGES.includes(bridge)) throw invalid('bridge');
  const key = source.key || '';
  if (key && !/^[a-f0-9]{32}$/i.test(key)) throw invalid('key');
  if (!DEMAND_OUTPUTS.includes(output)) throw invalid('output');
  const positionSeconds = input.positionSeconds ?? 0;
  if (!finite(positionSeconds, 0, 24 * 3600)) throw invalid('position');
  const durationHint = input.durationHint ?? null;
  if (durationHint !== null && !finite(durationHint, 0, 24 * 3600)) throw invalid('duration');
  const playback = input.playback || {};
  const paused = playback.paused ?? true;
  const bufferedAheadSeconds = playback.bufferedAheadSeconds ?? 0;
  const bufferTargetSeconds = playback.bufferTargetSeconds ?? 0;
  if (typeof paused !== 'boolean' || !finite(bufferedAheadSeconds, 0, 24 * 3600) ||
      !finite(bufferTargetSeconds, 0, 3600)) throw invalid('playback');
  const priority = input.priority ?? 'active';
  if (!PRIORITIES.includes(priority)) throw invalid('priority');
  const processing = input.processing ?? true;
  if (typeof processing !== 'boolean') throw invalid('processing');
  const codec = input.codec ?? null;
  if (codec !== null && !['h264', 'hevc'].includes(codec)) throw invalid('codec');
  if (output === 'playable-media' && bridge === 'cenc' && !key) throw invalid('key');
  return {
    id, revision, output, codec, positionSeconds, durationHint, priority, processing,
    source: { url: source.url, proxyUrl: source.proxyUrl || null, bridge, key },
    playback: { paused, bufferedAheadSeconds, bufferTargetSeconds }
  };
}

// Network read-ahead continues for speculative work, during playback, and
// while paused until the presentation's reported buffer target is met.
// Pausing never withdraws the demand itself.
export function wantsReadAhead(demand) {
  if (!demand || demand.output !== 'playable-media') return false;
  const { paused, bufferedAheadSeconds, bufferTargetSeconds } = demand.playback;
  return demand.priority === 'speculative' || !paused ||
    (bufferTargetSeconds > 0 && bufferedAheadSeconds < bufferTargetSeconds);
}

export function createDemandTable({ maxDemands = MAX_DEMANDS } = {}) {
  const demands = new Map();
  return {
    /**
     * Upsert a demand. A repeated revision is idempotent; an older revision
     * is ignored. `positionRevision` is the revision at which the requested
     * position or source last changed, so outputs produced for an earlier
     * position can be recognized as stale by both sides.
     */
    upsert(input) {
      const next = normalizeDemand(input);
      const previous = demands.get(next.id) || null;
      if (previous && next.revision < previous.revision) return { status: 'stale', demand: previous };
      if (previous && next.revision === previous.revision) return { status: 'unchanged', demand: previous };
      const sourceChanged = !previous || sourceKeyOf(previous.source) !== sourceKeyOf(next.source) ||
        previous.source.key !== next.source.key || previous.output !== next.output;
      if (next.output === 'playable-media' && [...demands.values()].some(other =>
          other.id !== next.id && other.output === 'playable-media'))
        throw Object.assign(new Error('Media Worker already serves a playable demand'),
          { code: 'MEDIA_DEMAND_BUSY' });
      if (!previous && demands.size >= maxDemands)
        throw Object.assign(new Error('Too many media demands'), { code: 'MEDIA_DEMAND_BUSY' });
      const positionChanged = sourceChanged || previous.positionSeconds !== next.positionSeconds;
      const demand = { ...next, sourceKey: sourceKeyOf(next.source),
        positionRevision: positionChanged ? next.revision : previous.positionRevision };
      demands.set(demand.id, demand);
      return { status: previous ? 'updated' : 'created', demand, previous, sourceChanged, positionChanged };
    },
    remove(id) {
      const demand = demands.get(id) || null;
      demands.delete(id);
      return demand;
    },
    get: id => demands.get(id) || null,
    values: () => [...demands.values()],
    playable: () => [...demands.values()].find(demand => demand.output === 'playable-media') || null,
    consumers: key => [...demands.values()].filter(demand => demand.sourceKey === key),
    sourceKeys: () => new Set([...demands.values()].map(demand => demand.sourceKey)),
    clear() { const all = [...demands.values()]; demands.clear(); return all; },
    get size() { return demands.size; }
  };
}
