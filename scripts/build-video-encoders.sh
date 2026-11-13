#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Additional single-threaded WASM encoders. Sources stay pinned for relinking.
set -euo pipefail
OUTPUT=$1
PREFIX="$OUTPUT/prefix"
VVENC=ca1af4a2bcfcf9cd9fea1bacb1f73037af253bda
AOM=10aece4157eb79315da205f39e19bf6ab3ee30d0
mkdir -p "$OUTPUT/src" "$PREFIX"
if [[ ! -s "$PREFIX/lib/libvvenc.a" ]]; then
  if [[ ! -d "$OUTPUT/src/vvenc" ]]; then
    git init "$OUTPUT/src/vvenc"
    git -C "$OUTPUT/src/vvenc" fetch --depth=1 https://github.com/fraunhoferhhi/vvenc.git "$VVENC"
    git -C "$OUTPUT/src/vvenc" checkout FETCH_HEAD
  fi
  test "$(git -C "$OUTPUT/src/vvenc" rev-parse HEAD)" = "$VVENC"
  # Upstream scalar builds leave part of setSIMDExtension outside its guard.
  # No SIMD dispatch exists in this scalar WASM port.
  python3 - "$OUTPUT/src/vvenc/source/Lib/vvenc/vvencimpl.cpp" <<'PYCODE'
import sys
from pathlib import Path
p=Path(sys.argv[1]); s=p.read_text()
a=s.index('const char* VVEncImpl::setSIMDExtension(')
b=s.index('///< creates compile info',a)
s=s[:a]+'const char* VVEncImpl::setSIMDExtension(const char*) { return "SCALAR"; }\n\n'+s[b:]
p.write_text(s)
PYCODE
  emcmake cmake -S "$OUTPUT/src/vvenc" -B "$OUTPUT/vvenc-build" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DVVENC_LIBRARY_ONLY=ON -DBUILD_SHARED_LIBS=OFF \
    -DVVENC_ENABLE_X86_SIMD=OFF -DVVENC_ENABLE_ARM_SIMD=OFF \
    -DVVENC_ENABLE_LINK_TIME_OPT=OFF -DVVENC_ENABLE_THIRDPARTY_JSON=OFF \
    -DCMAKE_CXX_FLAGS='-O3 -msimd128' > "$OUTPUT/vvenc-configure.log" 2>&1
  cmake --build "$OUTPUT/vvenc-build" -j4 > "$OUTPUT/vvenc-build.log" 2>&1
  cmake --install "$OUTPUT/vvenc-build" >> "$OUTPUT/vvenc-build.log" 2>&1
fi
if [[ ! -s "$PREFIX/lib/libaom.a" ]]; then
  if [[ ! -d "$OUTPUT/src/aom" ]]; then
    git init "$OUTPUT/src/aom"
    git -C "$OUTPUT/src/aom" fetch --depth=1 https://aomedia.googlesource.com/aom "$AOM"
    git -C "$OUTPUT/src/aom" checkout FETCH_HEAD
  fi
  test "$(git -C "$OUTPUT/src/aom" rev-parse HEAD)" = "$AOM"
  emcmake cmake -S "$OUTPUT/src/aom" -B "$OUTPUT/aom-build" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DAOM_TARGET_CPU=generic -DCONFIG_MULTITHREAD=0 \
    -DCONFIG_AV1_DECODER=0 -DENABLE_DOCS=0 -DENABLE_TESTS=0 \
    -DENABLE_EXAMPLES=0 -DENABLE_TOOLS=0 -DBUILD_SHARED_LIBS=0 \
    -DCMAKE_C_FLAGS='-O3 -msimd128' -DCMAKE_CXX_FLAGS='-O3 -msimd128' \
    > "$OUTPUT/aom-configure.log" 2>&1
  cmake --build "$OUTPUT/aom-build" -j4 > "$OUTPUT/aom-build.log" 2>&1
  cmake --install "$OUTPUT/aom-build" >> "$OUTPUT/aom-build.log" 2>&1
fi

X265=2bb5520e9596f361bf0ed81b3b8da0d7fd999069
if [[ ! -s "$PREFIX/lib/libx265.a" ]]; then
  if [[ ! -d "$OUTPUT/src/x265" ]]; then
    git init "$OUTPUT/src/x265"
    git -C "$OUTPUT/src/x265" fetch --depth=1 https://github.com/ffmpegwasm/x265.git "$X265"
    git -C "$OUTPUT/src/x265" checkout FETCH_HEAD
  fi
  test "$(git -C "$OUTPUT/src/x265" rev-parse HEAD)" = "$X265"
  git -C "$OUTPUT/src/x265" restore source/encoder/encoder.cpp source/encoder/frameencoder.cpp source/encoder/frameencoder.h
  python3 scripts/patch-x265-single-thread.py "$OUTPUT/src/x265"
  emcmake cmake -S "$OUTPUT/src/x265/source" -B "$OUTPUT/x265-build" \
    -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" -DENABLE_ASSEMBLY=OFF \
    -DENABLE_LIBNUMA=OFF -DENABLE_SHARED=OFF -DENABLE_CLI=OFF \
    -DCMAKE_CXX_FLAGS='-O3 -msimd128' > "$OUTPUT/x265-configure.log" 2>&1
  cmake --build "$OUTPUT/x265-build" -j4 > "$OUTPUT/x265-build.log" 2>&1
  cmake --install "$OUTPUT/x265-build" >> "$OUTPUT/x265-build.log" 2>&1
fi
# x265's CMake omits pkg-config installation when UNIX is false (Emscripten).
cat > "$PREFIX/lib/pkgconfig/x265.pc" <<PC
prefix=$PREFIX
libdir=$PREFIX/lib
includedir=$PREFIX/include
Name: x265
Description: single-threaded WebAssembly HEVC encoder
Version: 3.4
Libs: -L$PREFIX/lib -lx265
Libs.private: -lc++ -lm
Cflags: -I$PREFIX/include
PC
