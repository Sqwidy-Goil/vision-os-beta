import Foundation
import simd

enum SpatialMath {
    static func clamp(_ value: Float, _ range: ClosedRange<Float>) -> Float {
        min(max(value, range.lowerBound), range.upperBound)
    }

    static func translation(_ value: SIMD3<Float>) -> simd_float4x4 {
        simd_float4x4(columns: (
            SIMD4<Float>(1, 0, 0, 0),
            SIMD4<Float>(0, 1, 0, 0),
            SIMD4<Float>(0, 0, 1, 0),
            SIMD4<Float>(value.x, value.y, value.z, 1)
        ))
    }

    static func scale(_ value: SIMD3<Float>) -> simd_float4x4 {
        simd_float4x4(columns: (
            SIMD4<Float>(value.x, 0, 0, 0),
            SIMD4<Float>(0, value.y, 0, 0),
            SIMD4<Float>(0, 0, value.z, 0),
            SIMD4<Float>(0, 0, 0, 1)
        ))
    }

    static func rotation(yaw: Float, pitch: Float, roll: Float) -> simd_float4x4 {
        let yawQ = simd_quatf(angle: yaw, axis: SIMD3<Float>(0, 1, 0))
        let pitchQ = simd_quatf(angle: pitch, axis: SIMD3<Float>(1, 0, 0))
        let rollQ = simd_quatf(angle: roll, axis: SIMD3<Float>(0, 0, 1))
        return simd_float4x4(yawQ * pitchQ * rollQ)
    }

    static func modelMatrix(for window: SpatialWindow, headOrientation: simd_quatf) -> simd_float4x4 {
        let local = translation(SIMD3<Float>(
            window.placement.x,
            window.placement.y,
            window.placement.z
        )) * rotation(
            yaw: window.placement.yaw,
            pitch: window.placement.pitch,
            roll: window.placement.roll
        ) * scale(SIMD3<Float>(window.placement.width, window.placement.height, 1))

        switch window.positioning {
        case .worldLocked:
            return local
        case .headLocked:
            return simd_float4x4(headOrientation) * local
        case .individual:
            let forward = headOrientation.act(SIMD3<Float>(0, 0, -1))
            let flatForward = normalize(SIMD3<Float>(forward.x, 0, forward.z))
            let yaw = atan2(-flatForward.x, -flatForward.z)
            return simd_float4x4(simd_quatf(angle: yaw, axis: SIMD3<Float>(0, 1, 0))) * local
        }
    }

    static func ray(
        from point: CGPoint,
        viewport: CGRect,
        viewProjection: simd_float4x4
    ) -> (origin: SIMD3<Float>, direction: SIMD3<Float>) {
        let x = Float((point.x - viewport.minX) / viewport.width) * 2 - 1
        let y = 1 - Float((point.y - viewport.minY) / viewport.height) * 2
        let inverse = simd_inverse(viewProjection)
        let near4 = inverse * SIMD4<Float>(x, y, 0, 1)
        let far4 = inverse * SIMD4<Float>(x, y, 1, 1)
        let near = SIMD3<Float>(near4.x, near4.y, near4.z) / near4.w
        let far = SIMD3<Float>(far4.x, far4.y, far4.z) / far4.w
        return (near, normalize(far - near))
    }

    static func intersectPlane(
        rayOrigin: SIMD3<Float>,
        rayDirection: SIMD3<Float>,
        planePoint: SIMD3<Float>,
        planeNormal: SIMD3<Float>
    ) -> SIMD3<Float>? {
        let denominator = dot(rayDirection, planeNormal)
        guard abs(denominator) > 0.0001 else { return nil }
        let distance = dot(planePoint - rayOrigin, planeNormal) / denominator
        guard distance > 0 else { return nil }
        return rayOrigin + rayDirection * distance
    }

    static func localHit(point: SIMD3<Float>, modelMatrix: simd_float4x4) -> SIMD2<Float>? {
        let inverse = simd_inverse(modelMatrix)
        guard !inverse[0][0].isNaN else { return nil }
        let local4 = inverse * SIMD4<Float>(point.x, point.y, point.z, 1)
        guard abs(local4.z) < 0.08 else { return nil }
        return SIMD2<Float>(local4.x / local4.w, local4.y / local4.w)
    }

    static func yawOnly(_ quaternion: simd_quatf) -> simd_quatf {
        let forward = quaternion.act(SIMD3<Float>(0, 0, -1))
        let flattened = normalize(SIMD3<Float>(forward.x, 0, forward.z))
        return simd_quatf(angle: atan2(-flattened.x, -flattened.z), axis: SIMD3<Float>(0, 1, 0))
    }
}
