import Foundation
import Combine

private struct AppSettingsSnapshot: Codable {
    var ipdMillimeters: Double
    var viewingDistance: Double
    var fieldOfView: Double
    var lensDistortion: Double
    var motionSensitivity: Double
    var motionEnabled: Bool
    var cameraEnabled: Bool
    var handTrackingEnabled: Bool
    var showPerformance: Bool
    var environmentKind: EnvironmentKind
    var panoramaFileName: String?
}

@MainActor
final class AppSettings: ObservableObject {
    @Published var ipdMillimeters: Double { didSet { persist() } }
    @Published var viewingDistance: Double { didSet { persist() } }
    @Published var fieldOfView: Double { didSet { persist() } }
    @Published var lensDistortion: Double { didSet { persist() } }
    @Published var motionSensitivity: Double { didSet { persist() } }
    @Published var motionEnabled: Bool { didSet { persist() } }
    @Published var cameraEnabled: Bool { didSet { persist() } }
    @Published var handTrackingEnabled: Bool { didSet { persist() } }
    @Published var showPerformance: Bool { didSet { persist() } }
    @Published var environmentKind: EnvironmentKind { didSet { persist() } }
    @Published var panoramaFileName: String? { didSet { persist() } }

    private let defaultsKey = "vision-spatial.settings.v1"

    init() {
        let defaults = UserDefaults.standard
        ipdMillimeters = 64
        viewingDistance = 3.4
        fieldOfView = 78
        lensDistortion = 0
        motionSensitivity = 1
        motionEnabled = true
        cameraEnabled = false
        handTrackingEnabled = false
        showPerformance = false
        environmentKind = .studio
        panoramaFileName = nil

        guard let data = defaults.data(forKey: defaultsKey),
              let saved = try? JSONDecoder().decode(AppSettingsSnapshot.self, from: data) else { return }
        ipdMillimeters = saved.ipdMillimeters
        viewingDistance = saved.viewingDistance
        fieldOfView = saved.fieldOfView
        lensDistortion = saved.lensDistortion
        motionSensitivity = saved.motionSensitivity
        motionEnabled = saved.motionEnabled
        cameraEnabled = saved.cameraEnabled
        handTrackingEnabled = saved.handTrackingEnabled
        showPerformance = saved.showPerformance
        environmentKind = saved.environmentKind
        panoramaFileName = saved.panoramaFileName
    }

    var panoramaURL: URL? {
        guard let panoramaFileName else { return nil }
        return DocumentStore.shared.rootURL.appendingPathComponent(panoramaFileName)
    }

    func resetOpticalDefaults() {
        ipdMillimeters = 64
        viewingDistance = 3.4
        fieldOfView = 78
        lensDistortion = 0
    }

    private func persist() {
        let snapshot = AppSettingsSnapshot(
            ipdMillimeters: ipdMillimeters,
            viewingDistance: viewingDistance,
            fieldOfView: fieldOfView,
            lensDistortion: lensDistortion,
            motionSensitivity: motionSensitivity,
            motionEnabled: motionEnabled,
            cameraEnabled: cameraEnabled,
            handTrackingEnabled: handTrackingEnabled,
            showPerformance: showPerformance,
            environmentKind: environmentKind,
            panoramaFileName: panoramaFileName
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: defaultsKey)
    }
}
