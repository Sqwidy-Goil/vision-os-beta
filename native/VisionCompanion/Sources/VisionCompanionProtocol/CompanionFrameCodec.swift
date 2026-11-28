import CoreFoundation
import CryptoKit
import Foundation

public enum CompanionMessageType: String {
    case offer
    case join
    case ready
    case readyAck = "ready-ack"
    case calibration
    case sample
    case close
    case error
}

public enum CompanionPayloadEncoding: String {
    case identity
    case gzip
}

public enum CompanionDepthEncoding: String {
    case none
    case float32le = "float32le"
    case base64
}

public struct CompanionFrameHeader: Codable, Equatable {
    public var v: Int
    public var sid: String
    public var seq: UInt64
    public var sentAt: Double
    public var type: CompanionMessageType
    public var payloadEncoding: CompanionPayloadEncoding
    public var depthEncoding: CompanionDepthEncoding
    public var payloadBytes: Int
    public var depthBytes: Int
    public var mac: String?

    public init(
        v: Int,
        sid: String,
        seq: UInt64,
        sentAt: Double,
        type: CompanionMessageType,
        payloadEncoding: CompanionPayloadEncoding,
        depthEncoding: CompanionDepthEncoding,
        payloadBytes: Int,
        depthBytes: Int,
        mac: String? = nil
    ) {
        self.v = v
        self.sid = sid
        self.seq = seq
        self.sentAt = sentAt
        self.type = type
        self.payloadEncoding = payloadEncoding
        self.depthEncoding = depthEncoding
        self.payloadBytes = payloadBytes
        self.depthBytes = depthBytes
        self.mac = mac
    }
}

public struct DecodedCompanionFrame {
    public let header: CompanionFrameHeader
    public let payload: [String: Any]
    public let depthChunk: Data
}

public enum CompanionFrameCodec {
    public struct DecodeOptions {
        public var key: SessionKey?
        public var expectedSID: String?
        public var expectedSequence: UInt64?
        public var now: Double?
        public var maxClockSkewMs: Double
        public var maxFrameBytes: Int
        public var allowAuthenticatedPairingJoin: Bool

        public init(
            key: SessionKey? = nil,
            expectedSID: String? = nil,
            expectedSequence: UInt64? = nil,
            now: Double? = nil,
            maxClockSkewMs: Double = CompanionProtocol.maxClockSkewMs,
            maxFrameBytes: Int = CompanionProtocol.defaultMaxFrameBytes,
            allowAuthenticatedPairingJoin: Bool = false
        ) {
            self.key = key
            self.expectedSID = expectedSID
            self.expectedSequence = expectedSequence
            self.now = now
            self.maxClockSkewMs = maxClockSkewMs
            self.maxFrameBytes = maxFrameBytes
            self.allowAuthenticatedPairingJoin = allowAuthenticatedPairingJoin
        }
    }

    public struct EncodeOptions {
        public var key: SessionKey?
        public var depthEncoding: CompanionDepthEncoding
        public var compression: Bool
        public var maxFrameBytes: Int

        public init(
            key: SessionKey? = nil,
            depthEncoding: CompanionDepthEncoding = .float32le,
            compression: Bool = false,
            maxFrameBytes: Int = CompanionProtocol.defaultMaxFrameBytes
        ) {
            self.key = key
            self.depthEncoding = depthEncoding
            self.compression = compression
            self.maxFrameBytes = maxFrameBytes
        }
    }

    public static func encode(
        sid: String,
        sequence: UInt64,
        sentAt: Double,
        type: CompanionMessageType,
        payload: [String: Any],
        options: EncodeOptions = EncodeOptions()
    ) throws -> Data {
        guard sequence <= 9_007_199_254_740_991,
              sentAt.isFinite, sentAt >= 0,
              sid.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil,
              options.maxFrameBytes >= 1024,
              options.maxFrameBytes <= CompanionProtocol.absoluteMaxFrameBytes else {
            throw CompanionProtocolError("Invalid frame sequence, timestamp, session identifier, or frame limit.")
        }

        let depth = try splitDepth(payload, encoding: options.depthEncoding)
        var body = try CompanionBinary.jsonData(depth.payload)
        guard body.count <= CompanionProtocol.maxJSONBytes else {
            throw CompanionProtocolError("Companion JSON payload exceeds its limit.")
        }
        var payloadEncoding: CompanionPayloadEncoding = .identity
        if options.compression, let compressed = try CompanionGzip.compress(body), compressed.count < body.count {
            body = compressed
            payloadEncoding = .gzip
        }

        var header = CompanionFrameHeader(
            v: CompanionProtocol.version,
            sid: sid,
            seq: sequence,
            sentAt: sentAt,
            type: type,
            payloadEncoding: payloadEncoding,
            depthEncoding: depth.encoding,
            payloadBytes: body.count,
            depthBytes: depth.chunk.count
        )
        if let key = options.key {
            let metadata = try authenticationBytes(header: header, body: body, depth: depth.chunk)
            let mac = HMAC<SHA256>.authenticationCode(for: metadata, using: key.symmetricKey)
            header.mac = CompanionBinary.base64URL(Data(mac))
        }

        let headerData = try CompanionBinary.jsonData(header)
        guard headerData.count <= CompanionProtocol.maxHeaderBytes,
              8 + headerData.count + body.count + depth.chunk.count <= options.maxFrameBytes else {
            throw CompanionProtocolError("Companion message exceeds the frame limit.")
        }

        var frame = Data()
        frame.reserveCapacity(8 + headerData.count + body.count + depth.chunk.count)
        frame.append(CompanionBinary.utf8(CompanionProtocol.frameMagic))
        appendUInt32(UInt32(headerData.count), to: &frame)
        frame.append(headerData)
        frame.append(body)
        frame.append(depth.chunk)
        return frame
    }

    public static func decode(_ frame: Data, options: DecodeOptions = DecodeOptions()) throws -> DecodedCompanionFrame {
        guard options.maxFrameBytes >= 1024, options.maxFrameBytes <= CompanionProtocol.absoluteMaxFrameBytes else {
            throw CompanionProtocolError("Invalid companion frame limit.")
        }
        guard frame.count <= options.maxFrameBytes else {
            throw CompanionProtocolError("Companion message exceeds the frame limit.")
        }
        guard frame.count >= 10,
              CompanionBinary.constantTimeEqual(frame.prefix(4), CompanionBinary.utf8(CompanionProtocol.frameMagic)) else {
            throw CompanionProtocolError("Invalid companion frame magic.")
        }
        let headerLength = Int(readUInt32(frame, at: 4))
        guard headerLength >= 2, headerLength <= CompanionProtocol.maxHeaderBytes,
              8 + headerLength <= frame.count else {
            throw CompanionProtocolError("Invalid companion frame header length.")
        }

        let headerBytes = frame.subdata(in: 8..<(8 + headerLength))
        let rawHeader = try CompanionBinary.jsonObject(headerBytes)
        try ProtocolValidation.assertExactKeys(
            rawHeader,
            required: ["v", "sid", "seq", "sentAt", "type", "payloadEncoding", "depthEncoding", "payloadBytes", "depthBytes"],
            optional: ["mac"],
            label: "Frame header"
        )
        guard !(rawHeader["mac"] is NSNull) else {
            throw CompanionProtocolError("Invalid companion frame header fields.")
        }
        let header = try JSONDecoder().decode(CompanionFrameHeader.self, from: headerBytes)
        guard header.v == CompanionProtocol.version,
              header.sid.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil,
              header.seq <= 9_007_199_254_740_991,
              header.sentAt.isFinite, header.sentAt >= 0,
              header.payloadBytes >= 1,
              header.payloadBytes <= CompanionProtocol.maxJSONBytes,
              header.depthBytes >= 0,
              header.depthBytes <= CompanionProtocol.maxDepthBytes,
              (header.depthEncoding == .none || header.depthEncoding == .base64) ? header.depthBytes == 0 : (header.depthBytes > 0 && header.depthBytes % 8 == 0),
              header.mac == nil || header.mac!.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw CompanionProtocolError("Invalid companion frame header fields.")
        }
        let expectedLength = 8 + headerLength + header.payloadBytes + header.depthBytes
        guard expectedLength == frame.count else {
            throw CompanionProtocolError("Companion frame length does not match its header.")
        }
        if let expectedSID = options.expectedSID, header.sid != expectedSID {
            throw CompanionProtocolError("Unexpected companion session identifier.")
        }
        if let expectedSequence = options.expectedSequence, header.seq != expectedSequence {
            throw CompanionProtocolError("Companion message replay or sequence mismatch.")
        }
        let now = options.now ?? Date().timeIntervalSince1970 * 1000
        guard abs(now - header.sentAt) <= options.maxClockSkewMs else {
            throw CompanionProtocolError("Companion frame timestamp is outside the allowed clock skew.")
        }

        let body = frame.subdata(in: (8 + headerLength)..<(8 + headerLength + header.payloadBytes))
        let depthChunk = frame.subdata(in: (8 + headerLength + header.payloadBytes)..<frame.count)
        if header.type == .offer {
            guard header.mac == nil else {
                throw CompanionProtocolError("Pairing offers must not carry a session MAC.")
            }
        } else if options.allowAuthenticatedPairingJoin && header.type == .join && header.mac != nil {
            // The guest derives the session key from the offer and join keys.
        } else {
            guard let key = options.key, let mac = header.mac else {
                throw CompanionProtocolError("Companion frame is missing session authentication.")
            }
            let signature = try CompanionBinary.decodeBase64URL(mac, expectedBytes: 32)
            let expected = HMAC<SHA256>.authenticationCode(
                for: try authenticationBytes(header: header, body: body, depth: depthChunk),
                using: key.symmetricKey
            )
            let expectedData = Data(expected)
            guard CompanionBinary.constantTimeEqual(expectedData, signature) else {
                throw CompanionProtocolError("Companion frame authentication failed.")
            }
        }

        let json = header.payloadEncoding == .gzip
            ? try CompanionGzip.decompress(body, limit: CompanionProtocol.maxJSONBytes)
            : body
        guard json.count <= CompanionProtocol.maxJSONBytes else {
            throw CompanionProtocolError("Companion JSON payload exceeds its limit.")
        }
        let payload = try CompanionBinary.jsonObject(json)
        return DecodedCompanionFrame(header: header, payload: payload, depthChunk: depthChunk)
    }

    private static func splitDepth(_ payload: [String: Any], encoding: CompanionDepthEncoding) throws -> (payload: [String: Any], chunk: Data, encoding: CompanionDepthEncoding) {
        guard payload["kind"] as? String == "sample", let depth = payload["depth"] as? [String: Any] else {
            return (payload, Data(), .none)
        }
        if depth["mode"] as? String == "unchanged", depth["values"] == nil, depth["confidence"] == nil {
            return (payload, Data(), .none)
        }
        switch encoding {
        case .none:
            throw CompanionProtocolError("Companion sample depth requires an explicit depth encoding.")
        case .base64:
            guard depth["values"] is String, depth["confidence"] is String else {
                throw CompanionProtocolError("Depth arrays must both be base64 strings.")
            }
            return (payload, Data(), .base64)
        case .float32le:
            guard let values = floatArray(depth["values"]), let confidence = floatArray(depth["confidence"]),
                  values.count == confidence.count else {
                throw CompanionProtocolError("Binary depth requires matching Float32 values and confidence.")
            }
            var chunk = Data()
            chunk.reserveCapacity(values.count * 8)
            appendFloat32(values, to: &chunk)
            appendFloat32(confidence, to: &chunk)
            guard chunk.count <= CompanionProtocol.maxDepthBytes else {
                throw CompanionProtocolError("Depth chunk exceeds its limit.")
            }
            var output = payload
            var outputDepth = depth
            outputDepth["values"] = NSNull()
            outputDepth["confidence"] = NSNull()
            output["depth"] = outputDepth
            return (output, chunk, .float32le)
        }
    }

    private static func floatArray(_ value: Any?) -> [Float]? {
        if let value = value as? [Float] { return value }
        if let value = value as? [Double] { return value.map { Float($0) } }
        if let value = value as? NSArray {
            var output: [Float] = []
            output.reserveCapacity(value.count)
            for entry in value {
                guard let number = entry as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
                let float = number.floatValue
                guard float.isFinite else { return nil }
                output.append(float)
            }
            return output
        }
        return nil
    }

    private static func appendFloat32(_ values: [Float], to data: inout Data) {
        for value in values {
            appendUInt32(UInt32(bitPattern: value).littleEndian, to: &data)
        }
    }

    private static func appendUInt32(_ value: UInt32, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        data.withUnsafeBytes { buffer in
            UInt32(bigEndian: buffer.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
        }
    }

    private static func appendUInt64(_ value: UInt64, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }

    private static func appendFloat64(_ value: Double, to data: inout Data) {
        var bits = value.bitPattern.bigEndian
        withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
    }

    private static func authenticationBytes(header: CompanionFrameHeader, body: Data, depth: Data) throws -> Data {
        let type = CompanionBinary.utf8(header.type.rawValue)
        var metadata = Data()
        metadata.reserveCapacity(48 + type.count)
        metadata.append(CompanionBinary.utf8(CompanionProtocol.frameMagic))
        metadata.append(UInt8(header.v))
        metadata.append(try CompanionBinary.decodeBase64URL(header.sid, expectedBytes: 16))
        appendUInt64(header.seq, to: &metadata)
        appendFloat64(header.sentAt, to: &metadata)
        metadata.append(UInt8(type.count))
        metadata.append(type)
        metadata.append(header.payloadEncoding == .gzip ? 1 : 0)
        metadata.append(header.depthEncoding == .none ? 0 : (header.depthEncoding == .float32le ? 1 : 2))
        appendUInt32(UInt32(header.payloadBytes), to: &metadata)
        appendUInt32(UInt32(header.depthBytes), to: &metadata)
        return CompanionBinary.concat(metadata, body, depth)
    }
}
