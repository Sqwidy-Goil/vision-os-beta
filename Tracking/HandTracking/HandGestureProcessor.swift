import Foundation
import simd

struct HandSample: Sendable {
    var thumbTip: SIMD2<Float>
    var indexTip: SIMD2<Float>
    var wrist: SIMD2<Float>
    var middleMCP: SIMD2<Float>
    var timestamp: TimeInterval
}

enum HandGestureEvent: Equatable, Sendable {
    case pinchStarted(SIMD2<Float>)
    case pinchMoved(SIMD2<Float>, scale: Float)
    case pinchEnded
    case twoHandStarted(SIMD2<Float>)
    case twoHandMoved(SIMD2<Float>, scale: Float, rotation: Float)
    case twoHandEnded
}

private struct PinchGestureState: Sendable {
    var frames = 0
    var isPinching = false
    var previousSpread: Float?

    mutating func process(_ sample: HandSample) -> HandGestureEvent? {
        let spread = simd_distance(sample.thumbTip, sample.indexTip)
        let handSize = max(simd_distance(sample.wrist, sample.middleMCP), 0.001)
        let pinching = spread / handSize < 0.38
        frames = pinching ? frames + 1 : 0

        let location = SIMD2<Float>(1 - sample.wrist.x, sample.wrist.y)
        if pinching && frames >= 3 && !isPinching {
            isPinching = true
            previousSpread = spread
            return .pinchStarted(location)
        }
        if isPinching && pinching {
            let scale = previousSpread.map { max(0.01, spread / $0) } ?? 1
            previousSpread = spread
            return .pinchMoved(location, scale: scale)
        }
        if isPinching && !pinching {
            isPinching = false
            previousSpread = nil
            return .pinchEnded
        }
        return nil
    }

    mutating func reset() {
        frames = 0
        isPinching = false
        previousSpread = nil
    }
}

private struct TwoHandGestureState: Sendable {
    var distance: Float
    var angle: Float
}

struct HandGestureProcessor: Sendable {
    private var pinches = [PinchGestureState]()
    private var activePinchIndex: Int?
    private var twoHand: TwoHandGestureState?
    private(set) var isPinching = false

    mutating func process(_ sample: HandSample) -> HandGestureEvent? {
        process([sample])
    }

    mutating func process(_ samples: [HandSample]) -> HandGestureEvent? {
        if pinches.count < samples.count {
            pinches.append(contentsOf: Array(repeating: PinchGestureState(), count: samples.count - pinches.count))
        }
        if pinches.count > samples.count {
            pinches.removeLast(pinches.count - samples.count)
        }

        var events = [(index: Int, event: HandGestureEvent)]()
        for (index, sample) in samples.enumerated() {
            if let event = pinches[index].process(sample) {
                events.append((index, event))
            }
        }
        isPinching = pinches.contains { $0.isPinching }

        if samples.count >= 2 && pinches[0].isPinching && pinches[1].isPinching {
            let center = SIMD2<Float>(
                1 - (samples[0].wrist.x + samples[1].wrist.x) / 2,
                (samples[0].wrist.y + samples[1].wrist.y) / 2
            )
            let distance = max(simd_distance(samples[0].wrist, samples[1].wrist), 0.001)
            let angle = atan2(samples[1].wrist.y - samples[0].wrist.y, samples[1].wrist.x - samples[0].wrist.x)
            if var state = twoHand {
                let scale = max(0.01, distance / state.distance)
                let rotation = atan2(sin(angle - state.angle), cos(angle - state.angle))
                state.distance = distance
                state.angle = angle
                twoHand = state
                activePinchIndex = nil
                return .twoHandMoved(center, scale: scale, rotation: rotation)
            }
            twoHand = TwoHandGestureState(distance: distance, angle: angle)
            activePinchIndex = nil
            return .twoHandStarted(center)
        }

        if twoHand != nil {
            twoHand = nil
            activePinchIndex = nil
            return .twoHandEnded
        }

        if let activePinchIndex, pinches.indices.contains(activePinchIndex), pinches[activePinchIndex].isPinching {
            return events.first { $0.index == activePinchIndex }?.event
        }
        if let index = pinches.firstIndex(where: { $0.isPinching }) {
            activePinchIndex = index
            return events.first { $0.index == index }?.event
        }
        activePinchIndex = nil
        return events.first?.event
    }

    mutating func reset() {
        pinches.removeAll()
        activePinchIndex = nil
        twoHand = nil
        isPinching = false
    }
}
