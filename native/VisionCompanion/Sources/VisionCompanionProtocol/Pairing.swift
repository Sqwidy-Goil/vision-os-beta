import CryptoKit
import Foundation

public struct CompanionDevice: Codable, Equatable {
    public var name: String
    public var model: String?

    public init(name: String, model: String? = nil) {
        self.name = name
        self.model = model
    }

    public static func parse(_ value: Any?) throws -> CompanionDevice {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["name"],
            optional: ["model"],
            label: "Companion device"
        )
        let name = try ProtocolValidation.string(object["name"], label: "device metadata")
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CompanionProtocolError("Invalid companion device metadata.") }
        var model: String?
        if let rawModel = object["model"] {
            model = try ProtocolValidation.string(rawModel, label: "device metadata")
        }
        return CompanionDevice(name: name, model: model)
    }
}

public struct CompanionEphemeralPublicKey: Codable, Equatable {
    public var crv: String
    public var ext: Bool
    public var keyOps: [String]
    public var kty: String
    public var x: String
    public var y: String

    public init(crv: String = "P-256", ext: Bool = true, keyOps: [String] = [], kty: String = "EC", x: String, y: String) {
        self.crv = crv
        self.ext = ext
        self.keyOps = keyOps
        self.kty = kty
        self.x = x
        self.y = y
    }

    private enum CodingKeys: String, CodingKey {
        case crv, ext, kty, x, y
        case keyOps = "key_ops"
    }
}

public struct CompanionFeatures: Codable, Equatable {
    public var incremental: Bool
    public var compression: [String]
    public var depthEncodings: [String]

    public init(incremental: Bool = true, compression: [String] = ["identity"], depthEncodings: [String] = ["float32le", "base64"]) {
        self.incremental = incremental
        self.compression = compression
        self.depthEncodings = depthEncodings
    }

    public static func parse(_ value: Any?, offered: CompanionFeatures? = nil) throws -> CompanionFeatures {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["incremental", "compression", "depthEncodings"],
            label: "Companion features"
        )
        guard try ProtocolValidation.bool(object["incremental"], label: "features") else {
            throw CompanionProtocolError("Companion protocol features are incompatible.")
        }
        let compression = try ProtocolValidation.array(object["compression"], label: "features")
        guard compression.count >= 1, compression.count <= 2,
              compression.allSatisfy({ $0 is String }),
              Set(compression as? [String] ?? []).count == compression.count,
              let strings = compression as? [String],
              strings.allSatisfy({ $0 == "gzip" || $0 == "identity" }),
              strings.contains("identity") else {
            throw CompanionProtocolError("Companion protocol features are incompatible.")
        }
        let encodings = try ProtocolValidation.array(object["depthEncodings"], label: "features")
        guard let encodingStrings = encodings as? [String],
              encodingStrings == ["float32le", "base64"] else {
            throw CompanionProtocolError("Companion protocol features are incompatible.")
        }
        if let offered, strings.contains(where: { !offered.compression.contains($0) }) {
            throw CompanionProtocolError("Companion protocol features are incompatible.")
        }
        return CompanionFeatures(incremental: true, compression: strings, depthEncodings: encodingStrings)
    }
}

public struct CompanionPairingOffer: Codable, Equatable {
    public var kind: String
    public var sid: String
    public var protocolVersion: Int
    public var ephemeralPublicKey: CompanionEphemeralPublicKey
    public var salt: String
    public var pairingExpiresAt: Double
    public var sessionExpiresAt: Double
    public var maxFrameBytes: Int
    public var maxMessagesPerSecond: Int
    public var features: CompanionFeatures

    public init(
        sid: String,
        ephemeralPublicKey: CompanionEphemeralPublicKey,
        salt: String,
        pairingExpiresAt: Double,
        sessionExpiresAt: Double,
        maxFrameBytes: Int,
        maxMessagesPerSecond: Int,
        features: CompanionFeatures
    ) {
        self.kind = "offer"
        self.sid = sid
        self.protocolVersion = CompanionProtocol.version
        self.ephemeralPublicKey = ephemeralPublicKey
        self.salt = salt
        self.pairingExpiresAt = pairingExpiresAt
        self.sessionExpiresAt = sessionExpiresAt
        self.maxFrameBytes = maxFrameBytes
        self.maxMessagesPerSecond = maxMessagesPerSecond
        self.features = features
    }

    private enum CodingKeys: String, CodingKey {
        case kind, sid, salt, features
        case protocolVersion = "protocolVersion"
        case ephemeralPublicKey = "ephemeralPublicKey"
        case pairingExpiresAt = "pairingExpiresAt"
        case sessionExpiresAt = "sessionExpiresAt"
        case maxFrameBytes = "maxFrameBytes"
        case maxMessagesPerSecond = "maxMessagesPerSecond"
    }

    public static func parse(_ value: Any?, now: Double) throws -> CompanionPairingOffer {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: [
                "kind", "sid", "protocolVersion", "ephemeralPublicKey", "salt",
                "pairingExpiresAt", "sessionExpiresAt", "maxFrameBytes",
                "maxMessagesPerSecond", "features"
            ],
            label: "Pairing offer"
        )
        guard object["kind"] as? String == "offer",
              try ProtocolValidation.integer(object["protocolVersion"], label: "protocol version") == CompanionProtocol.version else {
            throw CompanionProtocolError("Invalid pairing offer.")
        }
        let sid = try ProtocolValidation.string(object["sid"], label: "session identifier")
        guard sid.count == 22, sid.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil else {
            throw CompanionProtocolError("Invalid pairing offer.")
        }
        let pairingExpiresAt = try ProtocolValidation.number(object["pairingExpiresAt"], label: "pairing expiry", minimum: 0)
        let sessionExpiresAt = try ProtocolValidation.number(object["sessionExpiresAt"], label: "session expiry", minimum: 0)
        guard now < pairingExpiresAt else {
            throw CompanionProtocolError("Companion pairing code has expired.")
        }
        guard now < sessionExpiresAt else {
            throw CompanionProtocolError("Companion session has expired.")
        }
        let maxFrameBytes = try ProtocolValidation.integer(object["maxFrameBytes"], label: "frame limit", minimum: 1024, maximum: CompanionProtocol.absoluteMaxFrameBytes)
        let maxMessages = try ProtocolValidation.integer(object["maxMessagesPerSecond"], label: "message rate limit", minimum: 1, maximum: CompanionProtocol.maxMessagesPerSecond)
        let salt = try ProtocolValidation.string(object["salt"], label: "pairing salt")
        _ = try CompanionBinary.decodeBase64URL(salt, expectedBytes: 16)
        let keyObject = try ProtocolValidation.assertExactKeys(
            object["ephemeralPublicKey"],
            required: ["crv", "kty", "x", "y"],
            optional: ["ext", "key_ops"],
            label: "Pairing public key"
        )
        let ext = try ProtocolValidation.bool(keyObject["ext"] ?? true, label: "public key")
        let keyOps: [String]
        if let rawKeyOps = keyObject["key_ops"] {
            let values = try ProtocolValidation.array(rawKeyOps, label: "public key")
            keyOps = try values.map { try ProtocolValidation.string($0, label: "public key", maxLength: 80) }
        } else {
            keyOps = []
        }
        let key = CompanionEphemeralPublicKey(
            crv: try ProtocolValidation.string(keyObject["crv"], label: "public key"),
            ext: ext,
            keyOps: keyOps,
            kty: try ProtocolValidation.string(keyObject["kty"], label: "public key"),
            x: try ProtocolValidation.string(keyObject["x"], label: "public key"),
            y: try ProtocolValidation.string(keyObject["y"], label: "public key")
        )
        try PairingCrypto.validatePublicKey(key)
        let features = try CompanionFeatures.parse(object["features"])
        return CompanionPairingOffer(
            sid: sid,
            ephemeralPublicKey: key,
            salt: salt,
            pairingExpiresAt: pairingExpiresAt,
            sessionExpiresAt: sessionExpiresAt,
            maxFrameBytes: maxFrameBytes,
            maxMessagesPerSecond: maxMessages,
            features: features
        )
    }
}

public struct CompanionPairingJoin: Codable, Equatable {
    public var kind: String
    public var protocolVersion: Int
    public var ephemeralPublicKey: CompanionEphemeralPublicKey
    public var proof: String
    public var device: CompanionDevice
    public var features: CompanionFeatures

    public init(
        ephemeralPublicKey: CompanionEphemeralPublicKey,
        proof: String,
        device: CompanionDevice,
        features: CompanionFeatures
    ) {
        self.kind = "join"
        self.protocolVersion = CompanionProtocol.version
        self.ephemeralPublicKey = ephemeralPublicKey
        self.proof = proof
        self.device = device
        self.features = features
    }

    private enum CodingKeys: String, CodingKey {
        case kind, proof, device, features
        case protocolVersion = "protocolVersion"
        case ephemeralPublicKey = "ephemeralPublicKey"
    }
}

public struct CompanionJoinResult {
    public let payload: CompanionPairingJoin
    public let sessionKey: SessionKey
    public let keyFingerprint: String

    public init(payload: CompanionPairingJoin, sessionKey: SessionKey, keyFingerprint: String) {
        self.payload = payload
        self.sessionKey = sessionKey
        self.keyFingerprint = keyFingerprint
    }
}

public enum PairingCrypto {
    public static func createJoin(
        offer: CompanionPairingOffer,
        code: String,
        device: CompanionDevice,
        now: Double
    ) throws -> CompanionJoinResult {
        guard now < offer.pairingExpiresAt else {
            throw CompanionProtocolError("Companion pairing code has expired.")
        }
        guard code.range(of: "^[0-9]{8,12}$", options: .regularExpression) != nil else {
            throw CompanionProtocolError("Invalid pairing code.")
        }
        let guestPrivate = P256.KeyAgreement.PrivateKey()
        let guestPublic = try exportPublicKey(guestPrivate.publicKey)
        let hostPublic = try importPublicKey(offer.ephemeralPublicKey)
        let salt = try CompanionBinary.decodeBase64URL(offer.salt, expectedBytes: 16)
        let shared = try guestPrivate.sharedSecretWithKey(hostPublic)
        let canonicalHost = try canonicalPublicKey(offer.ephemeralPublicKey)
        let canonicalGuest = try canonicalPublicKey(guestPublic)
        let info = CompanionBinary.concat(
            CompanionBinary.utf8(CompanionProtocol.ecdhDomain + offer.sid + "\0"),
            canonicalHost,
            canonicalGuest
        )
        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: shared),
            salt: SymmetricKey(data: salt),
            info: info,
            outputByteCount: 32
        )
        let sessionBytes = derived.withUnsafeBytes { Data($0) }
        let codeDigest = SHA256.hash(data: CompanionBinary.concat(
            CompanionBinary.utf8(CompanionProtocol.codeDomain),
            salt,
            CompanionBinary.utf8(code)
        ))
        let proofData = CompanionBinary.concat(
            CompanionBinary.utf8(CompanionProtocol.pairingDomain),
            try CompanionBinary.decodeBase64URL(offer.sid, expectedBytes: 16),
            canonicalHost,
            canonicalGuest,
            Data(codeDigest)
        )
        let proof = HMAC<SHA256>.authenticationCode(for: proofData, using: SymmetricKey(data: sessionBytes))
        let join = CompanionPairingJoin(
            ephemeralPublicKey: guestPublic,
            proof: CompanionBinary.base64URL(Data(proof)),
            device: device,
            features: CompanionFeatures(compression: ["identity"])
        )
        let fingerprint = SHA256.hash(data: canonicalGuest)
        return CompanionJoinResult(
            payload: join,
            sessionKey: SessionKey(bytes: sessionBytes),
            keyFingerprint: CompanionBinary.base64URL(Data(fingerprint))
        )
    }

    public static func verifyPairingCode(expected: String, presented: String, salt: Data) throws -> Bool {
        guard expected.range(of: "^[0-9]{8,12}$", options: .regularExpression) != nil,
              presented.range(of: "^[0-9]{8,12}$", options: .regularExpression) != nil,
              salt.count == 16 else { return false }
        let expectedDigest = SHA256.hash(data: CompanionBinary.concat(
            CompanionBinary.utf8(CompanionProtocol.codeDomain),
            salt,
            CompanionBinary.utf8(expected)
        ))
        let presentedDigest = SHA256.hash(data: CompanionBinary.concat(
            CompanionBinary.utf8(CompanionProtocol.codeDomain),
            salt,
            CompanionBinary.utf8(presented)
        ))
        return CompanionBinary.constantTimeEqual(Data(expectedDigest), Data(presentedDigest))
    }

    static func canonicalPublicKey(_ key: CompanionEphemeralPublicKey) throws -> Data {
        try validatePublicKey(key)
        let json = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(key.x)\",\"y\":\"\(key.y)\"}"
        return CompanionBinary.utf8(json)
    }

    static func validatePublicKey(_ key: CompanionEphemeralPublicKey) throws {
        guard key.crv == "P-256", key.kty == "EC" else {
            throw CompanionProtocolError("Companion requires P-256 ephemeral keys.")
        }
        let x = try CompanionBinary.decodeBase64URL(key.x, expectedBytes: 32)
        let y = try CompanionBinary.decodeBase64URL(key.y, expectedBytes: 32)
        _ = try importPublicKey(key)
        guard x.count == 32, y.count == 32 else {
            throw CompanionProtocolError("Companion requires P-256 ephemeral keys.")
        }
    }

    static func importPublicKey(_ key: CompanionEphemeralPublicKey) throws -> P256.KeyAgreement.PublicKey {
        let x = try CompanionBinary.decodeBase64URL(key.x, expectedBytes: 32)
        let y = try CompanionBinary.decodeBase64URL(key.y, expectedBytes: 32)
        var x963 = Data([0x04])
        x963.append(x)
        x963.append(y)
        do {
            return try P256.KeyAgreement.PublicKey(rawRepresentation: x963)
        } catch {
            throw CompanionProtocolError("Invalid P-256 companion public key.")
        }
    }

    static func exportPublicKey(_ key: P256.KeyAgreement.PublicKey) throws -> CompanionEphemeralPublicKey {
        let raw = key.rawRepresentation
        guard raw.count == 65, raw.first == 0x04 else {
            throw CompanionProtocolError("Unsupported P-256 public key representation.")
        }
        return CompanionEphemeralPublicKey(
            x: CompanionBinary.base64URL(raw.subdata(in: 1..<33)),
            y: CompanionBinary.base64URL(raw.subdata(in: 33..<65))
        )
    }

    static func deriveHostSessionKey(
        hostPrivateKey: P256.KeyAgreement.PrivateKey,
        hostPublicKey: CompanionEphemeralPublicKey,
        guestPublicKey: CompanionEphemeralPublicKey,
        salt: Data,
        sid: String
    ) throws -> SessionKey {
        let guest = try importPublicKey(guestPublicKey)
        let shared = try hostPrivateKey.sharedSecretWithKey(guest)
        let info = CompanionBinary.concat(
            CompanionBinary.utf8(CompanionProtocol.ecdhDomain + sid + "\0"),
            try canonicalPublicKey(hostPublicKey),
            try canonicalPublicKey(guestPublicKey)
        )
        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: shared),
            salt: SymmetricKey(data: salt),
            info: info,
            outputByteCount: 32
        )
        return SessionKey(bytes: derived.withUnsafeBytes { Data($0) })
    }
}
