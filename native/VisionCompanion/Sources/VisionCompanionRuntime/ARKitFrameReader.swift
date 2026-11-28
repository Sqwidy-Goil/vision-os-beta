#if os(iOS)
import ARKit
import CoreVideo
import Foundation
import simd
import VisionCompanionProtocol

struct CapturedARKitDepth {
    var width: Int
    var height: Int
    var values: [Float]
    var confidence: [Float]
    var intrinsics: CameraIntrinsicsWire
}

enum ARKitFrameReader {
    static func readDepth(frame: ARFrame, preferSmoothedDepth: Bool) -> CapturedARKitDepth? {
        guard let sceneDepth = preferSmoothedDepth ? frame.smoothedSceneDepth ?? frame.sceneDepth : frame.sceneDepth,
              let depthMap = sceneDepth.depthMap,
              let confidenceMap = sceneDepth.confidenceMap,
              CVPixelBufferGetWidth(depthMap) == CVPixelBufferGetWidth(confidenceMap),
              CVPixelBufferGetHeight(depthMap) == CVPixelBufferGetHeight(confidenceMap) else { return nil }

        let sourceWidth = CVPixelBufferGetWidth(depthMap)
        let sourceHeight = CVPixelBufferGetHeight(depthMap)
        guard sourceWidth > 0, sourceHeight > 0, sourceWidth <= 4096, sourceHeight <= 4096,
              sourceWidth <= Int.max / sourceHeight, sourceWidth * sourceHeight <= 16_777_216 else { return nil }
        let scale = min(1.0, 512.0 / Double(sourceWidth), 512.0 / Double(sourceHeight))
        let width = max(1, Int((Double(sourceWidth) * scale).rounded(.down)))
        let height = max(1, Int((Double(sourceHeight) * scale).rounded(.down)))
        guard width <= 512, height <= 512, width * height <= 262_144 else { return nil }
        let scaleX = Double(width) / Double(sourceWidth)
        let scaleY = Double(height) / Double(sourceHeight)
        let image = frame.camera.imageResolution
        guard image.width > 0, image.height > 0 else { return nil }
        let camera = frame.camera.intrinsics
        let sourceFX = Double(camera[0][0])
        let sourceFY = Double(camera[1][1])
        let sourceCX = Double(camera[2][0])
        let sourceCY = Double(camera[2][1])
        let fx = sourceFX * Double(sourceWidth) / Double(image.width) * scaleX
        let fy = sourceFY * Double(sourceHeight) / Double(image.height) * scaleY
        let cx = (sourceCX * Double(sourceWidth) / Double(image.width) + 0.5) * scaleX - 0.5
        let cy = (sourceCY * Double(sourceHeight) / Double(image.height) + 0.5) * scaleY - 0.5
        guard fx > 1, fy > 1,
              cx >= 0, cx <= Double(width), cy >= 0, cy <= Double(height) else { return nil }

        guard let depthValues = readFloats(
          depthMap,
          supportedFormats: [kCVPixelFormatType_DepthFloat32, kCVPixelFormatType_DepthFloat16],
          outputWidth: width,
          outputHeight: height
        ), let confidenceValues = readFloats(
          confidenceMap,
          supportedFormats: [kCVPixelFormatType_Confidence32, kCVPixelFormatType_OneComponentFloat16],
          outputWidth: width,
          outputHeight: height
        ), depthValues.count == width * height, confidenceValues.count == depthValues.count else { return nil }

        let timestamp = frame.timestamp * 1000
        guard timestamp.isFinite, timestamp >= 0 else { return nil }
        var values = [Float](repeating: 0, count: width * height)
        var confidence = [Float](repeating: 0, count: width * height)
        var usable = 0
        for row in 0..<height {
            let sourceRow = min(sourceHeight - 1, Int((Double(row) + 0.5) / scaleY))
            for column in 0..<width {
                let sourceColumn = min(sourceWidth - 1, Int((Double(column) + 0.5) / scaleX))
                let source = sourceRow * sourceWidth + sourceColumn
                let range = depthValues[source]
                let certain = confidenceValues[source]
                let validRange = range.isFinite && range >= 0.05 && range <= 30
                let validConfidence = certain.isFinite && certain >= 0 && certain <= 1
                if validRange, validConfidence {
                    values[row * width + column] = range
                    confidence[row * width + column] = certain
                    if certain >= 0.45 { usable += 1 }
                }
            }
        }
        guard usable > 0 else { return nil }
        return CapturedARKitDepth(
            width: width,
            height: height,
            values: values,
            confidence: confidence,
            intrinsics: CameraIntrinsicsWire(
                width: width,
                height: height,
                fx: fx,
                fy: fy,
                cx: cx,
                cy: cy,
                timestamp: timestamp,
                calibration: "calibrated"
            )
        )
    }

    private static func readFloats(
        _ buffer: CVPixelBuffer,
        supportedFormats: [OSType],
        outputWidth: Int,
        outputHeight: Int
    ) -> [Float]? {
        let format = CVPixelBufferGetPixelFormatType(buffer)
        guard supportedFormats.contains(format),
              CVPixelBufferGetPlaneCount(buffer) == 1 else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let outputCount = outputWidth * outputHeight
        guard width > 0, height > 0, outputWidth > 0, outputHeight > 0, outputCount > 0,
              outputCount <= 262_144 else { return nil }
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let raw = base.assumingMemoryBound(to: UInt8.self)
        let bytesPerPixel: Int
        if format == kCVPixelFormatType_DepthFloat16 || format == kCVPixelFormatType_OneComponentFloat16 {
            bytesPerPixel = MemoryLayout<Float16>.size
        } else {
            bytesPerPixel = MemoryLayout<Float>.size
        }
        let scaleX = Double(outputWidth) / Double(width)
        let scaleY = Double(outputHeight) / Double(height)
        var output = [Float](repeating: 0, count: outputCount)
        for row in 0..<outputHeight {
            let sourceRow = min(height - 1, Int((Double(row) + 0.5) / scaleY))
            let rowStart = sourceRow * bytesPerRow
            guard rowStart + width * bytesPerPixel <= bytesPerRow else { return nil }
            for column in 0..<outputWidth {
                let sourceColumn = min(width - 1, Int((Double(column) + 0.5) / scaleX))
                let pointer = raw.advanced(by: rowStart + sourceColumn * bytesPerPixel)
                if format == kCVPixelFormatType_DepthFloat16 || format == kCVPixelFormatType_OneComponentFloat16 {
                    output[row * outputWidth + column] = Float(pointer.assumingMemoryBound(to: Float16.self).pointee)
                } else {
                    output[row * outputWidth + column] = pointer.assumingMemoryBound(to: Float.self).pointee
                }
            }
        }
        return output
    }
}
#endif
