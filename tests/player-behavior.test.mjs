// Public player behavior: these scenarios also run against the pre-refactor player.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../src/player.js';

class Element extends EventTarget {
  constructor() { super(); this.style = {}; this.textContent = ''; this.attributes = new Map(); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) || null; }
  removeAttribute(key) { this.attributes.delete(key); }
  replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; }
}
class Video extends Element {
  constructor() {
    super(); this.currentTime = 0; this.duration = 180; this.paused = true;
    this.readyState = 0; this.buffered = { length: 1, start: () => 0, end: () => 180 };
  }
  set src(value) { this.setAttribute('src', value); }
  get src() { return this.getAttribute('src'); }
  canPlayType() { return 'probably'; }
  load() {
    this.currentTime = 0;
    this.readyState = this.src ? 3 : 0;
    if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
  }
  pause() { this.paused = true; }
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
}
const episodes = [{ vid: 'one', index: 1 }, { vid: 'two', index: 2 }];
const source = vid => ({ url: `https://media.example/${vid}.mp4`, codec: 'h264', quality: '720p' });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function scenario(run, { sourceFor, cache } = {}) {
  const globals = ['location', 'window', 'document', 'Option', 'HTMLMediaElement', 'navigator'];
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const logs = [], calls = [], values = new Map();
  let player;
  try {
    const replacements = {
      location: { search: '', hostname: 'localhost' }, window: new Element(), document: new Element(),
      Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
      HTMLMediaElement: { HAVE_METADATA: 1 }, navigator: { connection: { saveData: false } }
    };
    for (const [key, value] of Object.entries(replacements))
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const video = new Video();
    const select = value => Object.assign(new Element(), { value, options: [{ value }] });
    const qualitySelect = select('auto'), speedSelect = select('1.5');
    const controls = Object.fromEntries(['status', 'label', 'prevButton', 'nextButton',
      'settingsToggle', 'settingsMenu', 'settingsClose', 'sourceInfo'].map(key => [key, new Element()]));
    const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
    player = createPlayer({ ...controls, video, qualitySelect, speedSelect, storage,
      getSeries: () => ({ seriesId: 'series', episodes }), getWorkerOrigin: () => '',
      cache: cache || { getEntry: () => null },
      sourceFor: async (...args) => {
        calls.push(args);
        return sourceFor ? sourceFor(...args) : { variants: [source(args[1])] };
      },
      fetchBytes: () => assert.fail('Native MP4 must not require a whole-file download'),
      diagnostics: (event, fields) => logs.push({ event, ...fields })
    });
    const wait = async predicate => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
      assert.fail('Player did not reach the requested state: ' + JSON.stringify(logs));
    };
    const ready = count => wait(() => logs.filter(row => row.event === 'playback.ready').length >= count);
    await run({ player, video, calls, logs, ready, wait, storage, controls });
  } finally {
    player?.stop();
    globals.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]);
      else delete globalThis[key];
    });
  }
}

test('opening an already playing episode preserves the source, speed and position', async () => {
  await scenario(async ({ player, video, calls, ready }) => {
    player.open(episodes[0]); await ready(1);
    const url = video.src;
    video.currentTime = 35;
    player.open(episodes[0]); await tick();
    assert.equal(calls.length, 1);
    assert.equal(video.src, url);
    assert.equal(video.currentTime, 35);
    assert.equal(video.playbackRate, 1.5);
  });
});

test('a seek away from the ending does not fetch the next episode; near-end handoff reuses preparation', async () => {
  await scenario(async ({ player, video, calls, ready, logs, wait }) => {
    player.open(episodes[0]); await ready(1);
    video.currentTime = 20;
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked')); await tick();
    assert.deepEqual(calls.map(call => call[1]), ['one']);
    video.currentTime = 160;
    video.dispatchEvent(new Event('timeupdate'));
    await wait(() => logs.some(row => row.event === 'prefetch.prepared'));
    player.open(episodes[1]); await ready(2);
    assert.deepEqual(calls.map(call => call[1]), ['one', 'two']);
    assert.equal(player.current().vid, 'two');
    assert.equal(video.playbackRate, 1.5);
  });
});

test('a late source response from a canceled episode cannot replace its successor', async () => {
  let resolveFirst;
  await scenario(async ({ player, video, calls, ready, controls }) => {
    player.open(episodes[0]); await tick();
    player.open(episodes[1]); await ready(1);
    const url = video.src;
    assert.equal(calls[0][4].aborted, true);
    resolveFirst({ variants: [source('one')] }); await tick(); await tick();
    assert.equal(video.src, url);
    assert.equal(player.current().vid, 'two');
    assert.equal(controls.label.textContent, '第 2 集');
  }, { sourceFor: (_series, vid) => vid === 'one'
    ? new Promise(resolve => { resolveFirst = resolve; }) : { variants: [source(vid)] } });
});

test('cached playable media opens without resolving or downloading its source', async () => {
  await scenario(async ({ player, video, calls, ready }) => {
    player.open(episodes[0]); await ready(1);
    assert.equal(calls.length, 0);
    assert.match(video.src, /^blob:/);
    assert.equal(video.paused, false);
  }, { cache: { getEntry: () => ({ blob: new Blob(['playable']), source: source('one') }) } });
});

test('leaving playback cancels pending lookahead and releases the video source', async () => {
  await scenario(async ({ player, video, calls, ready, wait }) => {
    player.open(episodes[0]); await ready(1);
    video.currentTime = 160;
    video.dispatchEvent(new Event('timeupdate'));
    await wait(() => calls.length === 2);
    player.deactivate();
    assert.equal(calls[1][4].aborted, true);
    assert.equal(video.src, null);
    assert.equal(video.paused, true);
    assert.equal(player.current().vid, 'one');
  }, { sourceFor: (_series, vid) => vid === 'two'
    ? new Promise(() => {}) : { variants: [source(vid)] } });
});
