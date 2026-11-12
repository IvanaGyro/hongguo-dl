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
cd "$OUTPUT/src/librempeg-$COMMIT"
emconfigure ./configure \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-ffplay --disable-ffprobe --disable-asm --disable-x86asm \
  --disable-inline-asm --disable-stripping --disable-pthreads --disable-network \
  --enable-ffmpeg --enable-avcodec --enable-avformat --enable-avutil \
  --enable-avfilter --enable-swscale --enable-swresample \
  --enable-decoder=bvc2,vvc,aac \
  --enable-parser=aac --enable-encoder=libx264,aac \
  --enable-muxer=mp4,null --enable-demuxer=mov \
  --enable-filter=scale,format,aformat,null,anull \
  --enable-protocol=file,pipe \
  --enable-gpl --enable-agpl --enable-version3 --enable-libx264 \
  --pkg-config-flags=--static \
  --extra-cflags="-O3 -msimd128 -I$OUTPUT/prefix/include" \
  --extra-ldflags="-L$OUTPUT/prefix/lib" \
  > "$OUTPUT/librempeg-configure.log" 2>&1 || {
    tail -120 "$OUTPUT/librempeg-configure.log"; exit 1;
  }
emmake make -j4 ffmpeg > "$OUTPUT/librempeg-build.log" 2>&1 || {
  tail -120 "$OUTPUT/librempeg-build.log"; exit 1;
}
find . -maxdepth 2 -type f \( -name '*.wasm' -o -name '*.js' -o -name ffmpeg \) \
  -exec ls -lh '{}' \; > "$OUTPUT/build-manifest.txt"
cat "$OUTPUT/build-manifest.txt"
# No web deployment until the exact build output is inspected for its
# JS/wasm ABI and tested with an encrypted BVC2 fixture.
for file in ffmpeg ffmpeg.js ffmpeg.wasm; do
  if [[ -f "$file" ]]; then
    cp "$file" "$OUTPUT/dist/"
  fi
done
test -s "$OUTPUT/librempeg-build.log"
