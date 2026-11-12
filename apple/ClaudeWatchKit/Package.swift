// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClaudeWatchKit",
    platforms: [.watchOS(.v11), .iOS(.v18), .macOS(.v15)],
    products: [.library(name: "ClaudeWatchKit", targets: ["ClaudeWatchKit"])],
    targets: [
        .target(name: "ClaudeWatchKit"),
        .testTarget(
            name: "ClaudeWatchKitTests",
            dependencies: ["ClaudeWatchKit"],
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v5]
)
