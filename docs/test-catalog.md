# Test catalog

Every test in the repository, grouped by **kind** (how it runs and what it needs),
then by **subject**. Filename suffixes already encode the kind:

| Suffix | Kind | Runner |
| --- | --- | --- |
| `*.test.mjs` / `*.test.cjs` | Unit / component (no browser, no network) | `bun run test` |
| `*.node.mjs` | Node integration with the real WASM bundle | `node <file> <fixture>` |
| `*.browser.mjs` | Playwright end-to-end, synthetic/local media | `node <file> [fixture…]` |
| `*.firefox.mjs` | Playwright end-to-end, Firefox-focused | `node <file> [fixture…]` |
| `*.webkit.mjs` | Live acceptance on macOS WebKit against production | `node <file>` |
| `*.mjs` (no suffix) | Helper modules imported by the live WebKit suite | (not run directly) |
| `*.html` | Manual probe page | open in a browser |

Totals: **67 unit files (408 tests, all passing)**, 1 Node integration,
22 browser end-to-end scripts, 1 live suite (+3 helpers), 1 manual page and
the Rust crate tests.

## 1. Unit / component tests — `bun run test`

Deterministic and offline. Network calls are stubbed with fake `fetch`; URLs in
the files are fixtures. Run in `ci.yml` and `pages.yml`; some also run
in feature workflows (the CENC and BVC2 workflows, `live-worker-smoke.yml`).

### Cloudflare Worker API and request signing
| File | Covers |
| --- | --- |
| `tests/worker.test.mjs` | `worker/worker.js` routes, CORS, media proxy |
| `tests/playback-device.test.mjs` | Device registration across `src/playback-device.js` and the Worker |
| `tests/playback-v5.test.cjs` | v5 app-source signing against golden fixtures in `tests/fixtures/` |
| `tests/rust-sm3.test.cjs` | Rust/WASM SM3 and signing parity with the JS reference |
| `tests/empty-response-retry.test.cjs` | Worker upstream empty-response retry |
| `worker/vendor/playback-signature.test.cjs` | Argus/Ladon signatures against external golden vectors |

### Source selection, quality and codecs
| File | Covers |
| --- | --- |
| `tests/auto-quality.test.mjs` | Auto quality picks the highest playable rendition |
| `tests/rendition-options.test.mjs` | Rendition menu options |
| `tests/rendition-memory.test.mjs` | Quality remembered across episodes |
| `tests/hevc-rendition.test.mjs` | HEVC rendition filtering |
| `tests/bvc2-options.test.mjs` | ByteVC2 rendition options |
| `tests/source-query.test.mjs` | Source query parameters |
| `tests/source-race.test.mjs` | Web/App source race |
| `tests/retryable-availability.test.mjs` | Availability retry classification |
| `tests/source-device-recovery.test.mjs` | Device re-registration on source failure |
| `tests/episode-source-store.test.mjs` | Per-episode source store, download quality options |
| `tests/hevc-codec.test.mjs` | HEVC codec strings |
| `tests/codec-diagnostics.test.mjs` | Codec diagnostics report |

### CENC / MP4 parsing and remux
| File | Covers |
| --- | --- |
| `tests/cenc-startup.test.mjs` | CENC remux startup |
| `tests/cenc-init-codec.test.mjs` | Codec detection from the init segment |
| `tests/cenc-range-recovery.test.mjs` | Range request recovery |
| `tests/cenc-seek.test.mjs` | Seek target computation |
| `tests/cenc-source-errors.test.mjs` | Source error mapping |
| `tests/cenc-source-fallback.test.mjs` | Fallback between CENC routes |
| `tests/cenc-worker-error.test.mjs` | Remux worker error propagation |
| `tests/clear-key.test.mjs` | Clear Key / EME helpers |
| `tests/fmp4-assembler.test.mjs` | fMP4 box assembly |
| `tests/fmp4-native-eme.test.mjs` | `sidx`/`mfra` index and native-EME route |
| `tests/mp4-track-formats.test.mjs` | MP4 track format parsing |

### Media transport, caching and MSE
| File | Covers |
| --- | --- |
| `tests/http-range.test.mjs` | HTTP Range parsing |
| `tests/http-stream.test.mjs` | Streaming reader over Range |
| `tests/media-transport.test.mjs` | Direct CDN vs. proxy transport |
| `tests/media-body.test.mjs` | Response body handling |
| `tests/media-byte-cache.test.mjs` | Bounded byte cache |
| `tests/media-cache.test.mjs` | Media cache |
| `tests/cached-media-reader.test.mjs` | Cached reader over the byte cache |
| `tests/media-demand.test.mjs` | Demand / route selection |
| `tests/bvc2-render-route.test.mjs` | ByteVC2 direct-render route (uses `bun:test`) |
| `tests/media-worker-core.test.mjs` | Media Worker core |
| `tests/whole-file-source.test.mjs` | Whole-file fallback source |
| `tests/progressive-media-download.test.mjs` | Progressive download |
| `tests/mse-eviction.test.mjs` | MSE buffer eviction |
| `tests/mse-start-gap.test.mjs` | MSE start-gap handling |
| `tests/stream-buffer-policy.test.mjs` | Forward buffer policy |
| `tests/stream-preload.test.mjs` | Stream preload |

### Player and playback state
| File | Covers |
| --- | --- |
| `tests/player-behavior.test.mjs` | `createPlayer` behaviour contract |
| `tests/player-cenc-retry.test.mjs` | Player retry on CENC failures |
| `tests/player-prefetch.test.mjs` | Next-episode prefetch |
| `tests/playback-beta-progress.test.mjs` | Playback stage, range deadlines, Retry-After |
| `tests/playback-status.test.mjs` | Status text |
| `tests/playback-diagnostics.test.mjs` | Diagnostics v2 output |

### ByteVC2
| File | Covers |
| --- | --- |
| `tests/bvc2-config.test.mjs` | BVC2 configuration |
| `tests/bvc2-job.test.mjs` | Transcode job lifecycle |

### Download queue, library and export
| File | Covers |
| --- | --- |
| `tests/logic.test.mjs` | Shared helpers: names, Worker origin, error classes, HLS rejection |
| `tests/url-queue.test.mjs` | Deep links, naming, queue export |
| `tests/library.test.mjs` | Library / IndexedDB cache |
| `tests/queue-lifecycle.test.mjs` | Queue lifecycle |
| `tests/download-source-session.test.mjs` | Download source session |
| `tests/archive-download.test.mjs` | ZIP archive download |
| `tests/zip.test.mjs` | ZIP64 writer (output checked by spawning Python `zipfile`) |

### Build and tooling guards
| File | Covers |
| --- | --- |
| `tests/bvc2-bundle.test.mjs` | BVC2 WASM bundle manifest |
| `tests/cenc-bundle.test.mjs` | CENC bundle integrity hash |
| `tests/cenc-wasm-bundle.test.mjs` | CENC WASM bundle script |
| `tests/published-wasm.test.mjs` | Published WASM pins |
| `tests/bvc2-fixture-timing.test.mjs` | `scripts/bvc2-fixture-timing.mjs` |
| `tests/bvc2-local-fixture.test.mjs` | `scripts/verify-bvc2-fixture.mjs` argument guards (spawns Node) |
| `tests/live-worker-smoke.test.mjs` | `scripts/live-worker-smoke.mjs` harness, mocked `fetch` |

## 2. Node integration — real WASM, synthetic media

| File | Needs | Workflows |
| --- | --- | --- |
| `tests/cenc-worker-reuse.node.mjs` | Fixture MP4 path (argv); `esbuild`; pinned WASM. `PROOF_BRIDGE=bvc2` switches to ByteVC2 | `cenc-browser`, `bvc2-browser` |

## 3. Browser end-to-end — Playwright, synthetic or local media

None of these contacts the real service. Media comes from generated FFmpeg
fixtures, or responses are stubbed with `page.route`.

### 3a. Built app UI contracts (Chromium, `TEST_BASE_URL`) — `ci.yml`
| File | Covers |
| --- | --- |
| `tests/rendition-menu.browser.mjs` | Quality/codec menu |
| `tests/quality-contract.browser.mjs` | Quality selection contract |
| `tests/codec-diagnostics.browser.mjs` | Codec diagnostics panel |
| `tests/design-layout.browser.mjs` | Layout screenshots (`test-results/design-layout/`) |
| `tests/watch-progress.browser.mjs` | Episode grid watch-progress |
| `tests/player-1000.browser.mjs` | 1000-episode series rendering |

### 3b. CENC streaming (Chromium + Firefox, fixture argv) — `cenc-browser.yml`
| File | Covers |
| --- | --- |
| `tests/cenc-stream.browser.mjs` | Incremental CENC playback, audio, retries, seek, stress (env flags `CENC_TEST_*`) |
| `tests/cenc-seek-cache.browser.mjs` | Seek served from the episode cache |
| `tests/cenc-preload.browser.mjs` | Next-episode preload handoff (also BVC2 bridge in `bvc2-browser.yml`) |
| `tests/playback-cancel.browser.mjs` | Cancel / teardown |
| `tests/playback-fallback.browser.mjs` | Route fallback, incl. mid-stream |
| `tests/playback-resume.browser.mjs` | Resume after reload (Chromium) |
| `tests/prefetch-recovery.browser.mjs` | Prefetch failure recovery (Chromium) |

### 3c. ByteVC2 (Chromium + Firefox) — `bvc2-browser.yml`, `bvc2-wasm-probe.yml`
| File | Covers |
| --- | --- |
| `tests/bvc2-stream.browser.mjs` | Incremental and whole-file BVC2 transcode playback |

### 3d. FFmpeg.wasm, download mode, EME — `firefox-ffmpeg.yml`
| File | Browser | Covers |
| --- | --- | --- |
| `tests/ffmpeg.firefox.mjs` | Firefox | FFmpeg.wasm decrypt/remux |
| `tests/browser-modes.firefox.mjs` | Firefox | Watch/download mode switching |
| `tests/queue-pagehide.firefox.mjs` | Firefox | Queue state on `pagehide` |
| `tests/clear-key.firefox.mjs` | Firefox + Chromium (`HONGGUO_TEST_BROWSER`) | Native EME Clear Key, `sidx`/`mfra`/no-index routes |
| `tests/source-device-recovery.browser.mjs` | Chromium | Device recovery in the UI |

### 3e. Not run by any workflow
| File | Needs |
| --- | --- |
| `tests/media-referrer.browser.mjs` | Chromium, H.264 fixture, `TEST_APP_URL` |
| `tests/playback-device.browser.mjs` | Chromium, H.264 fixture, `TEST_APP_URL` |

These run only when someone starts them by hand. They need a preview server at
`http://127.0.0.1:4173/hongguo-dl/`.

## 4. Live acceptance — real production service — `live-hevc-webkit.yml`

macOS WebKit only. Opens `https://ivanagyro.github.io/hongguo-dl/` and plays a
real public HEVC episode. Logs must never contain signed URLs, keys or media.

| File | Role |
| --- | --- |
| `tests/live-hevc.webkit.mjs` | Entry point: first frame, then `CENC_WEBKIT_*` stages |
| `tests/live-hevc-extended.mjs` | Helper: real AAC audio + 120 s seek |
| `tests/live-hevc-journey.mjs` | Helper: seek → reload → resume → EOF |
| `tests/webkit-media-audio-control.mjs` | Helper: synthetic audible control (local ffmpeg + HTTP server) |

Related live checks live under `scripts/` rather than `tests/`:
`scripts/live-worker-smoke.mjs` (`live-worker-smoke.yml`),
`scripts/live-cenc-layout.mjs` and `scripts/live-cenc-wasm-proof.mjs`.

## 5. Manual

| File | Purpose |
| --- | --- |
| `tests/manual-cdn-cors-probe.html` | Hand-run CDN CORS/Range probe (16 bytes per URL) against the deployed Worker. Removed from Pages so it cannot fire repeatedly. |

## 6. Rust

`cargo test --manifest-path rust/crypto/Cargo.toml --locked` runs the 11
`#[test]` cases in `rust/crypto/src/` (`rust-wasm-build.yml`).
