import XCTest
import simd
@testable import VISI0NSpatial

final class ScanMetadataTests: XCTestCase {
    func testMetadataRoundTripAndHonestLabel() throws {
        let metadata = ScanMetadata(version: 1, createdAt: Date(timeIntervalSince1970: 100), trackingState: "Normal", featurePointCount: 2, planeCount: 1, reconstruction: "ARKit world tracking, raw feature points, and estimated planes; not a LiDAR depth mesh.", sampledPoints: [ScanFeaturePoint(x: 1, y: 2, z: -3)])
        let restored = try JSONDecoder().decode(ScanMetadata.self, from: JSONEncoder().encode(metadata))
        XCTAssertEqual(restored.featurePointCount, 2)
        XCTAssertEqual(restored.planeCount, 1)
        XCTAssertTrue(restored.reconstruction.contains("not a LiDAR"))
        XCTAssertEqual(restored.sampledPoints.first?.x, 1)
    }
}
