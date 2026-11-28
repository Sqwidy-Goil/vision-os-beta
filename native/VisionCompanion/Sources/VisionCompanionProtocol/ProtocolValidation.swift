import CoreFoundation
import Foundation

public enum CompanionProtocol {
    public static let version = 1
    public static let defaultMaxFrameBytes = 4 * 1024 * 1024
    public static let absoluteMaxFrameBytes = 8 * 1024 * 1024
    public static let defaultMaxMessagesPerSecond = 30
    public static let maxMessagesPerSecond = 120
    public static let maxJSONBytes = 4 * 1024 * 1024
    public static let maxDepthBytes = 2 * 1024 * 1024
    public static let maxHeaderBytes = 64 * 1024
    public static let maxClockSkewMs: Double = 30_000
    public static let ecdhDomain = "vision-companion/session/v1\0"
    public static let pairingDomain = "vision-companion/pair/v1\0"
    public static let codeDomain = "vision-companion/code/v1\0"
    public static let coordinateFrame = "world-y-up-right-handed"
    public static let depthUnits = "meters"
    public static let frameMagic = "VIS1"
}

public struct CompanionProtocolError: Error, CustomStringConvertible, LocalizedError {
    public let description: String

    public init(_ description: String) {
        self.description = description
    }

    public var errorDescription: String? { description }
}

public enum ProtocolValidation {
    public static func isRecord(_ value: Any?) -> Bool {
        guard let value else { return false }
        return value is [String: Any]
    }

    public static func assertExactKeys(
        _ value: Any?,
        required: [String],
        optional: [String] = [],
        label: String
    ) throws -> [String: Any] {
        guard let object = value as? [String: Any] else {
            throw CompanionProtocolError("\(label) must be an object.")
        }
        let keys = Set(object.keys)
        if !Set(required).isSubset(of: keys) || !keys.isSubset(of: Set(required + optional)) {
            throw CompanionProtocolError("\(label) has missing or unknown fields.")
        }
        return object
    }

    public static func string(
        _ value: Any?,
        label: String,
        minLength: Int = 1,
        maxLength: Int = 80
    ) throws -> String {
        guard let value = value as? String,
              value.utf16.count >= minLength,
              value.utf16.count <= maxLength else {
            throw CompanionProtocolError("Invalid companion \(label).")
        }
        return value
    }

    public static func number(
        _ value: Any?,
        label: String,
        minimum: Double = -.greatestFiniteMagnitude,
        maximum: Double = .greatestFiniteMagnitude
    ) throws -> Double {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw CompanionProtocolError("Invalid companion \(label).")
        }
        let result = number.doubleValue
        guard result.isFinite, result >= minimum, result <= maximum else {
            throw CompanionProtocolError("Invalid companion \(label).")
        }
        return result
    }

    public static func integer(
        _ value: Any?,
        label: String,
        minimum: Int = 0,
        maximum: Int = 9_007_199_254_740_991
    ) throws -> Int {
        let number = try self.number(value, label: label)
        guard let integer = Int(exactly: number),
              integer >= minimum, integer <= maximum else {
            throw CompanionProtocolError("Invalid companion \(label).")
        }
        return integer
    }

    public static func bool(_ value: Any?, label: String) throws -> Bool {
        guard let value = value as? Bool else {
            throw CompanionProtocolError("Invalid companion \(label).")
        }
        return value
    }

    public static func array(_ value: Any?, label: String) throws -> [Any] {
        guard let value = value as? [Any] else {
            throw CompanionProtocolError("Invalid companion \(label).")
        }
        return value
    }

    public static func vector(
        _ value: Any?,
        label: String,
        bound: Double = 1000
    ) throws -> [Double] {
        let values = try array(value, label: label)
        guard values.count == 3 else {
            throw CompanionProtocolError("Invalid companion \(label).")
        }
        return try values.map { try number($0, label: label, minimum: -bound, maximum: bound) }
    }

    public static func quaternion(_ value: Any?) throws -> [Double] {
        let values = try array(value, label: "quaternion")
        guard values.count == 4 else {
            throw CompanionProtocolError("Invalid companion quaternion.")
        }
        let output = try values.map { try number($0, label: "quaternion", minimum: -1, maximum: 1) }
        let length = SpatialMath.hypot(output)
        guard abs(length - 1) <= 0.001 else {
            throw CompanionProtocolError("Companion quaternion is not normalized.")
        }
        return output.map { $0 / length }
    }

    public static func confidence(_ value: Any?) throws -> Double {
        try number(value, label: "confidence", minimum: 0, maximum: 1)
    }

    public static func identifier(_ value: Any?) throws -> String {
        let output = try string(value, label: "identifier")
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")
        guard output.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw CompanionProtocolError("Invalid companion identifier.")
        }
        return output
    }

    public static func limit(_ value: Int?, fallback: Int, minimum: Int, maximum: Int) throws -> Int {
        let output = value ?? fallback
        guard output >= minimum, output <= maximum else {
            throw CompanionProtocolError("Invalid companion protocol limit.")
        }
        return output
    }
}
