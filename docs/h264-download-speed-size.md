# H.264 download speed/size setting

The six slider stops are **measured** H.264 x264 preset/CRF pairs, chosen
as the 12th-smallest highest-passing integer CRF over 45 ten-second clips.
Each passes the adaptive-VMAF test on at least 34/45 samples. `veryfast`
is excluded as it is dominated in measured time and size, although its
quality pass rate was different.

| Position | Preset | CRF | Avg WASM s/10s | Avg MB/10s | Pass/45 |
|---|---|---:|---:|---:|---:|
| 0 | ultrafast | 18 | 2.242 | 11.852 | 35 |
| 1 (default) | superfast | 19 | 4.004 | 8.311 | 35 |
| 2 | faster | 16 | 11.354 | 7.901 | 37 |
| 3 | fast | 17 | 13.130 | 7.193 | 40 |
| 4 | medium | 18 | 24.141 | 6.047 | 36 |
| 5 | slow | 18 | 28.370 | 5.810 | 36 |

The slider is only visible for H.264 downloads. Selection is stored in
localStorage; a job snapshots the profile on enqueue and retains it across
retries and reloads. Separate profiles may coexist as distinct jobs and
have distinct filenames.

- Non-ByteVC2: FFmpeg.wasm uses `-c:v libx264 -preset ... -crf ...`.
- ByteVC2: `bvc2_convert_h264` selects the same preset/CRF, High profile
  and two B-frames, while the existing playback transcode remains unchanged.

**Runtime deployment:** updating `scripts/bvc2-transcoder.c` does not
update the already published WASM. The JS worker detects missing
`bvc2_convert_h264` and reports the unavailable encoder rather than
silently reverting to a different CRF. Rebuild `public/bvc2/bvc2-core.mjs`,
`.wasm` and the manifest together using
`scripts/build-bvc2-wasm-transcode.sh` then
`scripts/bvc2-wasm-bundle.mjs publish DIST`, and verify the published
pair with `node scripts/bvc2-wasm-bundle.mjs verify`.

The reference speed and size measurements used a separate pinned 8-thread
WASM benchmark and are **not guaranteed** on end-user devices; the current
published browser x264 build is single-threaded.
