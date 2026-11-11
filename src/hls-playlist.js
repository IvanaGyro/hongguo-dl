// Pure HLS media-playlist parsing and rewriting.
// No fetch(), browser state, FFmpeg, filesystem access, or asynchronous work.
import { assertHlsManifest, errorWith } from './logic.js';

const MAX_SEGMENTS = 1500;

// Extract resource references in playlist order. They are later staged by the
// browser and rewritten using only local file names by rewriteHlsMediaPlaylist.
export function planHlsMediaPlaylist(text) {
  assertHlsManifest(text);
  const rows = text.split(/\r?\n/);
  const resources = [];
  let segmentCount = 0;
  for (let lineIndex = 0; lineIndex < rows.length; lineIndex++) {
    const line = rows[lineIndex];
    const value = line.trim();
    if (!value) continue;
    if (!value.startsWith('#')) {
      segmentCount++;
      if (segmentCount > MAX_SEGMENTS)
        throw errorWith('HLS_MANIFEST', 'HLS 分片數量超過 1500 個');
      resources.push({ kind: 'segment', lineIndex, uri: value, key: false });
      continue;
    }
    const key = /^#EXT-X-(?:SESSION-)?KEY:/.test(value);
    if (key && !/\bMETHOD=(?:AES-128|NONE)(?:,|$)/.test(value))
      throw errorWith('HLS_DRM', '此 HLS 使用未支援的加密方式');
    const matches = [...line.matchAll(/\bURI="([^"]+)"/g)];
    if ((line.match(/\bURI\s*=/g) || []).length !== matches.length)
      throw errorWith('HLS_MANIFEST', 'HLS 標籤的 URI 格式不正確');
    for (const match of matches) {
      resources.push({
        kind: 'attribute', lineIndex, uri: match[1], key,
        start: match.index, length: match[0].length
      });
    }
  }
  if (!segmentCount) throw errorWith('HLS_MANIFEST', 'HLS 清單沒有媒體分片');
  return { rows, resources, segmentCount };
}

// Applies the staged names without modifying the parsed plan. Descending
// attribute offsets preserve positions when a tag has multiple URI fields.
export function rewriteHlsMediaPlaylist(plan, localNames) {
  if (!Array.isArray(localNames) || localNames.length !== plan.resources.length)
    throw new TypeError('HLS resource count does not match staged filenames');
  const output = [...plan.rows];
  const attributes = new Map();
  plan.resources.forEach((resource, i) => {
    const local = localNames[i];
    if (typeof local !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(local))
      throw new TypeError('HLS staged filename must be a safe local basename');
    if (resource.kind === 'segment') output[resource.lineIndex] = local;
    else {
      if (!attributes.has(resource.lineIndex)) attributes.set(resource.lineIndex, []);
      attributes.get(resource.lineIndex).push({ ...resource, local });
    }
  });
  for (const [index, refs] of attributes) {
    for (const ref of refs.sort((a, b) => b.start - a.start)) {
      const original = output[index];
      output[index] = original.slice(0, ref.start) + 'URI="' + ref.local + '"' +
        original.slice(ref.start + ref.length);
    }
  }
  return output.join('\n');
}
