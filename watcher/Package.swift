// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "clipsnap-watcher",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "clipsnap-watcher", path: "Sources"),
    ]
)
