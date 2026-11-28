import CryptoKit
import Foundation
import XCTest
@testable import VisionCompanionProtocol

final class PairingTests: XCTestCase {
    func testP256ECDHHKDFAndPairingProofMatchHostDerivation() throws {
        let hostPrivate = P256.KeyAgreement.PrivateKey()
        let hostPublic = try PairingCrypto.exportPublicKey(hostPrivate.publicKey)
        let salt = Data(repeating: 7, count: 16)
        let sid = "AAAAAAAAAAAAAAAAAAAAAA"
        let offer = CompanionPairingOffer(
            sid: sid,
            ephemeralPublicKey: hostPublic,
            salt: CompanionBinary.base64URL(salt),
            pairingExpiresAt: 31_000,
            sessionExpiresAt: 3_601_000,
            maxFrameBytes: 4 * 1024 * 1024,
            maxMessagesPerSecond: 30,
            features: CompanionFeatures(compression: ["gzip", "identity"])
        )
        let offerData = try JSONEncoder().encode(offer)
        let parsedOffer = try CompanionPairingOffer.parse(
            try JSONSerialization.jsonObject(with: offerData),
            now: 1000
        )
        let joined = try PairingCrypto.createJoin(
            offer: parsedOffer,
            code: "1234567890",
            device: CompanionDevice(name: "Test iPhone", model: "iPhone"),
            now: 1000
        )
        let hostKey = try PairingCrypto.deriveHostSessionKey(
            hostPrivateKey: hostPrivate,
            hostPublicKey: hostPublic,
            guestPublicKey: joined.payload.ephemeralPublicKey,
            salt: salt,
            sid: sid
        )
        let guestBytes = joined.sessionKey.withBytes { $0 }
        let hostBytes = hostKey.withBytes { $0 }
        XCTAssertEqual(guestBytes, hostBytes)
        XCTAssertEqual(joined.payload.proof.count, 43)
        XCTAssertEqual(joined.keyFingerprint.count, 43)
        XCTAssertTrue(try PairingCrypto.verifyPairingCode(expected: "1234567890", presented: "1234567890", salt: salt))
        XCTAssertFalse(try PairingCrypto.verifyPairingCode(expected: "1234567890", presented: "1234567891", salt: salt))
    }

    func testPairingCodeAndOfferValidation() throws {
        XCTAssertThrowsError(try PairingCrypto.verifyPairingCode(expected: "123", presented: "123", salt: Data(repeating: 0, count: 16)))
        let offer = [
            "kind": "offer",
            "sid": "AAAAAAAAAAAAAAAAAAAAAA",
            "protocolVersion": 1,
            "ephemeralPublicKey": ["crv": "P-256", "kty": "EC", "x": "", "y": ""],
            "salt": CompanionBinary.base64URL(Data(repeating: 0, count: 16)),
            "pairingExpiresAt": 1000,
            "sessionExpiresAt": 2000,
            "maxFrameBytes": 4096,
            "maxMessagesPerSecond": 30,
            "features": ["incremental": true, "compression": ["identity"], "depthEncodings": ["float32le", "base64"]]
        ] as [String: Any]
        XCTAssertThrowsError(try CompanionPairingOffer.parse(offer, now: 1001))
        var unknown = offer
        unknown["unexpected"] = true
        XCTAssertThrowsError(try CompanionPairingOffer.parse(unknown, now: 999))
    }
}
