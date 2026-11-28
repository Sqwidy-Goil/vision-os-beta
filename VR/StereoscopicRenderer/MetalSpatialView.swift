import Foundation
import MetalKit
import QuartzCore
import SwiftUI
import simd

struct MetalSpatialView: UIViewRepresentable {
    @ObservedObject var windowManager: WindowManager
    @ObservedObject var settings: AppSettings
    @ObservedObject var motion: MotionTracker

    var environment: EnvironmentKind
    var stereoscopic: Bool
    var isActive: Bool
    var statuses: [AppModule: String]
    var panoramaURL: URL?
    var onWindowOpen: (SpatialWindow) -> Void
    var onExitVR: () -> Void
    var onCycleWindow: (Bool) -> Void
    var onFrame: (RenderFrameSnapshot) -> Void
    var onError: (String) -> Void

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.colorPixelFormat = .bgra8Unorm
        view.framebufferOnly = true
        view.autoResizeDrawable = true
        view.enableSetNeedsDisplay = false
        view.isPaused = !isActive
        view.preferredFramesPerSecond = 90
        view.clearColor = MTLClearColor(red: 0.01, green: 0.02, blue: 0.05, alpha: 1)
        view.accessibilityLabel = stereoscopic ? "Stereoscopic spatial workspace" : "Spatial workspace"

        let coordinator = context.coordinator
        coordinator.attach(view)
        coordinator.stereoscopic = stereoscopic
        coordinator.onWindowOpen = onWindowOpen
        coordinator.onExitVR = onExitVR
        coordinator.onCycleWindow = onCycleWindow
        coordinator.onFrame = onFrame
        coordinator.onError = onError

        let tap = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.handleTap(_:)))
        view.addGestureRecognizer(tap)

        let pan = UIPanGestureRecognizer(target: coordinator, action: #selector(Coordinator.handlePan(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)

        let pinch = UIPinchGestureRecognizer(target: coordinator, action: #selector(Coordinator.handlePinch(_:)))
        view.addGestureRecognizer(pinch)

        let rotation = UIRotationGestureRecognizer(target: coordinator, action: #selector(Coordinator.handleRotation(_:)))
        view.addGestureRecognizer(rotation)

        let longPress = UILongPressGestureRecognizer(target: coordinator, action: #selector(Coordinator.handleLongPress(_:)))
        longPress.minimumPressDuration = 0.45
        view.addGestureRecognizer(longPress)

        for direction in [UISwipeGestureRecognizer.Direction.up, .down] {
            let swipe = UISwipeGestureRecognizer(target: coordinator, action: #selector(Coordinator.handleSwipe(_:)))
            swipe.direction = direction
            view.addGestureRecognizer(swipe)
        }

        let exitPan = UIPanGestureRecognizer(target: coordinator, action: #selector(Coordinator.handleExitPan(_:)))
        exitPan.minimumNumberOfTouches = 3
        exitPan.maximumNumberOfTouches = 3
        view.addGestureRecognizer(exitPan)
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {
        let coordinator = context.coordinator
        coordinator.windowManager = windowManager
        coordinator.settings = settings
        coordinator.motion = motion
        coordinator.environment = environment
        coordinator.stereoscopic = stereoscopic
        coordinator.statuses = statuses
        coordinator.onWindowOpen = onWindowOpen
        coordinator.onExitVR = onExitVR
        coordinator.onCycleWindow = onCycleWindow
        coordinator.onFrame = onFrame
        coordinator.onError = onError
        coordinator.view?.isPaused = !isActive
        coordinator.renderer?.updateWindows(windowManager.windows, statuses: statuses)
        if coordinator.lastPanoramaURL != panoramaURL {
            coordinator.lastPanoramaURL = panoramaURL
            coordinator.renderer?.setPanorama(image: panoramaURL.flatMap { UIImage(contentsOfFile: $0.path) })
        }
    }

    static func dismantleUIView(_ view: MTKView, context: Context) {
        context.coordinator.detach()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, MTKViewDelegate {
        weak var view: MTKView?
        var renderer: StereoscopicRenderer?
        var windowManager: WindowManager?
        var settings: AppSettings?
        var motion: MotionTracker?
        var environment: EnvironmentKind = .studio
        var stereoscopic = false
        var statuses: [AppModule: String] = [:]
        var lastPanoramaURL: URL?
        var onWindowOpen: ((SpatialWindow) -> Void)?
        var onExitVR: (() -> Void)?
        var onCycleWindow: ((Bool) -> Void)?
        var onFrame: ((RenderFrameSnapshot) -> Void)?
        var onError: ((String) -> Void)?

        private var gaze = GazeDwell()
        private var touchLook = simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))
        private var lookYaw: Float = 0
        private var lookPitch: Float = 0
        private var lastLookPoint: CGPoint?
        private var dragWindowID: UUID?
        private var dragStartIntersection: SIMD3<Float>?
        private var dragStartPlacement: WindowPlacement?
        private var dragPlanePoint: SIMD3<Float>?
        private var resizeStartPoint: CGPoint?
        private var dragAction: WindowHitAction?
        private var lastPinchScale: CGFloat = 1
        private var lastRotation: CGFloat = 0
        private var pinchWindowID: UUID?
        private var rotationWindowID: UUID?

        func attach(_ view: MTKView) {
            self.view = view
            view.delegate = self
            do {
                guard let device = view.device ?? MTLCreateSystemDefaultDevice() else {
                    onError?("Metal is not available on this device.")
                    return
                }
                renderer = try StereoscopicRenderer(device: device)
                renderer?.onFrame = { [weak self] snapshot in
                    self?.onFrame?(snapshot)
                }
            } catch {
                onError?(error.localizedDescription)
            }
        }

        func detach() {
            view?.delegate = nil
            renderer = nil
            view = nil
        }

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

        func draw(in view: MTKView) {
            guard let renderer, let windowManager, let settings, let motion else { return }
            let orientation = motion.orientation * touchLook
            renderer.updateGaze(in: view, orientation: orientation, settings: settings, windows: windowManager.windows, stereoscopic: stereoscopic)
            if let completedID = gaze.update(target: renderer.gazedWindowID, now: CACurrentMediaTime()),
               let window = windowManager.windows.first(where: { $0.id == completedID }) {
                windowManager.focus(window.id)
            }

            do {
                try renderer.draw(
                    in: view,
                    windows: windowManager.windows,
                    orientation: orientation,
                    settings: settings,
                    environment: environment,
                    selectedWindowID: windowManager.selectedWindowID,
                    stereoscopic: stereoscopic,
                    gazeProgress: gaze.progress
                )
            } catch {
                onError?(error.localizedDescription)
                view.isPaused = true
            }
        }

        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard let view, let renderer, let settings, let windowManager else { return }
            let point = gesture.location(in: view)
            if stereoscopic, isExitPoint(point, in: view) {
                onExitVR?()
                return
            }
            guard let hit = currentHit(at: point) else { return }
            switch hit.action {
            case .close:
                windowManager.close(hit.windowID)
            case .minimize:
                windowManager.minimize(hit.windowID)
            case .move, .resize, .body:
                windowManager.focus(hit.windowID)
            }
        }

        @objc func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
            guard gesture.state == .began, let view, let windowManager else { return }
            if stereoscopic, isExitPoint(gesture.location(in: view), in: view) {
                onExitVR?()
                return
            }
            guard let hit = currentHit(at: gesture.location(in: view)),
                  let window = windowManager.windows.first(where: { $0.id == hit.windowID }) else { return }
            windowManager.focus(window.id)
            onWindowOpen?(window)
        }

        @objc func handlePan(_ gesture: UIPanGestureRecognizer) {
            guard let view, let renderer, let settings, let windowManager else { return }
            let point = gesture.location(in: view)
            let orientation = (motion?.orientation ?? simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))) * touchLook

            switch gesture.state {
            case .began:
                lastLookPoint = point
                guard let hit = currentHit(at: point), let window = windowManager.windows.first(where: { $0.id == hit.windowID }) else { return }
                if hit.action == .move || hit.action == .resize {
                    dragWindowID = window.id
                    dragAction = hit.action
                    dragStartPlacement = window.placement
                    resizeStartPoint = point
                    let model = renderer.modelMatrix(for: window, orientation: orientation, settings: settings)
                    let center4 = model * SIMD4<Float>(0, 0, 0, 1)
                    dragPlanePoint = SIMD3<Float>(center4.x, center4.y, center4.z) / center4.w
                    dragStartIntersection = intersection(at: point, planePoint: dragPlanePoint!, normal: renderer.dragPlaneNormal(orientation: orientation))
                }
            case .changed:
                if dragAction == .resize, let startPoint = resizeStartPoint, let start = dragStartPlacement {
                    var placement = start
                    let viewportWidth = max(view.bounds.width / (stereoscopic ? 2 : 1), 1)
                    placement.width += Float((point.x - startPoint.x) / viewportWidth) * 4.5
                    placement.height -= Float((point.y - startPoint.y) / max(view.bounds.height, 1)) * 3
                    guard let dragWindowID else { return }
                    windowManager.move(dragWindowID, to: placement)
                } else if let dragWindowID, let dragStartIntersection, let dragPlanePoint, let start = dragStartPlacement {
                    let normal = renderer.dragPlaneNormal(orientation: orientation)
                    guard let currentIntersection = intersection(at: point, planePoint: dragPlanePoint, normal: normal) else { return }
                    let delta = currentIntersection - dragStartIntersection
                    var placement = start
                    placement.x += delta.x
                    placement.y += delta.y
                    placement.z += delta.z
                    windowManager.move(dragWindowID, to: placement)
                } else if !stereoscopic, let previous = lastLookPoint {
                    let dx = Float(point.x - previous.x)
                    let dy = Float(point.y - previous.y)
                    lookYaw = SpatialMath.clamp(lookYaw - dx * 0.004, -Float.pi...Float.pi)
                    lookPitch = SpatialMath.clamp(lookPitch - dy * 0.004, -1.15...1.15)
                    touchLook = simd_quatf(angle: lookYaw, axis: SIMD3<Float>(0, 1, 0))
                        * simd_quatf(angle: lookPitch, axis: SIMD3<Float>(1, 0, 0))
                    lastLookPoint = point
                }
            case .ended, .cancelled, .failed:
                dragWindowID = nil
                dragStartIntersection = nil
                dragStartPlacement = nil
                dragPlanePoint = nil
                dragAction = nil
                resizeStartPoint = nil
                lastLookPoint = nil
            default:
                break
            }
        }

        @objc func handlePinch(_ gesture: UIPinchGestureRecognizer) {
            guard let view, let windowManager else { return }
            switch gesture.state {
            case .began:
                lastPinchScale = gesture.scale
                if let hit = currentHit(at: gesture.location(in: view)) {
                    pinchWindowID = hit.windowID
                    windowManager.focus(hit.windowID)
                }
            case .changed:
                let scale = lastPinchScale > 0 ? gesture.scale / lastPinchScale : 1
                if let pinchWindowID {
                    windowManager.resize(pinchWindowID, scale: Float(scale))
                }
                lastPinchScale = gesture.scale
            default:
                lastPinchScale = 1
                pinchWindowID = nil
            }
        }

        @objc func handleRotation(_ gesture: UIRotationGestureRecognizer) {
            guard let view, let windowManager else { return }
            switch gesture.state {
            case .began:
                lastRotation = gesture.rotation
                if let hit = currentHit(at: gesture.location(in: view)) {
                    rotationWindowID = hit.windowID
                    windowManager.focus(hit.windowID)
                }
            case .changed:
                if let rotationWindowID {
                    windowManager.rotate(rotationWindowID, by: Float(gesture.rotation - lastRotation))
                }
                lastRotation = gesture.rotation
            default:
                lastRotation = 0
                rotationWindowID = nil
            }
        }

        @objc func handleSwipe(_ gesture: UISwipeGestureRecognizer) {
            guard stereoscopic else { return }
            onCycleWindow?(gesture.direction == .down)
        }

        @objc func handleExitPan(_ gesture: UIPanGestureRecognizer) {
            guard stereoscopic, gesture.state == .changed else { return }
            let translation = gesture.translation(in: view)
            if translation.y > 45 {
                onExitVR?()
            }
        }

        private func currentHit(at point: CGPoint) -> WindowHit? {
            guard let view, let renderer, let settings, let windowManager else { return nil }
            let orientation = (motion?.orientation ?? simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))) * touchLook
            return renderer.hitTest(point: point, viewport: view.bounds, orientation: orientation, settings: settings, windows: windowManager.windows, stereoscopic: stereoscopic)
        }

        private func intersection(at point: CGPoint, planePoint: SIMD3<Float>, normal: SIMD3<Float>) -> SIMD3<Float>? {
            guard let view, let renderer, let settings else { return nil }
            let orientation = (motion?.orientation ?? simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))) * touchLook
            let eye: Eye = stereoscopic && point.x >= view.bounds.midX ? .right : .left
            let viewport = stereoscopic
                ? CGRect(x: eye == .left ? view.bounds.minX : view.bounds.midX, y: view.bounds.minY, width: view.bounds.width / 2, height: view.bounds.height)
                : view.bounds
            let camera = StereoCameraRig(orientation: orientation, interpupillaryDistance: Float(settings.ipdMillimeters) / 1000)
                .camera(eye, aspect: Float(viewport.width / max(viewport.height, 1)), fieldOfView: Float(settings.fieldOfView) * .pi / 180)
            let ray = SpatialMath.ray(from: point, viewport: viewport, viewProjection: camera.viewProjection)
            _ = renderer
            return SpatialMath.intersectPlane(rayOrigin: ray.origin, rayDirection: ray.direction, planePoint: planePoint, planeNormal: normal)
        }

        private func isExitPoint(_ point: CGPoint, in view: MTKView) -> Bool {
            let halfWidth = view.bounds.width / 2
            let localX = point.x < halfWidth ? point.x / halfWidth : (point.x - halfWidth) / halfWidth
            let localY = point.y / view.bounds.height
            return localX > 0.86 && localY < 0.14
        }
    }
}
