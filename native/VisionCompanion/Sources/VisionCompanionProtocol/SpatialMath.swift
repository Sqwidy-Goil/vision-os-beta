import Foundation

public enum SpatialMath {
    public static func hypot(_ values: [Double]) -> Double {
        values.reduce(0.0) { hypot($0, $1) }
    }

    public static func multiply(_ first: [Double], _ second: [Double]) -> [Double] {
        precondition(first.count == 4 && second.count == 4)
        let x = first[0], y = first[1], z = first[2], w = first[3]
        let bx = second[0], by = second[1], bz = second[2], bw = second[3]
        return [
            w * bx + x * bw + y * bz - z * by,
            w * by - x * bz + y * bw + z * bx,
            w * bz + x * by - y * bx + z * bw,
            w * bw - x * bx - y * by - z * bz
        ]
    }

    public static func inverse(_ quaternion: [Double]) -> [Double] {
        [-quaternion[0], -quaternion[1], -quaternion[2], quaternion[3]]
    }

    public static func rotate(_ value: [Double], orientation: [Double]) -> [Double] {
        precondition(value.count == 3 && orientation.count == 4)
        let x = value[0], y = value[1], z = value[2]
        let qx = orientation[0], qy = orientation[1], qz = orientation[2], qw = orientation[3]
        let ix = qw * x + qy * z - qz * y
        let iy = qw * y + qz * x - qx * z
        let iz = qw * z + qx * y - qy * x
        let iw = -qx * x - qy * y - qz * z
        return [
            ix * qw - iy * qz + iz * qy - iw * qx,
            ix * qz + iy * qw - iz * qx - iw * qy,
            -ix * qy + iy * qx + iz * qw - iw * qz
        ]
    }

    public static func rotationMatrix(_ orientation: [Double]) -> [[Double]] {
        (0..<3).map { row in
            var basis = [Double](repeating: 0, count: 3)
            basis[row] = 1
            return (0..<3).map { rotate(basis, orientation: orientation)[$0] }
        }
    }

    public static func transformCovariance6(_ covariance: [Double], orientation: [Double]) -> [Double] {
        precondition(covariance.count == 36)
        let rotation = rotationMatrix(orientation)
        var transform = [[Double]](repeating: [Double](repeating: 0, count: 6), count: 6)
        for row in 0..<3 {
            for column in 0..<3 {
                transform[row][column] = rotation[row][column]
                transform[row + 3][column + 3] = rotation[row][column]
            }
        }
        var output = [Double](repeating: 0, count: 36)
        for row in 0..<6 {
            for column in 0..<6 {
                for inner in 0..<6 {
                    for other in 0..<6 {
                        output[row * 6 + column] += transform[row][inner] * covariance[inner * 6 + other] * transform[column][other]
                    }
                }
            }
        }
        return output
    }

    public static func isPositiveSemidefinite(_ covariance: [Double], size: Int) -> Bool {
        guard covariance.count == size * size,
              covariance.allSatisfy({ $0.isFinite }) else { return false }
        var lower = [Double](repeating: 0, count: covariance.count)
        for row in 0..<size {
            if covariance[row * size + row] < 0 { return false }
            for column in row + 1..<size {
                let tolerance = 1e-6 * max(1, abs(covariance[row * size + column]), abs(covariance[column * size + row]))
                if abs(covariance[row * size + column] - covariance[column * size + row]) > tolerance {
                    return false
                }
            }
            for column in 0...row {
                var residual = covariance[row * size + column]
                for inner in 0..<column {
                    residual -= lower[row * size + inner] * lower[column * size + inner]
                }
                if row == column {
                    if residual < -1e-7 { return false }
                    lower[row * size + column] = sqrt(max(0, residual))
                } else if lower[column * size + column] < 1e-12 {
                    if abs(residual) > 1e-7 { return false }
                } else {
                    lower[row * size + column] = residual / lower[column * size + column]
                }
            }
        }
        return true
    }
}

public enum TrackingUncertainty {
    /// ARKit does not publish statistical covariance. These are conservative
    /// tracking-state envelopes, not calibrated sensor noise estimates.
    public static func covariance(trackingLimited: Bool) -> [Double] {
        let positionVariance = trackingLimited ? 0.25 : 0.01
        let orientationVariance = trackingLimited ? 0.04 : 0.0004
        var output = [Double](repeating: 0, count: 36)
        for index in 0..<3 {
            output[index * 6 + index] = positionVariance
            output[(index + 3) * 6 + index + 3] = orientationVariance
        }
        return output
    }

    /// Conservative protocol quality mapping, not a calibrated probability.
    public static func confidence(trackingLimited: Bool) -> Double {
        trackingLimited ? 0.55 : 0.9
    }
}
