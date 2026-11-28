import XCTest
import simd
@testable import VISI0NSpatial

final class HandGestureProcessorTests: XCTestCase {
    private func sample(thumb: Float, index: Float, wristX: Float = 0.2) -> HandSample {
        HandSample(
            thumbTip: SIMD2<Float>(thumb, 0.6),
            indexTip: SIMD2<Float>(index, 0.6),
            wrist: SIMD2<Float>(wristX, 0.2),
            middleMCP: SIMD2<Float>(wristX, 0.7),
            timestamp: 0
        )
    }

    func testPinchRequiresThreeConsecutiveFrames() {
        var processor = HandGestureProcessor()
        XCTAssertNil(processor.process(sample(thumb: 0.5, index: 0.5)))
        XCTAssertNil(processor.process(sample(thumb: 0.5, index: 0.5)))
        XCTAssertEqual(processor.process(sample(thumb: 0.5, index: 0.5)), .pinchStarted(SIMD2<Float>(0.8, 0.2)))
        XCTAssertTrue(processor.isPinching)
    }

    func testPinchMovementUsesMirroredRearCameraCoordinates() {
        var processor = HandGestureProcessor()
        _ = processor.process(sample(thumb: 0.5, index: 0.5, wristX: 0.1))
        _ = processor.process(sample(thumb: 0.5, index: 0.5, wristX: 0.1))
        XCTAssertEqual(processor.process(sample(thumb: 0.5, index: 0.5, wristX: 0.1)), .pinchStarted(SIMD2<Float>(0.9, 0.2)))
        let moved = processor.process(sample(thumb: 0.5, index: 0.5, wristX: 0.4))
        if case .pinchMoved(let location, _) = moved {
            XCTAssertEqual(location.x, 0.6, accuracy: 0.001)
        } else {
            XCTFail("Expected pinch movement")
        }
        XCTAssertEqual(processor.process(sample(thumb: 0.5, index: 0.8)), .pinchEnded)
        XCTAssertFalse(processor.isPinching)
    }

    func testTwoHandPinchSupportsPanZoomAndRotation() {
        var processor = HandGestureProcessor()
        let left = sample(thumb: 0.5, index: 0.5, wristX: 0.2)
        let right = sample(thumb: 0.5, index: 0.5, wristX: 0.8)
        _ = processor.process([left, right])
        _ = processor.process([left, right])
        guard case .twoHandStarted = processor.process([left, right]) else {
            return XCTFail("Expected two-hand gesture")
        }
        let movedLeft = sample(thumb: 0.5, index: 0.5, wristX: 0.1)
        let movedRight = sample(thumb: 0.5, index: 0.5, wristX: 0.7)
        if case .twoHandMoved(let center, let scale, _) = processor.process([movedLeft, movedRight]) {
            XCTAssertEqual(center.x, 0.6, accuracy: 0.001)
            XCTAssertEqual(scale, 0.6, accuracy: 0.001)
        } else {
            XCTFail("Expected two-hand movement")
        }
        XCTAssertEqual(processor.process([movedLeft, sample(thumb: 0.5, index: 0.8, wristX: 0.7)]), .twoHandEnded)
    }

    func testResetCancelsActivePinch() {
        var processor = HandGestureProcessor()
        _ = processor.process(sample(thumb: 0.5, index: 0.5))
        _ = processor.process(sample(thumb: 0.5, index: 0.5))
        _ = processor.process(sample(thumb: 0.5, index: 0.5))
        processor.reset()
        XCTAssertFalse(processor.isPinching)
        XCTAssertNil(processor.process(sample(thumb: 0.5, index: 0.5)))
    }
}
