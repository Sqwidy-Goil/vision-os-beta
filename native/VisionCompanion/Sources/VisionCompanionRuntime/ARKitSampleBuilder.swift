#if os(iOS)
import ARKit
import Foundation
import simd
import VisionCompanionProtocol

struct ARKitCaptureOptions {
    var preferSmoothedDepth: Bool
    var capturePlanes: Bool
    var captureMeshes: Bool
    var timestampUncertaintyMs: Double = 33.4
}

struct TimestampAlignment {
    /// Native ARKit capture clock, retained only for throttling and diagnostics.
    var captureMilliseconds: Double
    /// Session-relative protocol clock. The first accepted capture maps to 1 ms.
    var sampleMilliseconds: Double
    /// ARKit does not guarantee zero pose/scene-depth association latency.
    var poseDepthAssociationUncertaintyMs: Double = 33.4
    /// Mapping the first accepted capture to 1 ms has one capture-period uncertainty.
    var protocolOriginUncertaintyMs: Double = 33.4
    /// ARKit and wall-clock origins are intentionally not conflated. The host
    /// measures freshness at arrival; no cross-device offset is claimed.
    var wallClockOffsetMs: Double? = nil
}

struct ARKitBuilderOutput {
    var calibration: CalibrationWire?
    var sample: SpatialUpdateWire
    var timestampAlignment: TimestampAlignment
    var depthCaptured: Bool
    var surfaceCount: Int
    var previousFrameId: Int?
    var previousTimestamp: Double?
    var previousDepthIntrinsics: CameraIntrinsicsWire?
}

struct PreviousPose {
    var position: SIMD3<Float>
    var quaternion: [Double]
    var velocity: SIMD3<Float>
}

final class ARKitSampleBuilder {
    private var calibrationId: String?
    private var origin = SIMD3<Float>(repeating: 0)
    private var previousPose: PreviousPose?
    private var lastFrameId = 0
    private var lastTimestamp: Double?
    private var lastCaptureTimestamp: Double?
    private var captureTimestampOrigin: Double?
    private var lastFullDepth: DepthUpdateWire?
    private var lastDecoderDepthIntrinsics: CameraIntrinsicsWire?
    private var surfaces: [String: SurfaceWire] = [:]

    func reset() {
        calibrationId = nil
        previousPose = nil
        lastFrameId = 0
        lastTimestamp = nil
        lastCaptureTimestamp = nil
        captureTimestampOrigin = nil
        lastFullDepth = nil
        lastDecoderDepthIntrinsics = nil
        surfaces.removeAll()
    }

    func process(frame: ARFrame, trackingLimited: Bool, options: ARKitCaptureOptions) throws -> ARKitBuilderOutput? {
        let captureTimestamp = frame.timestamp * 1000
        guard captureTimestamp.isFinite, captureTimestamp >= 0 else { return nil }
        if let lastCaptureTimestamp, captureTimestamp <= lastCaptureTimestamp { return nil }
        guard frame.camera.trackingState != .notAvailable else { return nil }

        let translation = frame.camera.transform.columns.3.xyz
        let quaternion = Self.quaternion(from: frame.camera.transform)
        let priorRelativePosition = translation - origin
        var capturedDepth = ARKitFrameReader.readDepth(frame: frame, preferSmoothedDepth: options.preferSmoothedDepth)
        let recenter = Self.needsCalibrationReset(
            translation: priorRelativePosition,
            quaternion: quaternion,
            timestamp: captureTimestamp - (captureTimestampOrigin ?? captureTimestamp),
            origin: .zero,
            lastTimestamp: lastTimestamp,
            previousPose: previousPose
        )
        // An incremental sample without depth means "retain previous depth" in
        // protocol v1. Reset calibration instead of presenting stale depth as
        // current when scene depth disappears after it was available.
        let depthUnavailableAfterCapture = calibrationId != nil && capturedDepth == nil
        let reset = recenter || calibrationId == nil || depthUnavailableAfterCapture
        var emittedCalibration: CalibrationWire?
        if reset {
            origin = translation
            captureTimestampOrigin = captureTimestamp
            calibrationId = UUID().uuidString
            previousPose = nil
            lastFrameId = 0
            lastTimestamp = nil
            lastCaptureTimestamp = nil
            lastFullDepth = nil
            lastDecoderDepthIntrinsics = nil
            surfaces.removeAll()
            emittedCalibration = CalibrationWire(calibrationId: calibrationId!, confidence: trackingLimited ? 0.7 : 0.9)
        }

        // The host decoder requires the first post-calibration timestamp to be
        // in (0, 1000] ms and subsequent gaps to be at most 1000 ms. A
        // session-relative ARKit clock satisfies that without asserting a
        // wall-clock offset between devices.
        let timestamp = max(1, captureTimestamp - captureTimestampOrigin!)
        guard timestamp.isFinite, timestamp > 0 else { return nil }
        if var depth = capturedDepth {
            depth.intrinsics.timestamp = timestamp
            capturedDepth = depth
        }
        let currentRelativePosition = translation - origin
        guard Self.isBounded(currentRelativePosition) else {
            throw CompanionRuntimeError.poseOutsideProtocolBounds
        }
        var velocity = SIMD3<Float>(repeating: 0)
        if let previousPose, let lastTimestamp {
            let deltaSeconds = Float((timestamp - lastTimestamp) / 1000)
            guard deltaSeconds > 0, deltaSeconds <= 1 else {
                throw CompanionRuntimeError.poseOutsideProtocolBounds
            }
            velocity = (currentRelativePosition - previousPose.position) / deltaSeconds
            guard velocity.x.isFinite, velocity.y.isFinite, velocity.z.isFinite,
                  simd_length(velocity) <= 20 else {
                throw CompanionRuntimeError.poseOutsideProtocolBounds
            }
        }

        let currentSurfaces = Self.readSurfaces(
            frame: frame,
            origin: origin,
            timestamp: timestamp,
            confidence: trackingLimited ? 0.55 : 0.75,
            options: options
        )
        let nextFrameId = reset ? 1 : lastFrameId + 1
        let calibrationId = calibrationId!
        let calibrationConfidence = trackingLimited ? 0.65 : 0.85
        let covariance = TrackingUncertainty.covariance(trackingLimited: trackingLimited)
        let confidence = TrackingUncertainty.confidence(trackingLimited: trackingLimited)
        let fullPose = PoseWire(
            position: Self.array(currentRelativePosition),
            quaternion: quaternion,
            velocity: Self.array(velocity),
            covariance: covariance,
            confidence: confidence
        )

        let poseUpdate: PoseUpdateWire
        if reset || previousPose == nil {
            poseUpdate = .full(fullPose)
        } else {
            let previous = previousPose!
            poseUpdate = .delta(PoseDeltaWire(
                position: Self.array(currentRelativePosition - previous.position),
                quaternion: SpatialMath.multiply(SpatialMath.inverse(previous.quaternion), quaternion),
                velocity: Self.array(velocity - previous.velocity),
                covariance: covariance,
                confidence: confidence
            ))
        }

        var emittedDepth: DepthUpdateWire?
        if let capturedDepth {
            let nextIntrinsics = capturedDepth.intrinsics
            let planned = try DepthPlanner.plan(
                previous: reset ? nil : lastFullDepth,
                nextValues: capturedDepth.values,
                nextConfidence: capturedDepth.confidence,
                intrinsics: nextIntrinsics
            )
            if planned.mode == .unchanged, let retained = lastDecoderDepthIntrinsics {
                emittedDepth = DepthUpdateWire(
                    mode: .unchanged,
                    width: planned.width,
                    height: planned.height,
                    intrinsics: retained
                )
            } else {
                emittedDepth = planned
            }
            lastFullDepth = DepthUpdateWire(
                mode: .full,
                width: capturedDepth.width,
                height: capturedDepth.height,
                intrinsics: nextIntrinsics,
                values: capturedDepth.values,
                confidence: capturedDepth.confidence
            )
        }

        let changedSurfaces = currentSurfaces.filter { surface in
            guard let previous = surfaces[surface.id] else { return true }
            return !previous.contentEqual(to: surface)
        }
        let removedSurfaceIDs = Set(surfaces.keys).subtracting(Set(currentSurfaces.map { $0.id })).sorted()
        let wireSurfaces: [SurfaceWire]?
        if reset {
            wireSurfaces = currentSurfaces
        } else {
            wireSurfaces = changedSurfaces.isEmpty ? nil : changedSurfaces
        }
        let removed: RemovedWire?
        if reset {
            removed = nil
        } else if !changedSurfaces.isEmpty || !removedSurfaceIDs.isEmpty || emittedDepth == nil {
            // A no-op removals object is a valid protocol change and prevents a
            // depth-free frame from being rejected as having no changes.
            removed = RemovedWire(surfaces: removedSurfaceIDs)
        } else {
            removed = nil
        }

        let sample = SpatialUpdateWire(
            frameId: nextFrameId,
            timestamp: timestamp,
            baseFrameId: reset ? 0 : lastFrameId,
            reset: reset,
            calibrationId: calibrationId,
            pose: poseUpdate,
            calibrationConfidence: calibrationConfidence,
            depth: emittedDepth,
            surfaces: wireSurfaces,
            objects: reset ? [] : nil,
            freeSpace: reset ? [] : nil,
            removed: removed
        )
        try SpatialValidator.validateSample(
            sample.dictionary(),
            previousFrameId: reset ? nil : lastFrameId,
            previousTimestamp: reset ? nil : lastTimestamp,
            previousDepthIntrinsics: reset ? nil : lastDecoderDepthIntrinsics
        )

        let priorFrameId: Int? = reset ? nil : lastFrameId
        let priorTimestamp: Double? = reset ? nil : lastTimestamp
        let priorDepthIntrinsics: CameraIntrinsicsWire? = reset ? nil : lastDecoderDepthIntrinsics
        if reset || (emittedDepth != nil && emittedDepth?.mode != .unchanged) {
            lastDecoderDepthIntrinsics = capturedDepth?.intrinsics
        }
        previousPose = PreviousPose(position: currentRelativePosition, quaternion: quaternion, velocity: velocity)
        lastFrameId = nextFrameId
        lastTimestamp = timestamp
        lastCaptureTimestamp = captureTimestamp
        surfaces = Dictionary(uniqueKeysWithValues: currentSurfaces.map { ($0.id, $0) })

        return ARKitBuilderOutput(
            calibration: emittedCalibration,
            sample: sample,
            timestampAlignment: TimestampAlignment(
                captureMilliseconds: captureTimestamp,
                sampleMilliseconds: timestamp,
                poseDepthAssociationUncertaintyMs: options.timestampUncertaintyMs,
                protocolOriginUncertaintyMs: options.timestampUncertaintyMs,
                wallClockOffsetMs: nil
            ),
            depthCaptured: capturedDepth != nil,
            surfaceCount: currentSurfaces.count,
            previousFrameId: priorFrameId,
            previousTimestamp: priorTimestamp,
            previousDepthIntrinsics: priorDepthIntrinsics
        )
    }

    private static func needsCalibrationReset(
        translation: SIMD3<Float>,
        quaternion: [Double],
        timestamp: Double,
        origin: SIMD3<Float>,
        lastTimestamp: Double?,
        previousPose: PreviousPose?
    ) -> Bool {
        guard let lastTimestamp, let previousPose else { return true }
        let gap = timestamp - lastTimestamp
        if gap <= 0 || gap > 1000 { return true }
        if simd_length(translation - previousPose.position) > 30 { return true }
        let dot = abs(zip(previousPose.quaternion, quaternion).reduce(0.0) { dot, pair in dot + pair.0 * pair.1 })
        let angle = 2 * acos(min(1, max(-1, dot)))
        if angle > 1.0 { return true }
        return simd_length(translation - origin) > 800
    }

    private static func readSurfaces(
        frame: ARFrame,
        origin: SIMD3<Float>,
        timestamp: Double,
        confidence: Double,
        options: ARKitCaptureOptions
    ) -> [SurfaceWire] {
        var selected: [SurfaceWire] = []
        if options.capturePlanes {
            let planes = frame.anchors
                .compactMap { $0 as? ARPlaneAnchor }
                .sorted { $0.identifier.uuidString < $1.identifier.uuidString }
                .prefix(8)
                .compactMap { readPlane($0, origin: origin, timestamp: timestamp, confidence: confidence) }
            selected.append(contentsOf: planes)
        }
        if options.captureMeshes {
            let remaining = max(0, 12 - selected.count)
            let meshes = frame.anchors
                .compactMap { $0 as? ARMeshAnchor }
                .sorted { $0.identifier.uuidString < $1.identifier.uuidString }
                .prefix(remaining)
                .compactMap { readMesh($0, origin: origin, timestamp: timestamp, confidence: confidence) }
            selected.append(contentsOf: meshes)
        }
        return selected
    }

    private static func readPlane(_ anchor: ARPlaneAnchor, origin: SIMD3<Float>, timestamp: Double, confidence: Double) -> SurfaceWire? {
        let orientation = quaternion(from: anchor.transform)
        let normal = SpatialMath.rotate([0, 1, 0], orientation: orientation)
        let localCenter = SIMD4<Float>(anchor.center.x, 0, anchor.center.z, 1)
        let point = anchor.transform * localCenter
        let relative = SIMD3<Float>(point.x, point.y, point.z) - origin
        guard isBounded(relative), abs(SpatialMath.hypot(normal) - 1) <= 0.001 else { return nil }
        return SurfaceWire(
            id: anchor.identifier.uuidString,
            kind: .plane,
            normal: normal,
            point: array(relative),
            confidence: confidence,
            observedAt: timestamp
        )
    }

    private static func readMesh(_ anchor: ARMeshAnchor, origin: SIMD3<Float>, timestamp: Double, confidence: Double) -> SurfaceWire? {
        let geometry = anchor.geometry
        guard geometry.vertices.count >= 3,
              geometry.vertices.componentsPerVector == 3,
              geometry.faces.count >= 1,
              geometry.faces.indexCountPerPrimitive == 3,
              geometry.faces.primitiveType == .triangle,
              geometry.faces.bytesPerIndex == 2 || geometry.faces.bytesPerIndex == 4 else { return nil }
        var localVertices: [SIMD3<Float>] = []
        localVertices.reserveCapacity(geometry.vertices.count)
        let vertexBytes = geometry.vertices.buffer.contents().assumingMemoryBound(to: UInt8.self)
        for index in 0..<geometry.vertices.count {
            let offset = geometry.vertices.offset + index * geometry.vertices.stride
            guard offset + 12 <= geometry.vertices.buffer.length else { return nil }
            let vertex = SIMD3<Float>(
                vertexBytes.loadUnaligned(fromByteOffset: offset, as: Float.self),
                vertexBytes.loadUnaligned(fromByteOffset: offset + 4, as: Float.self),
                vertexBytes.loadUnaligned(fromByteOffset: offset + 8, as: Float.self)
            )
            guard vertex.x.isFinite, vertex.y.isFinite, vertex.z.isFinite else { return nil }
            localVertices.append(vertex)
        }

        var localIndices: [UInt32] = []
        let indexCount = geometry.faces.count * geometry.faces.indexCountPerPrimitive
        localIndices.reserveCapacity(indexCount)
        let indexBytes = geometry.faces.buffer.contents().assumingMemoryBound(to: UInt8.self)
        for index in 0..<indexCount {
            let offset = index * geometry.faces.bytesPerIndex
            if geometry.faces.bytesPerIndex == 2 {
                guard offset + 2 <= geometry.faces.buffer.length else { return nil }
                localIndices.append(UInt32(indexBytes.loadUnaligned(fromByteOffset: offset, as: UInt16.self)))
            } else {
                guard offset + 4 <= geometry.faces.buffer.length else { return nil }
                localIndices.append(indexBytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
            }
        }
        guard let simplified = MeshSimplifier.simplify(vertices: localVertices, indices: localIndices) else { return nil }
        var vertices: [Double] = []
        vertices.reserveCapacity(simplified.vertices.count * 3)
        for local in simplified.vertices {
            let world = anchor.transform * SIMD4<Float>(local, 1)
            let relative = SIMD3<Float>(world.x, world.y, world.z) - origin
            guard isBounded(relative) else { return nil }
            vertices.append(contentsOf: array(relative))
        }
        return SurfaceWire(
            id: anchor.identifier.uuidString,
            kind: .mesh,
            vertices: vertices,
            indices: simplified.indices.map { Int($0) },
            confidence: confidence,
            observedAt: timestamp
        )
    }

    static func quaternion(from transform: simd_float4x4) -> [Double] {
        let m00 = Double(transform.columns[0].x), m01 = Double(transform.columns[1].x), m02 = Double(transform.columns[2].x)
        let m10 = Double(transform.columns[0].y), m11 = Double(transform.columns[1].y), m12 = Double(transform.columns[2].y)
        let m20 = Double(transform.columns[0].z), m21 = Double(transform.columns[1].z), m22 = Double(transform.columns[2].z)
        let trace = m00 + m11 + m22
        var output: [Double]
        if trace > 0 {
            let scale = sqrt(max(0, trace + 1) * 2)
            output = [(m21 - m12) / scale, (m02 - m20) / scale, (m10 - m01) / scale, scale / 4]
        } else if m00 > m11 && m00 > m22 {
            let scale = sqrt(max(0, 1 + m00 - m11 - m22) * 2)
            output = [scale / 4, (m01 + m10) / scale, (m02 + m20) / scale, (m21 - m12) / scale]
        } else if m11 > m22 {
            let scale = sqrt(max(0, 1 + m11 - m00 - m22) * 2)
            output = [(m01 + m10) / scale, scale / 4, (m12 + m21) / scale, (m02 - m20) / scale]
        } else {
            let scale = sqrt(max(0, 1 + m22 - m00 - m11) * 2)
            output = [(m02 + m20) / scale, (m12 + m21) / scale, scale / 4, (m10 - m01) / scale]
        }
        let length = SpatialMath.hypot(output)
        guard length.isFinite, length > 0 else { return [0, 0, 0, 1] }
        return output.map { $0 / length }
    }

    static func isBounded(_ value: SIMD3<Float>) -> Bool {
        value.x.isFinite && value.y.isFinite && value.z.isFinite
            && abs(value.x) <= 1000 && abs(value.y) <= 1000 && abs(value.z) <= 1000
    }

    static func array(_ value: SIMD3<Float>) -> [Double] {
        [Double(value.x), Double(value.y), Double(value.z)]
    }
}
#endif
