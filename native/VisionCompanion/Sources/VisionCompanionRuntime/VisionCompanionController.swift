#if os(iOS)
import ARKit
import Foundation
import VisionCompanionProtocol

public enum VisionCompanionState: String {
    case disabled
    case idle
    case requestingPermission
    case connecting
    case waitingForTracking
    case trackingLimited
    case streaming
    case paused
    case disconnected
    case failed
}

public struct CompanionTimestampDiagnostics {
    public var sampleClock = "arkit-session-relative-milliseconds"
    public var nativeCaptureClock = "arkit-monotonic-milliseconds"
    public var transportClock = "unix-wall-clock-milliseconds"
    public var latestNativeCaptureMilliseconds: Double?
    public var latestSampleMilliseconds: Double?
    public var poseDepthAssociationUncertaintyMs: Double = 33.4
    public var protocolOriginUncertaintyMs: Double = 33.4
    public var wallClockOffsetKnown = false
    public var note = "The first accepted ARFrame maps to protocol timestamp 1 ms; later sample, intrinsics, and anchor timestamps are session-relative ARKit deltas. This satisfies the host's first-frame and 1000 ms interval bounds without asserting a cross-device wall-clock offset. Pose/scene-depth association and origin mapping retain a conservative target-frame-period uncertainty (at least 33.4 ms)."
}

public struct VisionCompanionConfiguration {
    public var endpoint: String
    public var deviceName: String
    public var deviceModel: String?
    public var targetFramesPerSecond: Double
    public var depthEncoding: CompanionDepthEncoding
    public var preferSmoothedDepth: Bool
    public var capturePlanes: Bool
    public var captureMeshes: Bool
    public var maxFrameBytes: Int
    public var maxMessagesPerSecond: Int

    public init(
        endpoint: String,
        deviceName: String,
        deviceModel: String? = nil,
        targetFramesPerSecond: Double = 15,
        depthEncoding: CompanionDepthEncoding = .float32le,
        preferSmoothedDepth: Bool = true,
        capturePlanes: Bool = true,
        captureMeshes: Bool = true,
        maxFrameBytes: Int = CompanionProtocol.defaultMaxFrameBytes,
        maxMessagesPerSecond: Int = CompanionProtocol.defaultMaxMessagesPerSecond
    ) {
        self.endpoint = endpoint
        self.deviceName = deviceName
        self.deviceModel = deviceModel
        self.targetFramesPerSecond = targetFramesPerSecond
        self.depthEncoding = depthEncoding
        self.preferSmoothedDepth = preferSmoothedDepth
        self.capturePlanes = capturePlanes
        self.captureMeshes = captureMeshes
        self.maxFrameBytes = maxFrameBytes
        self.maxMessagesPerSecond = maxMessagesPerSecond
    }
}

public struct VisionCompanionStatus {
    public var state: VisionCompanionState
    public var enabled: Bool
    public var capabilities: CompanionCapabilities
    public var error: String?
    public var latestCaptureTimestamp: Double?
    public var framesSent: Int
    public var latestDepthCaptured: Bool
    public var latestSurfaceCount: Int
    public var timestamps = CompanionTimestampDiagnostics()
}

@MainActor
public final class VisionCompanionController: NSObject, ARSessionDelegate {
    public private(set) var enabled: Bool
    public private(set) var status: VisionCompanionStatus
    public var onStatus: ((VisionCompanionStatus) -> Void)?

    private let configuration: VisionCompanionConfiguration
    private var configurationFailure: Error?
    private var guest: CompanionGuestSession?
    private var arSession: ARSession?
    private var builder = ARKitSampleBuilder()
    private var monitorTimer: Timer?
    private var arkitStartedAt: Date?
    private var lastARKitFrameAt: Date?
    private var limitedSince: Date?
    private var lastEmittedCaptureTimestamp: Double?
    private var captureActive = false
    private var stopRequested = false

    public init(configuration: VisionCompanionConfiguration, enabled: Bool = false) {
        self.configuration = configuration
        self.enabled = enabled
        self.status = VisionCompanionStatus(
            state: enabled ? .idle : .disabled,
            enabled: enabled,
            capabilities: CompanionCapabilities.detect(),
            error: nil,
            latestCaptureTimestamp: nil,
            framesSent: 0,
            latestDepthCaptured: false,
            latestSurfaceCount: 0
        )
        super.init()
        do {
            _ = try TrustedLocalWSS.validate(configuration.endpoint)
        } catch {
            configurationFailure = error
            status.state = .failed
            status.error = error.localizedDescription
            return
        }
        guard configuration.targetFramesPerSecond >= 1, configuration.targetFramesPerSecond <= 30 else {
            configurationFailure = CompanionRuntimeError.protocolFailed("Companion frame rate must be between 1 and 30 Hz.")
            self.status.state = .failed
            self.status.error = configurationFailure?.localizedDescription
            return
        }
        guard configuration.depthEncoding != .none else {
            configurationFailure = CompanionRuntimeError.protocolFailed("Companion depth requires Float32LE or base64 encoding.")
            self.status.state = .failed
            self.status.error = configurationFailure?.localizedDescription
            return
        }
        guard configuration.maxFrameBytes >= 1024, configuration.maxFrameBytes <= CompanionProtocol.absoluteMaxFrameBytes,
              configuration.maxMessagesPerSecond >= 1, configuration.maxMessagesPerSecond <= CompanionProtocol.maxMessagesPerSecond else {
            configurationFailure = CompanionRuntimeError.protocolFailed("Companion frame or rate limits are invalid.")
            self.status.state = .failed
            self.status.error = configurationFailure?.localizedDescription
            return
        }
    }

    public func setEnabled(_ enabled: Bool) {
        guard self.enabled != enabled else { return }
        self.enabled = enabled
        if enabled {
            status = VisionCompanionStatus(
                state: .idle,
                enabled: true,
                capabilities: CompanionCapabilities.detect(),
                error: nil,
                latestCaptureTimestamp: nil,
                framesSent: 0,
                latestDepthCaptured: false,
                latestSurfaceCount: 0
            )
        } else {
            stop(reason: "VisionCompanion was disabled.")
        }
        notify()
    }

    public func start(pairingCode: String) async throws {
        guard enabled else { throw CompanionRuntimeError.disabledByDefault }
        if let configurationFailure {
            status.state = .failed
            status.error = configurationFailure.localizedDescription
            notify()
            throw configurationFailure
        }
        guard status.state != .requestingPermission, status.state != .connecting, status.state != .waitingForTracking,
              status.state != .streaming, status.state != .trackingLimited else {
            throw CompanionProtocolError("VisionCompanion is already active.")
        }
        stopRequested = false
        let capabilities = CompanionCapabilities.detect()
        status.capabilities = capabilities
        guard capabilities.worldTracking else {
            throw CompanionRuntimeError.unsupportedDevice(capabilities.reasons.first ?? "ARKit world tracking is unavailable.")
        }
        guard capabilities.metricDepth else {
            throw CompanionRuntimeError.unsupportedDevice("LiDAR scene depth is required for this companion. No synthetic depth will be produced.")
        }
        status.state = .requestingPermission
        status.error = nil
        notify()
        do {
            try await CameraPermission.requireCameraAccess()
            try Task.checkCancellation()
            guard enabled, !stopRequested else { throw CompanionRuntimeError.disabledByDefault }
        } catch {
            if stopRequested || !enabled || Task.isCancelled {
                status.state = enabled ? .disconnected : .disabled
                status.error = nil
            } else {
                status.state = .failed
                status.error = error.localizedDescription
            }
            notify()
            throw error
        }

        let guestConfiguration = CompanionGuestConfiguration(
            endpoint: configuration.endpoint,
            deviceName: configuration.deviceName,
            deviceModel: configuration.deviceModel,
            maxFrameBytes: configuration.maxFrameBytes,
            maxMessagesPerSecond: configuration.maxMessagesPerSecond
        )
        let session = try CompanionGuestSession(configuration: guestConfiguration)
        session.depthEncoding = configuration.depthEncoding
        guest = session
        session.onEvent = { [weak self] event in
            Task { @MainActor in
                self?.handle(event, from: session)
            }
        }
        status.state = .connecting
        notify()
        do {
            try await session.connect(code: pairingCode)
            try Task.checkCancellation()
            startARKit(capabilities: capabilities)
        } catch {
            guest = nil
            session.onEvent = nil
            session.disconnect(reason: error.localizedDescription)
            cleanupCapture()
            if stopRequested || !enabled || Task.isCancelled {
                status.state = enabled ? .disconnected : .disabled
                status.error = nil
            } else {
                status.state = .failed
                status.error = error.localizedDescription
            }
            notify()
            throw error
        }
    }

    public func stop(reason: String = "VisionCompanion stopped by the user.") {
        stopRequested = true
        let session = guest
        guest = nil
        session?.onEvent = nil
        session?.disconnect(reason: reason)
        cleanupCapture()
        status.state = enabled ? .disconnected : .disabled
        status.error = nil
        notify()
    }

    public nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        Task { @MainActor in
            guard self.captureActive, self.guest != nil else { return }
            self.lastARKitFrameAt = Date()
            switch frame.camera.trackingState {
            case .normal:
                self.limitedSince = nil
                if self.status.state == .trackingLimited || self.status.state == .paused {
                    self.status.state = .waitingForTracking
                    self.notify()
                }
                guard self.shouldEmit(frame) else { return }
                self.emit(frame: frame, trackingLimited: false)
            case .limited:
                if self.limitedSince == nil { self.limitedSince = Date() }
                if self.status.state != .trackingLimited {
                    self.status.state = .trackingLimited
                    self.notify()
                }
                guard self.shouldEmit(frame) else { return }
                self.emit(frame: frame, trackingLimited: true)
            case .notAvailable:
                if self.limitedSince == nil { self.limitedSince = Date() }
                if self.status.state != .trackingLimited {
                    self.status.state = .trackingLimited
                    self.notify()
                }
            @unknown default:
                break
            }
        }
    }

    private func shouldEmit(_ frame: ARFrame) -> Bool {
        guard let last = lastEmittedCaptureTimestamp else { return true }
        return frame.timestamp * 1000 - last >= 1000 / configuration.targetFramesPerSecond
    }

    private func emit(frame: ARFrame, trackingLimited: Bool) {
        do {
            guard let output = try builder.process(
                frame: frame,
                trackingLimited: trackingLimited,
                options: ARKitCaptureOptions(
                    preferSmoothedDepth: configuration.preferSmoothedDepth && status.capabilities.smoothedDepth,
                    capturePlanes: configuration.capturePlanes && status.capabilities.planes,
                    captureMeshes: configuration.captureMeshes && status.capabilities.meshes,
                    timestampUncertaintyMs: max(33.4, 1000 / configuration.targetFramesPerSecond)
                )
            ) else { return }
            if let calibration = output.calibration {
                try guest?.sendCalibration(calibration)
            }
            try guest?.sendSample(
                output.sample,
                previousFrameId: output.previousFrameId,
                previousTimestamp: output.previousTimestamp,
                previousDepthIntrinsics: output.previousDepthIntrinsics
            )
            lastEmittedCaptureTimestamp = output.timestampAlignment.captureMilliseconds
            status.state = trackingLimited ? .trackingLimited : .streaming
            status.latestCaptureTimestamp = output.sample.timestamp
            status.framesSent += 1
            status.latestDepthCaptured = output.depthCaptured
            status.latestSurfaceCount = output.surfaceCount
            status.timestamps.latestNativeCaptureMilliseconds = output.timestampAlignment.captureMilliseconds
            status.timestamps.latestSampleMilliseconds = output.timestampAlignment.sampleMilliseconds
            status.timestamps.poseDepthAssociationUncertaintyMs = output.timestampAlignment.poseDepthAssociationUncertaintyMs
            status.timestamps.protocolOriginUncertaintyMs = output.timestampAlignment.protocolOriginUncertaintyMs
            status.timestamps.wallClockOffsetKnown = output.timestampAlignment.wallClockOffsetMs != nil
            notify()
        } catch {
            fail(error)
        }
    }

    public nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        Task { @MainActor in self.fail(error) }
    }

    public nonisolated func sessionWasInterrupted(_ session: ARSession) {
        Task { @MainActor in
            guard self.guest != nil else { return }
            self.captureActive = false
            self.status.state = .paused
            self.notify()
        }
    }

    public nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        Task { @MainActor in
            guard self.guest != nil else { return }
            self.captureActive = true
            self.status.state = .waitingForTracking
            self.lastARKitFrameAt = nil
            self.notify()
        }
    }

    private func startARKit(capabilities: CompanionCapabilities) {
        let configuration = ARWorldTrackingConfiguration()
        configuration.frameSemantics.insert(.sceneDepth)
        if capabilities.smoothedDepth { configuration.frameSemantics.insert(.smoothedSceneDepth) }
        configuration.planeDetection = capabilities.planes ? [.horizontal, .vertical] : []
        configuration.sceneReconstruction = capabilities.meshes ? .mesh : []
        configuration.isLightEstimationEnabled = false
        let session = ARSession()
        session.delegate = self
        arSession = session
        builder.reset()
        lastEmittedCaptureTimestamp = nil
        lastARKitFrameAt = nil
        limitedSince = nil
        arkitStartedAt = Date()
        captureActive = true
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        status.state = .waitingForTracking
        notify()
        startMonitor()
    }

    private func startMonitor() {
        monitorTimer?.invalidate()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkTrackingFreshness() }
        }
        RunLoop.main.add(timer, forMode: .common)
        monitorTimer = timer
    }

    private func checkTrackingFreshness() {
        guard guest != nil, captureActive else { return }
        let now = Date()
        if let limitedSince, now.timeIntervalSince(limitedSince) > 2 {
            fail(CompanionRuntimeError.trackingUnavailable)
            return
        }
        if let started = arkitStartedAt, status.state == .waitingForTracking,
           now.timeIntervalSince(started) > 10 {
            fail(CompanionRuntimeError.trackingUnavailable)
            return
        }
        if let last = lastARKitFrameAt, now.timeIntervalSince(last) > 1.5 {
            fail(CompanionRuntimeError.trackingUnavailable)
        }
    }

    private func handle(_ event: CompanionGuestEvent, from session: CompanionGuestSession) {
        guard guest === session else { return }
        switch event {
        case .connected:
            if status.state == .connecting { status.state = .waitingForTracking }
        case .disconnected(let reason, let error):
            cleanupCapture()
            guest = nil
            session.onEvent = nil
            status.state = error ? .failed : .disconnected
            status.error = error ? reason : nil
            notify()
        }
    }

    private func fail(_ error: Error) {
        guard status.state != .failed, status.state != .disconnected, guest != nil else { return }
        let session = guest
        guest = nil
        session?.onEvent = nil
        session?.disconnect(reason: error.localizedDescription)
        cleanupCapture()
        status.state = .failed
        status.error = error.localizedDescription
        notify()
    }

    private func cleanupCapture() {
        captureActive = false
        monitorTimer?.invalidate()
        monitorTimer = nil
        arSession?.delegate = nil
        arSession?.pause()
        arSession = nil
        builder.reset()
        arkitStartedAt = nil
        lastARKitFrameAt = nil
        limitedSince = nil
        lastEmittedCaptureTimestamp = nil
    }

    private func notify() {
        onStatus?(status)
    }
}
#endif
