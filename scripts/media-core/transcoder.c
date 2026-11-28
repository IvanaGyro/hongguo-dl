// SPDX-License-Identifier: GPL-3.0-only
// The media core's decode/encode half: generic MP4 conversion (stream copy,
// CENC decryption, H.264/HEVC/AV1/VVC encoding with preset/quality, lossless
// concat), incremental ByteVC2 -> H.264 streaming and a decode-only render
// mode (bvc2_play) for direct WebGL2 presentation. Whole-file jobs use
// Emscripten MEMFS paths; streaming jobs use the Asyncify AVIO in avio.c.
// The same source builds with pthreads (mt) and without (st).
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
#include <emscripten/emscripten.h>
#include <libavutil/mem.h>
#include <libavutil/intreadwrite.h>
#define AVIO_BUFFER 32768
#include "avio.h"

#ifdef __EMSCRIPTEN_PTHREADS__
#define MAX_THREADS 16
#else
#define MAX_THREADS 1
#endif
// Streaming playback (bvc2_stream/bvc2_play) uses this; whole-file jobs
// receive their own thread count.
static int stream_threads = 1;

EM_JS(void, report_progress, (double value), {
    if (Module["onProgress"]) Module["onProgress"](value);
});

// Render mode: one packed 8-bit I420 picture per call. The awaited consumer
// applies backpressure exactly like js_output_write does for fMP4 bytes.
EM_ASYNC_JS(int, js_frame_out, (const uint8_t *src, int length, int width, int height,
    double pts, int flags), {
    try {
        const data = HEAPU8.slice(src, src + length);
        await Module['writeFrame'](data, { width, height, pts, flags });
        return 0;
    } catch (error) {
        Module['bridgeError'] = error?.name || 'FrameError';
        return -5;
    }
});

#define MODE_RENDER 6
#define FRAME_BT709 1
#define FRAME_FULL_RANGE 2


static char last_error[256];
static int last_remuxed;

static int clamp_threads(int n) { return n < 1 ? 1 : n > MAX_THREADS ? MAX_THREADS : n; }

static int fail(int code, const char *where) {
    char reason[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(code, reason, sizeof(reason));
    snprintf(last_error, sizeof(last_error), "%s: %s", where, reason);
    return code < 0 ? code : AVERROR(EINVAL);
}

EMSCRIPTEN_KEEPALIVE const char *bvc2_last_error(void) { return last_error; }
// 1 when the last bvc2_convert wrote VVC by copying ByteVC2 NAL units.
EMSCRIPTEN_KEEPALIVE int bvc2_last_remuxed(void) { return last_remuxed; }
EMSCRIPTEN_KEEPALIVE const char *media_last_error(void) { return last_error; }
EMSCRIPTEN_KEEPALIVE int media_last_remuxed(void) { return last_remuxed; }
EMSCRIPTEN_KEEPALIVE int media_set_threads(int threads) {
    stream_threads = clamp_threads(threads);
    return stream_threads;
}
// ABI/capability report for the loader: "api=4;threads=N;<encoders...>".
EMSCRIPTEN_KEEPALIVE const char *media_core_info(void) {
    static char info[160];
    snprintf(info, sizeof(info), "api=4;threads=%d;%s%s%s%s%s", MAX_THREADS,
        avcodec_find_encoder_by_name("libx264") ? "libx264," : "",
        avcodec_find_encoder_by_name("libx265") ? "libx265," : "",
        avcodec_find_encoder_by_name("libsvtav1") ? "libsvtav1," : "",
        avcodec_find_encoder_by_name("libvvenc") ? "libvvenc," : "",
        avcodec_find_decoder_by_name("bvc2") ? "bvc2" : "");
    return info;
}

EMSCRIPTEN_KEEPALIVE int bvc2_decoder_available(void) {
    const AVCodec *decoder = avcodec_find_decoder_by_name("bvc2");
    const AVCodec *encoder = avcodec_find_encoder_by_name("libx264");
    return decoder && decoder->id == AV_CODEC_ID_BVC2 && encoder != NULL;
}

typedef struct Context {
    AVFormatContext *input, *output;
    AVCodecContext *decoder, *encoder;
    AVStream *video_in, *video_out, *audio_in, *audio_out;
    AVFrame *decoded, *scaled, *converted;
    uint8_t *packed;
    int packed_size;
    AVPacket *packet, *encoded;
    struct SwsContext *scale, *render_scale;
    AVIOContext *reader_io, *writer_io;
    Stream reader;
    int mode, streaming, threads;
    // Download encoder settings; NULL preset keeps the historic defaults.
    const char *preset;
    int quality;
    const char *input_format;
    // ByteVC2 slices use H.266 syntax (Librempeg decodes both with the same
    // VVC decoder); only the bvc2/bv2C framing differs. Remux, don't encode.
    int remux_vvc, copy, no_remux;
    double start_seconds, last_progress;
    int64_t next_pts;
    int64_t decoded_frames;
    int64_t last_dts[2]; // copied video, audio (output time base)
} Context;

// ByteVC2 configuration and samples are always 4-byte length-prefixed NAL
// units (Librempeg's BVC2 CBS reads them only that way; bv2C records are
// normalized to this form in JS). Never sniff for start codes: a 256-511
// byte NAL's length prefix begins with 00 00 01.
// Rewriting each length as a 4-byte start code keeps the size. movenc treats
// Annex B VVC extradata as a signal that packets are Annex B too, builds
// vvcC from it and converts each packet back to length-prefixed NAL units.
static int nal_lengths_valid(const uint8_t *data, int size) {
    for (int p = 0; p < size;) {
        if (size - p < 4) return 0;
        uint32_t length = AV_RB32(data + p);
        if (length < 2 || length > (uint32_t)(size - p - 4)) return 0;
        p += 4 + length;
    }
    return size > 0;
}

static void nal_lengths_to_start_codes(uint8_t *data, int size) {
    for (int p = 0; p < size;) {
        uint32_t length = AV_RB32(data + p);
        AV_WB32(data + p, 1);
        p += 4 + length;
    }
}

static int prepare_vvc_parameters(AVCodecParameters *par) {
    par->codec_id = AV_CODEC_ID_VVC;
    if (!par->extradata_size)
        return 0; // In-band only: movenc reads parameter sets from packet 1.
    if (!nal_lengths_valid(par->extradata, par->extradata_size))
        return AVERROR_INVALIDDATA;
    nal_lengths_to_start_codes(par->extradata, par->extradata_size);
    return 0;
}

static int packet_to_annexb(AVPacket *pkt) {
    if (!nal_lengths_valid(pkt->data, pkt->size)) return AVERROR_INVALIDDATA;
    int ret = av_packet_make_writable(pkt);
    if (ret < 0) return ret;
    nal_lengths_to_start_codes(pkt->data, pkt->size);
    return 0;
}

// Concatenated files overlap by AAC priming/rounding at each boundary. Like
// the FFmpeg CLI, nudge a copied packet's DTS forward instead of failing.
static void keep_monotonic(Context *c, AVPacket *pkt, int slot) {
    if (pkt->dts == AV_NOPTS_VALUE) return;
    if (c->last_dts[slot] != AV_NOPTS_VALUE && pkt->dts <= c->last_dts[slot]) {
        int64_t dts = c->last_dts[slot] + 1;
        if (pkt->pts != AV_NOPTS_VALUE && pkt->pts >= pkt->dts) pkt->pts += dts - pkt->dts;
        pkt->dts = dts;
    }
    c->last_dts[slot] = pkt->dts;
}

static int write_encoded(Context *c) {
    int ret;
    while ((ret = avcodec_receive_packet(c->encoder, c->encoded)) >= 0) {
        if (c->encoded->duration <= 0) c->encoded->duration = 1;
        av_packet_rescale_ts(c->encoded, c->encoder->time_base, c->video_out->time_base);
        c->encoded->stream_index = c->video_out->index;
        ret = av_interleaved_write_frame(c->output, c->encoded);
        av_packet_unref(c->encoded);
        if (ret < 0) return fail(ret, "write video packet");
    }
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    return fail(ret, "encode H.264");
}

static int encode_frame(Context *c, AVFrame *frame) {
    int ret = avcodec_send_frame(c->encoder, frame);
    if (ret < 0) return fail(ret, "submit encoder frame");
    return write_encoded(c);
}

// Decoded pictures go to the page's WebGL2 renderer without re-encoding.
// Only non-8-bit-4:2:0 output is converted; 8-bit I420 is copied as is.
static int render_frame(Context *c) {
    AVFrame *source = c->decoded;
    int width = source->width, height = source->height, ret;
    if (source->format != AV_PIX_FMT_YUV420P && source->format != AV_PIX_FMT_YUVJ420P) {
        if (!c->converted || c->converted->width != width || c->converted->height != height) {
            av_frame_free(&c->converted);
            c->converted = av_frame_alloc();
            if (!c->converted) return fail(AVERROR(ENOMEM), "allocate render frame");
            c->converted->format = AV_PIX_FMT_YUV420P;
            c->converted->width = width; c->converted->height = height;
            if ((ret = av_frame_get_buffer(c->converted, 32)) < 0)
                return fail(ret, "allocate render picture");
        }
        c->render_scale = sws_getCachedContext(c->render_scale, width, height, source->format,
            width, height, AV_PIX_FMT_YUV420P, SWS_BILINEAR, NULL, NULL, NULL);
        if (!c->render_scale) return fail(AVERROR(ENOMEM), "initialize render conversion");
        sws_scale(c->render_scale, (const uint8_t * const *)source->data, source->linesize,
            0, height, c->converted->data, c->converted->linesize);
        source = c->converted;
    }
    int chroma_width = (width + 1) / 2, chroma_height = (height + 1) / 2;
    int size = width * height + 2 * chroma_width * chroma_height;
    if (size > c->packed_size) {
        av_freep(&c->packed);
        c->packed = av_malloc(size);
        if (!c->packed) { c->packed_size = 0; return fail(AVERROR(ENOMEM), "allocate packed frame"); }
        c->packed_size = size;
    }
    uint8_t *out = c->packed;
    for (int y = 0; y < height; y++, out += width)
        memcpy(out, source->data[0] + (int64_t)y * source->linesize[0], width);
    for (int plane = 1; plane <= 2; plane++)
        for (int y = 0; y < chroma_height; y++, out += chroma_width)
            memcpy(out, source->data[plane] + (int64_t)y * source->linesize[plane], chroma_width);
    int flags = 0;
    if (c->decoded->colorspace == AVCOL_SPC_BT709 ||
        (c->decoded->colorspace == AVCOL_SPC_UNSPECIFIED && height >= 720)) flags |= FRAME_BT709;
    if (c->decoded->color_range == AVCOL_RANGE_JPEG || c->decoded->format == AV_PIX_FMT_YUVJ420P)
        flags |= FRAME_FULL_RANGE;
    int64_t pts = c->decoded->best_effort_timestamp;
    double seconds = pts != AV_NOPTS_VALUE ? pts * av_q2d(c->video_in->time_base)
        : c->decoded_frames / FFMAX(1.0, av_q2d(av_guess_frame_rate(c->input, c->video_in, NULL)));
    c->decoded_frames++;
    // A seek restarts at the preceding keyframe; earlier pictures are never shown.
    if (c->start_seconds > 0.5 && seconds < c->start_seconds - 0.05) return 0;
    if (js_frame_out(c->packed, size, width, height, seconds, flags) < 0)
        return fail(AVERROR(EIO), "deliver decoded frame");
    return 0;
}

static int process_frames(Context *c) {
    int ret;
    while ((ret = avcodec_receive_frame(c->decoder, c->decoded)) >= 0) {
        if (c->mode == MODE_RENDER) {
            ret = render_frame(c);
            av_frame_unref(c->decoded);
            if (ret < 0) return ret;
            continue;
        }
        c->scale = sws_getCachedContext(c->scale,
            c->decoded->width, c->decoded->height, c->decoded->format,
            c->encoder->width, c->encoder->height, c->encoder->pix_fmt,
            SWS_BILINEAR, NULL, NULL, NULL);
        if (!c->scale) return fail(AVERROR(ENOMEM), "initialize pixel conversion");
        if ((ret = av_frame_make_writable(c->scaled)) < 0)
            return fail(ret, "allocate scaled frame");
        sws_scale(c->scale, (const uint8_t * const *)c->decoded->data,
            c->decoded->linesize, 0, c->decoded->height,
            c->scaled->data, c->scaled->linesize);
        int64_t pts = c->decoded->best_effort_timestamp;
        if (pts != AV_NOPTS_VALUE) {
            pts = av_rescale_q(pts, c->video_in->time_base, c->encoder->time_base);
            if (pts < c->next_pts) pts = c->next_pts;
        } else pts = c->next_pts;
        c->scaled->pts = pts;
        c->next_pts = pts + 1;
        c->decoded_frames++;
        double duration = c->video_in->duration > 0
            ? c->video_in->duration * av_q2d(c->video_in->time_base)
            : c->input->duration / (double)AV_TIME_BASE;
        double seconds = pts * av_q2d(c->encoder->time_base);
        double progress = duration > 0 ? FFMIN(0.99, FFMAX(0, seconds / duration)) : 0;
        if (progress >= c->last_progress + 0.005) {
            c->last_progress = progress;
            report_progress(progress);
        }
        av_frame_unref(c->decoded);
        if ((ret = encode_frame(c, c->scaled)) < 0) return ret;
    }
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    return fail(ret, "decode ByteVC2 frame");
}

static int configure_encoder(Context *c) {
    void *opt = c->encoder->priv_data;
    char params[160];
    int threads = c->threads;
    if (c->mode == 5) {
#ifdef __EMSCRIPTEN_PTHREADS__
        int frames = threads >= 8 ? 3 : threads >= 3 ? 2 : 1;
        snprintf(params, sizeof(params), "pools=%d:frame-threads=%d%s", threads, frames,
            c->preset ? "" : ":bframes=0:rc-lookahead=0:cutree=0");
#else
        // The synchronous x265 port supports neither pools, WPP nor lookahead.
        snprintf(params, sizeof(params),
            "pools=none:frame-threads=1:wpp=0:bframes=0:rc-lookahead=0:cutree=0");
#endif
        av_opt_set(opt, "preset", c->preset ? c->preset : "ultrafast", 0);
        av_opt_set_int(opt, "crf", c->preset ? c->quality : 23, 0);
        av_opt_set(opt, "x265-params", params, 0);
    } else if (c->mode == 2) {
        snprintf(params, sizeof(params), "lp=%d", threads);
        av_opt_set(opt, "preset", c->preset ? c->preset : "10", 0);
        av_opt_set_int(opt, "crf", c->preset ? c->quality : 32, 0);
        av_opt_set(opt, "svtav1-params", params, 0);
    } else if (c->mode == 3) {
        snprintf(params, sizeof(params), "Threads=%d", threads > 1 ? threads : 0);
        av_opt_set(opt, "preset", c->preset ? c->preset : "faster", 0);
        av_opt_set_int(opt, "qp", c->preset ? c->quality : 32, 0);
        av_opt_set(opt, "vvenc-params", params, 0);
        if (threads <= 1) c->encoder->thread_count = 0;
    } else if (c->preset) {
        // Mirror the x264 coding tools used for the measured preset/CRF
        // options. Playback and other codecs keep their old defaults.
        av_opt_set(opt, "preset", c->preset, 0);
        av_opt_set(opt, "profile", "high", 0);
        av_opt_set(opt, "level", "5.1", 0);
        av_opt_set_int(opt, "crf", c->quality, 0);
    } else {
        av_opt_set(opt, "preset", "ultrafast", 0);
        av_opt_set(opt, "tune", "zerolatency", 0);
        av_opt_set(opt, "profile", "baseline", 0);
        av_opt_set(opt, "level", "3.1", 0);
        av_opt_set(opt, "crf", "20", 0);
    }
    return 0;
}

static int execute(Context *c, const char *input, const char *output, const char *key) {
    int ret;
    AVDictionary *open_options = NULL;
    if (key && key[0]) {
        if (strlen(key) != 32 || strspn(key, "0123456789abcdefABCDEF") != 32)
            return fail(AVERROR(EINVAL), "invalid CENC key");
        av_dict_set(&open_options, "decryption_key", key, 0);
    }
    if (c->streaming) {
        uint8_t *buffer = av_malloc(AVIO_BUFFER);
        if (!buffer) return fail(AVERROR(ENOMEM), "input buffer");
        c->reader_io = avio_alloc_context(buffer, AVIO_BUFFER, 0,
            &c->reader, media_input_read, NULL, media_input_seek);
        if (!c->reader_io) { av_free(buffer); return fail(AVERROR(ENOMEM), "input AVIO"); }
        c->input = avformat_alloc_context();
        if (!c->input) return fail(AVERROR(ENOMEM), "input context");
        c->input->pb = c->reader_io;
        c->input->flags |= AVFMT_FLAG_CUSTOM_IO;
    }
    if (c->input_format) {
        av_dict_set(&open_options, "safe", "1", 0);
        // MP4 to MP4: keep length-prefixed NAL units (no Annex B filters).
        av_dict_set(&open_options, "auto_convert", "0", 0);
    }
    ret = avformat_open_input(&c->input, input,
        av_find_input_format(c->input_format ? c->input_format : "mov"), &open_options);
    av_dict_free(&open_options);
    if (ret < 0) return fail(ret, "open MP4");

    int vi = av_find_best_stream(c->input, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (vi < 0) return fail(vi, "find video");
    c->video_in = c->input->streams[vi];
    if (c->mode == 1 && c->video_in->codecpar->codec_id != AV_CODEC_ID_BVC2)
        return fail(AVERROR_INVALIDDATA, "input is not ByteVC2");
    c->remux_vvc = c->mode == 3 && !c->no_remux && !c->streaming &&
        c->video_in->codecpar->codec_id == AV_CODEC_ID_BVC2;
    c->copy = c->mode == 0 || c->remux_vvc;
    if (!c->copy) {
    const AVCodec *dec = avcodec_find_decoder(c->video_in->codecpar->codec_id);
    const AVCodec *enc = c->mode == MODE_RENDER ? NULL : avcodec_find_encoder_by_name(
        c->mode == 5 ? "libx265" : c->mode == 2 ? "libsvtav1" : c->mode == 3 ? "libvvenc" : "libx264");
    if (!dec || (!enc && c->mode != MODE_RENDER))
        return fail(AVERROR_DECODER_NOT_FOUND, "missing decoder or encoder");
    c->decoder = avcodec_alloc_context3(dec);
    c->encoder = enc ? avcodec_alloc_context3(enc) : NULL;
    if (!c->decoder || (enc && !c->encoder)) return fail(AVERROR(ENOMEM), "allocate codecs");
    if ((ret = avcodec_parameters_to_context(c->decoder, c->video_in->codecpar)) < 0)
        return fail(ret, "read codec parameters");
    c->decoder->thread_count = c->threads;
    c->decoder->pkt_timebase = c->video_in->time_base;
    if ((ret = avcodec_open2(c->decoder, dec, NULL)) < 0)
        return fail(ret, "open BVC2 decoder");

    int width = c->decoder->width, height = c->decoder->height;
    if (width < 16 || height < 16 || width > 4096 || height > 4096)
        return fail(AVERROR(EINVAL), "invalid video dimensions");
    if (c->mode != MODE_RENDER) {
    AVRational fps = av_guess_frame_rate(c->input, c->video_in, NULL);
    if (fps.num <= 0 || fps.den <= 0 || av_q2d(fps) < 1 || av_q2d(fps) > 120)
        fps = (AVRational){25, 1};
    c->encoder->width = width; c->encoder->height = height;
    c->encoder->pix_fmt = c->mode == 3 ? AV_PIX_FMT_YUV420P10LE : AV_PIX_FMT_YUV420P;
    c->encoder->time_base = av_inv_q(fps);
    c->encoder->framerate = fps;
    c->encoder->gop_size = av_q2d(fps) * 2;
    // Tuned H.264 keeps the two B-frames it was measured with; a tuned
    // multi-threaded HEVC job lets the x265 preset choose. Everything else
    // (playback, synchronous x265) stays B-frame free.
    c->encoder->max_b_frames = c->mode == 4 && c->preset ? 2 :
        c->mode == 5 && c->preset && MAX_THREADS > 1 ? -1 : 0;
    c->encoder->thread_count = c->threads;
    c->encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if ((ret = configure_encoder(c)) < 0) return ret;
    if ((ret = avcodec_open2(c->encoder, enc, NULL)) < 0)
        return fail(ret, "open output encoder");
    }
    }

    if ((ret = avformat_alloc_output_context2(&c->output, NULL, "mp4", output)) < 0)
        return fail(ret, "create MP4 muxer");
    if (!c->output) return fail(AVERROR(ENOMEM), "create output");
    // Render mode muxes audio only: pictures leave through js_frame_out.
    if (c->mode != MODE_RENDER) {
    c->video_out = avformat_new_stream(c->output, NULL);
    if (!c->video_out) return fail(AVERROR(ENOMEM), "create video stream");
    ret = c->copy
        ? avcodec_parameters_copy(c->video_out->codecpar, c->video_in->codecpar)
        : avcodec_parameters_from_context(c->video_out->codecpar, c->encoder);
    if (ret < 0) return fail(ret, "copy video parameters");
    c->video_out->codecpar->codec_tag = 0;
    // Parameter sets live in hvcC (global header): hvc1 plays on Apple too.
    if (!c->copy && c->mode == 5) c->video_out->codecpar->codec_tag = MKTAG('h', 'v', 'c', '1');
    if (c->remux_vvc) {
        if ((ret = prepare_vvc_parameters(c->video_out->codecpar)) < 0)
            return fail(ret, "convert ByteVC2 parameter sets");
        // vvc1 requires every parameter set in vvcC; vvi1 allows in-band ones.
        c->video_out->codecpar->codec_tag = c->video_out->codecpar->extradata_size
            ? MKTAG('v', 'v', 'c', '1') : MKTAG('v', 'v', 'i', '1');
    }
    c->video_out->time_base = c->copy ? c->video_in->time_base : c->encoder->time_base;
    }
    for (unsigned i = 0; i < c->input->nb_streams; i++) {
        AVStream *track = c->input->streams[i];
        if (track->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
        // Streaming/render output feeds MSE: AAC only. Whole-file output
        // keeps any audio codec the MP4 muxer can store (like -map 0:a?).
        if (track->codecpar->codec_id != AV_CODEC_ID_AAC && (c->streaming ||
            avformat_query_codec(c->output->oformat, track->codecpar->codec_id,
                FF_COMPLIANCE_NORMAL) != 1)) continue;
        c->audio_in = track;
        c->audio_out = avformat_new_stream(c->output, NULL);
        if (!c->audio_out) return fail(AVERROR(ENOMEM), "create audio stream");
        if ((ret = avcodec_parameters_copy(c->audio_out->codecpar, track->codecpar)) < 0)
            return fail(ret, "copy audio parameters");
        c->audio_out->codecpar->codec_tag = 0;
        c->audio_out->time_base = track->time_base;
        break;
    }
    // The audio element clock drives the renderer; without AAC there is none.
    if (c->mode == MODE_RENDER && !c->audio_in)
        return fail(AVERROR_INVALIDDATA, "render mode requires an AAC track");
    if (c->streaming) {
        if (c->start_seconds > 0.5) {
            int64_t timestamp = av_rescale_q((int64_t)(c->start_seconds * AV_TIME_BASE),
                AV_TIME_BASE_Q, c->video_in->time_base);
            if ((ret = av_seek_frame(c->input, vi, timestamp, AVSEEK_FLAG_BACKWARD)) < 0)
                return fail(ret, "seek BVC2 keyframe");
            avcodec_flush_buffers(c->decoder);
        }
        uint8_t *buffer = av_malloc(AVIO_BUFFER);
        if (!buffer) return fail(AVERROR(ENOMEM), "output buffer");
        c->writer_io = avio_alloc_context(buffer, AVIO_BUFFER, 1,
            NULL, NULL, media_output_write, NULL);
        if (!c->writer_io) { av_free(buffer); return fail(AVERROR(ENOMEM), "output AVIO"); }
        c->writer_io->seekable = 0;
        c->output->pb = c->writer_io;
        c->output->flags |= AVFMT_FLAG_CUSTOM_IO;
        if (c->start_seconds > 0.5) c->output->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
    } else if (!(c->output->oformat->flags & AVFMT_NOFILE)) {
        if ((ret = avio_open(&c->output->pb, output, AVIO_FLAG_WRITE)) < 0)
            return fail(ret, "open output MP4");
    }
    AVDictionary *mux_options = NULL;
    if (c->mode == MODE_RENDER) {
        // frag_keyframe only splits video tracks; audio-only output is split
        // into half-second fragments so MSE stays just ahead of decoding.
        av_dict_set(&mux_options, "movflags", c->start_seconds > 0.5
            ? "+empty_moov+default_base_moof+delay_moov+frag_discont"
            : "+empty_moov+default_base_moof", 0);
        av_dict_set(&mux_options, "frag_duration", "500000", 0);
    } else
    av_dict_set(&mux_options, "movflags", c->streaming
        ? (c->start_seconds > 0.5
            ? "+frag_keyframe+empty_moov+default_base_moof+delay_moov+frag_discont"
            : "+frag_keyframe+empty_moov+default_base_moof") : "+faststart", 0);
    ret = avformat_write_header(c->output, &mux_options);
    av_dict_free(&mux_options);
    if (ret < 0) return fail(ret, "write MP4 header");

    c->decoded = av_frame_alloc();
    c->scaled = av_frame_alloc();
    c->packet = av_packet_alloc();
    c->encoded = av_packet_alloc();
    if (!c->decoded || !c->scaled || !c->packet || !c->encoded)
        return fail(AVERROR(ENOMEM), "allocate frames");
    if (!c->copy && c->mode != MODE_RENDER) {
    c->scaled->format = c->encoder->pix_fmt;
    c->scaled->width = c->encoder->width; c->scaled->height = c->encoder->height;
    if ((ret = av_frame_get_buffer(c->scaled, 32)) < 0)
        return fail(ret, "allocate output picture");
    }
    while ((ret = av_read_frame(c->input, c->packet)) >= 0) {
        if (c->packet->stream_index == vi && c->copy) {
            if (c->remux_vvc) {
                int code = packet_to_annexb(c->packet);
                if (code < 0) { av_packet_unref(c->packet); return fail(code, "convert ByteVC2 packet"); }
                c->decoded_frames++;
                double duration = c->video_in->duration > 0
                    ? c->video_in->duration * av_q2d(c->video_in->time_base) : 0;
                double seconds = c->packet->pts != AV_NOPTS_VALUE
                    ? (c->packet->pts - (c->video_in->start_time != AV_NOPTS_VALUE ? c->video_in->start_time : 0))
                      * av_q2d(c->video_in->time_base) : 0;
                double progress = duration > 0 ? FFMIN(0.99, FFMAX(0, seconds / duration)) : 0;
                if (progress >= c->last_progress + 0.005) {
                    c->last_progress = progress;
                    report_progress(progress);
                }
            }
            av_packet_rescale_ts(c->packet, c->video_in->time_base, c->video_out->time_base);
            c->packet->stream_index = c->video_out->index;
            keep_monotonic(c, c->packet, 0);
            int code = av_interleaved_write_frame(c->output, c->packet);
            av_packet_unref(c->packet);
            if (code < 0) return fail(code, "copy original video");
        } else if (c->packet->stream_index == vi) {
            int code = avcodec_send_packet(c->decoder, c->packet);
            av_packet_unref(c->packet);
            if (code < 0) return fail(code, "send BVC2 packet");
            if ((code = process_frames(c)) < 0) return code;
        } else if (c->audio_in && c->packet->stream_index == c->audio_in->index) {
            av_packet_rescale_ts(c->packet, c->audio_in->time_base, c->audio_out->time_base);
            c->packet->stream_index = c->audio_out->index;
            keep_monotonic(c, c->packet, 1);
            int code = av_interleaved_write_frame(c->output, c->packet);
            av_packet_unref(c->packet);
            if (code < 0) return fail(code, "write audio packet");
        } else av_packet_unref(c->packet);
    }
    if (ret != AVERROR_EOF) return fail(ret, "read MP4 packets");
    if (c->remux_vvc && !c->decoded_frames)
        return fail(AVERROR_INVALIDDATA, "no ByteVC2 video packets");
    if (!c->copy) {
    if ((ret = avcodec_send_packet(c->decoder, NULL)) < 0)
        return fail(ret, "flush BVC2 decoder");
    if ((ret = process_frames(c)) < 0) return ret;
    // A parser can accept a nominal BVC2 track yet decode no actual images.
    // Reject such files rather than returning an AAC-only / empty video MP4.
    if (!c->decoded_frames)
        return fail(AVERROR_INVALIDDATA, "no decoded ByteVC2 frames");
    if (c->mode != MODE_RENDER && (ret = encode_frame(c, NULL)) < 0) return ret;
    }
    if ((ret = av_write_trailer(c->output)) < 0) return fail(ret, "finalize MP4");
    avio_flush(c->output->pb);
    report_progress(1);
    return 0;
}

typedef struct Job {
    const char *input, *output, *key, *preset, *input_format;
    int mode, file_size, no_remux, quality, threads;
    double start_seconds;
} Job;

static int convert(const Job *job, int *remuxed) {
    Context c = {0};
    c.mode = job->mode; c.streaming = job->file_size > 0; c.no_remux = job->no_remux;
    c.preset = job->preset; c.quality = job->quality; c.input_format = job->input_format;
    c.threads = clamp_threads(job->threads);
    c.reader.size = job->file_size; c.start_seconds = job->start_seconds;
    c.last_dts[0] = c.last_dts[1] = AV_NOPTS_VALUE;
    last_error[0] = 0;
    int ret = execute(&c, job->input, job->output, job->key);
    if (remuxed) *remuxed = c.remux_vvc ? (ret >= 0 ? 1 : -1) : 0;
    sws_freeContext(c.scale); sws_freeContext(c.render_scale);
    av_frame_free(&c.converted); av_freep(&c.packed);
    av_packet_free(&c.packet); av_packet_free(&c.encoded);
    av_frame_free(&c.decoded); av_frame_free(&c.scaled);
    avcodec_free_context(&c.decoder); avcodec_free_context(&c.encoder);
    avformat_close_input(&c.input);
    if (c.output) {
        if (!c.streaming && c.output->pb && !(c.output->oformat->flags & AVFMT_NOFILE))
            avio_closep(&c.output->pb);
        avformat_free_context(c.output);
    }
    if (c.reader_io) { av_freep(&c.reader_io->buffer); avio_context_free(&c.reader_io); }
    if (c.writer_io) { av_freep(&c.writer_io->buffer); avio_context_free(&c.writer_io); }
    return ret;
}

// Whole-file conversion. VVC from a ByteVC2 source is first tried as a
// lossless re-mux (bvc2 NAL units are H.266); standard tools that cannot
// describe the parameter sets fall back to re-encoding.
static int convert_file(Job job) {
    int remuxed = 0;
    last_remuxed = 0;
    int ret = convert(&job, &remuxed);
    if (remuxed > 0) last_remuxed = 1;
    else if (remuxed < 0) {
        remove(job.output);
        job.no_remux = 1;
        ret = convert(&job, NULL);
    }
    return ret;
}

static int name_in(const char *name, const char *const *list) {
    for (; name && *list; list++) if (!strcmp(name, *list)) return 1;
    return 0;
}

static int valid_settings(int mode, const char *preset, int quality) {
    static const char *const x26x[] = { "ultrafast", "superfast", "veryfast", "faster",
        "fast", "medium", "slow", "slower", "veryslow", NULL };
    static const char *const svt[] = { "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
        "10", "11", "12", "13", NULL };
    static const char *const vvenc[] = { "faster", "fast", "medium", "slow", "slower", NULL };
    switch (mode) {
    case 4: case 5: return name_in(preset, x26x) && quality >= 0 && quality <= 51;
    case 2: return name_in(preset, svt) && quality >= 1 && quality <= 63;
    case 3: return name_in(preset, vvenc) && quality >= 0 && quality <= 63;
    default: return 0;
    }
}

// mode: 0 copy, 2 AV1 (SVT-AV1), 3 VVC (VVenC), 4 H.264 (x264), 5 HEVC
// (x265). An empty preset keeps each encoder's fast defaults; otherwise
// preset/quality are the encoder's own preset name and CRF (VVenC: QP).
EMSCRIPTEN_KEEPALIVE int media_convert(const char *in, const char *out, const char *key,
    int mode, const char *preset, int quality, int threads) {
    if (mode != 0 && mode != 2 && mode != 3 && mode != 4 && mode != 5)
        return fail(AVERROR(EINVAL), "invalid output mode");
    if (preset && !preset[0]) preset = NULL;
    if (preset && !valid_settings(mode, preset, quality))
        return fail(AVERROR(EINVAL), "invalid encoder preset or quality");
    return convert_file((Job){ .input = in, .output = out, .key = key, .mode = mode,
        .preset = preset, .quality = quality, .threads = threads });
}
// Lossless concatenation of compatible MP4s listed in an ffconcat file
// (relative names only: the demuxer runs with safe=1).
EMSCRIPTEN_KEEPALIVE int media_concat(const char *list, const char *out) {
    last_remuxed = 0;
    return convert(&(Job){ .input = list, .output = out, .mode = 0,
        .input_format = "concat", .threads = 1 }, NULL);
}

EMSCRIPTEN_KEEPALIVE int bvc2_transcode(const char *in, const char *out, const char *key) {
    return convert(&(Job){ .input = in, .output = out, .key = key, .mode = 1,
        .threads = stream_threads }, NULL);
}
EMSCRIPTEN_KEEPALIVE int bvc2_convert(const char *in, const char *out, const char *key, int mode) {
    return media_convert(in, out, key, mode, NULL, 0, stream_threads);
}
EMSCRIPTEN_KEEPALIVE int bvc2_convert_h264(const char *in, const char *out,
    const char *key, const char *preset, int crf) {
    return media_convert(in, out, key, 4, preset, crf, stream_threads);
}
EMSCRIPTEN_KEEPALIVE int bvc2_stream(int size, const char *key, double start) {
    if (size < 8 || size > 260 * 1024 * 1024 || !(start >= 0 && start <= 86400))
        return fail(AVERROR(EINVAL), "invalid stream input");
    return convert(&(Job){ .key = key, .mode = 4, .file_size = size, .start_seconds = start,
        .threads = stream_threads }, NULL);
}
// Decode only: AAC fMP4 through writeChunk, I420 pictures through writeFrame.
EMSCRIPTEN_KEEPALIVE int bvc2_play(int size, const char *key, double start) {
    if (size < 8 || size > 260 * 1024 * 1024 || !(start >= 0 && start <= 86400))
        return fail(AVERROR(EINVAL), "invalid stream input");
    return convert(&(Job){ .key = key, .mode = MODE_RENDER, .file_size = size,
        .start_seconds = start, .threads = stream_threads }, NULL);
}
