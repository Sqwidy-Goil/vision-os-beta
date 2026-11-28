import Foundation
import XCTest
@testable import VisionCompanionProtocol

final class ValidationAndGuardTests: XCTestCase {
    func testTrustedLocalEndpointBoundaries() throws {
        for endpoint in [
            "wss://192.168.1.20:8443/socket",
            "wss://127.0.0.1/socket",
            "wss://10.0.0.2/socket",
            "wss://169.254.1.2/socket",
            "wss://172.31.2.3/socket",
            "wss://localhost/socket",
            "wss://vision.local/socket",
            "wss://[::1]/socket",
            "wss://[fd00::1]/socket",
            "wss://[fe80::1]/socket",
            "wss://[::ffff:192.168.1.2]/socket"
        ] {
            XCTAssertNoThrow(try TrustedLocalWSS.validate(endpoint), endpoint)
        }
        for endpoint in [
            "ws://192.168.1.2/socket",
            "wss://example.com/socket",
            "wss://8.8.8.8/socket",
            "wss://user:secret@localhost/socket",
            "wss://localhost/socket?token=x",
            "wss://[2001:4860:4860::8888]/socket"
        ] {
            XCTAssertThrowsError(try TrustedLocalWSS.validate(endpoint), endpoint)
        }
    }

    func testReplayAndRateGuards() throws {
        let replay = ReplayGuard()
        try replay.accept(0)
        try replay.accept(1)
        XCTAssertThrowsError(try replay.accept(1))
        XCTAssertEqual(replay.nextSequence, 2)

        var now = 1000.0
        let rate = MessageRateLimiter(maximum: 2, now: { now })
        try rate.consume()
        try rate.consume()
        XCTAssertThrowsError(try rate.consume())
        now += 1000
        try rate.consume()
    }

    func testCanonicalBase64AndSecureCodeValidation() throws {
        let bytes = Data([0, 1, 2, 250, 255])
        XCTAssertEqual(try CompanionBinary.decodeBase64URL(CompanionBinary.base64URL(bytes)), bytes)
        XCTAssertThrowsError(try CompanionBinary.decodeBase64URL("AB"))
        XCTAssertThrowsError(try CompanionBinary.decodeBase64("AB=="))
        for _ in 0..<8 {
            let code = try CompanionBinary.generatePairingCode()
            XCTAssertEqual(code.count, 10)
            XCTAssertTrue(code.allSatisfy { $0.isNumber })
        }
    }
}
