import Foundation
import VisionCompanionProtocol

public struct CompanionGuestConfiguration {
    public var endpoint: String
    public var deviceName: String
    public var deviceModel: String?
    public var maxFrameBytes: Int
    public var maxMessagesPerSecond: Int
    public var openTimeoutMs: Double
    public var now: () -> Double

    public init(
        endpoint: String,
        deviceName: String,
        deviceModel: String? = nil,
        maxFrameBytes: Int = CompanionProtocol.defaultMaxFrameBytes,
        maxMessagesPerSecond: Int = CompanionProtocol.defaultMaxMessagesPerSecond,
        openTimeoutMs: Double = 10_000,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.endpoint = endpoint
        self.deviceName = deviceName
        self.deviceModel = deviceModel
        self.maxFrameBytes = maxFrameBytes
        self.maxMessagesPerSecond = maxMessagesPerSecond
        self.openTimeoutMs = openTimeoutMs
        self.now = now
    }
}

public enum CompanionGuestState: String {
    case idle
    case connecting
    case waitingForOffer
    case waitingForReady
    case connected
    case disconnected
    case failed
}

public enum CompanionGuestEvent {
    case connected
    case disconnected(reason: String, error: Bool)
}

public final class CompanionGuestSession {
    public var onEvent: ((CompanionGuestEvent) -> Void)?

    private let configuration: CompanionGuestConfiguration
    private let url: URL
    private let transportFactory: (URL, Int) -> CompanionTransport
    private let queue = DispatchQueue(label: "vision-companion.protocol")
    private var transport: CompanionTransport?
    private var key: SessionKey?
    private var sid: String?
    private var sessionExpiresAt: Double?
    private var offeredFeatures: CompanionFeatures?
    private var compressionEnabled = false
    private var negotiatedMaxMessagesPerSecond: Int
    private var outboundSequence: UInt64 = 1
    private var replayGuard = ReplayGuard()
    private var inboundRateLimiter: MessageRateLimiter?
    private var outboundRateLimiter: MessageRateLimiter?
    private var effectiveMaxFrameBytes: Int
    private var currentState: CompanionGuestState = .idle
    private var pairingCode: String?
    private var openTimer: DispatchWorkItem?
    private var expiryTimer: DispatchWorkItem?
    private var connectContinuation: CheckedContinuation<Void, Error>?
    private var completionSettled = false

    public init(
        configuration: CompanionGuestConfiguration,
        transportFactory: @escaping (URL, Int) -> CompanionTransport = { WSSWebSocketTransport(url: $0, maxFrameBytes: $1) }
    ) throws {
        self.url = try TrustedLocalWSS.validate(configuration.endpoint)
        self.configuration = configuration
        self.transportFactory = transportFactory
        self.effectiveMaxFrameBytes = configuration.maxFrameBytes
        self.negotiatedMaxMessagesPerSecond = configuration.maxMessagesPerSecond
    }

    public var state: CompanionGuestState {
        queue.sync { currentState }
    }

    public func connect(code: String) async throws {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    do {
                        try self.begin(code: code, continuation: continuation)
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        }, onCancel: { [weak self] in
            self?.disconnect(reason: "VisionCompanion pairing was cancelled.")
        })
    }

    public func disconnect(reason: String = "Companion disconnected by the user.") {
        queue.async {
            self.finish(reason: reason, error: false, sendClose: true)
        }
    }

    public func sendCalibration(_ calibration: CalibrationWire) throws {
        var captured: Error?
        queue.sync {
            do {
                SpatialValidator.validateCalibration(calibration.dictionary())
                try self.send(type: .calibration, payload: calibration.dictionary())
            } catch {
                captured = error
                self.fail(error: error)
            }
        }
        if let captured { throw captured }
    }

    public func sendSample(
        _ sample: SpatialUpdateWire,
        previousFrameId: Int?,
        previousTimestamp: Double?,
        previousDepthIntrinsics: CameraIntrinsicsWire?
    ) throws {
        var captured: Error?
        queue.sync {
            do {
                try SpatialValidator.validateSample(
                    sample.dictionary(),
                    previousFrameId: previousFrameId,
                    previousTimestamp: previousTimestamp,
                    previousDepthIntrinsics: previousDepthIntrinsics
                )
                try self.send(type: .sample, payload: sample.dictionary(depthEncoding: configurationDepthEncoding()), depthEncoding: configurationDepthEncoding())
            } catch {
                captured = error
                self.fail(error: error)
            }
        }
        if let captured { throw captured }
    }

    // The controller replaces this provider for its selected wire encoding.
    public var depthEncoding: CompanionDepthEncoding = .float32le

    private func configurationDepthEncoding() -> CompanionDepthEncoding {
        depthEncoding
    }

    private func begin(code: String, continuation: CheckedContinuation<Void, Error>) throws {
        guard currentState == .idle else {
            throw CompanionProtocolError("Companion session has already started.")
        }
        guard code.range(of: "^[0-9]{8,12}$", options: .regularExpression) != nil else {
            throw CompanionProtocolError("Invalid pairing code.")
        }
        _ = try ProtocolValidation.limit(configuration.maxFrameBytes, fallback: CompanionProtocol.defaultMaxFrameBytes, minimum: 1024, maximum: CompanionProtocol.absoluteMaxFrameBytes)
        _ = try ProtocolValidation.limit(configuration.maxMessagesPerSecond, fallback: CompanionProtocol.defaultMaxMessagesPerSecond, minimum: 1, maximum: CompanionProtocol.maxMessagesPerSecond)
        guard configuration.openTimeoutMs >= 1000, configuration.openTimeoutMs <= 60_000 else {
            throw CompanionProtocolError("Invalid companion open timeout.")
        }
        var deviceObject: [String: Any] = ["name": configuration.deviceName]
        if let model = configuration.deviceModel { deviceObject["model"] = model }
        _ = try CompanionDevice.parse(deviceObject)

        currentState = .connecting
        pairingCode = code
        connectContinuation = continuation
        completionSettled = false
        effectiveMaxFrameBytes = configuration.maxFrameBytes
        outboundRateLimiter = MessageRateLimiter(maximum: configuration.maxMessagesPerSecond, now: configuration.now)
        inboundRateLimiter = MessageRateLimiter(maximum: configuration.maxMessagesPerSecond, now: configuration.now)
        let transport = transportFactory(url, configuration.maxFrameBytes)
        self.transport = transport
        transport.onOpen = { [weak self] in self?.queue.async { self?.transportOpened() } }
        transport.onMessage = { [weak self] data in self?.queue.async { self?.receive(data) } }
        transport.onClose = { [weak self] code, reason in
            self?.queue.async { self?.transportClosed(code: code, reason: reason) }
        }
        transport.onError = { [weak self] error in self?.queue.async { self?.fail(error: error) } }
        transport.start()

        let timer = DispatchWorkItem { [weak self] in
            self?.fail(error: CompanionProtocolError("Companion WebSocket connection timed out."))
        }
        openTimer = timer
        queue.asyncAfter(deadline: .now() + configuration.openTimeoutMs / 1000, execute: timer)
    }

    private func transportOpened() {
        guard currentState == .connecting else { return }
        openTimer?.cancel()
        let timer = DispatchWorkItem { [weak self] in
            self?.fail(error: CompanionProtocolError("Companion pairing offer timed out."))
        }
        openTimer = timer
        queue.asyncAfter(deadline: .now() + configuration.openTimeoutMs / 1000, execute: timer)
        currentState = .waitingForOffer
    }

    private func receive(_ data: Data) {
        guard currentState != .disconnected, currentState != .failed else { return }
        do {
            let now = configuration.now()
            if let expiry = sessionExpiresAt, now >= expiry {
                throw CompanionProtocolError("Companion session expired.")
            }
            try inboundRateLimiter?.consume(now)
            let frame = try CompanionFrameCodec.decode(
                data,
                options: CompanionFrameCodec.DecodeOptions(
                    key: key,
                    expectedSID: sid,
                    expectedSequence: replayGuard.nextSequence,
                    now: now,
                    maxFrameBytes: effectiveMaxFrameBytes
                )
            )
            try replayGuard.accept(frame.header.seq)

            switch currentState {
            case .connecting, .waitingForOffer:
                guard frame.header.type == .offer, frame.header.seq == 0 else {
                    throw CompanionProtocolError("Companion sent data before its pairing offer.")
                }
                acceptOffer(frame, now: now)
            case .waitingForReady:
                guard let key, frame.header.type == .ready, frame.header.seq == 1 else {
                    throw CompanionProtocolError("Companion pairing requires an authenticated ready message.")
                }
                acceptReady(frame, key: key, now: now)
            case .connected:
                if frame.header.type == .close {
                    let payload = try ProtocolValidation.assertExactKeys(
                        frame.payload,
                        required: ["kind", "reason"],
                        label: "Companion close message"
                    )
                    guard payload["kind"] as? String == "close" else {
                        throw CompanionProtocolError("Invalid companion close message.")
                    }
                    let reason = try ProtocolValidation.string(payload["reason"], label: "close reason", minLength: 0, maxLength: 120)
                    finish(reason: reason, error: false, sendClose: false)
                } else if frame.header.type == .error {
                    let payload = try ProtocolValidation.assertExactKeys(
                        frame.payload,
                        required: ["kind", "code", "message"],
                        label: "Companion error message"
                    )
                    guard payload["kind"] as? String == "error" else {
                        throw CompanionProtocolError("Invalid companion error message.")
                    }
                    let code = try ProtocolValidation.string(payload["code"], label: "error code", maxLength: 40)
                    let message = try ProtocolValidation.string(payload["message"], label: "error message", maxLength: 200)
                    finish(reason: "\(code): \(message)", error: false, sendClose: false)
                } else {
                    throw CompanionProtocolError("Unexpected companion message type.")
                }
            default:
                throw CompanionProtocolError("Companion session is not active.")
            }
        } catch {
            fail(error: error)
        }
    }

    private func acceptOffer(_ frame: DecodedCompanionFrame, now: Double) {
        do {
            let offer = try CompanionPairingOffer.parse(frame.payload, now: now)
            guard let code = pairingCode else { throw CompanionProtocolError("Companion pairing code is unavailable.") }
            var deviceObject: [String: Any] = ["name": configuration.deviceName]
            if let model = configuration.deviceModel { deviceObject["model"] = model }
            let device = try CompanionDevice.parse(deviceObject)
            let joined = try PairingCrypto.createJoin(offer: offer, code: code, device: device, now: now)
            sid = offer.sid
            key = joined.sessionKey
            pairingCode = nil
            effectiveMaxFrameBytes = min(configuration.maxFrameBytes, offer.maxFrameBytes)
            negotiatedMaxMessagesPerSecond = min(configuration.maxMessagesPerSecond, offer.maxMessagesPerSecond)
            offeredFeatures = offer.features
            inboundRateLimiter = MessageRateLimiter(maximum: negotiatedMaxMessagesPerSecond, now: configuration.now)
            outboundRateLimiter = MessageRateLimiter(maximum: negotiatedMaxMessagesPerSecond, now: configuration.now)
            openTimer?.cancel()
            openTimer = nil
            currentState = .waitingForReady
            try send(
                type: .join,
                payload: try joined.payloadDictionary(),
                key: joined.sessionKey,
                sid: offer.sid,
                sequence: 1
            )
            let expiry = DispatchWorkItem { [weak self] in
                self?.fail(error: CompanionProtocolError("Companion pairing code expired."))
            }
            expiryTimer?.cancel()
            expiryTimer = expiry
            queue.asyncAfter(deadline: .now() + max(0, offer.pairingExpiresAt - now) / 1000, execute: expiry)
        } catch {
            fail(error: error)
        }
    }

    private func acceptReady(_ frame: DecodedCompanionFrame, key: SessionKey, now: Double) {
        do {
            let payload = try ProtocolValidation.assertExactKeys(
                frame.payload,
                required: ["kind", "sessionExpiresAt", "maxFrameBytes", "maxMessagesPerSecond", "features"],
                label: "Companion ready message"
            )
            guard payload["kind"] as? String == "ready" else {
                throw CompanionProtocolError("Invalid companion ready message.")
            }
            let expiry = try ProtocolValidation.number(payload["sessionExpiresAt"], label: "session expiry", minimum: 0)
            guard now < expiry else { throw CompanionProtocolError("Companion session has expired.") }
            let maxFrame = try ProtocolValidation.integer(payload["maxFrameBytes"], label: "frame limit", minimum: 1024, maximum: CompanionProtocol.absoluteMaxFrameBytes)
            let maxMessages = try ProtocolValidation.integer(payload["maxMessagesPerSecond"], label: "message rate limit", minimum: 1, maximum: CompanionProtocol.maxMessagesPerSecond)
            let features = try CompanionFeatures.parse(payload["features"], offered: offeredFeatures)
            guard features.compression.contains("identity") else {
                throw CompanionProtocolError("Companion identity payload encoding is required.")
            }
            guard features.depthEncodings.contains(configuration.depthEncoding.rawValue) else {
                throw CompanionProtocolError("Companion session does not support the selected depth encoding.")
            }
            compressionEnabled = features.compression.contains("gzip")
            guard let sid else { throw CompanionProtocolError("Companion session identifier is unavailable.") }
            negotiatedMaxMessagesPerSecond = min(negotiatedMaxMessagesPerSecond, maxMessages)
            effectiveMaxFrameBytes = min(effectiveMaxFrameBytes, maxFrame)
            inboundRateLimiter = MessageRateLimiter(maximum: negotiatedMaxMessagesPerSecond, now: configuration.now)
            outboundRateLimiter = MessageRateLimiter(maximum: negotiatedMaxMessagesPerSecond, now: configuration.now)
            sessionExpiresAt = expiry
            try send(type: .readyAck, payload: ["kind": "ready-ack"], key: key, sid: sid, sequence: 2)
            currentState = .connected
            expiryTimer?.cancel()
            expiryTimer = nil
            let timer = DispatchWorkItem { [weak self] in
                self?.fail(error: CompanionProtocolError("Companion session expired."))
            }
            expiryTimer = timer
            queue.asyncAfter(deadline: .now() + max(0, expiry - now) / 1000, execute: timer)
            emit(.connected)
            settleConnected()
        } catch {
            fail(error: error)
        }
    }

    private func send(
        type: CompanionMessageType,
        payload: [String: Any],
        key: SessionKey? = nil,
        sid: String? = nil,
        sequence: UInt64? = nil,
        depthEncoding: CompanionDepthEncoding = .float32le
    ) throws {
        guard let transport, currentState != .disconnected, currentState != .failed else {
            throw CompanionProtocolError("Companion transport is not active.")
        }
        let now = configuration.now()
        if let expiry = sessionExpiresAt, now >= expiry {
            throw CompanionProtocolError("Companion session expired.")
        }
        if type != .close {
            try outboundRateLimiter?.consume(now)
        }
        let actualSequence = sequence ?? outboundSequence
        let frame = try CompanionFrameCodec.encode(
            sid: sid ?? self.sid ?? "",
            sequence: actualSequence,
            sentAt: now,
            type: type,
            payload: payload,
            options: CompanionFrameCodec.EncodeOptions(
                key: key ?? self.key,
                depthEncoding: depthEncoding,
                compression: compressionEnabled,
                maxFrameBytes: effectiveMaxFrameBytes
            )
        )
        try transport.send(frame)
        if sequence == nil {
            outboundSequence += 1
        } else if actualSequence >= outboundSequence {
            outboundSequence = actualSequence + 1
        }
    }

    private func transportClosed(code: Int, reason: String) {
        guard currentState != .disconnected, currentState != .failed else { return }
        if currentState == .connected {
            finish(reason: reason.isEmpty ? "Companion transport closed (\(code))." : reason, error: false, sendClose: false)
        } else {
            fail(error: CompanionProtocolError(reason.isEmpty ? "Companion transport closed before pairing completed (\(code))." : reason))
        }
    }

    private func fail(error: Error) {
        guard currentState != .failed, currentState != .disconnected else { return }
        currentState = .failed
        cleanup()
        emit(.disconnected(reason: error.localizedDescription, error: true))
        settleConnection(with: .failure(error))
        transport?.close(code: 1008, reason: String(error.localizedDescription.prefix(100)))
        transport = nil
    }

    private func finish(reason: String, error: Bool, sendClose: Bool) {
        guard currentState != .failed, currentState != .disconnected else { return }
        if sendClose, currentState == .connected {
            _ = try? send(type: .close, payload: ["kind": "close", "reason": String(reason.prefix(120))])
        }
        currentState = .disconnected
        cleanup()
        emit(.disconnected(reason: reason, error: error))
        settleConnection(with: .failure(CompanionProtocolError(reason)))
        transport?.close(code: error ? 1008 : 1000, reason: String(reason.prefix(100)))
        transport = nil
    }

    private func cleanup() {
        openTimer?.cancel()
        expiryTimer?.cancel()
        openTimer = nil
        expiryTimer = nil
        key?.wipe()
        key = nil
        pairingCode = nil
        sid = nil
        sessionExpiresAt = nil
        offeredFeatures = nil
        compressionEnabled = false
    }

    private func settleConnected() {
        guard !completionSettled else { return }
        completionSettled = true
        connectContinuation?.resume()
        connectContinuation = nil
    }

    private func settleConnection(with result: Result<Void, Error>) {
        guard !completionSettled else { return }
        completionSettled = true
        switch result {
        case .success:
            connectContinuation?.resume()
        case .failure(let error):
            connectContinuation?.resume(throwing: error)
        }
        connectContinuation = nil
    }

    private func emit(_ event: CompanionGuestEvent) {
        onEvent?(event)
    }
}

private extension CompanionPairingJoin {
    func payloadDictionary() throws -> [String: Any] {
        let data = try JSONEncoder().encode(self)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CompanionProtocolError("Companion join payload is not an object.")
        }
        return object
    }
}
