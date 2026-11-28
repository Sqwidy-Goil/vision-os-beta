// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "VisionCompanion",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(name: "VisionCompanionProtocol", targets: ["VisionCompanionProtocol"]),
        .library(name: "VisionCompanion", targets: ["VisionCompanionRuntime"])
    ],
    targets: [
        .systemLibrary(
            name: "CZlib",
            path: "Sources/CZlib",
            pkgConfig: nil,
            providers: nil
        ),
        .target(
            name: "VisionCompanionProtocol",
            dependencies: ["CZlib"],
            linkerSettings: [.linkedLibrary("z")]
        ),
        .target(
            name: "VisionCompanionRuntime",
            dependencies: ["VisionCompanionProtocol"]
        ),
        .executableTarget(
            name: "VisionCompanionCLI",
            dependencies: ["VisionCompanionRuntime", "VisionCompanionProtocol"]
        ),
        .testTarget(
            name: "VisionCompanionProtocolTests",
            dependencies: ["VisionCompanionProtocol"]
        )
    ]
)
