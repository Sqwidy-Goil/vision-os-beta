#ifndef VISION_COMPANION_ZLIB_SHIM_H
#define VISION_COMPANION_ZLIB_SHIM_H

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

/* zlib's allocator callbacks. These wrappers keep pointer lifetimes inside C. */
static void *vision_companion_zalloc(voidpf opaque, uInt items, uInt size) {
    (void)opaque;
    if (size != 0 && items > SIZE_MAX / size) {
        return NULL;
    }
    return calloc((size_t)items, (size_t)size);
}

static void vision_companion_zfree(voidpf opaque, voidpf address) {
    (void)opaque;
    free(address);
}

/*
 * RFC 1952 gzip. Returns Z_STREAM_END on success, Z_BUF_ERROR when the output
 * limit is exhausted, or another negative zlib status on malformed input.
 */
static inline int vision_companion_gzip_decompress(
    const void *input,
    size_t input_length,
    void *output,
    size_t output_capacity,
    size_t *output_length
) {
    if (input_length > UINT_MAX || output_capacity > UINT_MAX || output_capacity == 0) {
        return Z_ERRNO;
    }

    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    stream.zalloc = vision_companion_zalloc;
    stream.zfree = vision_companion_zfree;
    stream.next_in = (Bytef *)(uintptr_t)input;
    stream.avail_in = (uInt)input_length;
    stream.next_out = (Bytef *)output;
    stream.avail_out = (uInt)output_capacity;

    int status = inflateInit2(&stream, 15 + 16);
    if (status != Z_OK) {
        return status;
    }

    status = inflate(&stream, Z_FINISH);
    size_t produced = (size_t)stream.total_out;
    inflateEnd(&stream);
    *output_length = produced;
    return status;
}

static inline int vision_companion_gzip_compress(
    const void *input,
    size_t input_length,
    void *output,
    size_t output_capacity,
    size_t *output_length
) {
    if (input_length > UINT_MAX || output_capacity > UINT_MAX || output_capacity == 0) {
        return Z_ERRNO;
    }

    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    stream.zalloc = vision_companion_zalloc;
    stream.zfree = vision_companion_zfree;
    stream.next_in = (Bytef *)(uintptr_t)input;
    stream.avail_in = (uInt)input_length;
    stream.next_out = (Bytef *)output;
    stream.avail_out = (uInt)output_capacity;

    int status = deflateInit2(
        &stream,
        Z_DEFAULT_COMPRESSION,
        Z_DEFLATED,
        15 + 16,
        8,
        Z_DEFAULT_STRATEGY
    );
    if (status != Z_OK) {
        return status;
    }

    status = deflate(&stream, Z_FINISH);
    size_t produced = (size_t)stream.total_out;
    deflateEnd(&stream);
    *output_length = produced;
    return status;
}

#endif
