#!/usr/bin/env bash
# Experimental browser ByteVC2 -> H.264 pipeline, NOT published into the app.
# Compiles the same pinned Librempeg decoder as upstream and a fixed x264 port.
set -euo pipefail
ROOT=$(pwd)
OUTPUT=${1:-/tmp/hongguo-bvc2-transcode}
COMMIT=cb1f8f3eef84999e61b27e2d44664858179bc240
SHA256=fd965e6ef9f745af96142cf118d7c2aa0dce906225c9d3cd2ef19e0221723813
X264_COMMIT=33cac6b77d5b9259c552156013a817ab23119612
mkdir -p "$OUTPUT/dist" "$OUTPUT/src" "$OUTPUT/prefix"
curl --fail --location --silent --show-error --retry 2 \
  "https://codeload.github.com/librempeg/librempeg/tar.gz/$COMMIT" \
  -o "$OUTPUT/librempeg.tar.gz"
printf '%s  %s\n' "$SHA256" "$OUTPUT/librempeg.tar.gz" | sha256sum -c -
tar -xzf "$OUTPUT/librempeg.tar.gz" -C "$OUTPUT/src"
curl --fail --location --silent --show-error --retry 2 \
  "https://codeload.github.com/ffmpegwasm/x264/tar.gz/$X264_COMMIT" \
  -o "$OUTPUT/x264.tar.gz"
tar -xzf "$OUTPUT/x264.tar.gz" -C "$OUTPUT/src"
X264_DIR=$(find "$OUTPUT/src" -maxdepth 1 -type d -name 'x264-*' -print -quit)
cd "$X264_DIR"
emconfigure ./configure --prefix="$OUTPUT/prefix" --host=x86-gnu \
  --enable-static --disable-cli --disable-asm --disable-thread \
  --extra-cflags="-O3 -msimd128" \
  > "$OUTPUT/x264-configure.log" 2>&1 || { tail -100 "$OUTPUT/x264-configure.log"; exit 1; }
emmake make install-lib-static -j4 > "$OUTPUT/x264-build.log" 2>&1 || {
  tail -120 "$OUTPUT/x264-build.log"; exit 1;
}
export PKG_CONFIG_PATH="$OUTPUT/prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$OUTPUT/prefix/lib/pkgconfig"
echo "x264 pkg-config version: $(pkg-config --modversion x264)"
echo "x264 linker flags: $(pkg-config --libs --static x264)"
test -s "$OUTPUT/prefix/lib/libx264.a"
cd "$OUTPUT/src/librempeg-$COMMIT"
# emconfigure overrides PKG_CONFIG_PATH with its sysroot; the explicit
# Emscripten toolchain flags below already configure the cross compiler.
# Invoke configure directly to keep our pinned x264.pc visible.
./configure \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-programs --disable-asm --disable-x86asm \
  --disable-inline-asm --disable-stripping --disable-pthreads --disable-network \
  --enable-avcodec --enable-avformat --enable-avutil --enable-swscale \
  --enable-decoder=bvc2,vvc,aac \
  --enable-parser=aac --enable-encoder=libx264 \
  --enable-muxer=mp4 --enable-demuxer=mov \
  --enable-protocol=file,pipe \
  --enable-gpl --enable-agpl --enable-version3 --enable-libx264 \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-O3 -msimd128 -I$OUTPUT/prefix/include" \
  --extra-ldflags="-L$OUTPUT/prefix/lib" \
  > "$OUTPUT/librempeg-configure.log" 2>&1 || {
    tail -60 "$OUTPUT/librempeg-configure.log"
    echo '---- pkg-config / compiler probe diagnostics ----'
    if [[ -f ffbuild/config.log ]]; then
      grep -F -A35 -B12 'x264_encoder_encode' ffbuild/config.log | tail -110 || true
      grep -F -A15 -B5 'check_pkg_config libx264' ffbuild/config.log | tail -60 || true
      cp ffbuild/config.log "$OUTPUT/librempeg-config-debug.log"
    fi
    exit 1
  }
emmake make -j4 libavcodec/libavcodec.a libavformat/libavformat.a \
  libavutil/libavutil.a libswscale/libswscale.a > "$OUTPUT/librempeg-build.log" 2>&1 || {
  tail -120 "$OUTPUT/librempeg-build.log"; exit 1;
}
# The ffmpeg CLI requires threads and is disabled above. Link the
# memory-backed browser API directly instead of pulling in fftools.
emcc "$ROOT/scripts/bvc2-transcoder.c" -O3 -msimd128 -I. \
  -Llibavformat -Llibavcodec -Llibavutil -Llibswscale -L"$OUTPUT/prefix/lib" \
  -Wl,--start-group -lavformat -lavcodec -lswscale -lavutil -lx264 -Wl,--end-group \
  -lm -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node \
  -s FORCE_FILESYSTEM=1 -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 -s MAXIMUM_MEMORY=1073741824 \
  -s "EXPORTED_FUNCTIONS=['_bvc2_transcode','_bvc2_decoder_available','_bvc2_last_error']" \
  -s "EXPORTED_RUNTIME_METHODS=['FS','cwrap','UTF8ToString']" \
  -o "$OUTPUT/dist/bvc2-core.mjs" > "$OUTPUT/link.log" 2>&1 || {
    tail -120 "$OUTPUT/link.log"; exit 1;
  }
cat > "$OUTPUT/dist/verify.mjs" <<'JS'
import createModule from './bvc2-core.mjs';
import { readFileSync } from 'node:fs';
const wasmBinary = readFileSync(new URL('./bvc2-core.wasm', import.meta.url));
const core = await createModule({ wasmBinary });
if (core._bvc2_decoder_available() !== 1) throw new Error('Missing BVC2 decoder or x264 encoder');
core.FS.writeFile('/bad.mp4', new Uint8Array([1, 2, 3, 4]));
const rc = core.cwrap('bvc2_transcode', 'number', ['string', 'string', 'string'])(
  '/bad.mp4', '/out.mp4', '');
if (rc >= 0) throw new Error('Truncated MP4 unexpectedly succeeded');
const error = core.UTF8ToString(core._bvc2_last_error());
if (!error) throw new Error('Error message not exposed');
console.log('BVC2+x264 WASM bridge linked, invalid input rejected: ' + error);
JS
node "$OUTPUT/dist/verify.mjs"
du -h "$OUTPUT/dist/bvc2-core.wasm"
find "$OUTPUT/dist" -maxdepth 1 -type f -exec ls -lh '{}' \; > "$OUTPUT/build-manifest.txt"
cat "$OUTPUT/build-manifest.txt"
# Experimental artifact only. A real encrypted BVC2 fixture is still needed.
