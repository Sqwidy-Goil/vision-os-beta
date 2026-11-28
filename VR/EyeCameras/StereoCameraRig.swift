import Foundation
import simd

enum Eye: Sendable {
    case left
    case right

    var offset: Float {
        switch self {
        case .left: -0.5
        case .right: 0.5
        }
    }
}

struct StereoEyeCamera {
    let position: SIMD3<Float>
    let view: simd_float4x4
    let projection: simd_float4x4
    var viewProjection: simd_float4x4 { projection * view }
}

struct StereoCameraRig {
    let orientation: simd_quatf
    let interpupillaryDistance: Float

    func camera(_ eye: Eye, aspect: Float, fieldOfView: Float, near: Float = 0.05, far: Float = 60) -> StereoEyeCamera {
        let position = SIMD3<Float>(eye.offset * interpupillaryDistance, 0, 0)
        let view = simd_float4x4(orientation) * SpatialMath.translation(-position)
        let projection = Self.perspective(fieldOfView: fieldOfView, aspect: aspect, near: near, far: far)
        return StereoEyeCamera(position: position, view: view, projection: projection)
    }

    static func perspective(fieldOfView: Float, aspect: Float, near: Float, far: Float) -> simd_float4x4 {
        let focalLength = 1 / tan(fieldOfView * 0.5)
        let a = -far / (far - near)
        let b = -far * near / (far - near)
        return simd_float4x4(columns: (
            SIMD4<Float>(focalLength / aspect, 0, 0, 0),
            SIMD4<Float>(0, focalLength, 0, 0),
            SIMD4<Float>(0, 0, a, 1),
            SIMD4<Float>(0, 0, b, 0)
        ))
    }
}

enum LensDistortion {
    static func correct(_ uv: SIMD2<Float>, coefficient: Float) -> SIMD2<Float> {
        let centered = uv * 2 - 1
        let radiusSquared = dot(centered, centered)
        let factor = 1 + coefficient * radiusSquared
        let corrected = centered * factor * 0.5 + 0.5
        return SIMD2<Float>(
            SpatialMath.clamp(corrected.x, 0...1),
            SpatialMath.clamp(corrected.y, 0...1)
        )
    }
}

struct GazeDwell {
    private var targetID: UUID?
    private var completedTargetID: UUID?
    private var startedAt: TimeInterval = 0
    private var latestNow: TimeInterval = 0
    private let duration: TimeInterval

    init(duration: TimeInterval = 1.25) {
        self.duration = duration
    }

    mutating func update(target: UUID?, now: TimeInterval) -> UUID? {
        latestNow = now
        guard let target else {
            targetID = nil
            completedTargetID = nil
            return nil
        }
        if targetID != target {
            targetID = target
            completedTargetID = nil
            startedAt = now
            return nil
        }
        guard completedTargetID == nil else { return nil }
        guard now - startedAt >= duration else { return nil }
        completedTargetID = target
        return target
    }

    var progress: Float {
        guard targetID != nil else { return 0 }
        return SpatialMath.clamp(Float((latestNow - startedAt) / duration), 0...1)
    }
}
