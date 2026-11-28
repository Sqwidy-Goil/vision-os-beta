import CryptoKit
import Foundation
import Security

public enum CompanionBinary {
    public static func utf8(_ value: String) -> Data {
        Data(value.utf8)
    }

    public static func concat(_ parts: Data...) -> Data {
        var output = Data()
        output.reserveCapacity(parts.reduce(0) { $0 + $1.count })
        for part in parts {
            output.append(part)
        }
        return output
    }

    public static func base64(_ data: Data) -> String {
        data.base64EncodedString()
    }

    public static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decodeBase64(_ value: String) throws -> Data {
        guard value.count <= CompanionProtocol.maxJSONBytes,
              value.count % 4 == 0,
              value.range(of: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$", options: .regularExpression) != nil,
              let data = Data(base64Encoded: value),
              data.base64EncodedString() == value else {
            throw CompanionProtocolError("Invalid base64 data.")
        }
        return data
    }

    public static func decodeBase64URL(_ value: String, expectedBytes: Int? = nil) throws -> Data {
        guard !value.isEmpty,
              value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              expectedBytes == nil || value.count == (expectedBytes * 4 + 2) / 3 else {
            throw CompanionProtocolError("Invalid base64url data.")
        }
        let padded = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: (4 - value.count % 4) % 4)
        let data = try decodeBase64(padded)
        if let expectedBytes, data.count != expectedBytes {
            throw CompanionProtocolError("Unexpected binary data length.")
        }
        guard base64URL(data) == value else {
            throw CompanionProtocolError("Non-canonical base64url data.")
        }
        return data
    }

    public static func randomBytes(_ count: Int) throws -> Data {
        guard count >= 0 else { throw CompanionProtocolError("Invalid random byte count.") }
        guard count > 0 else { return Data() }
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw CompanionProtocolError("Secure random generation failed.")
        }
        return data
    }

    public static func generatePairingCode(digits: Int = 10) throws -> String {
        guard digits >= 8, digits <= 12 else {
            throw CompanionProtocolError("Pairing codes require 8 to 12 digits.")
        }
        let limit = (UInt64(UInt32.max) + 1) / 10 * 10
        var output = [UInt8]()
        output.reserveCapacity(digits)
        while output.count < digits {
            let random = try randomBytes(4)
            let candidate = random.withUnsafeBytes { UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self)) }
            if UInt64(candidate) < limit {
                output.append(48 + UInt8(candidate % 10))
            }
        }
        return String(decoding: output, as: UTF8.self)
    }

    public static func constantTimeEqual(_ first: Data, _ second: Data) -> Bool {
        guard first.count == second.count else { return false }
        var difference: UInt8 = 0
        for (left, right) in zip(first, second) {
            difference |= left ^ right
        }
        return difference == 0
    }

    public static func wipe(_ data: inout Data) {
        data.resetBytes(in: 0..<data.count)
    }

    public static func jsonObject(_ data: Data) throws -> [String: Any] {
        do {
            let value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
            guard let object = value as? [String: Any] else {
                throw CompanionProtocolError("Companion JSON payload must be an object.")
            }
            return object
        } catch let error as CompanionProtocolError {
            throw error
        } catch {
            throw CompanionProtocolError("Invalid companion JSON payload.")
        }
    }

    public static func jsonData(_ object: Any) throws -> Data {
        do {
            return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        } catch {
            throw CompanionProtocolError("Companion payload is not valid JSON.")
        }
    }
}

public final class SessionKey {
    private var bytes: Data
    private let lock = NSLock()

    public init(bytes: Data) {
        precondition(bytes.count == 32, "Companion session keys must be 256 bits.")
        self.bytes = bytes
    }

    public var symmetricKey: SymmetricKey {
        lock.lock()
        defer { lock.unlock() }
        return SymmetricKey(data: bytes)
    }

    public func withBytes<Result>(_ body: (Data) throws -> Result) rethrows -> Result {
        lock.lock()
        defer { lock.unlock() }
        return try body(bytes)
    }

    public func wipe() {
        lock.lock()
        defer { lock.unlock() }
        bytes.resetBytes(in: 0..<bytes.count)
    }

    deinit {
        bytes.resetBytes(in: 0..<bytes.count)
    }
}
