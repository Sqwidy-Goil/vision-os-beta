import Foundation

struct AdaptiveQuality {
    private(set) var sampleCount = 0
    private(set) var accumulatedFrameTime: Double = 0
    private(set) var pixelRatio: Float
    private(set) var averageFPS: Double = 60
    private(set) var elapsedSinceChange: Double = 0

    init(maximumPixelRatio: Float) {
        pixelRatio = maximumPixelRatio
    }

    mutating func record(frameTime: Double, maximumPixelRatio: Float) {
        let clampedTime = min(max(frameTime, 1.0 / 240.0), 0.1)
        accumulatedFrameTime += clampedTime
        sampleCount += 1
        elapsedSinceChange += clampedTime
        guard sampleCount >= 45 else { return }
        let average = accumulatedFrameTime / Double(sampleCount)
        averageFPS = 1 / average
        if elapsedSinceChange >= 2 {
            if average > 1.0 / 50 {
                pixelRatio = max(0.75, pixelRatio - 0.15)
            } else if average < 1.0 / 58 {
                pixelRatio = min(maximumPixelRatio, pixelRatio + 0.1)
            }
            elapsedSinceChange = 0
        }
        accumulatedFrameTime = 0
        sampleCount = 0
    }
}
