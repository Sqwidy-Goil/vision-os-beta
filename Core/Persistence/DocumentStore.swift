import Foundation
import UniformTypeIdentifiers

final class DocumentStore {
    static let shared = DocumentStore()

    let rootURL: URL

    init(fileManager: FileManager = .default) {
        rootURL = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("VISI0N-SPATIAL", isDirectory: true)
        try? fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)
    }

    func documents() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey, .isDirectoryKey]
        ).sorted {
            modificationDate(for: $0) > modificationDate(for: $1)
        }
    }

    private func modificationDate(for url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    @discardableResult
    func importItem(_ url: URL) throws -> URL {
        let needsCopy = url.startAccessingSecurityScopedResource()
        defer { if needsCopy { url.stopAccessingSecurityScopedResource() } }
        let destination = uniqueURL(for: url.lastPathComponent)
        try FileManager.default.copyItem(at: url, to: destination)
        return destination
    }

    func uniqueURL(for fileName: String) -> URL {
        let base = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        var candidate = rootURL.appendingPathComponent(fileName)
        var index = 1
        while FileManager.default.fileExists(atPath: candidate.path) {
            let suffix = ext.isEmpty ? " \(index)" : " \(index).\(ext)"
            candidate = rootURL.appendingPathComponent(base + suffix)
            index += 1
        }
        return candidate
    }

    func write(_ data: Data, to fileName: String) throws -> URL {
        let url = uniqueURL(for: fileName)
        try data.write(to: url, options: .atomic)
        return url
    }

    func remove(_ url: URL) throws {
        guard url.deletingLastPathComponent().standardizedFileURL == rootURL.standardizedFileURL else {
            throw CocoaError(.fileWriteNoPermission)
        }
        try FileManager.default.removeItem(at: url)
    }

    func contentType(for url: URL) -> UTType? {
        UTType(filenameExtension: url.pathExtension)
    }
}
