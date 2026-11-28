import Foundation
import Metal
import MetalKit
import QuartzCore
import SwiftUI
import UIKit
import simd

struct WindowUniforms {
    var viewProjection = matrix_identity_float4x4
    var model = matrix_identity_float4x4
    var tint = SIMD4<Float>(1, 1, 1, 1)
    var params = SIMD4<Float>(0, 0, 0, 0)
}

struct BackgroundUniforms {
    var inverseViewProjection = matrix_identity_float4x4
    var cameraPosition = SIMD4<Float>(0, 0, 0, 1)
    var topColor = SIMD4<Float>(0, 0, 0, 1)
    var bottomColor = SIMD4<Float>(0, 0, 0, 1)
    var params = SIMD4<Float>(0, 0, 0, 0)
}

struct PostUniforms {
    var params = SIMD4<Float>(0, 0, 0, 0)
}

struct WindowVertex {
    var position: SIMD4<Float>
    var uv: SIMD2<Float>
}

struct WindowHit {
    let windowID: UUID
    let uv: SIMD2<Float>

    var action: WindowHitAction {
        if uv.x > 0.9 && uv.y < 0.17 { return .close }
        if uv.x > 0.81 && uv.y < 0.17 { return .minimize }
        if uv.x > 0.77 && uv.y > 0.72 { return .resize }
        if uv.y > 0.8 { return .move }
        return .body
    }
}

enum WindowHitAction {
    case close
    case minimize
    case resize
    case move
    case body
}

@MainActor
final class StereoscopicRenderer {
    let device: MTLDevice

    private let commandQueue: MTLCommandQueue
    private let library: MTLLibrary
    private let windowPipeline: MTLRenderPipelineState
    private let backgroundPipeline: MTLRenderPipelineState
    private let postPipeline: MTLRenderPipelineState
    private let depthState: MTLDepthStencilState
    private let sampler: MTLSamplerState
    private let vertexBuffer: MTLBuffer

    private var eyeTargets: EyeTargets?
    private var windowTextures: [UUID: MTLTexture] = [:]
    private var textureStatuses: [UUID: String] = [:]
    private var panoramaTexture: MTLTexture?
    private var quality: AdaptiveQuality
    private var lastFrameTime: TimeInterval?
    private var smoothedOrientation = simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))

    private(set) var gazedWindowID: UUID?
    private(set) var latestSnapshot = RenderFrameSnapshot(frameTime: 0, fps: 0, pixelRatio: 1, windowCount: 0, drawCalls: 0)
    var onFrame: ((RenderFrameSnapshot) -> Void)?

    init(device: MTLDevice) throws {
        self.device = device
        commandQueue = try Self.required(device.makeCommandQueue(), "Metal command queue")
        library = try Self.required(device.makeDefaultLibrary(), "Metal shader library")
        windowPipeline = try Self.makePipeline(
            device: device,
            library: library,
            vertex: "window_vertex",
            fragment: "window_fragment",
            colorFormat: .rgba8Unorm,
            depthFormat: .depth32Float,
            vertexDescriptor: Self.windowVertexDescriptor
        )
        backgroundPipeline = try Self.makePipeline(
            device: device,
            library: library,
            vertex: "background_vertex",
            fragment: "background_fragment",
            colorFormat: .rgba8Unorm,
            depthFormat: nil,
            vertexDescriptor: nil
        )
        postPipeline = try Self.makePipeline(
            device: device,
            library: library,
            vertex: "background_vertex",
            fragment: "post_fragment",
            colorFormat: .bgra8Unorm,
            depthFormat: nil,
            vertexDescriptor: nil
        )

        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .lessEqual
        depthDescriptor.isDepthWriteEnabled = true
        depthState = try Self.required(device.makeDepthStencilState(descriptor: depthDescriptor), "Metal depth state")

        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.sAddressMode = .clampToEdge
        samplerDescriptor.tAddressMode = .clampToEdge
        sampler = try Self.required(device.makeSamplerState(descriptor: samplerDescriptor), "Metal sampler")

        let vertices = [
            WindowVertex(position: SIMD4<Float>(-1, -1, 0, 1), uv: SIMD2<Float>(0, 1)),
            WindowVertex(position: SIMD4<Float>(1, -1, 0, 1), uv: SIMD2<Float>(1, 1)),
            WindowVertex(position: SIMD4<Float>(-1, 1, 0, 1), uv: SIMD2<Float>(0, 0)),
            WindowVertex(position: SIMD4<Float>(-1, 1, 0, 1), uv: SIMD2<Float>(0, 0)),
            WindowVertex(position: SIMD4<Float>(1, -1, 0, 1), uv: SIMD2<Float>(1, 1)),
            WindowVertex(position: SIMD4<Float>(1, 1, 0, 1), uv: SIMD2<Float>(1, 0))
        ]
        vertexBuffer = try Self.required(device.makeBuffer(bytes: vertices, length: MemoryLayout<WindowVertex>.stride * vertices.count, options: .storageModeShared), "Metal vertex buffer")
        quality = AdaptiveQuality(maximumPixelRatio: 1)
        panoramaTexture = try texture(from: WindowTextureFactory.placeholder())
    }

    func updateWindows(_ windows: [SpatialWindow], statuses: [AppModule: String] = [:]) {
        let ids = Set(windows.map(\.id))
        windowTextures = windowTextures.filter { ids.contains($0.key) }
        textureStatuses = textureStatuses.filter { ids.contains($0.key) }
        for window in windows {
            let status = statuses[window.module] ?? "-"
            let signature = "\(window.lifecycle.rawValue)|\(window.isPinned)|\(window.placement.width)|\(window.placement.height)|\(status)"
            if windowTextures[window.id] == nil || textureStatuses[window.id] != signature {
                windowTextures[window.id] = try? texture(from: WindowTextureFactory.image(for: window, status: statuses[window.module]))
                textureStatuses[window.id] = signature
            }
        }
    }

    func setPanorama(image: UIImage?) {
        guard let image else {
            panoramaTexture = try? texture(from: WindowTextureFactory.placeholder())
            return
        }
        panoramaTexture = try? texture(from: Self.downsample(image, maxDimension: 2048))
    }

    func draw(
        in view: MTKView,
        windows: [SpatialWindow],
        orientation: simd_quatf,
        settings: AppSettings,
        environment: EnvironmentKind,
        selectedWindowID: UUID?,
        stereoscopic: Bool,
        gazeProgress: Float
    ) throws {
        guard let currentDrawable = view.currentDrawable,
              let screenDescriptor = view.currentRenderPassDescriptor else { return }
        let now = CACurrentMediaTime()
        let frameTime = lastFrameTime.map { max(0, now - $0) } ?? 1.0 / 60
        lastFrameTime = now
        quality.record(frameTime: frameTime, maximumPixelRatio: 1)

        let smoothing = 1 - Float(exp(-Double(settings.motionSensitivity) * 14 * frameTime))
        smoothedOrientation = simd_slerp(smoothedOrientation, orientation, smoothing)
        try ensureTargets(size: targetSize(for: view, stereoscopic: stereoscopic))

        guard let targets = eyeTargets,
              let commandBuffer = commandQueue.makeCommandBuffer() else { return }

        let rig = StereoCameraRig(
            orientation: smoothedOrientation,
            interpupillaryDistance: Float(settings.ipdMillimeters) / 1000
        )
        let fov = Float(settings.fieldOfView) * .pi / 180
        let eyeList: [Eye] = stereoscopic ? [.left, .right] : [.left]
        let orderedWindows = Self.drawOrder(windows)
        var drawCalls = 0

        for eye in eyeList {
            let target = eye == .left ? targets.left : targets.right
            var passDescriptor = MTLRenderPassDescriptor()
            passDescriptor.colorAttachments[0].texture = target.color
            passDescriptor.colorAttachments[0].loadAction = .clear
            passDescriptor.colorAttachments[0].storeAction = .store
            passDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0.01, green: 0.02, blue: 0.05, alpha: 1)
            passDescriptor.depthAttachment.texture = target.depth
            passDescriptor.depthAttachment.loadAction = .clear
            passDescriptor.depthAttachment.storeAction = .dontCare
            passDescriptor.depthAttachment.clearDepth = 1

            guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: passDescriptor) else { continue }
            encoder.setViewport(MTLViewport(originX: 0, originY: 0, width: Double(targets.size.width), height: Double(targets.size.height), znear: 0, zfar: 1))
            let aspect = Float(targets.size.width / max(targets.size.height, 1))
            let camera = rig.camera(eye, aspect: aspect, fieldOfView: fov)
            let worldCameraPosition = smoothedOrientation.act(camera.position)
            var background = BackgroundUniforms(
                inverseViewProjection: simd_inverse(camera.viewProjection),
                cameraPosition: SIMD4<Float>(worldCameraPosition.x, worldCameraPosition.y, worldCameraPosition.z, 1),
                topColor: Self.color(environment.topColor),
                bottomColor: Self.color(environment.bottomColor),
                params: SIMD4<Float>(environment.shaderKind, environment.gridStrength, Float(now.truncatingRemainder(dividingBy: 1000)), 0)
            )
            encoder.setRenderPipelineState(backgroundPipeline)
            encoder.setFragmentBytes(&background, length: MemoryLayout<BackgroundUniforms>.stride, index: 0)
            encoder.setFragmentTexture(panoramaTexture, index: 0)
            encoder.setFragmentSamplerState(sampler, index: 0)
            encoder.drawPrimitives(type: MTLPrimitiveType.triangle, vertexStart: 0, vertexCount: 3)
            drawCalls += 1

            encoder.setDepthStencilState(depthState)
            encoder.setRenderPipelineState(windowPipeline)
            encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
            encoder.setFragmentSamplerState(sampler, index: 0)

            for window in orderedWindows {
                guard let content = windowTextures[window.id] else { continue }
                var model = modelMatrix(for: window, orientation: smoothedOrientation, settings: settings)
                var uniforms = WindowUniforms(
                    viewProjection: camera.viewProjection,
                    model: model,
                    tint: Self.color(window.module.tint),
                    params: SIMD4<Float>(window.id == selectedWindowID ? 1 : 0, window.id == gazedWindowID ? gazeProgress : 0, 0, 0)
                )
                encoder.setVertexBytes(&uniforms, length: MemoryLayout<WindowUniforms>.stride, index: 1)
                encoder.setFragmentBytes(&uniforms, length: MemoryLayout<WindowUniforms>.stride, index: 0)
                encoder.setFragmentTexture(content, index: 0)
                encoder.drawPrimitives(type: MTLPrimitiveType.triangle, vertexStart: 0, vertexCount: 6)
                drawCalls += 1
            }
            encoder.endEncoding()
        }

        guard let finalEncoder = commandBuffer.makeRenderCommandEncoder(descriptor: screenDescriptor) else { return }
        finalEncoder.setRenderPipelineState(postPipeline)
        finalEncoder.setViewport(MTLViewport(originX: 0, originY: 0, width: Double(view.drawableSize.width), height: Double(view.drawableSize.height), znear: 0, zfar: 1))
        var post = PostUniforms(params: SIMD4<Float>(Float(settings.lensDistortion), stereoscopic ? 1 : 0, gazeProgress, 0))
        finalEncoder.setFragmentBytes(&post, length: MemoryLayout<PostUniforms>.stride, index: 0)
        finalEncoder.setFragmentTexture(targets.left.color, index: 0)
        finalEncoder.setFragmentTexture(targets.right.color, index: 1)
        finalEncoder.setFragmentSamplerState(sampler, index: 0)
        finalEncoder.drawPrimitives(type: MTLPrimitiveType.triangle, vertexStart: 0, vertexCount: 3)
        finalEncoder.endEncoding()
        drawCalls += 1

        commandBuffer.present(currentDrawable)
        commandBuffer.commit()

        latestSnapshot = RenderFrameSnapshot(
            frameTime: frameTime,
            fps: quality.averageFPS,
            pixelRatio: quality.pixelRatio,
            windowCount: windows.count,
            drawCalls: drawCalls
        )
        onFrame?(latestSnapshot)
    }

    func hitTest(point: CGPoint, viewport: CGRect, orientation: simd_quatf, settings: AppSettings, windows: [SpatialWindow], stereoscopic: Bool) -> WindowHit? {
        let eye: Eye = stereoscopic && point.x >= viewport.midX ? .right : .left
        let eyeViewport = stereoscopic
            ? CGRect(x: eye == .left ? viewport.minX : viewport.midX, y: viewport.minY, width: viewport.width / 2, height: viewport.height)
            : viewport
        let aspect = Float(eyeViewport.width / max(eyeViewport.height, 1))
        let camera = StereoCameraRig(orientation: orientation, interpupillaryDistance: Float(settings.ipdMillimeters) / 1000)
            .camera(eye, aspect: aspect, fieldOfView: Float(settings.fieldOfView) * .pi / 180)
        let ray = SpatialMath.ray(from: point, viewport: eyeViewport, viewProjection: camera.viewProjection)

        var nearest: (hit: WindowHit, distance: Float)?
        for window in windows {
            let model = modelMatrix(for: window, orientation: orientation, settings: settings)
            let center4 = model * SIMD4<Float>(0, 0, 0, 1)
            let normal4 = model * SIMD4<Float>(0, 0, 1, 0)
            let center = SIMD3<Float>(center4.x, center4.y, center4.z) / center4.w
            let normal = normalize(SIMD3<Float>(normal4.x, normal4.y, normal4.z))
            guard let worldPoint = SpatialMath.intersectPlane(rayOrigin: ray.origin, rayDirection: ray.direction, planePoint: center, planeNormal: normal),
                  let local = SpatialMath.localHit(point: worldPoint, modelMatrix: model),
                  abs(local.x) <= 0.5, abs(local.y) <= 0.5 else { continue }
            let distance = simd_distance(ray.origin, worldPoint)
            if let nearest, distance >= nearest.distance { continue }
            nearest = (WindowHit(windowID: window.id, uv: SIMD2<Float>(local.x + 0.5, 0.5 - local.y)), distance)
        }
        return nearest?.hit
    }

    func modelMatrix(for window: SpatialWindow, orientation: simd_quatf, settings: AppSettings) -> simd_float4x4 {
        let model = SpatialMath.modelMatrix(for: window, headOrientation: orientation)
        let distanceScale: Float = window.positioning == .worldLocked ? 1 : Float(settings.viewingDistance / 3.4)
        guard distanceScale != 1 else { return model }
        var columns = model.columns
        columns.3 = SIMD4<Float>(SIMD3<Float>(columns.3.x, columns.3.y, columns.3.z) * distanceScale, columns.3.w)
        return simd_float4x4(columns: columns)
    }

    func dragPlaneNormal(orientation: simd_quatf) -> SIMD3<Float> {
        orientation.act(SIMD3<Float>(0, 0, 1))
    }

    func updateGaze(in view: MTKView, orientation: simd_quatf, settings: AppSettings, windows: [SpatialWindow], stereoscopic: Bool) {
        guard stereoscopic else {
            gazedWindowID = nil
            return
        }
        let point = CGPoint(x: view.bounds.width * 0.25, y: view.bounds.height * 0.5)
        gazedWindowID = hitTest(point: point, viewport: view.bounds, orientation: smoothedOrientation, settings: settings, windows: windows, stereoscopic: true)?.windowID
    }

    private func ensureTargets(size: CGSize) throws {
        let integerSize = CGSize(width: max(1, Int(size.width)), height: max(1, Int(size.height)))
        if let eyeTargets, eyeTargets.size == integerSize { return }
        func makeColor() throws -> MTLTexture {
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: Int(integerSize.width), height: Int(integerSize.height), mipmapped: false)
            descriptor.usage = [.renderTarget, .shaderRead]
            descriptor.storageMode = .private
            return try Self.required(device.makeTexture(descriptor: descriptor), "Eye color target")
        }
        func makeDepth() throws -> MTLTexture {
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .depth32Float, width: Int(integerSize.width), height: Int(integerSize.height), mipmapped: false)
            descriptor.usage = .renderTarget
            descriptor.storageMode = .private
            return try Self.required(device.makeTexture(descriptor: descriptor), "Eye depth target")
        }
        eyeTargets = EyeTargets(size: integerSize, left: EyeTarget(color: try makeColor(), depth: try makeDepth()), right: EyeTarget(color: try makeColor(), depth: try makeDepth()))
    }

    private func targetSize(for view: MTKView, stereoscopic: Bool) -> CGSize {
        let width = view.drawableSize.width * CGFloat(quality.pixelRatio) / (stereoscopic ? 2 : 1)
        return CGSize(width: width, height: view.drawableSize.height * CGFloat(quality.pixelRatio))
    }

    private func texture(from image: UIImage) throws -> MTLTexture {
        guard let cgImage = image.cgImage else { throw RendererError.invalidTexture }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: cgImage.width, height: cgImage.height, mipmapped: false)
        descriptor.usage = .shaderRead
        let texture = try Self.required(device.makeTexture(descriptor: descriptor), "Window texture")
        guard let context = CGContext(
            data: nil,
            width: cgImage.width,
            height: cgImage.height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw RendererError.invalidTexture }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
        guard let pixels = context.data else { throw RendererError.invalidTexture }
        texture.replace(
            region: MTLRegionMake2D(0, 0, cgImage.width, cgImage.height),
            mipmapLevel: 0,
            withBytes: pixels,
            bytesPerRow: context.bytesPerRow
        )
        return texture
    }

    private static func downsample(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let scale = min(1, maxDimension / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        return UIGraphicsImageRenderer(size: size).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    private static func drawOrder(_ windows: [SpatialWindow]) -> [SpatialWindow] {
        windows.sorted {
            if $0.isPinned != $1.isPinned { return !$0.isPinned }
            return $0.zIndex < $1.zIndex
        }
    }

    private static func color(_ color: Color) -> SIMD4<Float> {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 1
        UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return SIMD4<Float>(Float(red), Float(green), Float(blue), Float(alpha))
    }

    private static func makePipeline(device: MTLDevice, library: MTLLibrary, vertex: String, fragment: String, colorFormat: MTLPixelFormat, depthFormat: MTLPixelFormat?, vertexDescriptor: MTLVertexDescriptor?) throws -> MTLRenderPipelineState {
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = try Self.required(library.makeFunction(name: vertex), "Metal vertex shader \(vertex)")
        descriptor.fragmentFunction = try Self.required(library.makeFunction(name: fragment), "Metal fragment shader \(fragment)")
        descriptor.vertexDescriptor = vertexDescriptor
        descriptor.colorAttachments[0].pixelFormat = colorFormat
        if let depthFormat { descriptor.depthAttachmentPixelFormat = depthFormat }
        descriptor.rasterSampleCount = 1
        return try Self.required(device.makeRenderPipelineState(descriptor: descriptor), "Metal pipeline \(vertex)")
    }

    private static let windowVertexDescriptor: MTLVertexDescriptor = {
        let descriptor = MTLVertexDescriptor()
        descriptor.attributes[0].format = .float4
        descriptor.attributes[0].offset = 0
        descriptor.attributes[0].bufferIndex = 0
        descriptor.attributes[1].format = .float2
        descriptor.attributes[1].offset = MemoryLayout<SIMD4<Float>>.stride
        descriptor.attributes[1].bufferIndex = 0
        descriptor.layouts[0].stride = MemoryLayout<WindowVertex>.stride
        descriptor.layouts[0].stepRate = 1
        descriptor.layouts[0].stepFunction = .perVertex
        return descriptor
    }()

    private static func required<T>(_ value: T?, _ name: String) throws -> T {
        guard let value else { throw RendererError.missingResource(name) }
        return value
    }
}

private struct EyeTarget {
    let color: MTLTexture
    let depth: MTLTexture
}

private struct EyeTargets {
    let size: CGSize
    let left: EyeTarget
    let right: EyeTarget
}

enum RendererError: LocalizedError {
    case missingResource(String)
    case invalidTexture

    var errorDescription: String? {
        switch self {
        case .missingResource(let name): "Metal could not create \(name)."
        case .invalidTexture: "A spatial texture could not be loaded."
        }
    }
}
