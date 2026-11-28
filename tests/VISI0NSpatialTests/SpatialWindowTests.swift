import XCTest
@testable import VISI0NSpatial

final class SpatialWindowTests: XCTestCase {
    func testPlacementClampsUnsafeValues() {
        let placement = WindowPlacement(x: 100, y: -100, z: 100, width: 100, height: -5, yaw: 100, pitch: 100, roll: -100).clamped()
        XCTAssertEqual(placement.x, 7)
        XCTAssertEqual(placement.y, -4)
        XCTAssertEqual(placement.z, -1.1)
        XCTAssertEqual(placement.width, 5.2)
        XCTAssertEqual(placement.height, 0.3)
        XCTAssertEqual(placement.yaw, .pi, accuracy: 0.001)
        XCTAssertEqual(placement.pitch, 1.2, accuracy: 0.001)
        XCTAssertEqual(placement.roll, -.pi, accuracy: 0.001)
    }

    func testMinimizeAndRestorePreservePlacement() {
        var window = SpatialWindow(module: .browser, placement: WindowPlacement(x: 2, y: 1, z: -4, width: 3, height: 1.5, yaw: 0.2, pitch: 0.1, roll: 0.3))
        let original = window.placement
        window.minimize()
        XCTAssertEqual(window.lifecycle, .minimized)
        XCTAssertEqual(window.restorePlacement, original)
        XCTAssertLessThan(window.placement.width, original.width)
        window.restore()
        XCTAssertEqual(window.lifecycle, .floating)
        XCTAssertEqual(window.placement, original)
    }

    func testMaximizeThenRestore() {
        var window = SpatialWindow(module: .files)
        let original = window.placement
        window.maximize()
        XCTAssertEqual(window.lifecycle, .maximized)
        XCTAssertEqual(window.restorePlacement, original)
        XCTAssertEqual(window.placement.width, 3.5)
        window.restore()
        XCTAssertEqual(window.placement, original)
    }

    func testPinRoundTrip() {
        var window = SpatialWindow(module: .camera)
        window.togglePinned()
        XCTAssertTrue(window.isPinned)
        window.togglePinned()
        XCTAssertFalse(window.isPinned)
    }
}
