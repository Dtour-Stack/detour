// swift-tools-version:5.9
//
// Swiftun — Detour's eventual Electrobun replacement on macOS.
// Single binary that spawns Bun + hosts every native window.
//
// Build:
//   swift build -c release
// Run (from this directory):
//   .build/release/Swiftun
//
// The Bun binary is expected to be discoverable via the
// DETOUR_BUN_PATH env var at runtime (or PATH). When packaged inside
// Detour.app, BunProcess looks at Contents/Resources/bin/bun first.

import PackageDescription

let package = Package(
    name: "Swiftun",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "Swiftun", targets: ["Swiftun"]),
    ],
    targets: [
        .executableTarget(
            name: "Swiftun",
            path: "Sources/Swiftun",
        ),
    ],
)
