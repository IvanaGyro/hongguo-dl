// SPDX-License-Identifier: GPL-3.0-only
// Asynchronous Worker I/O shared by every streaming entry point. The JS side
// (Module.readRange / writeChunk) is awaited through Asyncify; it always runs
// on the thread that called the entry point, never on encoder threads.
#ifndef MEDIA_CORE_AVIO_H
#define MEDIA_CORE_AVIO_H
#include <stdint.h>

typedef struct Stream {
    int64_t size;
    int64_t position;
} Stream;

int media_input_read(void *opaque, uint8_t *buf, int capacity);
int64_t media_input_seek(void *opaque, int64_t offset, int whence);
int media_output_write(void *opaque, const uint8_t *data, int length);
#endif
