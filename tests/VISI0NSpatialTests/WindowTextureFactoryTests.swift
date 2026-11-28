import XCTest
import UIKit
@testable import VISI0NSpatial

final class WindowTextureFactoryTests: XCTestCase {
    func testTextureReflectsWindowLifecycleAndStatus() {
        var window = SpatialWindow(module: .scanner)
        let normal = WindowTextureFactory.image(for: window, status: "100 feature points")
        XCTAssertGreaterThan(normal.size.width, 1)
        XCTAssertGreaterThan(normal.size.height, 1)
        window.minimize()
        let minimized = WindowTextureFactory.image(for: window, status: "100 feature points")
        XCTAssertGreaterThan(minimized.size.width / minimized.size.height, normal.size.width / normal.size.height)
    }

    func testPlaceholderIsRenderable() {
        let image = WindowTextureFactory.placeholder()
        XCTAssertNotNil(image.cgImage)
        XCTAssertEqual(image.size, CGSize(width: 640, height: 360))
    }
}
