# CENC acceptance matrix — evidence must identify source, browser and decoder

Updated 2026-11-12. The historical success columns refer to the **main baseline**; new changes are not PASS until their own CI run completes.

| Scenario | Platform / stack | Source | Result | Evidence / limitation |
| --- | --- | --- | --- | --- |
| Progressive CENC HEVC/AAC -> clear fMP4 decode | Ubuntu 24.04 Actions; Librempeg WASM + native ffmpeg | Synthetic 320x180 | **PASS (main baseline only)** | [WASM proof #9](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230424222); no browser HEVC decoder |
| Progressive CENC H.264/AAC early frame + >1.5s | Chromium on Ubuntu 24.04 | Synthetic 480x270 | **PASS (main baseline only)** | [Browser acceptance #13](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230870775), source EOF after first frame |
| Progressive CENC H.264/AAC early frame + >1.5s | Firefox on Ubuntu 24.04 | Synthetic 480x270 | **PASS (main baseline only)** | [Browser acceptance #13](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230870775), source EOF after first frame |
| Real 1080p HEVC CENC EOF-before-frame, audio, full playback | Windows browser with HEVC MSE support | Real authorized episode | **NOT TESTED** | Requires real stream, GPU/codec capability and limited CDN probe; not proven by synthetic output |
| Real HEVC MSE playback | Android Firefox / Pixel | Real authorized episode | **NOT TESTED** | Decoder and MSE support need device-level capability checks |
| Unbuffered 10/50/90% seek + reload resume | Browser Worker/MediaSource | Synthetic & real | **NOT TESTED** | Existing sequential source reads do not implement time-based AVFormat seek |
| >=300 s / 30–60 min bounded buffer, cancel & CDN errors | Browser | Synthetic stress | **NOT TESTED** | Initial eviction, abort handling and Range guards newly implemented, CI validation pending |
| ByteVC2 decoding, frames, A/V sync | Actual ByteVC2 decoder | Real authorized short sample | **NOT TESTED** | Do not confuse ByteVC2 with VVC or synthetic HEVC |
| New committed JS/WASM manifest guard | Node/Bun + Pages | Generated assets | **NOT YET VERIFIED** | Test files and release checks on feature PR; wait for actual run conclusion |

## Repeatable commands

- `bun ci && bun run test && VITE_BASE_PATH=/hongguo-dl/ bun run build`.
- `node scripts/cenc-wasm-bundle.mjs verify`: the committed manifest, both assets and pinned C/build source bytes must agree.
- `node --test tests/cenc-bundle.test.mjs tests/cenc-wasm-bundle.test.mjs tests/http-range.test.mjs tests/mse-eviction.test.mjs`.
- Synthetic HEVC build/proof: `bash scripts/build-cenc-stream-wasm.sh /tmp/hongguo-cenc-stream` (requires Emscripten 3.1.74, FFmpeg, network to fetch pinned Librempeg).
- Synthetic browser: `tests/cenc-stream.browser.mjs` via `.github/workflows/cenc-browser.yml` (Playwright + fixture from workflow).
- Actual source: `node scripts/live-cenc-layout.mjs` manually or `workflow_dispatch` on `.github/workflows/live-cenc-layout.yml`; **metadata only** with <=6 media Range requests, <=3 MiB announced bytes, at most two source candidates, stop on 429. No live video/key/signed URL in commits or logs.

## Release procedure

1. Develop CENC changes under a same-repository `fix/cenc-*` or `feature/cenc-*` branch; pushing changed CENC inputs triggers the WASM synthetic build/proof.
2. Only after HEVC/AAC synthetic decode passes, CI publishes `cenc-core.mjs`, `cenc-core.wasm`, `manifest.json` in **one feature-branch commit**. No workflow writes directly to main.
3. Once assets are published, make a human/agent commit (for example this progress document) to re-trigger PR checks: GitHub `GITHUB_TOKEN` generated pushes do not normally trigger a second workflow.
4. PR CI and Pages build reject incomplete/stale assets with `node scripts/cenc-wasm-bundle.mjs verify`; main WASM proof additionally rebuilds and byte-compares both files with the committed release.
5. Merge the reviewed PR only when its required checks have concluded successfully. Never treat queued/in-progress as pass. The runtime worker checks the manifest's SHA-256 for both assets to detect mixed cached deployments.
6. Only after a main commit passes Pages and main WASM proof may the website's bundled release be described as deployed and validated.

No claim of real source playback, mobile compatibility or ByteVC2 decode is implied by this matrix.
