import Foundation

struct WindowPlacement: Codable, Equatable, Sendable {
    var x: Float
    var y: Float
    var z: Float
    var width: Float
    var height: Float
    var yaw: Float
    var pitch: Float
    var roll: Float

    static let centered = WindowPlacement(
        x: 0, y: 0, z: -3.4, width: 2.5, height: 1.45,
        yaw: 0, pitch: 0, roll: 0
    )

    func clamped() -> WindowPlacement {
        WindowPlacement(
            x: SpatialMath.clamp(x, -7...7),
            y: SpatialMath.clamp(y, -4...4),
            z: SpatialMath.clamp(z, -9...(-1.1)),
            width: SpatialMath.clamp(width, 0.65...5.2),
            height: SpatialMath.clamp(height, 0.3...3.2),
            yaw: SpatialMath.clamp(yaw, -Float.pi...Float.pi),
            pitch: SpatialMath.clamp(pitch, -1.2...1.2),
            roll: SpatialMath.clamp(roll, -Float.pi...Float.pi)
        )
    }
}

enum WindowPositioning: String, Codable, CaseIterable, Identifiable, Sendable {
    case worldLocked
    case headLocked
    case individual

    var id: String { rawValue }

    var title: String {
        switch self {
        case .worldLocked: "World-locked"
        case .headLocked: "Head-locked"
        case .individual: "Individual yaw"
        }
    }

    var description: String {
        switch self {
        case .worldLocked: "Stays fixed in the shared environment."
        case .headLocked: "Follows the full head orientation."
        case .individual: "Follows yaw while preserving manual pitch, roll, and placement."
        }
    }
}

enum WindowLifecycle: String, Codable, CaseIterable, Sendable {
    case floating
    case minimized
    case maximized

    var isHiddenInDock: Bool { self == .minimized }
}

struct SpatialWindow: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    var module: AppModule
    var placement: WindowPlacement
    var positioning: WindowPositioning
    var lifecycle: WindowLifecycle
    var isPinned: Bool
    var zIndex: Int
    var restorePlacement: WindowPlacement?
    var lastActiveAt: Double
    let createdAt: Double

    init(
        id: UUID = UUID(),
        module: AppModule,
        placement: WindowPlacement = .centered,
        positioning: WindowPositioning = .worldLocked,
        lifecycle: WindowLifecycle = .floating,
        isPinned: Bool = false,
        zIndex: Int = 0,
        restorePlacement: WindowPlacement? = nil,
        lastActiveAt: Double = Date().timeIntervalSinceReferenceDate,
        createdAt: Double = Date().timeIntervalSinceReferenceDate
    ) {
        self.id = id
        self.module = module
        self.placement = placement
        self.positioning = positioning
        self.lifecycle = lifecycle
        self.isPinned = isPinned
        self.zIndex = zIndex
        self.restorePlacement = restorePlacement
        self.lastActiveAt = lastActiveAt
        self.createdAt = createdAt
    }

    mutating func minimize() {
        guard lifecycle != .minimized else { return }
        restorePlacement = placement
        placement = WindowPlacement(
            x: placement.x, y: -1.45, z: -2.2,
            width: 0.85, height: 0.24,
            yaw: 0, pitch: 0, roll: 0
        )
        lifecycle = .minimized
    }

    mutating func maximize() {
        guard lifecycle != .maximized else { return }
        restorePlacement = placement
        placement = WindowPlacement.centered
        placement.width = 3.5
        placement.height = 1.95
        lifecycle = .maximized
    }

    mutating func restore() {
        if let restorePlacement {
            placement = restorePlacement
        }
        restorePlacement = nil
        lifecycle = .floating
    }

    mutating func togglePinned() {
        isPinned.toggle()
    }
}
