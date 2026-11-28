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
        XCTAssertTrue(app.buttons["open-selected-window"].waitForExistence(timeout: 5))
        app.buttons["open-selected-window"].tap()
        XCTAssertTrue(app.textFields["Search or enter a website"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertFalse(app.textFields["Search or enter a website"].exists)
    }

    func testSettingsAndVRCalibrationOpen() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-test-reset"]
        app.launch()
        XCTAssertTrue(app.buttons["module-browser"].waitForExistence(timeout: 5))
        let settings = app.buttons["module-settings"]
        for _ in 0..<3 where !settings.exists {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.buttons["open-selected-window"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.buttons["calibration-enter-vr"].waitForExistence(timeout: 5))
        app.buttons["calibration-enter-vr"].tap()
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["Handheld workspace"])
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 6), .completed)
    }
}
