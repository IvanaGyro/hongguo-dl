#!/usr/bin/env bash
# Experimental BVC2->WebAssembly compiler probe; not yet a production decoder.
# Source pinned to the exact revision used by jackotom/hongguo-drama.
set -euo pipefail
ROOT=$(pwd)
BUILD_DIR=${1:-/tmp/hongguo-bvc2-wasm}
COMMIT=cb1f8f3eef84999e61b27e2d44664858179bc240
SHA256=fd965e6ef9f745af96142cf118d7c2aa0dce906225c9d3cd2ef19e0221723813
mkdir -p "$BUILD_DIR/source" "$BUILD_DIR/dist"
curl --fail --location --silent --show-error --retry 2 \
  "https://codeload.github.com/librempeg/librempeg/tar.gz/$COMMIT" \
  -o "$BUILD_DIR/librempeg.tar.gz"
printf '%s  %s\n' "$SHA256" "$BUILD_DIR/librempeg.tar.gz" | sha256sum -c -
tar -xzf "$BUILD_DIR/librempeg.tar.gz" -C "$BUILD_DIR/source"
cd "$BUILD_DIR/source/librempeg-$COMMIT"
emconfigure ./configure \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --disable-everything --disable-autodetect --disable-doc \
  --disable-programs --disable-asm --disable-x86asm --disable-inline-asm \
  --disable-stripping --disable-pthreads --disable-network \
  --enable-avcodec --enable-avformat --enable-avutil --enable-swscale \
  --enable-decoder=bvc2,vvc,aac --enable-parser=aac \
  --enable-demuxer=mov --enable-protocol=file \
  --extra-cflags="-O3 -msimd128" \
  > "$BUILD_DIR/configure.log" 2>&1 || { tail -100 "$BUILD_DIR/configure.log"; exit 1; }
emmake make -j4 libavcodec/libavcodec.a libavformat/libavformat.a \
  libavutil/libavutil.a libswscale/libswscale.a \
  > "$BUILD_DIR/build.log" 2>&1 || { tail -120 "$BUILD_DIR/build.log"; exit 1; }
# This tiny ABI checks that the proprietary-specific BVC2 decoder is actually
# linked, rather than falsely treating standard VVC as interchangeable.
cat > "$BUILD_DIR/probe.c" <<'C'
#include <libavcodec/avcodec.h>
#include <emscripten/emscripten.h>
EMSCRIPTEN_KEEPALIVE int bvc2_decoder_available(void) {
  const AVCodec *codec = avcodec_find_decoder_by_name("bvc2");
  return codec && codec->id == AV_CODEC_ID_BVC2;
}
C
emcc "$BUILD_DIR/probe.c" -O3 -msimd128 -I. \
  -Llibavcodec -Llibavformat -Llibavutil -Llibswscale \
  -Wl,--start-group -lavformat -lavcodec -lavutil -lswscale -Wl,--end-group \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=67108864 \
  -s "EXPORTED_FUNCTIONS=['_bvc2_decoder_available']" \
  -o "$BUILD_DIR/dist/bvc2-probe.mjs"
cat > "$BUILD_DIR/dist/verify.mjs" <<'JS'
import createModule from './bvc2-probe.mjs';
import { readFileSync } from 'node:fs';
const bytes = readFileSync(new URL('./bvc2-probe.wasm', import.meta.url));
const wasm = await createModule({ wasmBinary: bytes });
if (wasm._bvc2_decoder_available() !== 1) {
  throw new Error('Linked decoder is not BVC2');
}
console.log('BVC2 decoder registered in WebAssembly');
JS
node "$BUILD_DIR/dist/verify.mjs"
du -h "$BUILD_DIR/dist/bvc2-probe.wasm"
