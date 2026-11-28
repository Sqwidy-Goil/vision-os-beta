import CoreVideo
import Foundation
import QuartzCore
import simd
import Vision

enum HandTrackingStatus: Equatable {
    case stopped
    case waitingForCamera
    case running
    case noHand
    case unavailable(String)
    case failed(String)
}

final class HandTrackingService: NSObject, ObservableObject, CameraFrameDelegate {
    @Published private(set) var status: HandTrackingStatus = .stopped
    @Published private(set) var handCount = 0
    @Published private(set) var isPinching = false
    var onGesture: ((HandGestureEvent) -> Void)?

    private let processingQueue = DispatchQueue(label: "vision-spatial.hand-tracking", qos: .userInteractive)
    private let sequenceHandler = VNSequenceRequestHandler()
    private var processor = HandGestureProcessor()
    private var isEnabled = false
    private var lastStatusUpdate = Date.distantPast
    private var lastPublishedStatus: HandTrackingStatus?

    func start() {
        status = .waitingForCamera
        processingQueue.async { [weak self] in
            self?.isEnabled = true
            self?.processor.reset()
        }
    }

    func stop() {
        processingQueue.async { [weak self] in
            self?.isEnabled = false
            self?.processor.reset()
            Task { @MainActor in
                self?.status = .stopped
                self?.handCount = 0
                self?.isPinching = false
            }
        }
    }

    func cameraService(_ service: CameraService, didOutput pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) {
        processingQueue.async { [weak self] in
            guard let self, isEnabled else { return }
            process(pixelBuffer, orientation: orientation)
        }
    }

    private func process(_ pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) {
        let request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = 2
        do {
            try sequenceHandler.perform([request], on: pixelBuffer, orientation: orientation)
            guard let observations = request.results, !observations.isEmpty else {
                publish(.noHand, handCount: 0, pinching: false)
                processor.reset()
                return
            }
            let samples = try observations.map { observation in
                func point(_ joint: VNHumanHandPoseObservation.JointName) throws -> SIMD2<Float> {
                    let landmark = try observation.recognizedPoint(joint)
                    let location = landmark.location
                    return SIMD2<Float>(Float(location.x), Float(location.y))
                }
                return HandSample(
                    thumbTip: try point(.thumbTip),
                    indexTip: try point(.indexTip),
                    wrist: try point(.wrist),
                    middleMCP: try point(.middleMCP),
                    timestamp: CACurrentMediaTime()
                )
            }
            if let event = processor.process(samples) {
                DispatchQueue.main.async { [weak self] in
                    switch event {
                    case .pinchStarted, .pinchMoved, .twoHandStarted, .twoHandMoved:
                        self?.isPinching = true
                        self?.onGesture?(event)
                    case .pinchEnded, .twoHandEnded:
                        self?.isPinching = false
                        self?.onGesture?(event)
                    }
                }
            }
            publish(.running, handCount: observations.count, pinching: processor.isPinching)
        } catch {
            processor.reset()
            publish(.failed(error.localizedDescription), handCount: 0, pinching: false)
        }
    }

    private func publish(_ status: HandTrackingStatus, handCount: Int, pinching: Bool) {
        guard status != lastPublishedStatus || Date().timeIntervalSince(lastStatusUpdate) > 0.15 else { return }
        lastPublishedStatus = status
        lastStatusUpdate = Date()
        DispatchQueue.main.async { [weak self] in
            self?.status = status
            self?.handCount = handCount
            self?.isPinching = pinching
        }
    }
}
