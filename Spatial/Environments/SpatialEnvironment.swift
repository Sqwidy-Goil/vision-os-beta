import SwiftUI

enum EnvironmentKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case studio
    case midnight
    case aurora
    case panorama

    var id: String { rawValue }

    var title: String {
        switch self {
        case .studio: "Light Studio"
        case .midnight: "Midnight Grid"
        case .aurora: "Aurora Field"
        case .panorama: "Panorama"
        }
    }

    var subtitle: String {
        switch self {
        case .studio: "Soft depth and a luminous floor"
        case .midnight: "Dark spatial workspace"
        case .aurora: "Procedural 3D star field"
        case .panorama: "An imported 360° image"
        }
    }

    var symbol: String {
        switch self {
        case .studio: "circle.lefthalf.filled"
        case .midnight: "moon.stars"
        case .aurora: "sparkles"
        case .panorama: "pano"
        }
    }

    var topColor: Color {
        switch self {
        case .studio: Color(hex: 0x536B8E)
        case .midnight: Color(hex: 0x0B1020)
        case .aurora: Color(hex: 0x12344A)
        case .panorama: Color(hex: 0x1E293B)
        }
    }

    var bottomColor: Color {
        switch self {
        case .studio: Color(hex: 0x0A1220)
        case .midnight: Color(hex: 0x02030A)
        case .aurora: Color(hex: 0x07131B)
        case .panorama: Color(hex: 0x020617)
        }
    }

    var shaderKind: Float {
        switch self {
        case .studio: 0
        case .midnight: 1
        case .aurora: 2
        case .panorama: 3
        }
    }

    var gridStrength: Float {
        switch self {
        case .studio: 0.22
        case .midnight: 0.7
        case .aurora: 0.18
        case .panorama: 0
        }
    }
}
