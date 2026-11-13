// SPDX-License-Identifier: GPL-3.0-only
// Experimental single-threaded ByteVC2 -> H.264/AAC MP4 transcoder.
// This is invoked from Emscripten MEMFS, not from the FFmpeg CLI.
// Keep this separate from the production player until a real BVC2 fixture passes.
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
#define AVIO_BUFFER 32768
#include "bvc2-avio.h"

EM_JS(void, report_progress, (double value), {
    if (Module["onProgress"]) Module["onProgress"](value);
});


static char last_error[256];

static int fail(int code, const char *where) {
    char reason[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(code, reason, sizeof(reason));
    snprintf(last_error, sizeof(last_error), "%s: %s", where, reason);
    return code < 0 ? code : AVERROR(EINVAL);
}

EMSCRIPTEN_KEEPALIVE const char *bvc2_last_error(void) { return last_error; }

EMSCRIPTEN_KEEPALIVE int bvc2_decoder_available(void) {
    const AVCodec *decoder = avcodec_find_decoder_by_name("bvc2");
    const AVCodec *encoder = avcodec_find_encoder_by_name("libx264");
    return decoder && decoder->id == AV_CODEC_ID_BVC2 && encoder != NULL;
}

typedef struct Context {
    AVFormatContext *input, *output;
    AVCodecContext *decoder, *encoder;
    AVStream *video_in, *video_out, *audio_in, *audio_out;
    AVFrame *decoded, *scaled;
    AVPacket *packet, *encoded;
    struct SwsContext *scale;
    AVIOContext *reader_io, *writer_io;
    Stream reader;
    int mode, streaming;
    double start_seconds, last_progress;
    int64_t next_pts;
    int64_t decoded_frames;
} Context;

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

static int process_frames(Context *c) {
    int ret;
    while ((ret = avcodec_receive_frame(c->decoder, c->decoded)) >= 0) {
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
            &c->reader, input_read, NULL, input_seek);
        if (!c->reader_io) { av_free(buffer); return fail(AVERROR(ENOMEM), "input AVIO"); }
        c->input = avformat_alloc_context();
        if (!c->input) return fail(AVERROR(ENOMEM), "input context");
        c->input->pb = c->reader_io;
        c->input->flags |= AVFMT_FLAG_CUSTOM_IO;
    }
    ret = avformat_open_input(&c->input, input, av_find_input_format("mov"), &open_options);
    av_dict_free(&open_options);
    if (ret < 0) return fail(ret, "open MP4");

    int vi = av_find_best_stream(c->input, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (vi < 0) return fail(vi, "find video");
    c->video_in = c->input->streams[vi];
    if (c->mode == 1 && c->video_in->codecpar->codec_id != AV_CODEC_ID_BVC2)
        return fail(AVERROR_INVALIDDATA, "input is not ByteVC2");
    if (c->mode != 0) {
    const AVCodec *dec = avcodec_find_decoder(c->video_in->codecpar->codec_id);
    const AVCodec *enc = avcodec_find_encoder_by_name(
        c->mode == 5 ? "libx265" : c->mode == 2 ? "libaom-av1" : c->mode == 3 ? "libvvenc" : "libx264");
    if (!dec || !enc) return fail(AVERROR_DECODER_NOT_FOUND, "missing BVC2/x264 codec");
    c->decoder = avcodec_alloc_context3(dec);
    c->encoder = avcodec_alloc_context3(enc);
    if (!c->decoder || !c->encoder) return fail(AVERROR(ENOMEM), "allocate codecs");
    if ((ret = avcodec_parameters_to_context(c->decoder, c->video_in->codecpar)) < 0)
        return fail(ret, "read codec parameters");
    c->decoder->thread_count = 1;
    c->decoder->pkt_timebase = c->video_in->time_base;
    if ((ret = avcodec_open2(c->decoder, dec, NULL)) < 0)
        return fail(ret, "open BVC2 decoder");

    int width = c->decoder->width, height = c->decoder->height;
    if (width < 16 || height < 16 || width > 4096 || height > 4096)
        return fail(AVERROR(EINVAL), "invalid video dimensions");
    AVRational fps = av_guess_frame_rate(c->input, c->video_in, NULL);
    if (fps.num <= 0 || fps.den <= 0 || av_q2d(fps) < 1 || av_q2d(fps) > 120)
        fps = (AVRational){25, 1};
    c->encoder->width = width; c->encoder->height = height;
    c->encoder->pix_fmt = c->mode == 3 ? AV_PIX_FMT_YUV420P10LE : AV_PIX_FMT_YUV420P;
    c->encoder->time_base = av_inv_q(fps);
    c->encoder->framerate = fps;
    c->encoder->gop_size = av_q2d(fps) * 2;
    c->encoder->max_b_frames = 0;
    c->encoder->thread_count = 1;
    c->encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if (c->mode == 5) {
        av_opt_set(c->encoder->priv_data, "preset", "ultrafast", 0);
        av_opt_set(c->encoder->priv_data, "crf", "23", 0);
        av_opt_set(c->encoder->priv_data, "x265-params",
            "pools=none:frame-threads=1:wpp=0:bframes=0:rc-lookahead=0:cutree=0", 0);
    } else if (c->mode == 2) {
        av_opt_set(c->encoder->priv_data, "cpu-used", "8", 0);
        av_opt_set(c->encoder->priv_data, "crf", "32", 0);
        av_opt_set(c->encoder->priv_data, "lag-in-frames", "0", 0);
    } else if (c->mode == 3) {
        av_opt_set(c->encoder->priv_data, "preset", "faster", 0);
        av_opt_set(c->encoder->priv_data, "qp", "32", 0);
        av_opt_set(c->encoder->priv_data, "vvenc-params", "Threads=0", 0);
    } else {
        av_opt_set(c->encoder->priv_data, "preset", "ultrafast", 0);
        av_opt_set(c->encoder->priv_data, "tune", "zerolatency", 0);
        av_opt_set(c->encoder->priv_data, "profile", "baseline", 0);
        av_opt_set(c->encoder->priv_data, "level", "3.1", 0);
        av_opt_set(c->encoder->priv_data, "crf", "20", 0);
    }
    if ((ret = avcodec_open2(c->encoder, enc, NULL)) < 0)
        return fail(ret, "open output encoder");
    }

    if ((ret = avformat_alloc_output_context2(&c->output, NULL, "mp4", output)) < 0)
        return fail(ret, "create MP4 muxer");
    if (!c->output) return fail(AVERROR(ENOMEM), "create output");
    c->video_out = avformat_new_stream(c->output, NULL);
    if (!c->video_out) return fail(AVERROR(ENOMEM), "create video stream");
    ret = c->mode == 0
        ? avcodec_parameters_copy(c->video_out->codecpar, c->video_in->codecpar)
        : avcodec_parameters_from_context(c->video_out->codecpar, c->encoder);
    if (ret < 0) return fail(ret, "copy video parameters");
    c->video_out->codecpar->codec_tag = 0;
    c->video_out->time_base = c->mode == 0 ? c->video_in->time_base : c->encoder->time_base;
    for (unsigned i = 0; i < c->input->nb_streams; i++) {
        AVStream *track = c->input->streams[i];
        if (track->codecpar->codec_type != AVMEDIA_TYPE_AUDIO ||
            track->codecpar->codec_id != AV_CODEC_ID_AAC) continue;
        c->audio_in = track;
        c->audio_out = avformat_new_stream(c->output, NULL);
        if (!c->audio_out) return fail(AVERROR(ENOMEM), "create audio stream");
        if ((ret = avcodec_parameters_copy(c->audio_out->codecpar, track->codecpar)) < 0)
            return fail(ret, "copy AAC parameters");
        c->audio_out->codecpar->codec_tag = 0;
        c->audio_out->time_base = track->time_base;
        break;
    }
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
            NULL, NULL, output_write, NULL);
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
    if (c->mode != 0) {
    c->scaled->format = c->encoder->pix_fmt;
    c->scaled->width = c->encoder->width; c->scaled->height = c->encoder->height;
    if ((ret = av_frame_get_buffer(c->scaled, 32)) < 0)
        return fail(ret, "allocate output picture");
    }
    while ((ret = av_read_frame(c->input, c->packet)) >= 0) {
        if (c->packet->stream_index == vi && c->mode == 0) {
            av_packet_rescale_ts(c->packet, c->video_in->time_base, c->video_out->time_base);
            c->packet->stream_index = c->video_out->index;
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
            int code = av_interleaved_write_frame(c->output, c->packet);
            av_packet_unref(c->packet);
            if (code < 0) return fail(code, "write audio packet");
        } else av_packet_unref(c->packet);
    }
    if (ret != AVERROR_EOF) return fail(ret, "read MP4 packets");
    if (c->mode != 0) {
    if ((ret = avcodec_send_packet(c->decoder, NULL)) < 0)
        return fail(ret, "flush BVC2 decoder");
    if ((ret = process_frames(c)) < 0) return ret;
    // A parser can accept a nominal BVC2 track yet decode no actual images.
    // Reject such files rather than returning an AAC-only / empty video MP4.
    if (!c->decoded_frames)
        return fail(AVERROR_INVALIDDATA, "no decoded ByteVC2 frames");
    if ((ret = encode_frame(c, NULL)) < 0) return ret;
    }
    if ((ret = av_write_trailer(c->output)) < 0) return fail(ret, "finalize MP4");
    avio_flush(c->output->pb);
    report_progress(1);
    return 0;
}

static int convert(const char *input, const char *output, const char *key, int mode, int file_size, double start_seconds) {
    Context c = {0};
    c.mode = mode; c.streaming = file_size > 0;
    c.reader.size = file_size; c.start_seconds = start_seconds;
    last_error[0] = 0;
    int ret = execute(&c, input, output, key);
    sws_freeContext(c.scale);
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

EMSCRIPTEN_KEEPALIVE int bvc2_transcode(const char *in, const char *out, const char *key) {
    return convert(in, out, key, 1, 0, 0);
}
EMSCRIPTEN_KEEPALIVE int bvc2_convert(const char *in, const char *out, const char *key, int mode) {
    if (mode != 0 && mode != 2 && mode != 3 && mode != 4 && mode != 5)
        return fail(AVERROR(EINVAL), "invalid output mode");
    return convert(in, out, key, mode, 0, 0);
}
EMSCRIPTEN_KEEPALIVE int bvc2_stream(int size, const char *key, double start) {
    if (size < 8 || size > 260 * 1024 * 1024 || !(start >= 0 && start <= 86400))
        return fail(AVERROR(EINVAL), "invalid stream input");
    return convert(NULL, NULL, key, 4, size, start);
}
