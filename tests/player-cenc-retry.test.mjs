import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../src/player.js';
import { playbackErrorSummary } from '../src/retry.js';

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

async function runScenario(sourceFor, fetchImpl, { canPlayType = () => 'probably', fastClock = false } = {}) {
  const globals = ['location', 'window', 'document', 'Option', 'fetch'];
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const realTimeout = globalThis.setTimeout, realNow = Date.now;
  let clock = realNow();
  if (fastClock) {
    Date.now = () => clock;
    globalThis.setTimeout = (callback, ms, ...args) => {
      const advance = ms <= 1000;
      return realTimeout(() => { if (advance) clock += ms; callback(...args); }, advance ? 0 : ms);
    };
  }
  let player, timer;
  const logs = [];
  try {
    globalThis.location = { search: '', hostname: 'localhost' };
    globalThis.window = new Element();
    globalThis.document = new Element();
    globalThis.Option = class { constructor(text, value) { this.textContent = text; this.value = value; } };
    globalThis.fetch = fetchImpl;
    const video = new Element();
    video.canPlayType = canPlayType;
    const episode = { vid: 'episode', index: 1 };
    let finish;
    const done = new Promise((resolve, reject) => {
      finish = resolve;
      timer = setTimeout(() => reject(new Error('Player retry scenario did not stop')), 14000);
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
        if (event === 'playback.retry.stopped' ||
            event === 'playback.attempt.failed' && fields.code === 'PLAYBACK_UNSUPPORTED') finish();
      }
    });
    player.open(episode, false);
    await done;
    return { logs, labels: qualitySelect.options.map(o => o.textContent), status: controls.status.textContent };
  } finally {
    clearTimeout(timer);
    player?.stop();
    globalThis.setTimeout = realTimeout; Date.now = realNow;
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
    assert.match(options.headers.Range, /^bytes=\d+-\d*$/);
    return new Response('', { status: 416 });
  });
  assert.equal(calls, 2);
  assert.equal(mediaCalls, 1);
  assert(logs.some(row => row.event === 'playback.attempt' && row.attempt === 2));
  assert(logs.some(row => row.event === 'cenc.prepare.begin' && row.codec === 'hevc'));
  assert(logs.some(row => row.event === 'cenc.prepare.failed' && row.code === 'CENC_RANGE_INVALID'));
  assert(!logs.some(row => row.event === 'playback.fallback.blocked'));
  assert.deepEqual(labels, ['自動最佳', '1080p']);
});

test('API failures do not skip CDN candidates or revive failed URLs after an unsuccessful refresh', { timeout: 15000 }, async () => {
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
    assert.match(options.headers.Range, /^bytes=\d+-\d*$/);
    const media = new URL(url, 'https://worker.example').searchParams.get('url');
    requested.push(media);
    return new Response('', { status: media === source('c').url ? 416 : 520 });
  });
  assert.equal(calls, 4);
  assert.deepEqual(requested, ['a', 'b', 'c'].map(name => source(name).url));
  assert.equal(logs.filter(row => row.event === 'source.list.refreshed').length, 1);
  assert(logs.some(row => row.event === 'cenc.prepare.failed' && row.code === 'CENC_RANGE_HTTP'));
});

test('single-source metadata failure immediately refreshes without retrying the failed CDN', async () => {
  let sourceCalls = 0;
  const requested = [];
  const { logs } = await runScenario(async () => {
    sourceCalls++;
    return { variants: [source('only')] };
  }, async (url, options) => {
    requested.push({ url, range: options.headers.Range });
    return new Response('', { status: requested.length === 1 ? 520 : 416 });
  });
  assert.equal(sourceCalls, 2);
  assert.equal(requested.length, 1);
  assert(!logs.some(row => row.event === 'cenc.stage' && row.phase === 'range.retry'));
  assert(!logs.some(row => row.event === 'playback.retry.scheduled'));
  assert(logs.some(row => row.event === 'source.list.stale'));
});


test('unsupported HEVC stays out of the player menu and makes no media request', async () => {
  const sourceFor = async () => ({ variants: [source('metadata-diagnostic')] });
  let requests = 0;
  const fetchImpl = async (_url, options) => {
    requests++;
    assert.match(options.headers.Range, /^bytes=\d+-\d*$/);
    return new Response('', { status: 416 });
  };
  const standard = await runScenario(sourceFor, fetchImpl, { canPlayType: () => '' });
  assert.equal(requests, 0, 'Ordinary entry must keep unsupported HEVC filtered');
  assert.deepEqual(standard.labels, ['自動最佳']);
  assert(!standard.logs.some(row => row.event === 'cenc.prepare.begin'));
});

test('refreshing the same failed signed URLs stops without reopening them', async () => {
  let calls = 0;
  const requested = [];
  const { logs } = await runScenario(async () => {
    calls++;
    return { variants: [source('a'), source('b')] };
  }, async url => {
    requested.push(new URL(url, 'https://worker.example').searchParams.get('url'));
    return new Response('', { status: 403 });
  });
  assert.equal(calls, 2);
  assert.deepEqual(requested, [source('a').url, source('b').url]);
  assert(logs.some(row => row.event === 'playback.retry.stopped' && row.code === 'CENC_SOURCE_EXHAUSTED'));
});

test('a refreshed list containing old failures only tries its new same-tier candidate', async () => {
  let calls = 0;
  const requested = [];
  await runScenario(async () => ({ variants: ++calls === 1
    ? [source('a'), source('b')] : [source('a'), source('c')] }), async url => {
    const target = new URL(url, 'https://worker.example').searchParams.get('url');
    requested.push(target);
    return new Response('', { status: target === source('c').url ? 416 : 403 });
  });
  assert.equal(calls, 2);
  assert.deepEqual(requested, ['a', 'b', 'c'].map(name => source(name).url));
});

test('source API 502 and media CDN failures retain separate diagnoses', async () => {
  let calls = 0;
  const { logs } = await runScenario(async () => {
    if (++calls === 1) throw Object.assign(failure('EMPTY_RESPONSE'), { status: 502 });
    return { variants: [source('a')] };
  }, async () => new Response('', { status: 416 }));
  const attempts = logs.filter(row => row.event === 'playback.attempt.failed');
  assert.equal(attempts[0].stage, 'source-api');
  assert.equal(attempts[0].status, 502);
  assert.match(playbackErrorSummary(attempts[0]), /片源 API.*HTTP 502/);
  assert.equal(attempts[1].stage, 'media');
  assert.equal(attempts[1].code, 'CENC_RANGE_INVALID');
  assert.match(playbackErrorSummary({ code: 'HTTP_403', stage: 'source-api', status: 403 }), /片源 API/);
});

test('CDN 429 refreshes an exhausted list without retrying the same candidate', async () => {
  let sourceCalls = 0, mediaCalls = 0;
  const { logs } = await runScenario(async () => { sourceCalls++; return { variants: [source('limited')] }; }, async () => {
    mediaCalls++;
    return new Response('', { status: mediaCalls === 1 ? 429 : 416, headers: { 'Retry-After': '0' } });
  });
  assert.equal(sourceCalls, 2); assert.equal(mediaCalls, 1);
  assert(!logs.some(row => row.event === 'playback.retry.scheduled'));
});

test('fresh same-quality CDN URLs may recover after more than one model refresh', async () => {
  let calls = 0; const opened = [];
  const { logs } = await runScenario(async () => ({ variants: [source('revision-' + ++calls)] }), async url => {
    opened.push(new URL(url, 'https://worker.example').searchParams.get('url'));
    return new Response('', { status: calls >= 4 ? 416 : 520 });
  }, { fastClock: true });
  assert.equal(calls, 4);
  assert.equal(new Set(opened).size, 4);
  assert.equal(logs.filter(row => row.event === 'source.list.refreshed').length, 3);
});

test('twenty failed source queries stop with refresh guidance and never attempt a CDN', async () => {
  let calls = 0;
  const { status, logs } = await runScenario(async () => {
    calls++; throw failure('EMPTY_RESPONSE');
  }, () => assert.fail('Source query failure must not contact a CDN'), { fastClock: true });
  assert.equal(calls, 20);
  assert.match(status, /片源候選查詢已達 20 次嘗試上限.*重新整理/);
  assert.equal(logs.filter(row => row.event === 'playback.retry.stopped').length, 1);
});
