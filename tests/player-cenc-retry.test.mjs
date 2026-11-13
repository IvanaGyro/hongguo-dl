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

test('a source failure before CENC setup does not disable incremental playback on the next attempt', async () => {
  const globals = ['location', 'window', 'document', 'Option', 'fetch'];
  const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  let player, timer, calls = 0, mediaCalls = 0;
  const logs = [];
  try {
    globalThis.location = { search: '', hostname: 'localhost' };
    globalThis.window = new Element();
    globalThis.document = new Element();
    globalThis.Option = class { constructor(text, value) { this.textContent = text; this.value = value; } };
    globalThis.fetch = async (_url, options) => {
      mediaCalls++;
      assert.match(options.headers.Range, /^bytes=\d+-\d+$/);
      return new Response('', { status: 429 });
    };
    const video = new Element();
    video.canPlayType = () => 'probably';
    const episode = { vid: 'episode', index: 1 };
    let finish;
    const done = new Promise((resolve, reject) => {
      finish = resolve;
      timer = setTimeout(() => reject(new Error('CENC initialization never reached after source retry')), 4000);
    });
    const qualitySelect = new Select();
    const controls = Object.fromEntries(['status', 'label', 'prevButton', 'nextButton',
      'autoNextInput', 'settingsToggle', 'settingsMenu', 'settingsClose', 'pipButton', 'sourceInfo']
      .map(key => [key, new Element()]));
    player = createPlayer({ ...controls, video, qualitySelect,
      speedSelect: new Select('1'), fitSelect: new Select('contain'),
      getSeries: () => ({ seriesId: 'series', episodes: [episode] }),
      sourceFor: async () => {
        if (++calls === 1) throw Object.assign(new Error('No source yet'), { code: 'SOURCE_UNAVAILABLE' });
        return { variants: [{ quality: '1080p', codec: 'hevc',
          url: 'https://cdn.fqnovelvod.com/test.mp4', contentKey: '00112233445566778899aabbccddeeff' }] };
      },
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
    assert.equal(calls, 2);
    assert.equal(mediaCalls, 1);
    assert(logs.some(row => row.event === 'playback.attempt' && row.attempt === 2));
    assert(logs.some(row => row.event === 'cenc.prepare.begin' && row.codec === 'hevc'));
    assert(logs.some(row => row.event === 'cenc.prepare.failed' && row.code === 'CENC_RATE_LIMITED'));
    assert(!logs.some(row => row.event === 'playback.fallback.blocked'));
    assert.deepEqual(qualitySelect.options.map(o => o.textContent), ['自動最佳', '1080p']);
  } finally {
    clearTimeout(timer);
    player?.stop();
    globals.forEach((key, i) => {
      if (previous[i]) Object.defineProperty(globalThis, key, previous[i]);
      else delete globalThis[key];
    });
  }
});
