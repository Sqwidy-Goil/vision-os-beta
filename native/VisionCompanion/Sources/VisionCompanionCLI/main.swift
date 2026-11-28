import Foundation
import VisionCompanionProtocol
import VisionCompanionRuntime

@main
struct VisionCompanionCommand {
    static func main() async {
        let capabilities = CompanionCapabilities.detect()
        print("VisionCompanion capability probe (capture is disabled by default)")
        print("worldTracking=\(capabilities.worldTracking) metricDepth=\(capabilities.metricDepth) planes=\(capabilities.planes) meshes=\(capabilities.meshes)")
        print("semanticObjects=\(capabilities.semanticObjects) freeSpace=\(capabilities.freeSpace)")
        for reason in capabilities.reasons {
            print("- \(reason)")
        }
        #if !os(iOS)
        print("Embed VisionCompanionRuntime in an iOS/iPadOS app or extension to start capture explicitly.")
        #endif
    }
}
