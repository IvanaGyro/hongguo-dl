# Issue #6: MOV diagnostics during CENC teardown

Scope: https://github.com/IvanaGyro/hongguo-dl/issues/6

## Investigation

The pinned Librempeg MOV demuxer can report corruption when an otherwise valid
sample is interrupted by an AVIO read failure. The message alone does not prove
bad source data or an AAC decoder bug. This worker copies compressed packets;
it does not contain an AAC decoder.

Relevant code at pinned Librempeg commit
`cb1f8f3eef84999e61b27e2d44664858179bc240`:

- [`mov_read_packet`](https://github.com/librempeg/librempeg/blob/cb1f8f3eef84999e61b27e2d44664858179bc240/libavformat/mov.c#L12969)
  reads the indexed sample with `av_get_packet`, then passes it to `cenc_filter`.
- [`cenc_scheme_decrypt`](https://github.com/librempeg/librempeg/blob/cb1f8f3eef84999e61b27e2d44664858179bc240/libavformat/mov.c#L8683)
  rejects a subsample whose declared size exceeds the remaining packet bytes.
- `scripts/cenc-stream-remux.c` maps a rejected asynchronous `readRange` callback
  to `-5` / `AVERROR(EIO)`. A partially buffered sample can therefore reach the
  MOV checks before the demux operation unwinds.

A local fault-injection experiment used the same valid 70-second H.264/AAC
fixture as browser acceptance. Rejecting reads from callback 5, 6 or 10 onward
at a 7-second seek produced `subsample size exceeds the packet size left`.
Rejecting reads from callback 20 onward produced `Packet corrupt` for audio
stream 1 and `partial file` for stream 0. Every message followed the injected
read failure. A fresh pinned-WASM remux at 7 seconds then passed
`ffmpeg -v error -xerror -i output.mp4 -f null -` for both tracks.

The old main-thread teardown posted `cancel` immediately before `terminate()`.
The cooperative message aborts HTTP reads and rejects the pending output ACK,
which can resume Asyncify with an I/O failure before the termination request
stops the worker. This is unnecessary when that worker will never be reused.

## Browser evidence

The [instrumented baseline run #43336329687](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43336329687)
at commit `7c7bc2e207d62f09a40bf9a15997717261e191c0` reproduced all eight
Chromium diagnostics. Its temporary `printErr` callback recorded the producing
worker's own `startSeconds`, AbortSignal and bridge-error state before forwarding
the unmodified diagnostic to `console.error`. Every callback had
`aborted: true` and `bridgeError: "Error"`. Worker seek positions were
55.845799, 7, 35 (twice), 5, 63.188231, 63.206899 and 63.206899 seconds;
these identify the outgoing stream relative to the next requested position.
There were no diagnostics from active workers.

Chromium subsequently produced 25/25 non-silent PCM windows with peak RMS
0.0885624; Firefox produced 25/25 with peak RMS 0.0885590 and no MOV warnings.
Both browsers had no media decoder error, advancing playback, stopped old Range
requests and exactly one live MSE URL. Temporary tracing is removed from the
final code, with no log filtering added.

## Change

Both normal close and failure cleanup now terminate the dedicated worker
directly. Main-thread MSE waits still receive their own AbortSignal, and object
URLs are revoked as before. No decoder, remux, Range validation, source bytes,
WASM asset or pinned library version changes are needed.

[Worker termination](https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker)
discards queued tasks and aborts worker script execution. Browser acceptance
also verifies that Range requests stop after disposal and that only one MSE URL
remains when playback resumes; those checks remain mandatory.

The browser test now treats these MOV messages as fatal in **all phases**,
including seek/disposal transitions. It still requires decoded non-silent AAC
PCM after five seeks, reload and three playback/download/playback cycles.
Lifecycle tests cover direct termination on both seek and failure cleanup.

## Validation

[Fixed browser run #43336535118](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43336535118)
at commit `4c248f09eb92b8f78930d5c746344a65e9562faa` passed the unchanged
15-second startup and 70-second seek/reload/mode-cycle scenarios in both
Chromium and Firefox, with the stricter transition error assertions enabled.

| Browser | Baseline MOV diagnostics | Fixed MOV diagnostics | Fixed recovery PCM | Peak RMS |
| --- | ---: | ---: | --- | ---: |
| Chromium | 8 | 0 | 25/25 non-silent windows | 0.0885106 |
| Firefox | 0 | 0 | 25/25 non-silent windows | 0.0885054 |

Both runs required an advancing playback clock, no media decoder error,
exactly one active MSE URL after recovery and no new Range requests after
disposal. This supports treating issue #6 as a teardown race, with no evidence
of persistent AAC corruption.

Local checks: `bun run test` (153 passed), `VITE_BASE_PATH=/hongguo-dl/ bun run
build`, `node scripts/cenc-wasm-bundle.mjs verify`, and `git diff --check`.
Restoring the old cancel-before-terminate implementation made the new lifecycle
regression fail; restoring the fix passed it. The WASM assets are byte-for-byte
unchanged. Browser validation ran on GitHub Actions because the local executor
blocked Chromium's process-singleton socket.

## Limits

A seek intentionally replaces the MediaSource and jumps to another timestamp;
some playback interruption during that operation is expected. The AAC check
proves non-silent recovery, not sample-perfect continuity through a seek or a
playback-to-download switch. This change makes no new continuity claim for
those intentional discontinuities, physical audio output or third-party media.
