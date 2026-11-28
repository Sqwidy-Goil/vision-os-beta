import SwiftUI

enum AppModule: String, Codable, CaseIterable, Identifiable, Sendable {
    case browser
    case photos
    case video
    case camera
    case music
    case scanner
    case files
    case settings
    case environments
    case windows

    var id: String { rawValue }

    var title: String {
        switch self {
        case .browser: "Browser"
        case .photos: "Photos"
        case .video: "Video"
        case .camera: "Camera"
        case .music: "Music"
        case .scanner: "3D Scanner"
        case .files: "Files"
        case .settings: "Settings"
        case .environments: "Environments"
        case .windows: "Windows"
        }
    }

    var subtitle: String {
        switch self {
        case .browser: "Browse the web"
        case .photos: "Local photo library"
        case .video: "Local video playback"
        case .camera: "Rear camera and hands"
        case .music: "Local audio playback"
        case .scanner: "ARKit point-cloud capture"
        case .files: "Import, inspect, and share"
        case .settings: "Motion and optical controls"
        case .environments: "Change your space"
        case .windows: "Arrange floating windows"
        }
    }

    var symbol: String {
        switch self {
        case .browser: "safari"
        case .photos: "photo.on.rectangle"
        case .video: "play.rectangle"
        case .camera: "camera"
        case .music: "music.note"
        case .scanner: "arkit"
        case .files: "folder"
        case .settings: "slider.horizontal.3"
        case .environments: "globe"
        case .windows: "macwindow.on.rectangle"
        }
    }

    var tint: Color {
        let hex: UInt32 = switch self {
        case .browser: 0x56B8FF
        case .photos: 0xFF7EA8
        case .video: 0xA78BFA
        case .camera: 0x5EEAD4
        case .music: 0xFB7185
        case .scanner: 0xA3E635
        case .files: 0xFBBF24
        case .settings: 0x94A3B8
        case .environments: 0x818CF8
        case .windows: 0x67E8F9
        }
        return Color(hex: hex)
    }
}
