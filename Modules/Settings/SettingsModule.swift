import SwiftUI

struct SettingsModuleView: View {
    @ObservedObject var coordinator: AppCoordinator
    @ObservedObject var settings: AppSettings
    @ObservedObject var motion: MotionTracker

    init(coordinator: AppCoordinator) {
        self.coordinator = coordinator
        self.settings = coordinator.settings
        self.motion = coordinator.motion
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                ModuleSection(title: "Optics") {
                    SettingsSlider(title: "Eye separation", value: $settings.ipdMillimeters, range: 50...80, step: 1, output: "\(Int(settings.ipdMillimeters)) mm")
                    SettingsSlider(title: "Screen distance", value: $settings.viewingDistance, range: 2...6, step: 0.1, output: String(format: "%.1f m", settings.viewingDistance))
                    SettingsSlider(title: "Field of view", value: $settings.fieldOfView, range: 50...100, step: 1, output: "\(Int(settings.fieldOfView))°")
                    SettingsSlider(title: "Lens correction", value: $settings.lensDistortion, range: 0...0.3, step: 0.01, output: String(format: "%.2f", settings.lensDistortion))
                    Button("Reset Optical Defaults") { settings.resetOpticalDefaults() }.buttonStyle(QuietButtonStyle())
                }

                ModuleSection(title: "Motion") {
                    Toggle("Head tracking", isOn: $settings.motionEnabled).tint(Theme.cyan)
                    SettingsSlider(title: "Sensitivity", value: $settings.motionSensitivity, range: 0.25...2, step: 0.05, output: String(format: "%.2fx", settings.motionSensitivity))
                    HStack {
                        Text(motionSummary).font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                        Spacer()
                        Button("Recalibrate") { motion.calibrate() }.buttonStyle(QuietButtonStyle())
                    }
                }

                ModuleSection(title: "Camera and hands") {
                    Toggle("Rear camera", isOn: Binding(get: { settings.cameraEnabled }, set: { enabled in
                        Task { await coordinator.updateCamera(enabled: enabled) }
                    })).tint(Theme.cyan)
                    Toggle("Hand gestures", isOn: Binding(get: { settings.handTrackingEnabled }, set: { enabled in
                        if enabled, !settings.cameraEnabled {
                            coordinator.showMessage("Enable the rear camera before starting hand tracking.")
                        } else {
                            coordinator.setHandTracking(enabled: enabled)
                        }
                    })).tint(Theme.cyan)
                    Text("Vision hand processing runs on this device. Pinch and move to select and reposition the nearest spatial window; pinch distance changes size.")
                        .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                    if coordinator.permissions.cameraStatus == .denied {
                        Button("Open Camera Settings") { coordinator.permissions.openSettings() }.buttonStyle(QuietButtonStyle())
                    }
                }

                ModuleSection(title: "Rendering") {
                    Toggle("Performance overlay", isOn: $settings.showPerformance).tint(Theme.cyan)
                    Text("Adaptive rendering reduces resolution under load. Window creation is limited by memory and thermal state.")
                        .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                }
            }
            .padding(22)
        }
    }

    private var motionSummary: String {
        switch motion.status {
        case .running: "Tracking • 90 Hz target"
        case .interrupted: "Interrupted • touch look remains available"
        case .unavailable: "Motion unavailable on this device"
        case .failed: "Motion error"
        case .stopped: "Stopped"
        }
    }
}
