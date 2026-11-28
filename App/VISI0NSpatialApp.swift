import SwiftUI

@main
struct VISI0NSpatialApp: App {
    init() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-test-reset") {
            UserDefaults.standard.removeObject(forKey: "vision-spatial.settings.v1")
            let workspace = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("VISI0N-SPATIAL", isDirectory: true)
                .appendingPathComponent("workspace.json")
            try? FileManager.default.removeItem(at: workspace)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
