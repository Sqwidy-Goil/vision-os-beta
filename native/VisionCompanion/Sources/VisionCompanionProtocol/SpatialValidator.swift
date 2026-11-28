import Foundation

public enum SpatialValidator {
    public static func validateCalibration(_ value: Any?) throws {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["kind", "calibrationId", "confidence", "frame", "depthUnits", "origin", "orientation"],
            label: "Companion calibration"
        )
        guard object["kind"] as? String == "calibration",
              object["frame"] as? String == CompanionProtocol.coordinateFrame,
              object["depthUnits"] as? String == CompanionProtocol.depthUnits else {
            throw CompanionProtocolError("Unsupported companion coordinate calibration.")
        }
        _ = try ProtocolValidation.identifier(object["calibrationId"])
        _ = try ProtocolValidation.number(object["confidence"], label: "calibration confidence", minimum: 0.65, maximum: 1)
        _ = try ProtocolValidation.vector(object["origin"], label: "calibration origin", bound: 100)
        _ = try ProtocolValidation.quaternion(object["orientation"])
    }

    public static func validateSample(
        _ value: Any?,
        previousFrameId: Int? = nil,
        previousTimestamp: Double? = nil,
        previousDepthIntrinsics: CameraIntrinsicsWire? = nil
    ) throws {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["kind", "frameId", "timestamp", "baseFrameId", "reset", "calibrationId", "poseMode", "pose", "calibrationConfidence"],
            optional: ["depth", "surfaces", "objects", "freeSpace", "removed"],
            label: "Companion sample"
        )
        guard object["kind"] as? String == "sample" else {
            throw CompanionProtocolError("Invalid companion sample.")
        }
        let frameId = try ProtocolValidation.integer(object["frameId"], label: "frame identifier", minimum: 1)
        let timestamp = try ProtocolValidation.number(object["timestamp"], label: "sample timestamp", minimum: 0)
        let baseFrameId = try ProtocolValidation.integer(object["baseFrameId"], label: "base frame identifier")
        let reset = try ProtocolValidation.bool(object["reset"], label: "sample reset")
        _ = try ProtocolValidation.identifier(object["calibrationId"])
        _ = try ProtocolValidation.number(object["calibrationConfidence"], label: "calibration confidence", minimum: 0.65, maximum: 1)
        if let previousTimestamp, (timestamp <= previousTimestamp || timestamp - previousTimestamp > 1000) {
            throw CompanionProtocolError("Companion sample sequence or timestamp is stale.")
        }
        if let previousFrameId, frameId <= previousFrameId {
            throw CompanionProtocolError("Companion sample sequence or timestamp is stale.")
        }
        if reset {
            guard baseFrameId == 0, object["poseMode"] as? String == "full",
                  object["removed"] == nil,
                  object["surfaces"] != nil, object["objects"] != nil, object["freeSpace"] != nil else {
                throw CompanionProtocolError("Full companion samples require complete environment arrays.")
            }
        } else {
            guard let previousFrameId, baseFrameId == previousFrameId,
                  object["depth"] != nil || object["surfaces"] != nil
                    || object["objects"] != nil || object["freeSpace"] != nil || object["removed"] != nil else {
                throw CompanionProtocolError("Companion incremental sample has an invalid base or no changes.")
            }
        }
        try validatePose(object["pose"], mode: object["poseMode"], hasPrevious: !reset && previousFrameId != nil)

        if let depth = object["depth"] {
            try validateDepth(
                depth,
                timestamp: timestamp,
                previousIntrinsics: reset ? nil : previousDepthIntrinsics,
                reset: reset
            )
        }
        if let surfaces = object["surfaces"] {
            let values = try ProtocolValidation.array(surfaces, label: "surfaces")
            guard values.count <= 12 else { throw CompanionProtocolError("Too many companion surfaces.") }
            var ids = Set<String>()
            for surface in values {
                try validateSurface(surface, timestamp: timestamp)
                let id = try ProtocolValidation.identifier((surface as? [String: Any])?["id"])
                guard ids.insert(id).inserted else { throw CompanionProtocolError("Duplicate companion surface identifiers.") }
            }
        }
        if let objects = object["objects"] {
            let values = try ProtocolValidation.array(objects, label: "objects")
            guard values.count <= 16 else { throw CompanionProtocolError("Too many companion objects.") }
            var ids = Set<String>()
            for object in values {
                try validateObject(object, timestamp: timestamp)
                let id = try ProtocolValidation.identifier((object as? [String: Any])?["id"])
                guard ids.insert(id).inserted else { throw CompanionProtocolError("Duplicate companion object identifiers.") }
            }
        }
        if let freeSpace = object["freeSpace"] {
            let values = try ProtocolValidation.array(freeSpace, label: "free-space")
            guard values.count <= 64 else { throw CompanionProtocolError("Too many companion free-space cells.") }
            var ids = Set<String>()
            for cell in values {
                try validateFreeSpace(cell, timestamp: timestamp)
                let id = try ProtocolValidation.identifier((cell as? [String: Any])?["id"])
                guard ids.insert(id).inserted else { throw CompanionProtocolError("Duplicate companion free-space identifiers.") }
            }
        }
        if let removed = object["removed"] {
            let removedObject = try ProtocolValidation.assertExactKeys(
                removed,
                required: ["surfaces", "objects", "freeSpace"],
                label: "Companion removals"
            )
            for key in ["surfaces", "objects", "freeSpace"] {
                let ids = try ProtocolValidation.array(removedObject[key], label: "removals")
                var seen = Set<String>()
                for entry in ids {
                    let id = try ProtocolValidation.identifier(entry)
                    guard seen.insert(id).inserted else { throw CompanionProtocolError("Duplicate companion removal identifiers.") }
                }
            }
        }
    }

    private static func validatePose(_ value: Any?, mode: Any?, hasPrevious: Bool) throws {
        let modeString = try ProtocolValidation.string(mode, label: "pose update mode")
        guard let object = value as? [String: Any] else {
            throw CompanionProtocolError("Invalid companion pose.")
        }
        if modeString == "full" {
            try ProtocolValidation.assertExactKeys(
                object,
                required: ["position", "quaternion", "velocity", "covariance", "confidence"],
                label: "Companion pose"
            )
            _ = try ProtocolValidation.vector(object["position"], label: "position")
            _ = try ProtocolValidation.quaternion(object["quaternion"])
            _ = try ProtocolValidation.vector(object["velocity"], label: "velocity", bound: 30)
            try validateCovariance(object["covariance"], size: 6)
            _ = try ProtocolValidation.confidence(object["confidence"])
            return
        }
        guard modeString == "delta", hasPrevious else {
            throw CompanionProtocolError("Invalid companion pose update mode.")
        }
        try ProtocolValidation.assertExactKeys(
            object,
            required: [],
            optional: ["position", "quaternion", "velocity", "covariance", "confidence"],
            label: "Companion pose delta"
        )
        guard !object.isEmpty else {
            throw CompanionProtocolError("Companion pose delta has no matching base or changes.")
        }
        if let position = object["position"] {
            _ = try ProtocolValidation.vector(position, label: "position delta", bound: 30)
        }
        if let quaternion = object["quaternion"] {
            _ = try ProtocolValidation.quaternion(quaternion)
        }
        if let velocity = object["velocity"] {
            _ = try ProtocolValidation.vector(velocity, label: "velocity delta", bound: 30)
        }
        if let covariance = object["covariance"] {
            try validateCovariance(covariance, size: 6)
        }
        if let confidence = object["confidence"] {
            _ = try ProtocolValidation.confidence(confidence)
        }
    }

    private static func validateCovariance(_ value: Any?, size: Int) throws {
        let values = try ProtocolValidation.array(value, label: "covariance")
        let covariance = try values.map { try ProtocolValidation.number($0, label: "covariance") }
        guard SpatialMath.isPositiveSemidefinite(covariance, size: size) else {
            throw CompanionProtocolError("Companion covariance is invalid or not positive semidefinite.")
        }
    }

    private static func validateDepth(_ value: Any?, timestamp: Double, previousIntrinsics: CameraIntrinsicsWire?, reset: Bool) throws {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["mode", "width", "height", "intrinsics"],
            optional: ["x", "y", "baseWidth", "baseHeight", "values", "confidence"],
            label: "Companion depth update"
        )
        let mode = try ProtocolValidation.string(object["mode"], label: "depth update mode")
        guard ["full", "rect", "unchanged"].contains(mode) else {
            throw CompanionProtocolError("Invalid companion depth update mode.")
        }
        if mode == "rect" {
            guard object["x"] != nil, object["y"] != nil, object["baseWidth"] != nil, object["baseHeight"] != nil else {
                throw CompanionProtocolError("Depth rectangles require bounds and a base resolution.")
            }
        } else {
            guard object["x"] == nil, object["y"] == nil, object["baseWidth"] == nil, object["baseHeight"] == nil else {
                throw CompanionProtocolError("Full or unchanged depth must not include rectangle bounds.")
            }
        }
        let fullWidth = try ProtocolValidation.integer(
            mode == "rect" ? object["baseWidth"] : object["width"],
            label: "base depth width", minimum: 1, maximum: 512
        )
        let fullHeight = try ProtocolValidation.integer(
            mode == "rect" ? object["baseHeight"] : object["height"],
            label: "base depth height", minimum: 1, maximum: 512
        )
        guard fullWidth * fullHeight <= 262_144 else {
            throw CompanionProtocolError("Companion depth resolution exceeds its limit.")
        }
        let intrinsics = try CameraIntrinsicsWire.parse(
            object["intrinsics"], width: fullWidth, height: fullHeight,
            timestamp: timestamp, requireCurrentTimestamp: mode != "unchanged"
        )
        if mode == "rect" && !reset {
            guard let previousIntrinsics,
                  previousIntrinsics.width == fullWidth, previousIntrinsics.height == fullHeight,
                  previousIntrinsics.sameCalibration(as: intrinsics) else {
                throw CompanionProtocolError("Depth rectangle has no matching base frame or intrinsics.")
            }
        }
        if mode == "unchanged" {
            guard !reset, let previousIntrinsics,
                  previousIntrinsics.timestamp == intrinsics.timestamp,
                  previousIntrinsics.sameCalibration(as: intrinsics),
                  object["values"] == nil, object["confidence"] == nil else {
                throw CompanionProtocolError("Unchanged depth has no matching base frame or intrinsics.")
            }
            return
        }
        let x = mode == "rect" ? try ProtocolValidation.integer(object["x"], label: "depth patch x", minimum: 0, maximum: fullWidth - 1) : 0
        let y = mode == "rect" ? try ProtocolValidation.integer(object["y"], label: "depth patch y", minimum: 0, maximum: fullHeight - 1) : 0
        let patchWidth = mode == "rect" ? try ProtocolValidation.integer(object["width"], label: "depth patch width", minimum: 1, maximum: fullWidth - x) : fullWidth
        let patchHeight = mode == "rect" ? try ProtocolValidation.integer(object["height"], label: "depth patch height", minimum: 1, maximum: fullHeight - y) : fullHeight
        let count = patchWidth * patchHeight
        let values = try float32Array(object["values"], expected: count, label: "values")
        let confidence = try float32Array(object["confidence"], expected: count, label: "confidence")
        var usable = 0
        for (range, certain) in zip(values, confidence) {
            guard range.isFinite, certain.isFinite, certain >= 0, certain <= 1,
                  range == 0 || (range >= 0.05 && range <= 30) else {
                throw CompanionProtocolError("Companion depth contains invalid or out-of-bounds samples.")
            }
            if range >= 0.05 && certain >= 0.45 { usable += 1 }
        }
        if mode == "full" && usable == 0 {
            throw CompanionProtocolError("Companion depth contains no usable samples.")
        }
    }

    private static func float32Array(_ value: Any?, expected: Int, label: String) throws -> [Float] {
        if let value = value as? String {
            let data = try CompanionBinary.decodeBase64(value)
            guard data.count == expected * 4 else { throw CompanionProtocolError("Companion depth array length mismatch.") }
            return data.withUnsafeBytes { buffer in
                (0..<expected).map { Float(bitPattern: UInt32(littleEndian: buffer.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self))) }
            }
        }
        let values = try ProtocolValidation.array(value, label: "depth \(label)")
        guard values.count == expected else { throw CompanionProtocolError("Companion depth array length mismatch.") }
        return try values.map {
            let number = try ProtocolValidation.number($0, label: "depth \(label)")
            let float = Float(number)
            guard float.isFinite else { throw CompanionProtocolError("Invalid companion depth \(label).") }
            return float
        }
    }

    private static func validateSurface(_ value: Any?, timestamp: Double) throws {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["id", "kind", "confidence", "observedAt"],
            optional: ["normal", "point", "vertices", "indices", "covariance"],
            label: "Companion surface"
        )
        _ = try ProtocolValidation.identifier(object["id"])
        let kind = try ProtocolValidation.string(object["kind"], label: "surface kind")
        guard kind == "plane" || kind == "mesh" else { throw CompanionProtocolError("Invalid companion surface kind.") }
        guard try ProtocolValidation.number(object["observedAt"], label: "observation timestamp") == timestamp else {
            throw CompanionProtocolError("Companion surface timestamp does not match its frame.")
        }
        _ = try ProtocolValidation.confidence(object["confidence"])
        if let normal = object["normal"] { _ = try unitVector(normal) }
        if let point = object["point"] { _ = try ProtocolValidation.vector(point, label: "surface point") }
        if let covariance = object["covariance"] { try validateCovariance(covariance, size: 3) }
        if kind == "plane" {
            guard object["normal"] != nil, object["point"] != nil,
                  object["vertices"] == nil, object["indices"] == nil else {
                throw CompanionProtocolError("Companion planes require a normal and point only.")
            }
        } else {
            let vertices = try ProtocolValidation.array(object["vertices"], label: "simplified mesh vertices")
            let indices = try ProtocolValidation.array(object["indices"], label: "simplified mesh indices")
            guard vertices.count >= 3, vertices.count <= 12_000, vertices.count % 3 == 0,
                  indices.count >= 3, indices.count <= 18_000, indices.count % 3 == 0 else {
                throw CompanionProtocolError("Invalid simplified companion mesh.")
            }
            for vertex in vertices { _ = try ProtocolValidation.number(vertex, label: "mesh vertex", minimum: -1000, maximum: 1000) }
            for index in indices {
                _ = try ProtocolValidation.integer(index, label: "mesh index", minimum: 0, maximum: vertices.count / 3 - 1)
            }
        }
    }

    private static func unitVector(_ value: Any?) throws -> [Double] {
        let vector = try ProtocolValidation.vector(value, label: "normal")
        guard abs(SpatialMath.hypot(vector) - 1) <= 0.001 else {
            throw CompanionProtocolError("Companion plane normal is not normalized.")
        }
        return vector
    }

    private static func validateObject(_ value: Any?, timestamp: Double) throws {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["id", "center", "extents", "pointIds", "confidence", "observedAt"],
            optional: ["label"],
            label: "Companion object"
        )
        _ = try ProtocolValidation.identifier(object["id"])
        _ = try ProtocolValidation.vector(object["center"], label: "object center")
        let extents = try ProtocolValidation.vector(object["extents"], label: "object extents")
        guard extents.allSatisfy({ $0 >= 0 }) else {
            throw CompanionProtocolError("Companion object extents has invalid bounds.")
        }
        let points = try ProtocolValidation.array(object["pointIds"], label: "object points")
        guard points.count <= 256 else { throw CompanionProtocolError("Invalid companion object points.") }
        for point in points { _ = try ProtocolValidation.integer(point, label: "object point identifier") }
        _ = try ProtocolValidation.confidence(object["confidence"])
        if let label = object["label"] { _ = try ProtocolValidation.string(label, label: "object label", minLength: 0) }
        guard try ProtocolValidation.number(object["observedAt"], label: "observation timestamp") == timestamp else {
            throw CompanionProtocolError("Companion object timestamp does not match its frame.")
        }
    }

    private static func validateFreeSpace(_ value: Any?, timestamp: Double) throws {
        let object = try ProtocolValidation.assertExactKeys(
            value,
            required: ["id", "center", "extents", "confidence", "observedAt"],
            label: "Companion free-space cell"
        )
        _ = try ProtocolValidation.identifier(object["id"])
        _ = try ProtocolValidation.vector(object["center"], label: "free-space center")
        let extents = try ProtocolValidation.vector(object["extents"], label: "free-space extents")
        guard extents.allSatisfy({ $0 > 0 }) else { throw CompanionProtocolError("Companion free-space extents has invalid bounds.") }
        _ = try ProtocolValidation.confidence(object["confidence"])
        guard try ProtocolValidation.number(object["observedAt"], label: "observation timestamp") == timestamp else {
            throw CompanionProtocolError("Companion free-space timestamp does not match its frame.")
        }
    }
}
