#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# CI's distro FFmpeg may predate VVC. Build an offline VVC-only verifier from
# the same pinned Librempeg commit as the media core, in its own checkout:
#   OUTPUT/native/librempeg/{ffmpeg,ffprobe}
set -euo pipefail
OUTPUT=$1
COMMIT=cb1f8f3eef84999e61b27e2d44664858179bc240
SOURCE="$OUTPUT/native/librempeg"
if [[ ! -d "$SOURCE/.git" ]]; then
  git init -q "$SOURCE"
  git -C "$SOURCE" fetch -q --depth=1 https://github.com/librempeg/librempeg.git "$COMMIT"
  git -C "$SOURCE" checkout -q FETCH_HEAD
fi
test "$(git -C "$SOURCE" rev-parse HEAD)" = "$COMMIT"
cd "$SOURCE"
./configure --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-asm --disable-inline-asm --disable-x86asm --disable-network --enable-ffmpeg --enable-ffprobe \
  --enable-protocol=file,pipe --enable-demuxer=mov --enable-decoder=vvc,aac \
  --enable-encoder=wrapped_avframe,pcm_s16le --enable-muxer=null,vvc,mp4 \
  --enable-bsf=vvc_mp4toannexb --enable-filter=null,anull \
  --enable-gpl --enable-agpl --enable-version3 > "$OUTPUT/native-configure.log" 2>&1
make -j"$(nproc)" ffmpeg ffprobe > "$OUTPUT/native-build.log" 2>&1
