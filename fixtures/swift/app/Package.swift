// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "DemoServer",
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.30.0"),
        .package(url: "https://github.com/vapor/vapor.git", .upToNextMajor(from: "4.50.0")),
    ],
    targets: [.executableTarget(name: "DemoServer", dependencies: [])]
)
