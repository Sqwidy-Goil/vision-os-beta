import AVFoundation
import Foundation
import Photos
import UIKit

@MainActor
final class PermissionCenter: ObservableObject {
    @Published private(set) var cameraStatus: PermissionState = .notDetermined
    @Published private(set) var photoStatus: PermissionState = .notDetermined

    enum PermissionState: Equatable {
        case notDetermined
        case authorized
        case denied
        case restricted
        case unavailable
    }

    init() {
        refresh()
    }

    func refresh() {
        cameraStatus = Self.map(AVCaptureDevice.authorizationStatus(for: .video))
        photoStatus = Self.map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    func requestCamera() async -> Bool {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        refresh()
        return granted
    }

    func requestPhotoLibrary() async -> Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        let granted: Bool
        if status == .notDetermined {
            granted = await PHPhotoLibrary.requestAuthorization(for: .readWrite) == .authorized
        } else {
            granted = status == .authorized || status == .limited
        }
        refresh()
        return granted
    }

    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private static func map(_ status: AVAuthorizationStatus) -> PermissionState {
        switch status {
        case .authorized: .authorized
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .unavailable
        }
    }

    private static func map(_ status: PHAuthorizationStatus) -> PermissionState {
        switch status {
        case .authorized, .limited: .authorized
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .unavailable
        }
    }
}
