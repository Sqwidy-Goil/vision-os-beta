import Foundation

public enum TrustedLocalWSS {
    public static func validate(_ value: String) throws -> URL {
        guard let components = URLComponents(string: value),
              components.scheme?.lowercased() == "wss",
              let host = components.host,
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.port == nil || (components.port! >= 1 && components.port! <= 65535),
              let url = components.url else {
            throw CompanionProtocolError("Companion requires WSS to a trusted local-network, localhost, or .local host.")
        }

        let normalizedHost = host.lowercased()
            .replacingOccurrences(of: "[", with: "")
            .replacingOccurrences(of: "]", with: "")
        let localName = normalizedHost == "localhost"
            || normalizedHost.hasSuffix(".localhost")
            || normalizedHost.hasSuffix(".local")
        let localIP = isPrivateIPv4(normalizedHost) || isLocalIPv6(normalizedHost)
        guard localName || localIP else {
            throw CompanionProtocolError("Companion requires WSS to a trusted local-network, localhost, or .local host.")
        }
        return url
    }

    private static func isPrivateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ $0 >= 0 && $0 <= 255 }) else { return false }
        let a = octets[0]
        let b = octets[1]
        return a == 10
            || a == 127
            || (a == 169 && b == 254)
            || (a == 172 && b >= 16 && b <= 31)
            || (a == 192 && b == 168)
    }

    private static func isLocalIPv6(_ host: String) -> Bool {
        guard host.contains(":"), let words = ipv6Words(host) else { return false }
        let loopback = words[0...6].allSatisfy { $0 == 0 } && words[7] == 1
        let uniqueLocal = (words[0] & 0xfe00) == 0xfc00
        let linkLocal = (words[0] & 0xffc0) == 0xfe80
        let mappedPrivate = words[0...4].allSatisfy { $0 == 0 }
            && words[5] == 0xffff
            && isPrivateIPv4("\(words[6] >> 8).\(words[6] & 255).\(words[7] >> 8).\(words[7] & 255)")
        return loopback || uniqueLocal || linkLocal || mappedPrivate
    }

    private static func ipv6Words(_ host: String) -> [UInt16]? {
        var address = host
        if let dotted = address.range(of: "^(.*:)([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)$", options: .regularExpression),
           let whole = try? NSRegularExpression(pattern: "^(.*:)([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)$")
                .firstMatch(in: address, range: NSRange(address.startIndex..., in: address)) {
            let prefix = String(address[Range(whole.range(at: 1), in: address)!])
            let ipv4 = String(address[Range(whole.range(at: 2), in: address)!])
            guard isPrivateIPv4(ipv4) else { return nil }
            let octets = ipv4.split(separator: ".").compactMap { Int($0) }
            address = prefix + String(format: "%x:%x", (octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
        } else if dotted != nil {
            return nil
        }

        let halves = address.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        let left = parseWords(halves[0])
        let right = halves.count == 2 ? parseWords(halves[1]) : []
        guard left != nil, right != nil else { return nil }
        if halves.count == 1 {
            guard left!.count == 8 else { return nil }
            return left!
        }
        let missing = 8 - left!.count - right!.count
        guard missing >= 1 else { return nil }
        return left! + [UInt16](repeating: 0, count: missing) + right!
    }

    private static func parseWords(_ value: String) -> [UInt16]? {
        guard !value.isEmpty else { return [] }
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        var output: [UInt16] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 4,
                  part.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains($0) }),
                  let word = UInt16(part, radix: 16) else { return nil }
            output.append(word)
        }
        return output
    }
}

public final class MessageRateLimiter {
    private var windowStart: Double
    private var count = 0
    private let maximum: Int
    private let now: () -> Double

    public init(maximum: Int, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        precondition(maximum >= 1 && maximum <= CompanionProtocol.maxMessagesPerSecond)
        self.maximum = maximum
        self.now = now
        self.windowStart = now()
    }

    public func consume(_ timestamp: Double? = nil) throws {
        let current = timestamp ?? now()
        if current - windowStart >= 1000 {
            windowStart = current
            count = 0
        }
        count += 1
        if count > maximum {
            throw CompanionProtocolError("Companion message rate limit exceeded.")
        }
    }
}

public final class ReplayGuard {
    private var expectedSequence: UInt64 = 0

    public init() {}

    public var nextSequence: UInt64 { expectedSequence }

    public func accept(_ sequence: UInt64) throws {
        guard sequence == expectedSequence else {
            throw CompanionProtocolError("Companion message replay or sequence mismatch.")
        }
        expectedSequence += 1
    }
}
