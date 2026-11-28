import XCTest
@testable import VISI0NSpatial

final class AdaptiveQualityTests: XCTestCase {
    func testSlowFramesReducePixelRatioAfterTwoSeconds() {
        var quality = AdaptiveQuality(maximumPixelRatio: 1)
        for _ in 0..<110 { quality.record(frameTime: 1.0 / 30, maximumPixelRatio: 1) }
        XCTAssertLessThan(quality.pixelRatio, 1)
        XCTAssertGreaterThanOrEqual(quality.pixelRatio, 0.75)
    }

    func testFastFramesRestoreResolutionWithoutExceedingMaximum() {
        var quality = AdaptiveQuality(maximumPixelRatio: 0.8)
        for _ in 0..<130 { quality.record(frameTime: 1.0 / 90, maximumPixelRatio: 0.8) }
        XCTAssertEqual(quality.pixelRatio, 0.8, accuracy: 0.001)
    }

    func testAbsurdFrameTimesAreBounded() {
        var quality = AdaptiveQuality(maximumPixelRatio: 1)
        quality.record(frameTime: 100, maximumPixelRatio: 1)
        XCTAssertEqual(quality.accumulatedFrameTime, 0.1, accuracy: 0.001)
    }
}
