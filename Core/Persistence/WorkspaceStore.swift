import Foundation

struct WorkspaceSnapshot: Codable, Equatable, Sendable {
    var version: Int
    var windows: [SpatialWindow]
    var selectedWindowID: UUID?

    static let empty = WorkspaceSnapshot(version: 1, windows: [], selectedWindowID: nil)
}

final class WorkspaceStore {
    static let shared = WorkspaceStore()

    private let fileURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(fileManager: FileManager = .default) {
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = documents.appendingPathComponent("VISI0N-SPATIAL", isDirectory: true)
            .appendingPathComponent("workspace.json")
    }

    func load() throws -> WorkspaceSnapshot {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return .empty }
        let data = try Data(contentsOf: fileURL)
        let snapshot = try decoder.decode(WorkspaceSnapshot.self, from: data)
        guard snapshot.version == 1 else { return .empty }
        return snapshot
    }

    func save(_ snapshot: WorkspaceSnapshot) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try encoder.encode(snapshot)
        try data.write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: fileURL.path)
    }
}
