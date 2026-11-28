import Foundation
import simd

enum AppMode: String, Sendable {
    case handheld
    case spatial
    case vr
}

enum AppConfiguration {
    static let productName = "VISI0N SPATIAL"
    static let bundleIdentifier = "com.visionspatial.iphone"
    static let deploymentTarget = "18.0"
    static let workspaceDirectory = "VISI0N-SPATIAL"
    static let defaultIPDMillimeters: Double = 64
    static let defaultViewingDistance: Double = 3.4
    static let maximumHands = 2
}

@MainActor
final class AppCoordinator: NSObject, ObservableObject {
    @Published var mode: AppMode = .handheld
    @Published var activeModule: AppModule?
    @Published var showLauncher = true
    @Published var showCalibration = false
    @Published var notice: String?
    @Published var renderError: String?
    @Published var renderSnapshot = RenderFrameSnapshot(frameTime: 0, fps: 0, pixelRatio: 1, windowCount: 0, drawCalls: 0)
    @Published var vrMessage: String?

    let windowManager = WindowManager()
    let settings = AppSettings()
    let motion = MotionTracker()
    let permissions = PermissionCenter()
    let camera = CameraService()
    let handTracking = HandTrackingService()

    private var cameraTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?

    override init() {
        super.init()
        camera.frameDelegate = handTracking
        handTracking.onGesture = { [weak self] event in
            self?.handleHandGesture(event)
        }
    }

    var statuses: [AppModule: String] {
        var result: [AppModule: String] = [
            .browser: "Ready • full browsing in handheld mode",
            .photos: "On-device photo import",
            .video: "Local video playback",
            .music: "Local audio playback",
            .files: "\(documentCount) local items",
            .scanner: "ARKit feature points • no LiDAR mesh",
            .settings: "IPD \(Int(settings.ipdMillimeters)) mm • distance \(String(format: "%.1f", settings.viewingDistance)) m",
            .environments: settings.environmentKind.title,
            .windows: "\(windowManager.windows.count) of \(windowManager.resourceBudget) resource slots"
        ]
        result[.camera] = "\(cameraStatusSummary) • \(handStatusSummary)"
        if mode == .vr, let selected = windowManager.selectedWindow {
            result[selected.module] = vrMessage ?? "Gaze + dwell selects • hold opens in handheld mode"
        }
        return result
    }

    var documentCount: Int {
        (try? DocumentStore.shared.documents().count) ?? 0
    }

    func launch(_ module: AppModule) {
        windowManager.open(module)
        showMessage("\(module.title) opened in the shared scene.")
    }

    func openWindow(_ window: SpatialWindow) {
        windowManager.focus(window.id)
        guard mode != .vr else {
            exitVR()
            mode = .handheld
            activeModule = window.module
            return
        }
        activeModule = window.module
    }

    func enterVR() {
        activeModule = nil
        showCalibration = false
        vrMessage = nil
        mode = .vr
        if settings.motionEnabled {
            motion.start()
            motion.calibrate()
        }
    }

    func exitVR() {
        mode = .spatial
        showMessage("VR exited. Touch look is available in spatial mode.")
    }

    func toggleSpatialMode() {
        mode = mode == .handheld ? .spatial : .handheld
    }

    func updateCamera(enabled: Bool) async {
        settings.cameraEnabled = enabled
        cameraTask?.cancel()
        cameraTask = nil
        guard enabled else {
            camera.stop()
            handTracking.stop()
            settings.handTrackingEnabled = false
            return
        }
        if settings.handTrackingEnabled {
            handTracking.start()
        } else {
            handTracking.stop()
        }
        cameraTask = Task { [weak self] in
            let started = await self?.camera.start() ?? false
            guard !Task.isCancelled else { return }
            if !started {
                await MainActor.run {
                    self?.settings.cameraEnabled = false
                    self?.showMessage("Rear camera is unavailable or permission was denied.")
                }
            }
        }
    }

    func stopCameraSession() {
        cameraTask?.cancel()
        cameraTask = nil
        camera.stop()
        handTracking.stop()
    }

    func restartCameraIfNeeded() async {
        guard settings.cameraEnabled else { return }
        await updateCamera(enabled: true)
    }

    func setHandTracking(enabled: Bool) {
        settings.handTrackingEnabled = enabled
        if enabled {
            handTracking.start()
        } else {
            handTracking.stop()
        }
    }

    func handleHandGesture(_ event: HandGestureEvent) {
        switch event {
        case .pinchStarted(let location):
            windowManager.selectAt(location)
            windowManager.moveSelected(to: location)
        case .pinchMoved(let location, let scale):
            windowManager.moveSelected(to: location)
            windowManager.resizeSelected(scale: scale)
        case .pinchEnded:
            break
        case .twoHandStarted(let center):
            windowManager.selectAt(center)
        case .twoHandMoved(let center, let scale, let rotation):
            windowManager.moveSelected(to: center)
            windowManager.resizeSelected(scale: scale)
            windowManager.rotateSelected(by: rotation)
        case .twoHandEnded:
            break
        }
    }

    func showMessage(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    func flush() {
        windowManager.flush()
    }

    private var cameraStatusSummary: String {
        switch camera.status {
        case .stopped: "Camera off"
        case .requestingPermission: "Requesting camera"
        case .configuring: "Starting rear camera"
        case .running: "Rear camera live"
        case .permissionDenied: "Camera permission denied"
        case .unavailable: "Rear camera unavailable"
        case .interrupted: "Camera interrupted"
        case .failed: "Camera error"
        }
    }

    private var handStatusSummary: String {
        switch handTracking.status {
        case .stopped: "Hands off"
        case .waitingForCamera: "Hands waiting"
        case .running: "\(handTracking.handCount) hand(s)"
        case .noHand: "No hand detected"
        case .unavailable: "Hands unavailable"
        case .failed: "Hand tracking error"
        }
    }
}
