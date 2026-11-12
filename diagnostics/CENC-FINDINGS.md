# CENC streaming diagnosis (2026-11-12)

## Finding

The existing native fallback is selecting an unsupported demuxing path: assigning an encrypted MP4 URL directly to `video.src` does not establish a working MP4/CENC pipeline in the tested Chromium and Firefox. Loading a Clear Key license (even with key status `usable`) is insufficient.

A standalone experiment, completely independent of Video.js, app source selection, and FFmpeg.wasm fallback, reproduces the failure. The **same Shaka-encrypted fragmented MP4** plays using MSE in both browsers.

Evidence: [completed matrix run](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43211193645). Raw sanitized results: [cenc-results.json](./cenc-results.json). This is an observational diagnostic workflow; a green job means the matrix completed, not that every tested route passed.

## Controlled experiment

Ubuntu 24.04 GitHub Actions, Playwright 1.58.0, Chromium 145.0.7632.6, Firefox 146.0.1. Eight-second 480x270 H.264 video with a known synthetic key. No real Hongguo media, content keys, or signed URLs are committed.

| Fixture | Direct URL: Chromium | MSE: Chromium | Direct URL: Firefox | MSE: Firefox |
| --- | --- | --- | --- | --- |
| Clear progressive MP4 | Plays | Append error | Plays | No frames within 3 seconds |
| Clear fragmented MP4 | Plays | Plays | Plays | Plays |
| FFmpeg progressive CENC MP4 | Decode error | Append error | Explicit non-MSE rejection | No frames within 3 seconds |
| Shaka fragmented CENC MP4 | Decode error | Plays, 76 frames | Explicit non-MSE rejection | Plays, 72 frames |

For the encrypted Shaka fixture:
- Chromium direct URL: `PIPELINE_ERROR_DECODE`, failed video packet reports `encrypted=0`; key status is `usable`.
- Firefox direct URL: `Encrypted content not supported outside of MSE`; key status is `usable`.
- MSE: currentTime advances approximately 3 seconds, width=480, frames>0 in both engines.
- Chromium rejects progressive MP4 in MSE with: `Detected unfragmented MP4. Media Source Extensions require ISO BMFF moov to contain mvex`.

The harness appends the fixture after fetching it completely. It proves the distinction between decoder/demuxer paths; it **does not** benchmark streaming startup, progressive network delivery, seek, A/V sync, or production HEVC compatibility.

## Actual source inspection

Read-only requests to the configured production Worker for series `7699513062054710296`, **available episode 1**, vid `7699522762213182488`:

- Metadata lists encrypted HEVC at 1080p and ByteVC2 at 720p and below.
- First HEVC CDN candidate returned HTTP 403; second returned a successful bounded 206 Range response. Availability is a separate variable from decoding.
- HEVC file begins with `ftyp` (28 bytes), then `moov` (260182 bytes).
- The complete moov was fetched with a bounded Range request, not the full episode.
- moov has populated sample tables, two tracks, `tenc/senc/saio/saiz/hvcC`, and **no mvex**. Thus this inspected source is progressive/non-fragmented MP4.
- No PSSH was found in this moov. The successful synthetic MSE test preloads the key using `keyids`, so repeatedly changing Common PSSH is not a sufficient fix for the observed direct-URL failure.
- This inspection does not establish the layout of every episode/rendition, nor prove actual HEVC playback. No real media or credentials are included here.

## Implication for the parallel agent's new implementation

The main branch moved during investigation. Commits `c1a4472` / `c4fa556` / `b4a5ba7` add incremental MSE input for files already detected as fragmented, but retain direct URL playback for progressive MP4.

That addition addresses the synthetic Shaka fMP4 case. It does **not** make the inspected real HEVC source stream correctly through EME. Progressive input still falls into the failing direct-URL path, and then whole-file FFmpeg.wasm fallback.

## Recommended implementation order

1. Keep a synthetic MSE/CENC positive control that requires time advancement and decoded/presented frames, with fallback disabled. Keep direct URL as a negative control on these tested engines.
2. Implement progressive MP4 **demuxing and incremental fragmentation**. Use stts/ctts/stsc/stsz/stco or co64/stss and the CENC auxiliary data to produce init + moof/mdat batches while preserving timestamps, sync samples, IVs, subsample encryption and corrected offsets. Reading byte chunks alone does not perform fragmentation.
3. Either preserve CENC for EME, or decrypt samples incrementally and emit clear fMP4. Both approaches still require valid MSE packaging. H.264/HEVC can remain compressed; they need not be decoded and re-encoded merely to change the container.
4. Derive the actual video/audio codec strings from sample entries; test clear and encrypted HEVC separately on the target browser/device. The H.264 Linux result does not establish HEVC or Android support.
5. Add bounded buffering/backpressure, buffered-range eviction, seek-to-keyframe, cancel/release, and restoration of saved playback time. Demonstrate first frame **before network EOF** on a throttled multi-fragment fixture.
6. Treat ByteVC2 as a separate workstream. The current bridge writes a complete input to MEMFS, synchronously transcodes, then reads a complete output. Its compiled-symbol / invalid-input smoke checks do not prove real BVC2 decoding, and its API cannot currently deliver incremental output. Validate a real accessible BVC2 fixture first, then change the I/O API for streaming.

Do not spend further iterations treating a usable key as proof of native playback, or changing PSSH as the main explanation of these particular failures.

## Primary references

- [Chromium encrypted media browser tests](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/media/encrypted_media_browsertest.cc): describes encrypted MP4 tests as requiring MSE (crbug.com/40960332).
- [Chromium FFmpegDemuxer](https://chromium.googlesource.com/chromium/src/+/HEAD/media/filters/ffmpeg_demuxer.cc): its encrypted-buffer path uses WebM decrypt configuration.
- [W3C ISO BMFF MSE byte stream format](https://www.w3.org/TR/mse-byte-stream-format-isobmff/): init segments and movie-fragment media segment requirements.
