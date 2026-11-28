import Foundation

public protocol CompanionTransport: AnyObject {
    var onOpen: (() -> Void)? { get set }
    var onMessage: ((Data) -> Void)? { get set }
    var onClose: ((Int, String) -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }
    func start()
    func send(_ data: Data) throws
    func close(code: Int, reason: String)
}

public final class WSSWebSocketTransport: NSObject, CompanionTransport, URLSessionWebSocketDelegate {
    public var onOpen: (() -> Void)?
    public var onMessage: ((Data) -> Void)?
    public var onClose: ((Int, String) -> Void)?
    public var onError: ((Error) -> Void)?

    private let url: URL
    private let maxFrameBytes: Int
    private let callbackQueue: OperationQueue
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private let lock = NSLock()
    private var opened = false
    private var terminal = false

    public init(url: URL, maxFrameBytes: Int) {
        self.url = url
        self.maxFrameBytes = maxFrameBytes
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        self.callbackQueue = queue
        super.init()
    }

    public func start() {
        lock.lock()
        defer { lock.unlock() }
        guard !opened, !terminal else { return }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: callbackQueue)
        let task = session.webSocketTask(with: url)
        self.session = session
        self.task = task
        task.resume()
    }

    public func send(_ data: Data) throws {
        lock.lock()
        let canSend = opened && !terminal
        let currentTask = task
        lock.unlock()
        guard canSend, let currentTask, data.count <= maxFrameBytes else {
            throw CompanionProtocolError("Companion transport is not open or the message exceeds the frame limit.")
        }
        currentTask.send(.data(data)) { [weak self] error in
            guard let self, let error else { return }
            self.fail(error: self.mappedError(error))
        }
    }

    public func close(code: Int, reason: String) {
        lock.lock()
        let alreadyTerminal = terminal
        terminal = true
        let currentTask = task
        let currentSession = session
        task = nil
        session = nil
        lock.unlock()
        guard !alreadyTerminal else { return }
        currentTask?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normal, reason: Data(reason.utf8))
        currentSession?.invalidateAndCancel()
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        lock.lock()
        opened = true
        let shouldNotify = !terminal
        lock.unlock()
        if shouldNotify {
            onOpen?()
            receive(on: webSocketTask)
        }
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        finish(code: Int(closeCode.rawValue), reason: reason.flatMap { String(decoding: $0, as: UTF8.self) } ?? "")
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            fail(error: mappedError(error))
        } else {
            finish(code: 1006, reason: "Companion WebSocket closed.")
        }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        lock.lock()
        let shouldReceive = !terminal
        lock.unlock()
        guard shouldReceive else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .data(let data):
                    guard data.count <= self.maxFrameBytes else {
                        self.fail(error: CompanionProtocolError("Companion message exceeds the frame limit."))
                        return
                    }
                    self.onMessage?(data)
                case .string:
                    self.fail(error: CompanionProtocolError("Companion WebSocket messages must be binary."))
                    return
                @unknown default:
                    self.fail(error: CompanionProtocolError("Unsupported companion WebSocket message."))
                    return
                }
                self.receive(on: task)
            case .failure(let error):
                if !self.isTerminal {
                    self.fail(error: self.mappedError(error))
                }
            }
        }
    }

    private func fail(error: Error) {
        let shouldNotify = beginFailure()
        guard shouldNotify else { return }
        onError?(error)
        finish(code: 1006, reason: error.localizedDescription)
    }

    private func beginFailure() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !terminal else { return false }
        terminal = true
        return true
    }

    private var isTerminal: Bool {
        lock.lock()
        defer { lock.unlock() }
        return terminal
    }

    private func finish(code: Int, reason: String) {
        let shouldNotify = beginFailure()
        if shouldNotify { onClose?(code, reason) }
        lock.lock()
        task = nil
        let currentSession = session
        session = nil
        lock.unlock()
        currentSession?.invalidateAndCancel()
        if shouldNotify {
            onOpen = nil
            onMessage = nil
            onClose = nil
            onError = nil
        }
    }

    private func mappedError(_ error: Error) -> Error {
        let nsError = error as NSError
        let certificateCodes: Set<Int> = [-1201, -1202, -1203, -1204, -1205]
        if nsError.domain == NSURLErrorDomain && certificateCodes.contains(nsError.code) {
            return CompanionProtocolError(
                "Trusted WSS certificate rejected. The local host must present a certificate trusted by iOS/macOS with the correct hostname or IP SAN; disabling certificate validation is not supported."
            )
        }
        return error
    }
}
