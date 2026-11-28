import Foundation
import XCTest
@testable import VisionCompanionProtocol

final class SpatialProtocolTests: XCTestCase {
    func testCovarianceRotationMatchesWorldYUpCalibration() throws {
        var covariance = [Double](repeating: 0, count: 36)
        covariance[0] = 4
        covariance[7] = 1
        covariance[14] = 0.25
        let quarterTurn = [0.0, 0.0, sqrt(0.5), sqrt(0.5)]
        let transformed = SpatialMath.transformCovariance6(covariance, orientation: quarterTurn)
        XCTAssertEqual(transformed[0], 1, accuracy: 1e-9)
        XCTAssertEqual(transformed[7], 4, accuracy: 1e-9)
        XCTAssertEqual(transformed[14], 0.25, accuracy: 1e-9)
        XCTAssertTrue(SpatialMath.isPositiveSemidefinite(transformed, size: 6))
        XCTAssertEqual(SpatialMath.multiply([0, 0, 0, 1], quarterTurn), quarterTurn)
    }

    func testDepthPlannerProducesFullRectangleAndUnchangedUpdates() throws {
        let firstIntrinsics = CameraIntrinsicsWire(width: 4, height: 4, fx: 4, fy: 4, cx: 2, cy: 2, timestamp: 1000)
        let values = [Float](repeating: 1, count: 16)
        let confidence = [Float](repeating: 0.8, count: 16)
        let full = try DepthPlanner.plan(previous: nil, nextValues: values, nextConfidence: confidence, intrinsics: firstIntrinsics)
        XCTAssertEqual(full.mode, .full)
        let nextIntrinsics = CameraIntrinsicsWire(width: 4, height: 4, fx: 4, fy: 4, cx: 2, cy: 2, timestamp: 1100)
        let unchanged = try DepthPlanner.plan(previous: full, nextValues: values, nextConfidence: confidence, intrinsics: nextIntrinsics)
        XCTAssertEqual(unchanged.mode, .unchanged)
        XCTAssertEqual(unchanged.intrinsics.timestamp, 1000)

        var changed = values
        changed[5] = 2
        let rectangle = try DepthPlanner.plan(previous: full, nextValues: changed, nextConfidence: confidence, intrinsics: nextIntrinsics)
        XCTAssertEqual(rectangle.mode, .rect)
        XCTAssertEqual(rectangle.x, 1)
        XCTAssertEqual(rectangle.y, 1)
        XCTAssertEqual(rectangle.values, [2])
        XCTAssertEqual(rectangle.baseWidth, 4)
        XCTAssertEqual(rectangle.baseHeight, 4)

        changed = values
        for index in 0..<8 { changed[index] = 2 }
        let fullChange = try DepthPlanner.plan(previous: full, nextValues: changed, nextConfidence: confidence, intrinsics: nextIntrinsics)
        XCTAssertEqual(fullChange.mode, .full)
    }

    func testFullAndIncrementalSampleValidation() throws {
        let first = sample(frameId: 1, timestamp: 1000)
        try SpatialValidator.validateCalibration(CalibrationWire(calibrationId: "cal-1", confidence: 0.85).dictionary())
        try SpatialValidator.validateSample(first.dictionary())
        let second = sample(frameId: 2, timestamp: 1100, reset: false, baseFrameId: 1)
        try SpatialValidator.validateSample(
            second.dictionary(),
            previousFrameId: 1,
            previousTimestamp: 1000,
            previousDepthIntrinsics: first.depth?.intrinsics
        )
        var unchanged = second.dictionary()
        var unchangedDepth = try XCTUnwrap(unchanged["depth"] as? [String: Any])
        unchangedDepth["mode"] = "unchanged"
        unchangedDepth["values"] = nil
        unchangedDepth["confidence"] = nil
        unchangedDepth["intrinsics"] = try XCTUnwrap(first.depth?.intrinsics.dictionary())
        unchanged["depth"] = unchangedDepth
        try SpatialValidator.validateSample(
            unchanged,
            previousFrameId: 1,
            previousTimestamp: 1000,
            previousDepthIntrinsics: first.depth?.intrinsics
        )
        var stale = second.dictionary()
        stale["timestamp"] = 1000
        XCTAssertThrowsError(try SpatialValidator.validateSample(stale, previousFrameId: 1, previousTimestamp: 1000))
        var unknown = first.dictionary()
        unknown["unexpected"] = true
        XCTAssertThrowsError(try SpatialValidator.validateSample(unknown))
        var estimated = first.dictionary()
        var depth = try XCTUnwrap(estimated["depth"] as? [String: Any])
        var intrinsics = try XCTUnwrap(depth["intrinsics"] as? [String: Any])
        intrinsics["calibration"] = "estimated"
        depth["intrinsics"] = intrinsics
        estimated["depth"] = depth
        XCTAssertThrowsError(try SpatialValidator.validateSample(estimated))
    }

    func testUnchangedDepthUsesMostRecentRectangleIntrinsics() throws {
        let first = sample(frameId: 1, timestamp: 1000)
        let firstDepth = try XCTUnwrap(first.depth)
        let rectangleIntrinsics = CameraIntrinsicsWire(width: 2, height: 2, fx: 2, fy: 2, cx: 1, cy: 1, timestamp: 1100)
        let changedValues: [Float] = [0, 2, 2, 3]
        let rectangle = try DepthPlanner.plan(
            previous: firstDepth,
            nextValues: changedValues,
            nextConfidence: try XCTUnwrap(firstDepth.confidence),
            intrinsics: rectangleIntrinsics
        )
        XCTAssertEqual(rectangle.mode, .rect)

        let second = sample(frameId: 2, timestamp: 1100, reset: false, baseFrameId: 1)
        var secondDictionary = second.dictionary()
        secondDictionary["depth"] = rectangle.dictionary()
        try SpatialValidator.validateSample(
            secondDictionary,
            previousFrameId: 1,
            previousTimestamp: 1000,
            previousDepthIntrinsics: firstDepth.intrinsics
        )

        let currentFull = DepthUpdateWire(
            mode: .full,
            width: 2,
            height: 2,
            intrinsics: rectangleIntrinsics,
            values: changedValues,
            confidence: try XCTUnwrap(firstDepth.confidence)
        )
        let unchanged = try DepthPlanner.plan(
            previous: currentFull,
            nextValues: changedValues,
            nextConfidence: try XCTUnwrap(firstDepth.confidence),
            intrinsics: CameraIntrinsicsWire(width: 2, height: 2, fx: 2, fy: 2, cx: 1, cy: 1, timestamp: 1200)
        )
        XCTAssertEqual(unchanged.mode, .unchanged)
        XCTAssertEqual(unchanged.intrinsics.timestamp, 1100)

        let third = sample(frameId: 3, timestamp: 1200, reset: false, baseFrameId: 2)
        var thirdDictionary = third.dictionary()
        thirdDictionary["depth"] = unchanged.dictionary()
        try SpatialValidator.validateSample(
            thirdDictionary,
            previousFrameId: 2,
            previousTimestamp: 1100,
            previousDepthIntrinsics: rectangle.intrinsics
        )
        XCTAssertThrowsError(try SpatialValidator.validateSample(
            thirdDictionary,
            previousFrameId: 2,
            previousTimestamp: 1100,
            previousDepthIntrinsics: firstDepth.intrinsics
        ))
    }

    func testPlaneMeshAndConservativeEmptyCapabilities() throws {
        let update = sample(frameId: 1, timestamp: 1000)
        let plane = SurfaceWire(
            id: "plane-1",
            kind: .plane,
            normal: [0, 1, 0],
            point: [0, 0, 1],
            confidence: 0.65,
            observedAt: 1000
        )
        let mesh = SurfaceWire(
            id: "mesh-1",
            kind: .mesh,
            vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            confidence: 0.65,
            observedAt: 1000
        )
        var dictionary = update.dictionary()
        dictionary["surfaces"] = [plane.dictionary(), mesh.dictionary()]
        try SpatialValidator.validateSample(dictionary)
        XCTAssertTrue((dictionary["objects"] as? [[String: Any]])?.isEmpty == true)
        XCTAssertTrue((dictionary["freeSpace"] as? [[String: Any]])?.isEmpty == true)
    }

    private func sample(frameId: Int, timestamp: Double, reset: Bool = true, baseFrameId: Int = 0) -> SpatialUpdateWire {
        var covariance = [Double](repeating: 0, count: 36)
        covariance[0] = covariance[7] = covariance[14] = 0.01
        covariance[21] = covariance[28] = covariance[35] = 0.0004
        let intrinsics = CameraIntrinsicsWire(width: 2, height: 2, fx: 2, fy: 2, cx: 1, cy: 1, timestamp: timestamp)
        return SpatialUpdateWire(
            frameId: frameId,
            timestamp: timestamp,
            baseFrameId: baseFrameId,
            reset: reset,
            calibrationId: "cal-1",
            pose: reset ? .full(PoseWire(position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], covariance: covariance, confidence: 0.9)) : .delta(PoseDeltaWire(position: [0.01, 0, 0])),
            calibrationConfidence: 0.85,
            depth: DepthUpdateWire(mode: .full, width: 2, height: 2, intrinsics: intrinsics, values: [0, 1, 2, 3], confidence: [0, 0.9, 0.8, 0.7]),
            surfaces: reset ? [] : nil,
            objects: reset ? [] : nil,
            freeSpace: reset ? [] : nil,
            removed: nil
        )
    }
}
