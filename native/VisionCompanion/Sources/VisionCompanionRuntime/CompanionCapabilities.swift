import Foundation
import VisionCompanionProtocol
#if canImport(ARKit)
import ARKit
#endif
#if canImport(AVFoundation)
import AVFoundation
#endif

public struct CompanionCapabilities {
    public var worldTracking: Bool
    public var metricDepth: Bool
    public var smoothedDepth: Bool
    public var planes: Bool
    public var meshes: Bool
    public var semanticObjects: Bool
    public var freeSpace: Bool
    public var reasons: [String]

    public init(worldTracking: Bool, metricDepth: Bool, smoothedDepth: Bool, planes: Bool, meshes: Bool, semanticObjects: Bool, freeSpace: Bool, reasons: [String]) {
        self.worldTracking = worldTracking
        self.metricDepth = metricDepth
        self.smoothedDepth = smoothedDepth
        self.planes = planes
        self.meshes = meshes
        self.semanticObjects = semanticObjects
        self.freeSpace = freeSpace
        self.reasons = reasons
    }

    public static func detect() -> CompanionCapabilities {
        #if os(iOS)
        let worldTracking = ARWorldTrackingConfiguration.isSupported
        let depth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
        let smoothed = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
        let planes = ARWorldTrackingConfiguration.supportsPlaneDetection([.horizontal, .vertical])
        let meshes = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        var reasons: [String] = []
        if !worldTracking { reasons.append("ARKit world tracking is unavailable on this device.") }
        if !depth { reasons.append("LiDAR scene depth is unavailable; metric depth will not be fabricated.") }
        if !planes { reasons.append("ARKit plane detection is unavailable.") }
        if !meshes { reasons.append("ARKit scene mesh reconstruction is unavailable.") }
        reasons.append("ARKit does not provide semantic object recognition or certified free-space cells; both remain empty.")
        return CompanionCapabilities(
            worldTracking: worldTracking,
            metricDepth: depth,
            smoothedDepth: smoothed,
            planes: planes,
            meshes: meshes,
            semanticObjects: false,
            freeSpace: false,
            reasons: reasons
        )
        #else
        return CompanionCapabilities(
            worldTracking: false,
            metricDepth: false,
            smoothedDepth: false,
            planes: false,
            meshes: false,
            semanticObjects: false,
            freeSpace: false,
            reasons: ["VisionCompanion spatial capture requires an iOS or iPadOS device."]
        )
        #endif
    }
}

public enum CameraPermission {
    public static func requireCameraAccess() async throws {
        #if os(iOS)
        guard let purpose = Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String,
              !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CompanionRuntimeError.permissionPurposeMissing
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return
        case .notDetermined:
            let granted = await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .video) { continuation.resume(returning: $0) }
            }
            guard granted else { throw CompanionRuntimeError.cameraPermissionDenied }
        case .denied, .restricted:
            throw CompanionRuntimeError.cameraPermissionDenied
        @unknown default:
            throw CompanionRuntimeError.cameraPermissionDenied
        }
        #else
        throw CompanionRuntimeError.unsupportedDevice("Camera capture requires iOS or iPadOS.")
        #endif
    }
}

public enum CompanionRuntimeError: Error, CustomStringConvertible, LocalizedError {
    case disabledByDefault
    case unsupportedDevice(String)
    case permissionPurposeMissing
    case cameraPermissionDenied
    case depthUnavailable
    case invalidDepthFormat
    case poseOutsideProtocolBounds
    case meshOutsideProtocolBounds
    case trackingUnavailable
    case protocolFailed(String)

    public var description: String {
        switch self {
        case .disabledByDefault:
            return "VisionCompanion is disabled. Enable it and call start(pairingCode:) explicitly."
        case .unsupportedDevice(let reason):
            return reason
        case .permissionPurposeMissing:
            return "The host app or extension must declare NSCameraUsageDescription before requesting camera access."
        case .cameraPermissionDenied:
            return "Camera permission is required for ARKit capture and was not granted."
        case .depthUnavailable:
            return "ARKit did not provide a usable scene-depth and confidence map; depth was omitted."
        case .invalidDepthFormat:
            return "ARKit returned an unsupported depth pixel format; depth was omitted."
        case .poseOutsideProtocolBounds:
            return "ARKit pose is outside the companion protocol's metric bounds."
        case .meshOutsideProtocolBounds:
            return "ARKit mesh could not be simplified within companion protocol limits."
        case .trackingUnavailable:
            return "ARKit world tracking is not currently reliable."
        case .protocolFailed(let reason):
            return reason
        }
    }

    public var errorDescription: String? { description }
}
