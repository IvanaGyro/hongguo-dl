// SPDX-License-Identifier: GPL-3.0-only
// When something goes wrong, the viewer still ends up watching, or sees the
// right message. One row per injected fault; every row starts the same way.
import { test, expect, variant } from './support/app.mjs';

const refuse = (status, code = 'FIXTURE_REFUSAL') => ({ status, json: { error: { code, message: 'fixture refusal' } },
  headers: { 'Access-Control-Allow-Origin': '*' } });
const emptyUpstream = refuse(502, 'EMPTY_RESPONSE');
emptyUpstream.json.error.upstreamStatus = 200;
emptyUpstream.json.error.emptyResponseCount = 3;
// Device sessions on; like most real episodes, there is no public web source,
// so playback depends on the App source and its device.
const withDevices = app => {
  app.health = { ok: true, sourceChannels: true, deviceSessions: true, deviceProfile: 'fixture-v1' };
  app.fault('source', ({ device }) => !device && refuse(404, 'PUBLIC_SOURCE_UNAVAILABLE'));
};
// The first App source request (it carries the device) returns empty bodies.
const firstAppSourceEmpty = () => {
  let seen = 0;
  return ({ device }) => device && seen++ === 0 && emptyUpstream;
};

const FAULTS = [
  {
    name: 'the source API fails once',
    setup: ({ app }) => app.fault('source', ({ n }) => n === 0 && refuse(503, 'SOURCE_UNAVAILABLE'))
  },
  {
    name: 'the first CDN refuses (HTTP 403)',
    variants: [variant('clear.mp4', { host: 'denied' }), variant('clear.mp4', { host: 'alternate' })],
    setup: ({ app }) => app.fault('media', ({ host }) => host.startsWith('denied.') && refuse(403)),
    check: ({ app }) => expect(app.requestsOf('media').some(r => r.host.startsWith('alternate.'))).toBe(true)
  },
  {
    // A direct read the page cannot use (CORS or network failure) moves to the
    // Worker proxy. A readable HTTP error instead rotates to another CDN.
    name: 'direct CDN reads fail with a CORS or network error',
    setup: ({ app }) => app.fault('media', ({ via }) => via === 'cdn' && { abort: 'failed' }),
    check: ({ app }) => expect(app.requestsOf('media').some(r => r.via === 'proxy')).toBe(true)
  },
  {
    name: 'the CDN refuses requests that carry the page Referer',
    setup: ({ app }) => app.fault('media', ({ via, referer }) => via === 'cdn' && referer && refuse(403)),
    check: ({ app }) => expect(app.requestsOf('media').filter(r => r.via === 'cdn' && r.referer)).toEqual([])
  },
  {
    name: 'the App source returns empty bodies until a new device registers',
    setup: ({ app }) => {
      withDevices(app);
      app.fault('source', firstAppSourceEmpty());
    },
    check: ({ app }) => {
      const ids = app.requestsOf('source').filter(r => r.device).map(r => r.device.device_id);
      expect(new Set(ids).size, 'a fresh device ID after the empty responses').toBeGreaterThan(1);
    }
  },
  {
    name: 'device registration fails twice during that recovery',
    setup: ({ app }) => {
      withDevices(app);
      app.fault('source', firstAppSourceEmpty());
      app.fault('device', ({ n }) => (n === 1 || n === 2) && refuse(502, 'DEVICE_REGISTRATION_FAILED'));
    }
  },
  {
    name: 'device registration keeps failing',
    setup: ({ app }) => {
      withDevices(app);
      app.fault('source', firstAppSourceEmpty());
      app.fault('device', ({ n }) => n >= 1 && refuse(502, 'DEVICE_REGISTRATION_FAILED'));
    },
    message: /請等一分鐘/
  },
  {
    name: 'incremental decryption is unavailable (no WASM, no EME)',
    variants: [variant('cenc-medium.mp4')],
    setup: async ({ context }) => {
      await context.route('**/cenc/cenc-core.wasm', route => route.fulfill({ status: 404, body: 'not deployed' }));
      await context.addInitScript(() => Object.defineProperty(navigator, 'requestMediaKeySystemAccess', { value: undefined }));
    }
  },
  {
    name: 'processing fails in the middle of streaming',
    variants: [variant('cenc-medium.mp4')],
    setup: ({ context }) => context.addInitScript(() => {
      const append = SourceBuffer.prototype.appendBuffer;
      let calls = 0;
      SourceBuffer.prototype.appendBuffer = function (bytes) {
        // The init segment and three media fragments, then a failure.
        if (++calls > 4) throw new Error('synthetic SourceBuffer failure');
        return append.call(this, bytes);
      };
    })
  }
];

for (const fault of FAULTS) {
  test(`when ${fault.name}, the viewer ${fault.message ? 'is told why playback waits' : 'still ends up watching'}`, async ({ app, page, context }) => {
    app.addSeries(42, { title: 'Recovery', episodes: [fault.variants ?? [variant('clear.mp4')]] });
    await fault.setup({ app, page, context });
    await page.goto('./');
    await app.open(42);
    if (fault.message) {
      await expect(page.locator('#player-status')).toHaveText(fault.message, { timeout: 30_000 });
    } else {
      await app.expectPlaying(1, { from: 0.5, timeout: 60_000 });
    }
    await fault.check?.({ app, page });
  });
}
