# Test catalog

Tests are grouped by **how they run**, and within each group by **what they
check**.

| Tier | Location | Runner | Runs in CI |
| --- | --- | --- | --- |
| Unit | `tests/unit/` | `bun run test` (also `node --test 'tests/unit/**/*.test.mjs'`) | `ci.yml`, `pages.yml`, some feature workflows |
| Browser behaviour | `tests/browser/*.spec.mjs` | `bunx playwright test` | `browser.yml`: Chromium, Firefox, WebKit |
| Live pipeline health | `tests/live/pipeline-health.test.mjs` | `node --test` | `live-pipeline-health.yml`: daily and by hand |
| Not yet ported | `tests/*.browser.mjs`, `tests/*.node.mjs` | `node <file> <sample>` | `cenc-browser.yml`, `bvc2-browser.yml`, `bvc2-wasm-probe.yml` |
| Manual | `tests/manual-cdn-cors-probe.html` | open in a browser | no |
| Rust | `rust/crypto/src/` | `cargo test` | `rust-wasm-build.yml` |

All JavaScript tests are ES modules and use `node:test` with
`node:assert/strict` (unit and live) or `@playwright/test` (browser).

## Unit tests: `tests/unit/`

Offline and deterministic. Each file tests **one module** and sits at a path
that mirrors it. A case belongs to the module whose behaviour it asserts, not
to every module it imports. Where one file covers several former files, each
has its own `describe()`.

| Folder | Mirrors | Example |
| --- | --- | --- |
| `app/` | `src/*.js` | `src/http-range.js` → `app/http-range.test.mjs` |
| `worker/`, `worker/vendor/` | `worker/*.js`, `worker/vendor/*.js` | `worker/vendor/app-source.js` → `worker/vendor/app-source.test.mjs` |
| `tooling/` | `scripts/*.mjs`, and the published WASM pins | `scripts/cenc-wasm-bundle.mjs` → `tooling/cenc-wasm-bundle.test.mjs` |
| `component/` | Tests that need several modules at once | `playback-device`: front end and Worker agree on the device |
| `helpers/` | Fixtures shared by more than one test file | fake CDN and WASM runtime, fragmented CENC boxes |

`tooling/published-wasm.test.mjs` checks the committed WASM files against
their pins. It is a separate file because `cenc-wasm-stream.yml` runs the
bundle-script tests on branches whose inputs have changed but whose new pins
are not published yet.

Some modules have no unit test: `media-worker-core`, `mp4-metadata`,
`media-source`, `playback-attempts`, `fmp4-passthrough`, `download-store`,
`bulk`, `worker/vendor/request-signal` and `worker/vendor/download-quality`.
Others are only covered by the browser specs: `main`, `ffmpeg`, `theme` and
`bvc2*`.

## Browser behaviour specs: `tests/browser/`

Each spec describes what a viewer sees and runs unchanged in **Chromium,
Firefox and WebKit** (`playwright.config.mjs`). Results depend on what the
browser **can do**, not on its name: a step a browser cannot run is an explicit
skip that names the missing capability. The app is the production build.
Media and API responses are local:

- `support/fixtures.mjs` generates the sample videos once: clear and CENC
  progressive MP4 with FFmpeg, and fragmented CENC (`sidx`, `mfra`, no index)
  with a pinned, checksum-verified Shaka Packager. They are cached in
  `node_modules/.cache/hongguo-media`.
- `support/app.mjs` is a fake Worker API and CDN with real HTTP Range
  behaviour. Faults are injected per request kind (`series`, `source`,
  `device`, `media`). It also holds helpers for what a user does (open a
  series, seek, pick a quality) and fails the test on any uncaught page error.

| Spec | Flow or table |
| --- | --- |
| `watch.spec.mjs` | **Watch flow**, once per source format: open by ID → plays → quality menu → switch quality → unbuffered seek → seek back → watch progress → reload and resume → next episode at the end → leaving stops loading. Also: quick episode switching, per-series positions, several IDs in the URL. |
| `download.spec.mjs` | **Download flow**: queue → survives a reload → save one episode (byte-identical) → ZIP → merged MP4 with no refetch. An encrypted episode saves as an MP4 that decodes without the key. An interrupted job resumes only on retry. |
| `recovery.spec.mjs` | **Fault table**: source API failure, CDN 403 rotation, CORS failure → proxy, Referer refusal, a 520 in the middle of an episode, empty App source → new device, failing device registration (twice; and the cooldown message), no WASM/EME → whole-file, mid-stream processing failure. Also: the device is reused after a reload. |
| `quality.spec.mjs` | **Quality rules**, with codec support emulated: the player offers only playable renditions while downloads offer all; a late list extends the menu without switching; manual quality is per session; it survives a codec change; the codec report. |
| `layout.spec.mjs` | Widths 1440–320 px in watch (landscape and portrait video) and download mode; a 1000-episode series pages its grid and queue. Screenshots are attached to the report. |
| `slow.spec.mjs` | `@slow`, only with `HONGGUO_SLOW=1` (and on pushes to `main`): a 5-minute CENC episode across a 2-minute pause, and a 30-minute CENC episode, both to the end. |

### Known bugs the specs record

- **Native EME route** (`sidx`, `mfra`): a seek made in the first seconds after
  the episode (re)starts is dropped. The step records a `known bug` annotation,
  seeks again after the race window, and the flow continues.
- **No-index remux route**: after a restart, a seek lands short and stalls. That
  flow is marked as an expected failure (`test.fail`).

### Test-harness limits

- Playwright's Chromium and WebKit capture a download by requesting its URL
  again from the network. They therefore cannot capture the ZIP that the
  Service Worker streams, so the ZIP step is skipped there with that reason;
  Firefox checks it.
- Headless Chromium replaces a non-ASCII download name with `download`, so the
  download flow uses an ASCII series title.
- Playwright contexts are ephemeral, like a private window. WebKit does not
  keep Blobs in IndexedDB there, so every finished download fails with the
  storage-full message. The download specs therefore use `testWithProfile`,
  a normal on-disk profile. A Safari private window would show the same
  message.

## Live pipeline health: `tests/live/pipeline-health.test.mjs`

Alarms when an external service no longer accepts the current
implementation. One test per stage, in order. A failing stage skips the rest,
so the first failure names the service that changed:

1. The Worker under test (by default `wrangler dev` of the checked-out commit)
2. Series page: `hongguoduanju.com`, via `/api/series`
3. Device registration: the App log service, via `/api/device`
4. Signed source request: the App player API, via `/api/source`
5. CDN: a 256-byte Range read, via `/api/media`
6. Media format: the sample entry matches the advertised codec, and encrypted
   variants carry a CENC key ID

Bounded: about ten requests per run, and it stops on HTTP 429. Logs carry no
URLs, IDs or keys. Playback behaviour is not tested here; the browser specs
cover it.

## Not yet ported

| File | Why it is not a spec yet | Workflow |
| --- | --- | --- |
| `tests/bvc2-stream.browser.mjs` | ByteVC2 needs its special sample build | `bvc2-browser.yml`, `bvc2-wasm-probe.yml` |
| `tests/cenc-preload.browser.mjs` | Covers the ByteVC2 preload handoff as well | `cenc-browser.yml`, `bvc2-browser.yml` |
| `tests/prefetch-recovery.browser.mjs` | Needs a deliberately slow streaming server | `cenc-browser.yml` |
| `tests/cenc-worker-reuse.node.mjs` | Node integration with the real WASM; not a browser test | `cenc-browser.yml`, `bvc2-browser.yml` |
