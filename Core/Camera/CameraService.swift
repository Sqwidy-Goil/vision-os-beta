import AVFoundation
import CoreVideo
import Foundation
import UIKit

protocol CameraFrameDelegate: AnyObject {
    func cameraService(_ service: CameraService, didOutput pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation)
}

enum CameraStatus: Equatable {
    case stopped
    case requestingPermission
    case configuring
    case running
    case permissionDenied
    case unavailable(String)
    case interrupted
    case failed(String)
}

final class CameraService: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    @Published private(set) var status: CameraStatus = .stopped
    @Published private(set) var lastCaptureURL: URL?

    let previewLayer: AVCaptureVideoPreviewLayer
    weak var frameDelegate: CameraFrameDelegate?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "vision-spatial.camera", qos: .userInitiated)
    private let videoOutput = AVCaptureVideoDataOutput()
    private let photoOutput = AVCapturePhotoOutput()
    private var captureDelegate: PhotoCaptureDelegate?
    private var isConfigured = false
    private let lifecycleLock = NSLock()
    private var lifecycleID = 0
    private var activeLifecycleID: Int?

    override init() {
        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        super.init()
        previewLayer.connection?.videoOrientation = .landscapeRight
        NotificationCenter.default.addObserver(self, selector: #selector(sessionInterrupted), name: .AVCaptureSessionWasInterrupted, object: session)
        NotificationCenter.default.addObserver(self, selector: #selector(sessionInterruptionEnded), name: .AVCaptureSessionInterruptionEnded, object: session)
        NotificationCenter.default.addObserver(self, selector: #selector(sessionRuntimeError), name: .AVCaptureSessionRuntimeError, object: session)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    func start() async -> Bool {
        let runID = nextLifecycleID()
        guard !session.isRunning else {
            guard activateLifecycle(runID) else { return false }
            updateStatus(.running, runID: runID)
            return true
        }
        guard AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil else {
            updateStatus(.unavailable("No rear camera is available."), runID: runID)
            return false
        }
        updateStatus(.requestingPermission, runID: runID)
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted else {
            updateStatus(.permissionDenied, runID: runID)
            return false
        }
        guard isCurrentLifecycle(runID) else { return false }
        updateStatus(.configuring, runID: runID)
        return await withCheckedContinuation { continuation in
            sessionQueue.async { [weak self] in
                guard let self else {
                    continuation.resume(returning: false)
                    return
                }
                guard isCurrentLifecycle(runID) else {
                    continuation.resume(returning: false)
                    return
                }
                do {
                    try configureSession()
                    guard startSessionIfCurrent(runID) else {
                        continuation.resume(returning: false)
                        return
                    }
                    updateStatus(.running, runID: runID)
                    continuation.resume(returning: true)
                } catch {
                    updateStatus(.failed(error.localizedDescription), runID: runID)
                    continuation.resume(returning: false)
                }
            }
        }
    }

    func stop() {
        lifecycleLock.lock()
        lifecycleID += 1
        activeLifecycleID = nil
        lifecycleLock.unlock()
        updateStatus(.stopped)
        sessionQueue.async { [weak self] in
            guard let self, session.isRunning else { return }
            session.stopRunning()
        }
    }

    func capturePhoto() async -> URL? {
        guard session.isRunning, photoOutput.connection(with: .video) != nil else { return nil }
        let settings = AVCapturePhotoSettings(format: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        settings.flashMode = .off
        return await withCheckedContinuation { continuation in
            let lock = NSLock()
            var completed = false
            func finish(_ url: URL?) {
                lock.lock()
                defer { lock.unlock() }
                guard !completed else { return }
                completed = true
                continuation.resume(returning: url)
            }
            let delegate = PhotoCaptureDelegate { [weak self] result in
                Task { @MainActor in
                    var url: URL?
                    if let self {
                        switch result {
                        case .success(let data):
                            do {
                                url = try DocumentStore.shared.write(data, to: "VISI0N-\(UUID().uuidString).jpg")
                                self.lastCaptureURL = url
                            } catch {
                                url = nil
                            }
                        case .failure:
                            url = nil
                        }
                    }
                    finish(url)
                }
            }
            delegate.scheduleTimeout { finish(nil) }
            captureDelegate = delegate
            sessionQueue.async { [weak self] in
                guard let self else { return }
                photoOutput.capturePhoto(with: settings, delegate: delegate)
            }
        }
    }

    private func configureSession() throws {
        guard !isConfigured else { return }
        session.beginConfiguration()
        do {
            session.sessionPreset = .hd1280x720
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else {
                throw CameraError.rearCameraUnavailable
            }
            session.addInput(input)

            videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            videoOutput.alwaysDiscardsLateVideoFrames = true
            videoOutput.setSampleBufferDelegate(self, queue: sessionQueue)
            guard session.canAddOutput(videoOutput) else { throw CameraError.outputUnavailable }
            session.addOutput(videoOutput)
            if let connection = videoOutput.connection(with: .video) {
                connection.videoOrientation = .landscapeRight
            }

            if session.canAddOutput(photoOutput) {
                session.addOutput(photoOutput)
                photoOutput.connection(with: .video)?.videoOrientation = .landscapeRight
                if photoOutput.isHighResolutionCaptureEnabled {
                    photoOutput.isHighResolutionCaptureEnabled = false
                }
            }
            session.commitConfiguration()
            isConfigured = true
        } catch {
            for output in session.outputs { session.removeOutput(output) }
            for input in session.inputs { session.removeInput(input) }
            session.commitConfiguration()
            throw error
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        frameDelegate?.cameraService(self, didOutput: pixelBuffer, orientation: Self.imageOrientation(for: connection.videoOrientation))
    }

    @objc private func sessionInterrupted(_ notification: Notification) {
        guard let runID = currentActiveLifecycleID() else { return }
        updateStatus(.interrupted, runID: runID)
    }

    @objc private func sessionInterruptionEnded(_ notification: Notification) {
        guard session.isRunning, let runID = currentActiveLifecycleID() else { return }
        updateStatus(.running, runID: runID)
    }

    @objc private func sessionRuntimeError(_ notification: Notification) {
        guard let runID = currentActiveLifecycleID(),
              let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error else { return }
        updateStatus(.failed(error.localizedDescription), runID: runID)
    }

    private func nextLifecycleID() -> Int {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        lifecycleID += 1
        activeLifecycleID = nil
        return lifecycleID
    }

    private func activateLifecycle(_ runID: Int) -> Bool {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        guard lifecycleID == runID else { return false }
        activeLifecycleID = runID
        return true
    }

    private func currentActiveLifecycleID() -> Int? {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        return activeLifecycleID
    }

    private func isCurrentLifecycle(_ runID: Int) -> Bool {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        return lifecycleID == runID
    }

    private func startSessionIfCurrent(_ runID: Int) -> Bool {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        guard lifecycleID == runID else { return false }
        activeLifecycleID = runID
        session.startRunning()
        return true
    }

    private func updateStatus(_ status: CameraStatus, runID: Int? = nil) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let runID, !isCurrentLifecycle(runID) { return }
            self.status = status
        }
    }

    private static func imageOrientation(for orientation: AVCaptureVideoOrientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .portrait: .up
        case .portraitUpsideDown: .down
        case .landscapeLeft: .right
        case .landscapeRight: .left
        @unknown default: .up
        }
    }
}

private enum CameraError: LocalizedError {
    case rearCameraUnavailable
    case outputUnavailable

    var errorDescription: String? {
        switch self {
        case .rearCameraUnavailable: "The rear camera could not be configured."
        case .outputUnavailable: "The camera output could not be added."
        }
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private let completion: (Result<Data, Error>) -> Void
    private let lock = NSLock()
    private var timeout: DispatchWorkItem?
    private var isFinished = false

    init(completion: @escaping (Result<Data, Error>) -> Void) {
        self.completion = completion
    }

    func scheduleTimeout(_ handler: @escaping () -> Void) {
        let work = DispatchWorkItem(block: handler)
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
    }

    private func finish(_ result: Result<Data, Error>) {
        lock.lock()
        defer { lock.unlock() }
        guard !isFinished else { return }
        isFinished = true
        timeout?.cancel()
        completion(result)
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        if let error {
            finish(.failure(error))
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            finish(.failure(CocoaError(.fileReadUnknown)))
            return
        }
        finish(.success(data))
    }
}
