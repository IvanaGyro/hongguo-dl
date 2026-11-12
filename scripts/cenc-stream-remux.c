// SPDX-License-Identifier: GPL-3.0-only
// Incremental CENC progressive MP4 -> clear fragmented MP4, preserving
// compressed H.264/HEVC/AAC packets. No video decoder or encoder is linked.
// All HTTP reads and MSE output are async Worker callbacks via Asyncify.
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>
#include <emscripten/emscripten.h>

#define INPUT_LIMIT (260 * 1024 * 1024)
#define AVIO_BUFFER 32768

static char last_error[256];

EMSCRIPTEN_KEEPALIVE const char *cenc_remux_error(void) { return last_error; }
EMSCRIPTEN_KEEPALIVE int cenc_remux_available(void) {
    return av_find_input_format("mov") != NULL &&
        av_guess_format("mp4", NULL, NULL) != NULL;
}

static int failure(int code, const char *stage) {
    char reason[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(code, reason, sizeof(reason));
    snprintf(last_error, sizeof(last_error), "%s: %s", stage, reason);
    return code < 0 ? code : AVERROR(EINVAL);
}

EM_ASYNC_JS(int, js_range_read, (int offset, int wanted, uint8_t *dest), {
    try {
        const data = await Module['readRange'](offset, wanted);
        if (!(data instanceof Uint8Array) || data.byteLength > wanted)
            return -5;
        if (!data.byteLength) return 0;
        HEAPU8.set(data, dest);
        return data.byteLength;
    } catch (error) {
        // Worker owns the actual error; never log signed URL or CENC key.
        Module['bridgeError'] = error?.name || 'ReadError';
        return -5;
    }
});

EM_ASYNC_JS(int, js_output_write, (const uint8_t *src, int length), {
    try {
        const data = HEAPU8.slice(src, src + length);
        await Module['writeChunk'](data);
        return length;
    } catch (error) {
        Module['bridgeError'] = error?.name || 'WriteError';
        return -5;
    }
});

typedef struct Stream {
    int64_t size;
    int64_t position;
} Stream;

static int input_read(void *opaque, uint8_t *buf, int capacity) {
    Stream *stream = opaque;
    if (stream->position >= stream->size) return AVERROR_EOF;
    int length = (int)FFMIN((int64_t)capacity, stream->size - stream->position);
    int count = js_range_read((int)stream->position, length, buf);
    if (count <= 0) return count < 0 ? AVERROR(EIO) : AVERROR_EOF;
    stream->position += count;
    return count;
}

static int64_t input_seek(void *opaque, int64_t offset, int whence) {
    Stream *stream = opaque;
    if (whence == AVSEEK_SIZE) return stream->size;
    int64_t next;
    switch (whence & ~AVSEEK_FORCE) {
    case SEEK_SET: next = offset; break;
    case SEEK_CUR: next = stream->position + offset; break;
    case SEEK_END: next = stream->size + offset; break;
    default: return AVERROR(EINVAL);
    }
    if (next < 0 || next > stream->size) return AVERROR(EINVAL);
    stream->position = next;
    return next;
}

static int output_write(void *opaque, const uint8_t *data, int length) {
    (void)opaque;
    if (length <= 0) return 0;
    return js_output_write(data, length);
}

static int execute(Stream *reader, const char *key, double start_seconds) {
    int ret, video_tracks = 0, video_input_index = -1;
    AVFormatContext *input = NULL, *output = NULL;
    AVIOContext *reader_io = NULL, *writer_io = NULL;
    AVPacket *packet = NULL;
    uint8_t *input_buffer = NULL, *output_buffer = NULL;
    AVDictionary *options = NULL, *mov_options = NULL;
    int *index_map = NULL;

    input_buffer = av_malloc(AVIO_BUFFER);
    if (!input_buffer) { ret = failure(AVERROR(ENOMEM), "input AVIO buffer"); goto done; }
    reader_io = avio_alloc_context(input_buffer, AVIO_BUFFER, 0,
        reader, input_read, NULL, input_seek);
    if (!reader_io) { ret = failure(AVERROR(ENOMEM), "input AVIO context"); goto done; }
    input_buffer = NULL; // now owned by reader_io
    input = avformat_alloc_context();
    if (!input) { ret = failure(AVERROR(ENOMEM), "input context"); goto done; }
    input->pb = reader_io;
    input->flags |= AVFMT_FLAG_CUSTOM_IO;
    if (key && *key) av_dict_set(&options, "decryption_key", key, 0);
    ret = avformat_open_input(&input, NULL, av_find_input_format("mov"), &options);
    if (ret < 0) { ret = failure(ret, "open encrypted MP4"); goto done; }
    // MOV stsd/moov parsing supplies video/audio codec parameters without
    // decoding encrypted video frames or probing the entire media stream.
    ret = avformat_alloc_output_context2(&output, NULL, "mp4", NULL);
    if (ret < 0 || !output) { ret = failure(ret < 0 ? ret : AVERROR(ENOMEM),
        "create fragmented MP4 muxer"); goto done; }
    index_map = av_malloc_array(input->nb_streams, sizeof(int));
    if (!index_map) { ret = failure(AVERROR(ENOMEM), "stream index map"); goto done; }
    for (unsigned i = 0; i < input->nb_streams; ++i) {
        const AVStream *src = input->streams[i];
        enum AVMediaType type = src->codecpar->codec_type;
        index_map[i] = -1;
        if (type == AVMEDIA_TYPE_VIDEO &&
            (src->codecpar->codec_id == AV_CODEC_ID_HEVC ||
             src->codecpar->codec_id == AV_CODEC_ID_H264) && !video_tracks) {
            video_tracks++;
            video_input_index = (int)i;
        } else if (type != AVMEDIA_TYPE_AUDIO ||
            src->codecpar->codec_id != AV_CODEC_ID_AAC) continue;
        AVStream *dst = avformat_new_stream(output, NULL);
        if (!dst) { ret = failure(AVERROR(ENOMEM), "allocate output stream"); goto done; }
        if ((ret = avcodec_parameters_copy(dst->codecpar, src->codecpar)) < 0) {
            ret = failure(ret, "copy compressed codec parameters"); goto done;
        }
        dst->codecpar->codec_tag = 0; // no 'encv' / 'enca' sample entry in clear output
        dst->time_base = src->time_base;
        index_map[i] = dst->index;
    }
    if (!video_tracks) { ret = failure(AVERROR_STREAM_NOT_FOUND,
        "no supported H.264/HEVC stream"); goto done; }

    // Seek the demuxer's indexed MP4 samples to the preceding random access
    // point. HTTP AVIO then requests the corresponding byte offsets, rather
    // than sequentially downloading all frames between 0 and start_seconds.
    // Preserve the original stream time base for MSE's global timeline.
    if (start_seconds > 0.5) {
        const AVStream *video = input->streams[video_input_index];
        const int64_t seek_us = (int64_t)(start_seconds * AV_TIME_BASE);
        const int64_t timestamp = av_rescale_q(seek_us, AV_TIME_BASE_Q,
            video->time_base);
        ret = av_seek_frame(input, video_input_index, timestamp,
            AVSEEK_FLAG_BACKWARD);
        if (ret < 0) {
            ret = failure(ret, "seek indexed video RAP");
            goto done;
        }
    }

    output_buffer = av_malloc(AVIO_BUFFER);
    if (!output_buffer) { ret = failure(AVERROR(ENOMEM), "output AVIO buffer"); goto done; }
    writer_io = avio_alloc_context(output_buffer, AVIO_BUFFER, 1,
        NULL, NULL, output_write, NULL);
    if (!writer_io) { ret = failure(AVERROR(ENOMEM), "output AVIO context"); goto done; }
    output_buffer = NULL;
    writer_io->seekable = 0;
    output->pb = writer_io;
    output->flags |= AVFMT_FLAG_CUSTOM_IO;
    // Preserve the baseline zero-start muxer's automatic timestamp shift.
    // A nonzero indexed RAP must retain its source time instead.
    if (start_seconds > 0.5)
        output->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
    // For a nonzero seek, delay moov until the first RAP packet reveals
    // its DTS, and mark the missing earlier fragments as a discontinuity.
    // Otherwise MOV muxer silently normalizes the output near t=0.
    av_dict_set(&mov_options, "movflags", start_seconds > 0.5
        ? "+frag_keyframe+empty_moov+default_base_moof+delay_moov+frag_discont"
        : "+frag_keyframe+empty_moov+default_base_moof", 0);
    if ((ret = avformat_write_header(output, &mov_options)) < 0) {
        ret = failure(ret, "write init fMP4"); goto done;
    }
    avio_flush(output->pb);
    packet = av_packet_alloc();
    if (!packet) { ret = failure(AVERROR(ENOMEM), "allocate packet"); goto done; }
    while ((ret = av_read_frame(input, packet)) >= 0) {
        int src_index = packet->stream_index;
        int dst_index = src_index < (int)input->nb_streams ? index_map[src_index] : -1;
        if (dst_index >= 0) {
            AVStream *src = input->streams[src_index];
            AVStream *dst = output->streams[dst_index];
            av_packet_rescale_ts(packet, src->time_base, dst->time_base);
            packet->stream_index = dst_index;
            packet->pos = -1;
            int write = av_interleaved_write_frame(output, packet);
            if (write < 0) { ret = failure(write, "write encrypted-source packet"); goto done; }
        } else av_packet_unref(packet);
    }
    if (ret != AVERROR_EOF) { ret = failure(ret, "read source packet"); goto done; }
    if ((ret = av_write_trailer(output)) < 0) {
        ret = failure(ret, "write final fragment"); goto done;
    }
    avio_flush(output->pb);
    ret = 0;
done:
    av_packet_free(&packet);
    av_dict_free(&options); av_dict_free(&mov_options);
    av_free(index_map);
    if (output) avformat_free_context(output);
    if (input) avformat_close_input(&input);
    if (reader_io) {
        av_freep(&reader_io->buffer);
        avio_context_free(&reader_io);
    }
    if (writer_io) {
        av_freep(&writer_io->buffer);
        avio_context_free(&writer_io);
    }
    av_free(input_buffer); av_free(output_buffer);
    return ret;
}

// The original two-argument entry point remains available to older test
// fixtures, while the explicit time variant supports unbuffered seeks.
EMSCRIPTEN_KEEPALIVE int cenc_stream_remux_at(int file_size,
                                              const char *key,
                                              double start_seconds) {
    last_error[0] = '\0';
    if (file_size <= 0 || file_size > INPUT_LIMIT)
        return failure(AVERROR(EINVAL), "invalid input size");
    if (!(start_seconds >= 0.0 && start_seconds <= 24.0 * 3600.0))
        return failure(AVERROR(EINVAL), "invalid seek time");
    if (!key || strlen(key) != 32 || strspn(key, "0123456789abcdefABCDEF") != 32)
        return failure(AVERROR(EINVAL), "invalid 128-bit CENC key");
    Stream reader = { .size = file_size, .position = 0 };
    return execute(&reader, key, start_seconds);
}

EMSCRIPTEN_KEEPALIVE int cenc_stream_remux(int file_size, const char *key) {
    return cenc_stream_remux_at(file_size, key, 0.0);
}
