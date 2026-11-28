import XCTest
@testable import VISI0NSpatial

@MainActor
final class WindowManagerTests: XCTestCase {
    func testOpenDeduplicatesAndRestoresMinimizedWindow() throws {
        let store = WorkspaceStore()
        let manager = WindowManager(store: store)
        for id in manager.windows.map(\.id) { manager.close(id) }
        manager.flush()

        manager.open(.browser)
        let id = try XCTUnwrap(manager.selectedWindowID)
        manager.open(.browser)
        XCTAssertEqual(manager.windows.count, 1)
        XCTAssertEqual(manager.selectedWindowID, id)

        let original = try XCTUnwrap(manager.selectedWindow).placement
        manager.minimize(id)
        manager.open(.browser)
        XCTAssertEqual(manager.windows.count, 1)
        XCTAssertEqual(manager.selectedWindow?.lifecycle, .floating)
        XCTAssertEqual(manager.selectedWindow?.placement, original)
    }

    func testMaximizeAndFocusKeepLifecycle() throws {
        let manager = WindowManager()
        let id = try XCTUnwrap(manager.selectedWindowID)
        manager.maximize(id)
        manager.focus(id)
        XCTAssertEqual(manager.selectedWindow?.lifecycle, .maximized)
    }

    func testSnapshotRoundTrip() throws {
        let store = WorkspaceStore()
        let manager = WindowManager(store: store)
        let window = SpatialWindow(module: .files, placement: WindowPlacement(x: 3, y: -1, z: -5, width: 1.5, height: 2, yaw: 0.5, pitch: 0.2, roll: -0.1), positioning: .headLocked)
        manager.close(window.id)
        manager.open(.files)
        let selected = try XCTUnwrap(manager.selectedWindowID)
        manager.move(selected, to: window.placement)
        manager.setPositioning(.headLocked, for: selected)
        manager.togglePinned(selected)
        manager.flush()

        let restored = WindowManager(store: store)
        XCTAssertEqual(restored.windows.count, manager.windows.count)
        XCTAssertEqual(restored.selectedWindowID, selected)
        XCTAssertEqual(restored.selectedWindow?.placement, window.placement)
        XCTAssertEqual(restored.selectedWindow?.positioning, .headLocked)
        XCTAssertEqual(restored.selectedWindow?.isPinned, true)
    }

    func testDepthAndRotationAreClamped() throws {
        let manager = WindowManager()
        let id = try XCTUnwrap(manager.selectedWindowID)
        manager.adjustDepth(of: id, by: 100)
        XCTAssertEqual(manager.selectedWindow?.placement.z, -1.1)
        manager.rotateSelected(by: 100)
        let selected = try XCTUnwrap(manager.selectedWindow)
        XCTAssertEqual(selected.placement.roll, .pi, accuracy: 0.001)
    }
}
