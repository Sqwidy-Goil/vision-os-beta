import ARKit
import AVFoundation
import Foundation
import simd

enum ScannerStatus: Equatable {
    case stopped
    case requestingPermission
    case running
    case limited(String)
    case unavailable(String)
    case permissionDenied
    case failed(String)
}

struct ScanFeaturePoint: Codable, Sendable {
    var x: Float
    var y: Float
    var z: Float
}

struct ScanMetadata: Codable, Sendable {
    var version: Int
    var createdAt: Date
    var trackingState: String
    var featurePointCount: Int
    var planeCount: Int
    var reconstruction: String
    var sampledPoints: [ScanFeaturePoint]
}

@MainActor
final class ScannerService: ObservableObject {
    @Published private(set) var status: ScannerStatus = .stopped
    @Published private(set) var featurePointCount = 0
    @Published private(set) var planeCount = 0
    @Published private(set) var trackingState = "Not started"
    @Published private(set) var lastSavedMap: URL?
    @Published private(set) var lastSavedPoints: URL?
    @Published private(set) var loadedMetadata: ScanMetadata?
    @Published var error: String?

    let session = ARSession()
    private var timer: Timer?

    init() {
        NotificationCenter.default.addObserver(self, selector: #selector(sessionWasInterrupted), name: Notification.Name("ARSessionWasInterrupted"), object: session)
        NotificationCenter.default.addObserver(self, selector: #selector(sessionInterruptionEnded), name: Notification.Name("ARSessionWasInterruptionEnded"), object: session)
    }

    deinit {
        timer?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    var isSessionActive: Bool {
        if case .running = status { return true }
        if case .limited = status { return true }
        return false
    }

    func start() async {
        guard ARWorldTrackingConfiguration.isSupported else {
            status = .unavailable("ARKit world tracking is unavailable on this device.")
            return
        }
        status = .requestingPermission
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            status = .permissionDenied
            return
        }
        let configuration = ARWorldTrackingConfiguration()
        configuration.planeDetection = [.horizontal, .vertical]
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        status = .running
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sampleFrame() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        session.pause()
        status = .stopped
        trackingState = "Stopped"
    }

    func saveScan(name: String) async {
        guard session.currentFrame != nil else {
            error = "Start scanning before saving."
            return
        }
        let snapshot = makeMetadata()
        let safeName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        let base = "Scan-\(safeName.isEmpty ? "workspace" : safeName)-\(Int(Date().timeIntervalSince1970))"
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let metadataData = try encoder.encode(snapshot)
            lastSavedPoints = try DocumentStore.shared.write(metadataData, to: "\(base).visionpoints.json")
            await saveWorldMap(base: base)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadWorldMap(from url: URL) async {
        guard ARWorldTrackingConfiguration.isSupported else {
            status = .unavailable("ARKit world tracking is unavailable on this device.")
            return
        }
        status = .requestingPermission
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            status = .permissionDenied
            return
        }
        restoreWorldMap(from: url)
    }

    func loadScan(_ url: URL) async {
        if url.pathExtension.lowercased() == "visionmap" {
            await loadWorldMap(from: url)
        } else if url.lastPathComponent.contains(".visionpoints.") {
            loadMetadata(from: url)
        } else {
            error = "Choose a VISI0N world map or its saved point metadata."
        }
    }

    func loadMetadata(from url: URL) {
        let needsScope = url.startAccessingSecurityScopedResource()
        defer { if needsScope { url.stopAccessingSecurityScopedResource() } }
        do {
            loadedMetadata = try JSONDecoder().decode(ScanMetadata.self, from: Data(contentsOf: url))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func restoreWorldMap(from url: URL) {
        let needsScope = url.startAccessingSecurityScopedResource()
        defer { if needsScope { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard let map = try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: data) else {
                error = "The selected file is not a valid VISI0N SPATIAL world map."
                return
            }
            let configuration = ARWorldTrackingConfiguration()
            configuration.initialWorldMap = map
            configuration.planeDetection = [.horizontal, .vertical]
            session.run(configuration, options: [])
            status = .running
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.sampleFrame() }
            }
            let pointsName = url.deletingPathExtension().lastPathComponent + ".visionpoints.json"
            loadedMetadata = nil
            if let pointsURL = (try? DocumentStore.shared.documents())?.first(where: { $0.lastPathComponent == pointsName }) {
                loadedMetadata = try? JSONDecoder().decode(ScanMetadata.self, from: Data(contentsOf: pointsURL))
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
            status = .failed(error.localizedDescription)
        }
    }

    func scanFiles() -> [URL] {
        ((try? DocumentStore.shared.documents()) ?? []).filter {
            $0.pathExtension == "visionmap" || $0.lastPathComponent.contains(".visionpoints.")
        }
    }

    private func saveWorldMap(base: String) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.getCurrentWorldMap { [weak self] map, failure in
                Task { @MainActor in
                    guard let self else {
                        continuation.resume()
                        return
                    }
                    if let failure {
                        self.error = "World map export failed: \(failure.localizedDescription)"
                    } else if let map {
                        do {
                            let data = try NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true)
                            self.lastSavedMap = try DocumentStore.shared.write(data, to: "\(base).visionmap")
                            self.error = nil
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                    continuation.resume()
                }
            }
        }
    }

    private func sampleFrame() {
        guard let frame = session.currentFrame else { return }
        featurePointCount = frame.rawFeaturePoints?.points.count ?? 0
        planeCount = frame.anchors.reduce(0) { count, anchor in
            count + (anchor is ARPlaneAnchor ? 1 : 0)
        }
        switch frame.camera.trackingState {
        case .normal:
            trackingState = "Normal"
            if case .limited = status { status = .running }
        case .limited(let reason):
            let message: String
            switch reason {
            case .initializing: message = "Initializing tracking"
            case .excessiveMotion: message = "Move more slowly"
            case .insufficientFeatures: message = "Add light or surface detail"
            case .relocalizing: message = "Relocalizing world map"
            @unknown default: message = "Tracking is limited"
            }
            trackingState = message
            status = .limited(message)
        case .notAvailable:
            trackingState = "Unavailable"
            status = .limited("Tracking unavailable")
        @unknown default:
            trackingState = "Unknown"
        }
    }

    private func makeMetadata() -> ScanMetadata {
        let points = session.currentFrame?.rawFeaturePoints
        let count = points?.points.count ?? 0
        let stride = max(1, count / 10_000)
        var samples: [ScanFeaturePoint] = []
        if let points {
            samples.reserveCapacity((count + stride - 1) / stride)
            for index in Swift.stride(from: 0, to: count, by: stride) {
                let point = points.points[index]
                samples.append(ScanFeaturePoint(x: point.x, y: point.y, z: point.z))
            }
        }
        return ScanMetadata(
            version: 1,
            createdAt: Date(),
            trackingState: trackingState,
            featurePointCount: count,
            planeCount: planeCount,
            reconstruction: "ARKit world tracking, raw feature points, and estimated planes; not a LiDAR depth mesh.",
            sampledPoints: samples
        )
    }

    @objc nonisolated private func sessionInterruptionEnded(_ notification: Notification) {
        Task { @MainActor [weak self] in
            self?.sampleFrame()
        }
    }

    @objc nonisolated private func sessionWasInterrupted(_ notification: Notification) {
        Task { @MainActor [weak self] in
            self?.trackingState = "Session interrupted"
            self?.status = .limited("Session interrupted")
        }
    }
}
