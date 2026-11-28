import XCTest
import simd
@testable import VISI0NSpatial

final class StereoRigTests: XCTestCase {
    func testEyesUseParallelCamerasSeparatedByIPD() {
        let rig = StereoCameraRig(orientation: simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0)), interpupillaryDistance: 0.064)
        let left = rig.camera(.left, aspect: 1, fieldOfView: .pi / 2)
        let right = rig.camera(.right, aspect: 1, fieldOfView: .pi / 2)
        XCTAssertEqual(left.position.x, -0.032, accuracy: 0.00001)
        XCTAssertEqual(right.position.x, 0.032, accuracy: 0.00001)
        XCTAssertEqual(simd_distance(left.position, right.position), 0.064, accuracy: 0.00001)
        XCTAssertEqual(left.view.columns.0, right.view.columns.0)
        XCTAssertEqual(left.view.columns.1, right.view.columns.1)
        XCTAssertEqual(left.view.columns.2, right.view.columns.2)
        XCTAssertNotEqual(left.view.columns.3, right.view.columns.3)
        XCTAssertNotEqual(left.viewProjection.columns.3, right.viewProjection.columns.3)
    }

    func testZeroDepthProjectionMapsNearToZeroAndFarToOne() {
        let projection = StereoCameraRig.perspective(fieldOfView: 1, aspect: 1, near: 0.05, far: 60)
        let near = projection * SIMD4<Float>(0, 0, -0.05, 1)
        let far = projection * SIMD4<Float>(0, 0, -60, 1)
        XCTAssertEqual(near.z / near.w, 0, accuracy: 0.0001)
        XCTAssertEqual(far.z / far.w, 1, accuracy: 0.0001)
    }

    func testEyeCentersDifferForWorldPoint() {
        let rig = StereoCameraRig(orientation: simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0)), interpupillaryDistance: 0.064)
        let left = rig.camera(.left, aspect: 1, fieldOfView: 1)
        let right = rig.camera(.right, aspect: 1, fieldOfView: 1)
        let world = SIMD4<Float>(0, 0, -3.4, 1)
        let leftClip = left.viewProjection * world
        let rightClip = right.viewProjection * world
        XCTAssertLessThan(leftClip.x / leftClip.w, rightClip.x / rightClip.w)
    }

    func testLensCorrectionLeavesCenterAndExpandsEdges() {
        let center = LensDistortion.correct(SIMD2<Float>(0.5, 0.5), coefficient: 0.2)
        XCTAssertEqual(center.x, 0.5, accuracy: 0.0001)
        XCTAssertEqual(center.y, 0.5, accuracy: 0.0001)
        let edge = LensDistortion.correct(SIMD2<Float>(0.8, 0.5), coefficient: 0.2)
        XCTAssertGreaterThan(edge.x, 0.8)
    }

    func testGazeDwellCompletesOnceAndResetsOnNewTarget() {
        var dwell = GazeDwell(duration: 1)
        let first = UUID()
        let second = UUID()
        XCTAssertNil(dwell.update(target: first, now: 0))
        XCTAssertEqual(dwell.progress, 0)
        XCTAssertNil(dwell.update(target: first, now: 0.5))
        XCTAssertEqual(dwell.progress, 0.5, accuracy: 0.001)
        XCTAssertEqual(dwell.update(target: first, now: 1), first)
        XCTAssertNil(dwell.update(target: first, now: 2))
        XCTAssertEqual(dwell.progress, 1, accuracy: 0.001)
        XCTAssertNil(dwell.update(target: second, now: 2.1))
        XCTAssertEqual(dwell.progress, 0, accuracy: 0.001)
        XCTAssertEqual(dwell.update(target: second, now: 3.1), second)
        XCTAssertNil(dwell.update(target: nil, now: 3.2))
        XCTAssertEqual(dwell.progress, 0)
    }
}
