import CZlib
import Foundation

public enum CompanionGzip {
    public static func compress(_ data: Data) throws -> Data? {
        // Keep a non-null base address for the valid zero-length input case.
        let input = data.isEmpty ? Data([0]) : data
        let source = input.withUnsafeBytes { UnsafeRawPointer($0.baseAddress!) }
        let capacity = max(64, data.count + data.count / 1000 + 32)
        var output = Data(count: capacity)
        var outputLength: size_t = 0
        let status = output.withUnsafeMutableBytes { buffer in
            vision_companion_gzip_compress(source, data.count, buffer.baseAddress!, capacity, &outputLength)
        }
        guard status == Z_STREAM_END, outputLength <= capacity else {
            if status == Z_BUF_ERROR { return nil }
            throw CompanionProtocolError("Companion gzip compression failed.")
        }
        output.removeSubrange(outputLength..<output.count)
        return output
    }

    public static func decompress(_ data: Data, limit: Int) throws -> Data {
        precondition(limit > 0)
        let input = data.isEmpty ? Data([0]) : data
        let source = input.withUnsafeBytes { UnsafeRawPointer($0.baseAddress!) }
        var output = Data(count: limit)
        var outputLength: size_t = 0
        let status = output.withUnsafeMutableBytes { buffer in
            vision_companion_gzip_decompress(source, data.count, buffer.baseAddress!, limit, &outputLength)
        }
        guard status == Z_STREAM_END, outputLength <= limit else {
            if status == Z_BUF_ERROR || outputLength > limit {
                throw CompanionProtocolError("Decompressed companion payload exceeds its limit.")
            }
            throw CompanionProtocolError("Invalid companion gzip payload.")
        }
        output.removeSubrange(outputLength..<output.count)
        return output
    }
}
