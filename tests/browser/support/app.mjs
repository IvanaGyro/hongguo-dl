// SPDX-License-Identifier: GPL-3.0-only
// The page under test plus a fake Worker API and CDN. Specs describe series
// and episodes; this module answers /api/health, /api/series, /api/source,
// /api/device and /api/media, and serves the CDN directly (with CORS), all
// from local sample videos with real HTTP Range semantics.
//
// Faults are injected per request kind, so a spec can say "the first CDN
// refuses" without knowing which internal route the app takes.
import { test as base, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY, mediaPath } from './fixtures.mjs';

export { expect, KEY };

const OPEN_RANGE_CAP = 8 * 1024 * 1024;
const files = new Map();
const bytesOf = name => {
  if (!files.has(name)) files.set(name, new Uint8Array(readFileSync(mediaPath(name))));
  return files.get(name);
};

// One variant of an episode. `media` names a file from fixtures.mjs.
// The app labels renditions by their reported height, so report one that
// matches the quality name (the sample videos themselves are all 480x270).
const SIZES = { '1080p': [1920, 1080], '720p': [1280, 720], '540p': [960, 540], '480p': [854, 480], '360p': [640, 360] };
export const variant = (media, { quality = '720p', codec = 'h264', encrypted = /^cenc/.test(media),
  host = 'cdn', ...rest } = {}) => ({
  media, quality, codec, source: 'app', width: SIZES[quality]?.[0] ?? 480, height: SIZES[quality]?.[1] ?? 270,
  ...(encrypted ? { contentKey: KEY } : {}),
  url: `https://${host}.fqnovelvod.com/${quality}-${codec}/${media}`, ...rest
});

export class App {
  constructor(page, context) {
    this.page = page;
    this.context = context;
    this.series = new Map();
    this.faults = [];
    this.requests = [];
    this.errors = [];
    this.health = { ok: true, sourceChannels: false };
    this.searchPages = {};
  }

  // episodes: array of variant lists, one list per episode.
  addSeries(id, { title = 'Series ' + id, episodes }) {
    this.series.set(String(id), { title, episodes: episodes.map((variants, i) => ({
      vid: String(id) + String(i + 1).padStart(3, '0'), index: i + 1, variants })) });
    return this;
  }

  // decide(request) returns Playwright fulfill options (or { abort: reason }
  // for a network/CORS failure) to fail that request, or nothing to let it
  // through. `n` counts the requests of that kind this fault has seen.
  fault(kind, decide) {
    this.faults.push({ kind, decide, count: 0 });
    return this;
  }

  requestsOf(kind) { return this.requests.filter(r => r.kind === kind); }

  async install() {
    this.page.on('pageerror', error => this.errors.push(error.message));
    await this.context.addInitScript(() => {
      // Point the app at the fake Worker on this origin.
      localStorage.setItem('hongguo-dl-worker-origin-v1', location.origin);
    });
    await this.context.route(url => url.pathname.startsWith('/api/'), route => this.api(route));
    // Search covers: a 3x4 PNG from the official picture host.
    await this.context.route(/^https:\/\/p3-novel\.byteimg\.com\//, route => {
      this.requests.push({ kind: 'cover', url: route.request().url() });
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' },
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAAECAIAAADETxJQAAAAEklEQVR4nGP4z8AARAxEMjAGANn5C/U9wPKZAAAAAElFTkSuQmCC', 'base64') });
    });
    await this.context.route(/^https:\/\/[a-z0-9-]+\.fqnovelvod\.com\//, route =>
      this.media(route, route.request().url(), 'cdn'));
  }

  async injected(kind, route, info) {
    for (const f of this.faults) {
      if (f.kind !== kind) continue;
      const result = await f.decide({ ...info, n: f.count++ });
      if (result?.abort) { await route.abort(result.abort); return true; }
      if (result) { await route.fulfill(result); return true; }
    }
    return false;
  }

  async api(route) {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, json: body,
      headers: { 'Access-Control-Allow-Origin': '*' } });
    switch (url.pathname) {
      case '/api/health': return json(this.health);
      case '/api/series': {
        const id = url.searchParams.get('input');
        const series = this.series.get(id);
        this.requests.push({ kind: 'series', id });
        if (await this.injected('series', route, { id })) return;
        if (!series) return json({ error: { code: 'NOT_FOUND', message: 'No fixture series' } }, 404);
        return json({ kind: 'series', seriesId: id, title: series.title, total: series.episodes.length,
          accessible: series.episodes.length,
          episodes: series.episodes.map(({ vid, index }) => ({ vid, index, available: true })) });
      }
      case '/api/device': {
        const body = JSON.parse(request.postData() || '{}');
        this.requests.push({ kind: 'device' });
        if (await this.injected('device', route, { body })) return;
        const n = this.requestsOf('device').length;
        return json({ ...body.installation, profile: this.health.deviceProfile,
          device_id: String(7000 + n), iid: String(8000 + n), registeredAt: Date.now() });
      }
      case '/api/source': {
        const sid = url.searchParams.get('sid'), vid = url.searchParams.get('vid');
        const episode = this.series.get(sid)?.episodes.find(e => e.vid === vid);
        const device = request.headers()['x-playback-device'];
        this.requests.push({ kind: 'source', sid, vid, device: device ? JSON.parse(device) : null });
        if (await this.injected('source', route, { sid, vid, device })) return;
        if (!episode) return json({ error: { code: 'NOT_FOUND', message: 'No fixture episode' } }, 404);
        return json({ variants: episode.variants.map(({ media, ...v }) => v) });
      }
      case '/api/search': {
        // Pages of `searchPages` (set by a spec); page N+1 needs cursor "cN".
        const q = url.searchParams.get('q'), page = Number(url.searchParams.get('page') || 1);
        const device = request.headers()['x-playback-device'];
        this.requests.push({ kind: 'search', q, page, cursor: url.searchParams.get('cursor'), device: device ? JSON.parse(device) : null });
        if (await this.injected('search', route, { q, page })) return;
        if (!device) return json({ error: { code: 'DEVICE_REQUIRED', message: '請先初始化播放裝置' } }, 409);
        if (page > 1 && url.searchParams.get('cursor') !== 'c' + (page - 1))
          return json({ error: { code: 'INVALID_CURSOR', message: 'bad cursor' } }, 400);
        const pages = this.searchPages[q] || [];
        const more = page < pages.length;
        return json({ items: pages[page - 1] || [], page, hasMore: more, cursor: more ? 'c' + page : null });
      }
      case '/api/media': return this.media(route, url.searchParams.get('url'), 'proxy');
      default: return json({ error: { code: 'NOT_FOUND', message: 'No fixture API' } }, 404);
    }
  }

  async media(route, target, via) {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD' } });
    const url = new URL(target);
    const name = url.pathname.split('/').pop();
    const range = request.headers().range || '';
    const info = { via, host: url.hostname, name, range, referer: request.headers().referer || '' };
    this.requests.push({ kind: 'media', ...info });
    if (await this.injected('media', route, info)) return;
    const bytes = bytesOf(name);
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const first = match ? Number(match[1]) : 0;
    // Like real CDNs, answer an open-ended range with a capped part; the app
    // continues at the boundary. (One huge fulfilled body also fails.)
    const last = Math.min(match?.[2] ? Number(match[2]) : bytes.length - 1, bytes.length - 1,
      match && !match[2] ? first + OPEN_RANGE_CAP - 1 : Infinity);
    if (first >= bytes.length) return route.fulfill({ status: 416, headers: {
      'Access-Control-Allow-Origin': '*', 'Content-Range': `bytes */${bytes.length}` } });
    return route.fulfill({ status: match ? 206 : 200, contentType: 'video/mp4', headers: {
      'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
      'Content-Length': String(last - first + 1),
      ...(match ? { 'Content-Range': `bytes ${first}-${last}/${bytes.length}` } : {})
    }, body: Buffer.from(bytes.buffer, bytes.byteOffset + first, last - first + 1) });
  }

  // ---- what a user does -------------------------------------------------

  async open(id) {
    const { title } = this.series.get(String(id));
    if (!this.page.url().startsWith('http')) await this.page.goto('./');
    await this.page.locator('#input-url').fill(String(id));
    await this.page.locator('#lookup-button').click();
    await expect(this.page.locator('#series-title')).toHaveText(title);
  }

  episodeButton(index) {
    return this.page.locator('#episodes button.play-episode').nth(index - 1);
  }

  video() { return this.page.locator('#player-video'); }

  // Wait until episode `index` is visibly playing between `from` and `to` s.
  async expectPlaying(index, { from = 0.2, to = Infinity, timeout = 30_000 } = {}) {
    await this.page.waitForFunction(({ index, from, to }) => {
      const video = document.querySelector('#player-video');
      return document.querySelector('#player-episode')?.textContent.includes('第 ' + index + ' 集') &&
        video.currentTime > from && video.currentTime < to && video.videoWidth > 0 &&
        !video.paused && !video.error;
    }, { index, from, to: to === Infinity ? 1e9 : to }, { timeout }).catch(async error => {
      throw new Error(error.message + '\nplayer: ' + JSON.stringify(await this.state()));
    });
  }

  async seek(seconds) {
    await this.video().evaluate((video, s) => { video.currentTime = s; }, seconds);
  }

  async pause() { await this.video().evaluate(video => video.pause()); }

  async state() {
    return this.page.evaluate(() => {
      const video = document.querySelector('#player-video');
      return { episode: document.querySelector('#player-episode')?.textContent,
        status: document.querySelector('#player-status')?.textContent,
        time: video?.currentTime, paused: video?.paused, width: video?.videoWidth,
        error: video?.error?.code ?? null,
        log: (document.querySelector('#playback-log')?.value || '').split('\n').slice(-12) };
    });
  }

  // Wait until `count` queue jobs are finished; on timeout, report what the
  // queue shows (status, detail and error of each job).
  async expectQueueCompleted(count, timeout = 60_000) {
    await expect(this.page.locator('#queue .status.s-completed')).toHaveCount(count, { timeout })
      .catch(async error => {
        const jobs = await this.page.locator('#queue .job').evaluateAll(nodes => nodes.map(node =>
          [node.querySelector('.status')?.textContent, node.querySelector('.job-meta')?.textContent,
            node.querySelector('.job-error')?.textContent].filter(Boolean).join(' | ')));
        throw new Error(error.message + '\nqueue: ' + JSON.stringify(jobs) +
          '\nbulk: ' + await this.page.locator('#bulk-status').textContent().catch(() => ''));
      });
  }

  async chooseQuality(value) {
    // The player hides its controls while playing; pointing at it shows them.
    await this.page.locator('#player-stage').hover();
    await this.page.locator('#player-settings-toggle').click();
    await this.page.locator('#player-settings [data-settings-target="quality"]').click();
    await this.page.locator(`#player-quality-options [data-choice-value="${value}"]`).click();
    await this.page.locator('#player-settings-close').click().catch(() => {});
  }

  async qualityChoices() {
    return this.page.locator('#player-quality option').allTextContents();
  }

  async mode(name) {
    await this.page.locator(name === 'download' ? '#mode-download' : '#mode-play').click();
  }
}

export const test = base.extend({
  app: async ({ page, context }, use) => {
    const app = new App(page, context);
    await app.install();
    await use(app);
    expect(app.errors, 'uncaught page errors').toEqual([]);
  }
});

// The same fixtures in a normal, on-disk browser profile instead of an
// ephemeral (private-window-like) context. Use it where the app keeps files in
// IndexedDB: WebKit does not store Blobs there in ephemeral sessions, as in a
// Safari private window, while normal browsing does.
export const testWithProfile = test.extend({
  context: async ({ browserName, playwright, baseURL, viewport, userAgent, acceptDownloads }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir(), 'hongguo-profile-'));
    const context = await playwright[browserName].launchPersistentContext(dir, {
      ...testInfo.project.use.launchOptions, baseURL, viewport, userAgent, acceptDownloads });
    await use(context);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Capability checks for skip conditions: name the capability, not a browser.
export async function supports(page, what) {
  return page.evaluate(what => {
    const mse = mime => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
    switch (what) {
      case 'h264-aac-mse': return mse('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
      case 'h264-mse': return mse('video/mp4; codecs="avc1.42E01E"');
      case 'clear-key': return navigator.requestMediaKeySystemAccess?.('org.w3.clearkey', [{
        initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
      }]).then(() => true, () => false) ?? false;
      case 'directory-picker': return typeof window.showDirectoryPicker === 'function';
      default: throw new Error('unknown capability ' + what);
    }
  }, what);
}
