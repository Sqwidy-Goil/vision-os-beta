import XCTest
@testable import VISI0NSpatial

final class DocumentStoreTests: XCTestCase {
    func testImportWriteUniqueNamesAndRemove() throws {
        let store = DocumentStore()
        let first = try store.write(Data("first".utf8), to: "unit-test.txt")
        let second = try store.write(Data("second".utf8), to: "unit-test.txt")
        defer {
            try? store.remove(first)
            try? store.remove(second)
        }
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(try Data(contentsOf: first), Data("first".utf8))
        XCTAssertTrue(try store.documents().contains(first))
        try store.remove(first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
    }
}
