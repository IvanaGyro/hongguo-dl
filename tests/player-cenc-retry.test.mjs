import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../src/player.js';

class Element extends EventTarget {
  constructor() { super(); this.style = {}; this.textContent = ''; }
  setAttribute() {}
  removeAttribute() {}
  pause() {}
  load() {}
}
class Select extends Element {
  constructor(value = 'auto') { super(); this.options = [{ value }]; this.value = value; }
  add(option) { this.options.push(option); }
  replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; }
}

async function runScenario(sourceFor, fetchImpl) {
  const globals = ['location', 'window', 'document', 'Option', 'fetch'];
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  let player, timer;
  const logs = [];
  try {
    globalThis.location = { search: '', hostname: 'localhost' };
    globalThis.window = new Element();
    globalThis.document = new Element();
    globalThis.Option = class { constructor(text, value) { this.textContent = text; this.value = value; } };
    globalThis.fetch = fetchImpl;
    const video = new Element();
    video.canPlayType = () => 'probably';
    const episode = { vid: 'episode', index: 1 };
    let finish;
    const done = new Promise((resolve, reject) => {
      finish = resolve;
      timer = setTimeout(() => reject(new Error('Player retry scenario did not stop')), 7000);
    });
    const qualitySelect = new Select();
    const controls = Object.fromEntries(['status', 'label', 'prevButton', 'nextButton',
      'autoNextInput', 'settingsToggle', 'settingsMenu', 'settingsClose', 'pipButton', 'sourceInfo']
      .map(key => [key, new Element()]));
    player = createPlayer({ ...controls, video, qualitySelect,
      speedSelect: new Select('1'), fitSelect: new Select('contain'),
      getSeries: () => ({ seriesId: 'series', episodes: [episode] }), sourceFor,
      fetchBytes: () => assert.fail('CENC must not download the entire file'),
      getWorkerOrigin: () => '', cache: { getEntry: () => null },
      storage: { getItem: () => null, setItem() {} },
      diagnostics: (event, fields) => {
        logs.push({ event, ...fields });
        if (event === 'playback.retry.stopped') finish();
      }
    });
    player.open(episode, false);
    await done;
    return { logs, labels: qualitySelect.options.map(o => o.textContent) };
  } finally {
    clearTimeout(timer);
    player?.stop();
    globals.forEach((key, i) => {
      if (previous[i]) Object.defineProperty(globalThis, key, previous[i]);
      else delete globalThis[key];
    });
  }
}
const source = name => ({ quality: '1080p', codec: 'hevc',
  url: 'https://cdn.fqnovelvod.com/' + name + '.mp4',
  contentKey: '00112233445566778899aabbccddeeff' });
const failure = code => Object.assign(new Error(code), { code });

test('a source failure before CENC setup does not disable incremental playback on the next attempt', async () => {
  let calls = 0, mediaCalls = 0;
  const { logs, labels } = await runScenario(async () => {
    if (++calls === 1) throw failure('SOURCE_UNAVAILABLE');
    return { variants: [source('a')] };
  }, async (_url, options) => {
    mediaCalls++;
    assert.match(options.headers.Range, /^bytes=\d+-\d+$/);
    return new Response('', { status: 429 });
  });
  assert.equal(calls, 2);
  assert.equal(mediaCalls, 1);
  assert(logs.some(row => row.event === 'playback.attempt' && row.attempt === 2));
  assert(logs.some(row => row.event === 'cenc.prepare.begin' && row.codec === 'hevc'));
  assert(logs.some(row => row.event === 'cenc.prepare.failed' && row.code === 'CENC_RATE_LIMITED'));
  assert(!logs.some(row => row.event === 'playback.fallback.blocked'));
  assert.deepEqual(labels, ['自動最佳', '1080p']);
});

test('API failures do not skip CDN candidates or revive failed URLs after an unsuccessful refresh', async () => {
  let calls = 0;
  const requested = [];
  const { logs } = await runScenario(async (...args) => {
    calls++;
    if (calls === 1) throw failure('SOURCE_UNAVAILABLE');
    if (calls === 2) return { variants: [source('a'), source('b')] };
    assert.equal(args[5].refresh, true);
    if (calls === 3) throw failure('EMPTY_RESPONSE');
    return { variants: [source('c')] };
  }, async (url, options) => {
    assert.match(options.headers.Range, /^bytes=\d+-\d+$/);
    const media = new URL(url, 'https://worker.example').searchParams.get('url');
    requested.push(media);
    return new Response('', { status: media === source('c').url ? 429 : 520 });
  });
  assert.equal(calls, 4);
  assert.deepEqual(requested, ['a', 'b', 'b', 'c'].map(name => source(name).url));
  assert.equal(logs.filter(row => row.event === 'source.list.refreshed').length, 1);
  assert(logs.some(row => row.event === 'cenc.prepare.failed' && row.code === 'CENC_RANGE_HTTP'));
});

test('single-source metadata recovers transient 520 without another source API call', async () => {
  let sourceCalls = 0;
  const requested = [];
  const { logs } = await runScenario(async () => {
    sourceCalls++;
    return { variants: [source('only')] };
  }, async (url, options) => {
    requested.push({ url, range: options.headers.Range });
    return new Response('', { status: requested.length === 1 ? 520 : 429 });
  });
  assert.equal(sourceCalls, 1);
  assert.equal(requested.length, 2);
  assert.deepEqual(requested[0], requested[1], 'Retry only the failed bounded Range');
  assert(logs.some(row => row.event === 'cenc.stage' && row.phase === 'range.retry' && row.status === 520));
  assert(logs.some(row => row.event === 'cenc.prepare.failed' && row.code === 'CENC_RATE_LIMITED'));
});
