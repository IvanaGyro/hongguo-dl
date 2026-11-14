#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# CI's distro FFmpeg may predate VVC. Build an offline VVC-only verifier
# from the same pinned, already downloaded Librempeg tree, out of source.
set -euo pipefail
OUTPUT=$1
SOURCE="$OUTPUT/src/librempeg-cb1f8f3eef84999e61b27e2d44664858179bc240"
mkdir -p "$OUTPUT/native"
# A configured source tree forbids out-of-tree configure; use a clean copy
# of the pinned archive rather than disturbing the WASM build products.
tar -xzf "$OUTPUT/librempeg.tar.gz" -C "$OUTPUT/native"
SOURCE="$OUTPUT/native/$(basename "$SOURCE")"
cd "$SOURCE"
./configure --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-asm --disable-inline-asm --disable-x86asm --disable-network --enable-ffmpeg --enable-ffprobe \
  --enable-protocol=file,pipe --enable-demuxer=mov --enable-decoder=vvc,aac \
  --enable-encoder=wrapped_avframe,pcm_s16le --enable-muxer=null,vvc,mp4 \
  --enable-bsf=vvc_mp4toannexb --enable-filter=null,anull \
  --enable-gpl --enable-agpl --enable-version3 > "$OUTPUT/native-configure.log" 2>&1
make -j4 ffmpeg ffprobe > "$OUTPUT/native-build.log" 2>&1
