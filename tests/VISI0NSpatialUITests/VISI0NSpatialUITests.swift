import XCTest

final class VISI0NSpatialUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testLaunchLauncherAndOpenBrowser() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-test-reset"]
        app.launch()
        XCTAssertTrue(app.staticTexts["VISI0N SPATIAL"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["module-browser"].waitForExistence(timeout: 5))
        app.buttons["module-browser"].tap()
        app.buttons["open-selected-window"].tap()
        XCTAssertTrue(app.textFields["Search or enter a website"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertFalse(app.textFields["Search or enter a website"].exists)
    }

    func testSettingsAndVRCalibrationOpen() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-test-reset"]
        app.launch()
        XCTAssertTrue(app.buttons["module-settings"].waitForExistence(timeout: 5))
        app.buttons["module-settings"].tap()
        app.buttons["open-selected-window"].tap()
        XCTAssertTrue(app.staticTexts["OPTICS"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.buttons["enter-vr"].tap()
        XCTAssertTrue(app.staticTexts["Fit your spatial view"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertFalse(app.staticTexts["Fit your spatial view"].exists)
    }

    func testVRCountdownEntersStereoMode() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-test-reset"]
        app.launch()
        XCTAssertTrue(app.buttons["enter-vr"].waitForExistence(timeout: 5))
        app.buttons["enter-vr"].tap()
        app.buttons["Enter VR"].tap()
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["Handheld workspace"])
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 6), .completed)
    }
}
