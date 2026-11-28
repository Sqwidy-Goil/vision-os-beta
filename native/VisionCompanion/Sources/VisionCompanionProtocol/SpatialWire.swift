import Foundation

public struct CameraIntrinsicsWire: Codable, Equatable {
    public var width: Int
    public var height: Int
    public var fx: Double
    public var fy: Double
    public var cx: Double
    public var cy: Double
    public var timestamp: Double
    public var calibration: String

    public init(width: Int, height: Int, fx: Double, fy: Double, cx: Double, cy: Double, timestamp: Double, calibration: String = "calibrated") {
        self.width = width
        self.height = height
        self.fx = fx
        self.fy = fy
        self.cx = cx
        self.cy = cy
        self.timestamp = timestamp
        self.calibration = calibration
    }

    public func sameCalibration(as other: CameraIntrinsicsWire) -> Bool {
        width == other.width && height == other.height
            && fx == other.fx && fy == other.fy
            && cx == other.cx && cy == other.cy
            && calibration == other.calibration
    }

    public func dictionary() -> [String: Any] {
        [
            "width": width,
            "height": height,
            "fx": fx,
            "fy": fy,
            "cx": cx,
            "cy": cy,
            "timestamp": timestamp,
            "calibration": calibration
        ]
    }

    public static func parse(_ value: Any?, width: Int, height: Int, timestamp: Double, requireCurrentTimestamp: Bool) throws -> CameraIntrinsicsWire {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["width", "height", "fx", "fy", "cx", "cy", "timestamp", "calibration"],
            label: "Companion camera intrinsics"
        )
        let intrinsics = CameraIntrinsicsWire(
            width: try ProtocolValidation.integer(object["width"], label: "intrinsics width", minimum: 1, maximum: 1280),
            height: try ProtocolValidation.integer(object["height"], label: "intrinsics height", minimum: 1, maximum: 720),
            fx: try ProtocolValidation.number(object["fx"], label: "intrinsics", minimum: Double(1).nextUp),
            fy: try ProtocolValidation.number(object["fy"], label: "intrinsics", minimum: Double(1).nextUp),
            cx: try ProtocolValidation.number(object["cx"], label: "intrinsics", minimum: 0),
            cy: try ProtocolValidation.number(object["cy"], label: "intrinsics", minimum: 0),
            timestamp: try ProtocolValidation.number(object["timestamp"], label: "intrinsics timestamp", minimum: 0),
            calibration: try ProtocolValidation.string(object["calibration"], label: "intrinsics calibration")
        )
        guard intrinsics.width == width, intrinsics.height == height,
              intrinsics.cx <= Double(width), intrinsics.cy <= Double(height),
              intrinsics.calibration == "calibrated",
              requireCurrentTimestamp ? intrinsics.timestamp == timestamp : intrinsics.timestamp <= timestamp else {
            throw CompanionProtocolError("Companion depth requires matching calibrated camera intrinsics.")
        }
        return intrinsics
    }
}

public struct PoseWire: Equatable {
    public var position: [Double]
    public var quaternion: [Double]
    public var velocity: [Double]
    public var covariance: [Double]
    public var confidence: Double

    public init(position: [Double], quaternion: [Double], velocity: [Double], covariance: [Double], confidence: Double) {
        self.position = position
        self.quaternion = quaternion
        self.velocity = velocity
        self.covariance = covariance
        self.confidence = confidence
    }

    public func dictionary() -> [String: Any] {
        [
            "position": position,
            "quaternion": quaternion,
            "velocity": velocity,
            "covariance": covariance,
            "confidence": confidence
        ]
    }
}

public struct PoseDeltaWire: Equatable {
    public var position: [Double]?
    public var quaternion: [Double]?
    public var velocity: [Double]?
    public var covariance: [Double]?
    public var confidence: Double?

    public init(position: [Double]? = nil, quaternion: [Double]? = nil, velocity: [Double]? = nil, covariance: [Double]? = nil, confidence: Double? = nil) {
        self.position = position
        self.quaternion = quaternion
        self.velocity = velocity
        self.covariance = covariance
        self.confidence = confidence
    }

    public func dictionary() -> [String: Any] {
        var output: [String: Any] = [:]
        if let position { output["position"] = position }
        if let quaternion { output["quaternion"] = quaternion }
        if let velocity { output["velocity"] = velocity }
        if let covariance { output["covariance"] = covariance }
        if let confidence { output["confidence"] = confidence }
        return output
    }
}

public enum PoseUpdateWire: Equatable {
    case full(PoseWire)
    case delta(PoseDeltaWire)

    public var mode: String {
        switch self {
        case .full: return "full"
        case .delta: return "delta"
        }
    }

    public func dictionary() -> [String: Any] {
        switch self {
        case .full(let pose): return pose.dictionary()
        case .delta(let pose): return pose.dictionary()
        }
    }
}

public enum DepthModeWire: String {
    case full
    case rect
    case unchanged
}

public struct DepthUpdateWire: Equatable {
    public var mode: DepthModeWire
    public var width: Int
    public var height: Int
    public var x: Int?
    public var y: Int?
    public var baseWidth: Int?
    public var baseHeight: Int?
    public var intrinsics: CameraIntrinsicsWire
    public var values: [Float]?
    public var confidence: [Float]?

    public init(
        mode: DepthModeWire,
        width: Int,
        height: Int,
        x: Int? = nil,
        y: Int? = nil,
        baseWidth: Int? = nil,
        baseHeight: Int? = nil,
        intrinsics: CameraIntrinsicsWire,
        values: [Float]? = nil,
        confidence: [Float]? = nil
    ) {
        self.mode = mode
        self.width = width
        self.height = height
        self.x = x
        self.y = y
        self.baseWidth = baseWidth
        self.baseHeight = baseHeight
        self.intrinsics = intrinsics
        self.values = values
        self.confidence = confidence
    }

    public func dictionary(depthEncoding: CompanionDepthEncoding = .float32le) -> [String: Any] {
        var output: [String: Any] = [
            "mode": mode.rawValue,
            "width": width,
            "height": height,
            "intrinsics": intrinsics.dictionary()
        ]
        if mode == .rect {
            if let x { output["x"] = x }
            if let y { output["y"] = y }
            if let baseWidth { output["baseWidth"] = baseWidth }
            if let baseHeight { output["baseHeight"] = baseHeight }
        }
        if mode != .unchanged {
            if depthEncoding == .base64, let values, let confidence {
                output["values"] = Self.float32Base64(values)
                output["confidence"] = Self.float32Base64(confidence)
            } else {
                if let values { output["values"] = values }
                if let confidence { output["confidence"] = confidence }
            }
        }
        return output
    }

    private static func float32Base64(_ values: [Float]) -> String {
        var bytes = Data()
        bytes.reserveCapacity(values.count * 4)
        for value in values {
            var encoded = UInt32(bitPattern: value).littleEndian
            withUnsafeBytes(of: &encoded) { bytes.append(contentsOf: $0) }
        }
        return CompanionBinary.base64(bytes)
    }
}

public struct SurfaceWire: Equatable {
    public enum Kind: String { case plane, mesh }

    public var id: String
    public var kind: Kind
    public var normal: [Double]?
    public var point: [Double]?
    public var vertices: [Double]?
    public var indices: [Int]?
    public var confidence: Double
    public var covariance: [Double]?
    public var observedAt: Double

    public init(id: String, kind: Kind, normal: [Double]? = nil, point: [Double]? = nil, vertices: [Double]? = nil, indices: [Int]? = nil, confidence: Double, covariance: [Double]? = nil, observedAt: Double) {
        self.id = id
        self.kind = kind
        self.normal = normal
        self.point = point
        self.vertices = vertices
        self.indices = indices
        self.confidence = confidence
        self.covariance = covariance
        self.observedAt = observedAt
    }

    public func dictionary() -> [String: Any] {
        var output: [String: Any] = [
            "id": id,
            "kind": kind.rawValue,
            "confidence": confidence,
            "observedAt": observedAt
        ]
        if let normal { output["normal"] = normal }
        if let point { output["point"] = point }
        if let vertices { output["vertices"] = vertices }
        if let indices { output["indices"] = indices }
        if let covariance { output["covariance"] = covariance }
        return output
    }

    public func contentEqual(to other: SurfaceWire) -> Bool {
        id == other.id && kind == other.kind && normal == other.normal && point == other.point
            && vertices == other.vertices && indices == other.indices
            && confidence == other.confidence && covariance == other.covariance
    }
}

public struct RemovedWire: Equatable {
    public var surfaces: [String]
    public var objects: [String]
    public var freeSpace: [String]

    public init(surfaces: [String] = [], objects: [String] = [], freeSpace: [String] = []) {
        self.surfaces = surfaces
        self.objects = objects
        self.freeSpace = freeSpace
    }

    public func dictionary() -> [String: Any] {
        ["surfaces": surfaces, "objects": objects, "freeSpace": freeSpace]
    }
}

public struct SpatialUpdateWire {
    public var frameId: Int
    public var timestamp: Double
    public var baseFrameId: Int
    public var reset: Bool
    public var calibrationId: String
    public var pose: PoseUpdateWire
    public var calibrationConfidence: Double
    public var depth: DepthUpdateWire?
    public var surfaces: [SurfaceWire]?
    public var objects: [[String: Any]]?
    public var freeSpace: [[String: Any]]?
    public var removed: RemovedWire?

    public init(frameId: Int, timestamp: Double, baseFrameId: Int, reset: Bool, calibrationId: String, pose: PoseUpdateWire, calibrationConfidence: Double, depth: DepthUpdateWire?, surfaces: [SurfaceWire]?, objects: [[String: Any]]?, freeSpace: [[String: Any]]?, removed: RemovedWire?) {
        self.frameId = frameId
        self.timestamp = timestamp
        self.baseFrameId = baseFrameId
        self.reset = reset
        self.calibrationId = calibrationId
        self.pose = pose
        self.calibrationConfidence = calibrationConfidence
        self.depth = depth
        self.surfaces = surfaces
        self.objects = objects
        self.freeSpace = freeSpace
        self.removed = removed
    }

    public func dictionary(depthEncoding: CompanionDepthEncoding = .float32le) -> [String: Any] {
        var output: [String: Any] = [
            "kind": "sample",
            "frameId": frameId,
            "timestamp": timestamp,
            "baseFrameId": baseFrameId,
            "reset": reset,
            "calibrationId": calibrationId,
            "poseMode": pose.mode,
            "pose": pose.dictionary(),
            "calibrationConfidence": calibrationConfidence
        ]
        if let depth { output["depth"] = depth.dictionary(depthEncoding: depthEncoding) }
        if let surfaces { output["surfaces"] = surfaces.map { $0.dictionary() } }
        if let objects { output["objects"] = objects }
        if let freeSpace { output["freeSpace"] = freeSpace }
        if let removed { output["removed"] = removed.dictionary() }
        return output
    }
}

public struct CalibrationWire {
    public var calibrationId: String
    public var confidence: Double

    public init(calibrationId: String, confidence: Double) {
        self.calibrationId = calibrationId
        self.confidence = confidence
    }

    public func dictionary() -> [String: Any] {
        [
            "kind": "calibration",
            "calibrationId": calibrationId,
            "confidence": confidence,
            "frame": CompanionProtocol.coordinateFrame,
            "depthUnits": CompanionProtocol.depthUnits,
            "origin": [0.0, 0.0, 0.0],
            "orientation": [0.0, 0.0, 0.0, 1.0]
        ]
    }
}

public enum DepthPlanner {
    public static func plan(previous: DepthUpdateWire?, nextValues: [Float], nextConfidence: [Float], intrinsics: CameraIntrinsicsWire) throws -> DepthUpdateWire {
        guard intrinsics.width >= 1, intrinsics.width <= 512,
              intrinsics.height >= 1, intrinsics.height <= 512,
              intrinsics.width * intrinsics.height <= 262_144,
              nextValues.count == nextConfidence.count,
              nextValues.count == intrinsics.width * intrinsics.height else {
            throw CompanionProtocolError("Companion depth array length mismatch.")
        }
        let full = DepthUpdateWire(
            mode: .full,
            width: intrinsics.width,
            height: intrinsics.height,
            intrinsics: intrinsics,
            values: nextValues,
            confidence: nextConfidence
        )
        guard let previous, previous.mode != .unchanged,
              previous.width == full.width, previous.height == full.height,
              previous.values?.count == full.width * full.height,
              previous.confidence?.count == full.width * full.height,
              previous.intrinsics.sameCalibration(as: intrinsics),
              let previousValues = previous.values, let previousConfidence = previous.confidence else {
            return full
        }
        if previousValues == nextValues, previousConfidence == nextConfidence {
            return DepthUpdateWire(
                mode: .unchanged,
                width: full.width,
                height: full.height,
                intrinsics: previous.intrinsics
            )
        }

        var minX = full.width
        var minY = full.height
        var maxX = -1
        var maxY = -1
        for index in 0..<full.width * full.height {
            if previousValues[index] != nextValues[index] || previousConfidence[index] != nextConfidence[index] {
                let x = index % full.width
                let y = index / full.width
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY else { return full }
        let patchWidth = maxX - minX + 1
        let patchHeight = maxY - minY + 1
        let patchCount = patchWidth * patchHeight
        guard patchCount < full.width * full.height / 2 else { return full }
        var values: [Float] = []
        var confidence: [Float] = []
        values.reserveCapacity(patchCount)
        confidence.reserveCapacity(patchCount)
        for row in minY...maxY {
            for column in minX...maxX {
                let source = row * full.width + column
                values.append(nextValues[source])
                confidence.append(nextConfidence[source])
            }
        }
        return DepthUpdateWire(
            mode: .rect,
            width: patchWidth,
            height: patchHeight,
            x: minX,
            y: minY,
            baseWidth: full.width,
            baseHeight: full.height,
            intrinsics: intrinsics,
            values: values,
            confidence: confidence
        )
    }
}
