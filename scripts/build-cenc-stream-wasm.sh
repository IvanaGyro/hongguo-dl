#!/usr/bin/env bash
# Compiles a small no-decoder/no-encoder CENC -> clear fMP4 streaming bridge.
set -euo pipefail
ROOT=$(pwd)
OUTPUT=$1
COMMIT=cb1f8f3eef84999e61b27e2d44664858179bc240
SHA256=fd965e6ef9f745af96142cf118d7c2aa0dce906225c9d3cd2ef19e0221723813
mkdir -p "$OUTPUT/src" "$OUTPUT/dist"
curl --fail --location --silent --show-error --retry 2 \
  "https://codeload.github.com/librempeg/librempeg/tar.gz/$COMMIT" \
  -o "$OUTPUT/librempeg.tar.gz"
printf '%s  %s\n' "$SHA256" "$OUTPUT/librempeg.tar.gz" | sha256sum -c -
tar -xzf "$OUTPUT/librempeg.tar.gz" -C "$OUTPUT/src"
cd "$OUTPUT/src/librempeg-$COMMIT"
./configure \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-programs --disable-asm --disable-x86asm --disable-inline-asm \
  --disable-stripping --disable-pthreads --disable-network \
  --enable-avcodec --enable-avformat --enable-avutil \
  --enable-demuxer=mov --enable-muxer=mp4 \
  --enable-parser=hevc,aac \
  --enable-protocol=file,pipe \
  --extra-cflags="-O2" \
  > "$OUTPUT/configure.log" 2>&1 || { tail -100 "$OUTPUT/configure.log"; exit 1; }
emmake make -j4 libavcodec/libavcodec.a libavformat/libavformat.a \
  libavutil/libavutil.a > "$OUTPUT/build.log" 2>&1 || {
    tail -120 "$OUTPUT/build.log"; exit 1;
  }
emcc "$ROOT/scripts/cenc-stream-remux.c" \
  -O2 -I. -Llibavformat -Llibavcodec -Llibavutil \
  -Wl,--start-group -lavformat -lavcodec -lavutil -Wl,--end-group -lm \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node \
  -s ASYNCIFY=1 -s ASYNCIFY_STACK_SIZE=65536 \
  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=536870912 \
  -s "EXPORTED_FUNCTIONS=['_cenc_stream_remux','_cenc_stream_remux_at','_cenc_remux_available','_cenc_remux_error']" \
  -s "EXPORTED_RUNTIME_METHODS=['ccall','UTF8ToString']" \
  -o "$OUTPUT/dist/cenc-core.mjs" > "$OUTPUT/link.log" 2>&1 || {
    tail -120 "$OUTPUT/link.log"; exit 1;
  }
node "$ROOT/scripts/verify-cenc-stream-wasm.mjs" \
  "$OUTPUT/dist/cenc-core.mjs" "$OUTPUT/dist/cenc-core.wasm" \
  "$ROOT/tests/fixtures/cenc-hevc-aac.mp4"
du -h "$OUTPUT/dist/cenc-core.wasm" "$OUTPUT/dist/cenc-core.mjs"
