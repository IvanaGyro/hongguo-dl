#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# The single browser media runtime: pinned Librempeg + x264 + x265 + SVT-AV1
# + VVenC, linked once with the CENC remux, ByteVC2 and generic conversion
# entry points (scripts/media-core/*.c).
#
#   bash scripts/build-media-core.sh mt OUTPUT   # pthreads, needs crossOriginIsolated
#   bash scripts/build-media-core.sh st OUTPUT   # same API, no SharedArrayBuffer
#
# Both variants are compiled from identical sources and options apart from
# threading; the page selects one at runtime (src/media-core.js).
set -euo pipefail
ROOT=$(pwd)
VARIANT=${1:?usage: build-media-core.sh mt|st OUTPUT}
OUTPUT=${2:?usage: build-media-core.sh mt|st OUTPUT}
JOBS=${JOBS:-$(nproc)}
case "$VARIANT" in
  mt) THREAD='-pthread'; NAME=media-core ;;
  st) THREAD=''; NAME=media-core-st ;;
  *) echo "variant must be mt or st" >&2; exit 2 ;;
esac
LIBREMPEG=cb1f8f3eef84999e61b27e2d44664858179bc240
X264=33cac6b77d5b9259c552156013a817ab23119612
X265=2bb5520e9596f361bf0ed81b3b8da0d7fd999069
VVENC=ca1af4a2bcfcf9cd9fea1bacb1f73037af253bda
# SVT-AV1 4.3.1 (upstream main as mirrored by IvanaGyro/SVT-AV1), plus the
# vendored fixes from that fork's PR #1 and PR #2 (scripts/patches/svt-av1).
SVTAV1=ad875ab772c67ff3f098c59667348d80fb5c68b6
CFLAGS="-O3 -msimd128 $THREAD"
W="$OUTPUT/$VARIANT"
PREFIX="$W/prefix"
mkdir -p "$W/src" "$OUTPUT/dist" "$PREFIX/lib/pkgconfig"

fetch() { # name url commit
  local dir="$W/src/$1"
  if [[ ! -d "$dir/.git" ]]; then
    git init -q "$dir"
    git -C "$dir" fetch -q --depth=1 "$2" "$3"
    git -C "$dir" checkout -q FETCH_HEAD
  fi
  test "$(git -C "$dir" rev-parse HEAD)" = "$3"
}
log() { echo "[media-core:$VARIANT] $*"; }

# ---- x264 ---------------------------------------------------------------
if [[ ! -s "$PREFIX/lib/libx264.a" ]]; then
  log 'x264'
  fetch x264 https://github.com/ffmpegwasm/x264.git "$X264"
  THREADING=--disable-thread; [[ $VARIANT == mt ]] && THREADING=
  (cd "$W/src/x264" && emconfigure ./configure --prefix="$PREFIX" --host=x86-gnu \
    --enable-static --disable-cli --disable-asm $THREADING \
    --extra-cflags="$CFLAGS" --extra-ldflags="$THREAD" \
    > "$W/x264-configure.log" 2>&1 && \
    emmake make install-lib-static -j"$JOBS" > "$W/x264-build.log" 2>&1) || {
      tail -60 "$W"/x264-*.log; exit 1; }
fi

# ---- x265 ---------------------------------------------------------------
if [[ ! -s "$PREFIX/lib/libx265.a" ]]; then
  log 'x265'
  fetch x265 https://github.com/ffmpegwasm/x265.git "$X265"
  git -C "$W/src/x265" checkout -q -- .
  # Without pthreads, frame encoders must run synchronously in the caller.
  [[ $VARIANT == st ]] && python3 "$ROOT/scripts/patch-x265-single-thread.py" "$W/src/x265"
  emcmake cmake -S "$W/src/x265/source" -B "$W/x265-build" \
    -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DENABLE_ASSEMBLY=OFF \
    -DENABLE_LIBNUMA=OFF -DENABLE_SHARED=OFF -DENABLE_CLI=OFF \
    -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CFLAGS" > "$W/x265-configure.log" 2>&1
  cmake --build "$W/x265-build" -j"$JOBS" > "$W/x265-build.log" 2>&1 || {
    tail -60 "$W/x265-build.log"; exit 1; }
  cmake --install "$W/x265-build" >> "$W/x265-build.log" 2>&1
fi
# x265's CMake omits pkg-config installation when UNIX is false (Emscripten).
cat > "$PREFIX/lib/pkgconfig/x265.pc" <<PC
prefix=$PREFIX
libdir=$PREFIX/lib
includedir=$PREFIX/include
Name: x265
Description: WebAssembly HEVC encoder ($VARIANT)
Version: 3.4
Libs: -L$PREFIX/lib -lx265
Libs.private: -lc++ -lm
Cflags: -I$PREFIX/include
PC

# ---- SVT-AV1 ------------------------------------------------------------
if [[ ! -s "$PREFIX/lib/libSvtAv1Enc.a" ]]; then
  log 'SVT-AV1'
  fetch svt-av1 https://github.com/IvanaGyro/SVT-AV1.git "$SVTAV1"
  git -C "$W/src/svt-av1" checkout -q -- .
  # PR #1 fixes undefined pointer masking in the scalar Wiener filter that
  # every Emscripten (C-only) build executes; PR #2 fixes 32-bit pointer
  # width in the AVX2 motion-info copy (only used if x86 SIMD is emulated).
  git -C "$W/src/svt-av1" apply "$ROOT"/scripts/patches/svt-av1/*.patch
  emcmake cmake -S "$W/src/svt-av1" -B "$W/svt-build" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DBUILD_SHARED_LIBS=OFF -DCOMPILE_C_ONLY=ON -DBUILD_APPS=OFF -DBUILD_DEC=OFF \
    -DBUILD_TESTING=OFF -DENABLE_NASM=OFF \
    -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CFLAGS" > "$W/svt-configure.log" 2>&1
  cmake --build "$W/svt-build" -j"$JOBS" > "$W/svt-build.log" 2>&1 || {
    tail -60 "$W/svt-build.log"; exit 1; }
  cmake --install "$W/svt-build" >> "$W/svt-build.log" 2>&1
fi

# ---- VVenC --------------------------------------------------------------
if [[ ! -s "$PREFIX/lib/libvvenc.a" ]]; then
  log 'VVenC'
  fetch vvenc https://github.com/fraunhoferhhi/vvenc.git "$VVENC"
  git -C "$W/src/vvenc" checkout -q -- .
  # Upstream scalar builds leave part of setSIMDExtension outside its guard.
  python3 - "$W/src/vvenc/source/Lib/vvenc/vvencimpl.cpp" <<'PYCODE'
import sys
from pathlib import Path
p=Path(sys.argv[1]); s=p.read_text()
a=s.index('const char* VVEncImpl::setSIMDExtension(')
b=s.index('///< creates compile info',a)
s=s[:a]+'const char* VVEncImpl::setSIMDExtension(const char*) { return "SCALAR"; }\n\n'+s[b:]
p.write_text(s)
PYCODE
  emcmake cmake -S "$W/src/vvenc" -B "$W/vvenc-build" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DVVENC_LIBRARY_ONLY=ON -DBUILD_SHARED_LIBS=OFF \
    -DVVENC_ENABLE_X86_SIMD=OFF -DVVENC_ENABLE_ARM_SIMD=OFF \
    -DVVENC_ENABLE_LINK_TIME_OPT=OFF -DVVENC_ENABLE_THIRDPARTY_JSON=OFF \
    -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CFLAGS" > "$W/vvenc-configure.log" 2>&1
  cmake --build "$W/vvenc-build" -j"$JOBS" > "$W/vvenc-build.log" 2>&1 || {
    tail -60 "$W/vvenc-build.log"; exit 1; }
  cmake --install "$W/vvenc-build" >> "$W/vvenc-build.log" 2>&1
fi

# ---- Librempeg ----------------------------------------------------------
LREM="$W/src/librempeg"
if [[ ! -s "$LREM/libavformat/libavformat.a" ]]; then
  log 'Librempeg'
  fetch librempeg https://github.com/librempeg/librempeg.git "$LIBREMPEG"
  git -C "$LREM" checkout -q -- .
  # The pinned tree keeps the vvenc configure/Makefile entries but lacks the
  # wrapper source: restore FFmpeg n8.0's LGPL wrapper, kept in-tree.
  cp "$ROOT/scripts/vendor/libvvenc.c" "$LREM/libavcodec/libvvenc.c"
  # BVC2 has in-band parameters and its own sample tag; never relabel it vvc1.
  python3 "$ROOT/scripts/patch-bvc2-mov.py" "$LREM"
  PTHREADS=--disable-pthreads; [[ $VARIANT == mt ]] && PTHREADS=--enable-pthreads
  export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
  # emconfigure would replace PKG_CONFIG_PATH with its sysroot; the explicit
  # cross toolchain flags below configure Emscripten directly.
  (cd "$LREM" && ./configure \
    --target-os=none --arch=x86_32 --enable-cross-compile \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --disable-everything --disable-autodetect --disable-doc --disable-debug \
    --disable-programs --disable-asm --disable-x86asm \
    --disable-inline-asm --disable-stripping $PTHREADS --disable-network \
    --enable-avcodec --enable-avformat --enable-avutil --enable-swscale \
    --enable-decoder=bvc2,vvc,aac,h264,hevc \
    --enable-parser=aac,h264,hevc,vvc \
    --enable-encoder=libx264,libx265,libsvtav1,libvvenc \
    --enable-muxer=mp4 --enable-demuxer=mov,concat \
    --enable-protocol=file,pipe \
    --enable-gpl --enable-version3 \
    --enable-libx264 --enable-libx265 --enable-libsvtav1 --enable-libvvenc \
    --pkg-config=pkg-config --pkg-config-flags=--static \
    --extra-cflags="$CFLAGS -I$PREFIX/include" \
    --extra-cxxflags="$CFLAGS" \
    --extra-ldflags="$THREAD -L$PREFIX/lib" \
    > "$W/librempeg-configure.log" 2>&1) || {
      tail -40 "$W/librempeg-configure.log"
      tail -80 "$LREM/ffbuild/config.log" || true
      exit 1; }
  (cd "$LREM" && emmake make -j"$JOBS" libavcodec/libavcodec.a libavformat/libavformat.a \
    libavutil/libavutil.a libswscale/libswscale.a > "$W/librempeg-build.log" 2>&1) || {
      tail -80 "$W/librempeg-build.log"; exit 1; }
fi

# ---- Link ---------------------------------------------------------------
log 'link'
LINK_THREAD=()
if [[ $VARIANT == mt ]]; then
  # The pool is sized per job by the loader (Module.pthreadPoolSize), since
  # SVT-AV1 alone starts ~40-60 threads at lp 2-4 while a CENC remux needs none.
  LINK_THREAD=(-pthread '-sPTHREAD_POOL_SIZE=Module["pthreadPoolSize"]||2'
    -sDEFAULT_PTHREAD_STACK_SIZE=2097152 -sMAXIMUM_MEMORY=2147483648)
else
  LINK_THREAD=(-sMAXIMUM_MEMORY=2147483648)
fi
EXPORTS="['_media_core_info','_media_set_threads','_media_convert','_media_concat','_media_last_error',\
'_media_last_remuxed','_bvc2_transcode','_bvc2_decoder_available','_bvc2_last_error','_bvc2_convert',\
'_bvc2_convert_h264','_bvc2_stream','_bvc2_last_remuxed','_bvc2_play','_cenc_stream_remux',\
'_cenc_stream_remux_at','_cenc_remux_available','_cenc_remux_error']"
emcc "$ROOT/scripts/media-core/transcoder.c" "$ROOT/scripts/media-core/cenc-remux.c" \
  "$ROOT/scripts/media-core/avio.c" \
  -O3 -msimd128 $THREAD -I"$LREM" -I"$ROOT/scripts/media-core" \
  -L"$LREM/libavformat" -L"$LREM/libavcodec" -L"$LREM/libavutil" -L"$LREM/libswscale" -L"$PREFIX/lib" \
  -Wl,--start-group -lavformat -lavcodec -lswscale -lavutil \
  -lx264 -lx265 -lSvtAv1Enc -lvvenc -lc++ -Wl,--end-group -lm \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node \
  -s ASYNCIFY=1 -s ASYNCIFY_STACK_SIZE=262144 -s FORCE_FILESYSTEM=1 -s ALLOW_MEMORY_GROWTH=1 \
  -s STACK_SIZE=5242880 -s INITIAL_MEMORY=67108864 "${LINK_THREAD[@]}" \
  -s "EXPORTED_FUNCTIONS=$EXPORTS" \
  -s "EXPORTED_RUNTIME_METHODS=['FS','cwrap','ccall','UTF8ToString']" \
  -o "$OUTPUT/dist/$NAME.mjs" > "$W/link-$VARIANT.log" 2>&1 || {
    tail -80 "$W/link-$VARIANT.log"; exit 1; }
node "$ROOT/scripts/verify-media-core.mjs" "$OUTPUT/dist/$NAME.mjs"
ls -l "$OUTPUT/dist/$NAME".*
