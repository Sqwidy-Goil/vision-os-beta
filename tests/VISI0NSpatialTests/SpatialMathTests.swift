import XCTest
import simd
@testable import VISI0NSpatial

final class SpatialMathTests: XCTestCase {
    func testCenterRayLooksForward() {
        let camera = StereoCameraRig(orientation: simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0)), interpupillaryDistance: 0.064)
            .camera(.left, aspect: 1, fieldOfView: .pi / 2)
        let ray = SpatialMath.ray(from: CGPoint(x: 100, y: 100), viewport: CGRect(x: 0, y: 0, width: 200, height: 200), viewProjection: camera.viewProjection)
        XCTAssertEqual(simd_length(ray.origin - camera.position), 0, accuracy: 0.0001)
        XCTAssertEqual(ray.direction.x, 0, accuracy: 0.0001)
        XCTAssertEqual(ray.direction.y, 0, accuracy: 0.0001)
        XCTAssertEqual(ray.direction.z, -1, accuracy: 0.0001)
    }

    func testPlaneIntersection() throws {
        let point = SpatialMath.intersectPlane(rayOrigin: SIMD3<Float>(0, 0, 0), rayDirection: SIMD3<Float>(0, 0, -1), planePoint: SIMD3<Float>(0, 0, -3), planeNormal: SIMD3<Float>(0, 0, 1))
        let intersection = try XCTUnwrap(point)
        XCTAssertEqual(intersection.z, -3, accuracy: 0.0001)
        XCTAssertNil(SpatialMath.intersectPlane(rayOrigin: SIMD3<Float>(0, 0, 0), rayDirection: SIMD3<Float>(0, 1, 0), planePoint: SIMD3<Float>(0, 0, -3), planeNormal: SIMD3<Float>(0, 0, 1)))
    }

    func testLocalHitConvertsWorldPointToNormalizedQuad() throws {
        let window = SpatialWindow(module: .browser, placement: WindowPlacement(x: 1, y: 2, z: -3, width: 2, height: 1, yaw: 0, pitch: 0, roll: 0))
        let model = SpatialMath.modelMatrix(for: window, headOrientation: simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0)))
        let point = SIMD3<Float>(1.5, 2.25, -3)
        let local = SpatialMath.localHit(point: point, modelMatrix: model)
        let hit = try XCTUnwrap(local)
        XCTAssertEqual(hit.x, 0.25, accuracy: 0.0001)
        XCTAssertEqual(hit.y, 0.25, accuracy: 0.0001)
    }

    func testHeadLockedWindowFollowsHeadAndWorldLockedDoesNot() {
        let window = SpatialWindow(module: .settings, placement: WindowPlacement(x: 0, y: 0, z: -3, width: 2, height: 1, yaw: 0, pitch: 0, roll: 0), positioning: .headLocked)
        let identity = simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))
        let yaw = simd_quatf(angle: .pi / 2, axis: SIMD3<Float>(0, 1, 0))
        let headModel = SpatialMath.modelMatrix(for: window, headOrientation: yaw)
        let center = headModel * SIMD4<Float>(0, 0, 0, 1)
        XCTAssertEqual(center.x, -3, accuracy: 0.001)
        XCTAssertEqual(center.z, 0, accuracy: 0.001)
        var worldWindow = window
        worldWindow.positioning = .worldLocked
        let worldCenter = SpatialMath.modelMatrix(for: worldWindow, headOrientation: yaw) * SIMD4<Float>(0, 0, 0, 1)
        XCTAssertEqual(worldCenter.z, -3, accuracy: 0.001)
        let worldPosition = SIMD3<Float>(worldCenter.x, worldCenter.y, worldCenter.z)
        XCTAssertEqual(simd_length(worldPosition), simd_length(SIMD3<Float>(center.x, center.y, center.z)), accuracy: 0.001)
        XCTAssertEqual(simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0)).vector, identity.vector)
    }
}
