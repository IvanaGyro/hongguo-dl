// SPDX-License-Identifier: GPL-3.0-only
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

