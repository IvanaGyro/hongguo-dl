// SPDX-License-Identifier: GPL-3.0-only
// Experimental progressive CENC MP4 -> clear fMP4, HEVC/AAC packet copy.
// Custom AVIO bridges async HTTP Range reads to libavformat via Asyncify.
// Not a general-purpose DRM/CDM implementation.
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <emscripten/emscripten.h>

#define IO_SIZE (64 * 1024)
static char error_text[256];

EM_ASYNC_JS(int, cenc_range_read, (int64_t pos, uint8_t *dest, int len), {
  try {
    const io = globalThis.__cencIO;
    if (!io || !io.read) return -1;
    const bytes = await io.read(Number(pos), len);
    if (!(bytes instanceof Uint8Array) || bytes.length > len) return -1;
    HEAPU8.set(bytes, dest);
    return bytes.length;
  } catch (e) {
    return -1;
  }
});

EM_JS(void, cenc_output_write, (const uint8_t *ptr, int size), {
  const io = globalThis.__cencIO;
  if (io && io.write) io.write(HEAPU8.slice(ptr, ptr + size));
});

static int fail(int code, const char *stage) {
  char reason[AV_ERROR_MAX_STRING_SIZE];
  av_strerror(code, reason, sizeof(reason));
  snprintf(error_text, sizeof(error_text), "%s: %s", stage, reason);
  return code < 0 ? code : AVERROR(EINVAL);
}

EMSCRIPTEN_KEEPALIVE const char *cenc_remux_error(void) { return error_text; }

typedef struct {
  int64_t pos, size;
} Input;

static int read_packet(void *opaque, uint8_t *buf, int buf_size) {
  Input *io = opaque;
  if (io->pos >= io->size) return AVERROR_EOF;
  if ((int64_t)buf_size > io->size - io->pos)
    buf_size = (int)(io->size - io->pos);
  int n = cenc_range_read(io->pos, buf, buf_size);
  if (n <= 0) return n < 0 ? AVERROR(EIO) : AVERROR_EOF;
  io->pos += n;
  return n;
}

static int64_t seek_packet(void *opaque, int64_t offset, int whence) {
  Input *io = opaque;
  if (whence == AVSEEK_SIZE) return io->size;
  int64_t pos;
  switch (whence & ~AVSEEK_FORCE) {
    case SEEK_SET: pos = offset; break;
    case SEEK_CUR: pos = io->pos + offset; break;
    case SEEK_END: pos = io->size + offset; break;
    default: return AVERROR(EINVAL);
  }
  if (pos < 0 || pos > io->size) return AVERROR(EINVAL);
  io->pos = pos;
  return pos;
}

static int write_packet(void *opaque, const uint8_t *buf, int size) {
  (void)opaque;
  cenc_output_write(buf, size);
  return size;
}

EMSCRIPTEN_KEEPALIVE int cenc_remux(int64_t file_size, const char *key) {
  AVFormatContext *in = NULL, *out = NULL;
  AVIOContext *input_io = NULL, *output_io = NULL;
  AVDictionary *opts = NULL, *mux = NULL;
  AVPacket *pkt = NULL;
  Input source = { .pos = 0, .size = file_size };
  int ret = AVERROR(EINVAL), stream_map[16], copied = 0;
  int64_t last_fragment_us = AV_NOPTS_VALUE;
  error_text[0] = '\0';
  if (file_size < 32 || file_size > INT64_C(1) << 34)
    return fail(ret, "invalid file size");
  if (!key || strlen(key) != 32 || strspn(key, "0123456789abcdefABCDEF") != 32)
    return fail(ret, "invalid CENC key");
  input_io = avio_alloc_context(av_malloc(IO_SIZE), IO_SIZE, 0,
                               &source, read_packet, NULL, seek_packet);
  if (!input_io) { ret = fail(AVERROR(ENOMEM), "allocate input AVIO"); goto done; }
  in = avformat_alloc_context();
  if (!in) { ret = fail(AVERROR(ENOMEM), "allocate demuxer"); goto done; }
  in->pb = input_io;
  in->flags |= AVFMT_FLAG_CUSTOM_IO;
  av_dict_set(&opts, "decryption_key", key, 0);
  const AVInputFormat *mov = av_find_input_format("mov");
  ret = avformat_open_input(&in, NULL, mov, &opts);
  if (ret < 0) { fail(ret, "open encrypted MP4"); goto done; }
  if (in->nb_streams == 0 || in->nb_streams > 16) {
    ret = fail(AVERROR_INVALIDDATA, "unsupported stream count"); goto done;
  }
  ret = avformat_alloc_output_context2(&out, NULL, "mp4", NULL);
  if (ret < 0 || !out) { ret = fail(ret, "allocate MP4 muxer"); goto done; }
  for (unsigned i = 0; i < in->nb_streams; ++i) {
    AVStream *src = in->streams[i];
    enum AVCodecID codec = src->codecpar->codec_id;
    stream_map[i] = -1;
    if (codec != AV_CODEC_ID_HEVC && codec != AV_CODEC_ID_H264 &&
        codec != AV_CODEC_ID_AAC) continue;
    AVStream *dst = avformat_new_stream(out, NULL);
    if (!dst) { ret = fail(AVERROR(ENOMEM), "allocate output track"); goto done; }
    ret = avcodec_parameters_copy(dst->codecpar, src->codecpar);
    if (ret < 0) { fail(ret, "copy codec parameters"); goto done; }
    dst->codecpar->codec_tag = 0;
    dst->time_base = src->time_base;
    stream_map[i] = dst->index;
    ++copied;
  }
  if (!copied) { ret = fail(AVERROR_STREAM_NOT_FOUND, "no supported video/audio"); goto done; }
  output_io = avio_alloc_context(av_malloc(IO_SIZE), IO_SIZE, 1,
                                 NULL, NULL, write_packet, NULL);
  if (!output_io) { ret = fail(AVERROR(ENOMEM), "allocate output AVIO"); goto done; }
  out->pb = output_io;
  out->flags |= AVFMT_FLAG_CUSTOM_IO;
  av_dict_set(&mux, "movflags", "+empty_moov+default_base_moof+frag_custom", 0);
  ret = avformat_write_header(out, &mux);
  if (ret < 0) { fail(ret, "write fragmented init"); goto done; }
  avio_flush(out->pb);
  pkt = av_packet_alloc();
  if (!pkt) { ret = fail(AVERROR(ENOMEM), "allocate packet"); goto done; }
  while ((ret = av_read_frame(in, pkt)) >= 0) {
    unsigned index = pkt->stream_index;
    if (index >= in->nb_streams || stream_map[index] < 0) {
      av_packet_unref(pkt); continue;
    }
    AVStream *src = in->streams[index];
    AVStream *dst = out->streams[stream_map[index]];
    int is_video = src->codecpar->codec_type == AVMEDIA_TYPE_VIDEO;
    int is_rap = is_video && (pkt->flags & AV_PKT_FLAG_KEY);
    int64_t time_us = pkt->dts == AV_NOPTS_VALUE ? AV_NOPTS_VALUE :
      av_rescale_q(pkt->dts, src->time_base, AV_TIME_BASE_Q);
    // Flush only on a new RAP, so the next fragment is independently decodable.
    if (is_rap && last_fragment_us != AV_NOPTS_VALUE &&
        time_us != AV_NOPTS_VALUE && time_us - last_fragment_us >= 1000000) {
      int flush = av_write_frame(out, NULL);
      if (flush < 0) { ret = fail(flush, "flush fragment"); break; }
      avio_flush(out->pb);
      last_fragment_us = time_us;
    } else if (is_rap && last_fragment_us == AV_NOPTS_VALUE)
      last_fragment_us = time_us;
    av_packet_rescale_ts(pkt, src->time_base, dst->time_base);
    pkt->stream_index = dst->index;
    ret = av_interleaved_write_frame(out, pkt);
    av_packet_unref(pkt);
    if (ret < 0) { fail(ret, "write packet"); break; }
  }
  if (ret == AVERROR_EOF) ret = 0;
  if (ret >= 0) {
    ret = av_write_trailer(out);
    if (ret < 0) fail(ret, "finish fragment");
    avio_flush(out->pb);
  } else if (!error_text[0]) fail(ret, "read encrypted sample");
done:
  av_packet_free(&pkt);
  av_dict_free(&opts);
  av_dict_free(&mux);
  if (out) { out->pb = NULL; avformat_free_context(out); }
  if (in) { in->pb = NULL; avformat_close_input(&in); }
  if (output_io) avio_context_free(&output_io);
  if (input_io) avio_context_free(&input_io);
  return ret;
}
