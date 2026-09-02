// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "DingDongSelection",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SelectionCore", targets: ["SelectionCore"]),
        .executable(name: "DingDongSelection", targets: ["DingDongSelection"])
    ],
    targets: [
        .target(name: "SelectionCore"),
        .executableTarget(
            name: "DingDongSelection",
            dependencies: ["SelectionCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Security")
            ]
        ),
        .testTarget(name: "SelectionCoreTests", dependencies: ["SelectionCore"])
    ]
)
