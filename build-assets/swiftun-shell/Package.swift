// swift-tools-version:6.0
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
    // macOS 26 (Tahoe) — Liquid Glass APIs (.glassEffect, GlassEffectContainer)
    // are first-party here. The user is on macOS 26.2 + SDK 26.5; we use the
    // material throughout the Settings sidebar, Pensieve, Activity, and the
    // tray's NSMenu rather than synthesizing it. SupportedPlatform doesn't
    // expose `.v26` in this toolchain yet — use the string overload.
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "Swiftun", targets: ["Swiftun"]),
        .executable(name: "MLXImageVerify", targets: ["MLXImageVerify"]),
        .executable(name: "MLXOmniVerify", targets: ["MLXOmniVerify"]),
    ],
    dependencies: [
        // mlx-swift — Apple's low-level MLX framework. We use MLX
        // directly for tensor ops + Metal kernels. The LLM loading
        // pipeline (tokenizer, weights, KV-cache) is implemented in
        // MLXInferenceService.swift on top of mlx-swift primitives +
        // swift-transformers for the tokenizer. mlx-swift-examples
        // does NOT expose MLXLLM as a library product (only MLXMNIST
        // / StableDiffusion); the LLM code there is example apps,
        // not library exports. So we build our own thin layer.
        .package(url: "https://github.com/ml-explore/mlx-swift", from: "0.31.0"),
        .package(url: "https://github.com/huggingface/swift-transformers", from: "1.3.0"),
        // mlx-swift-examples — pulls in the StableDiffusion library
        // product (Libraries/StableDiffusion). That gives us a real
        // text-to-image MLX path on Apple Silicon today. Sana would be
        // the ideal model (smaller + faster on Apple Silicon) but no
        // verified MLX port exists yet; the vendor path is documented
        // in MLXImageService.swift. SD is the first working backend.
        .package(url: "https://github.com/ml-explore/mlx-swift-examples", branch: "main"),
    ],
    targets: [
        .executableTarget(
            name: "Swiftun",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "Transformers", package: "swift-transformers"),
                .product(name: "StableDiffusion", package: "mlx-swift-examples"),
            ],
            path: "Sources/Swiftun",
        ),
        // Minimal verification binary — calls the StableDiffusion pipeline
        // end-to-end without booting the full NSApp + tray + sockets.
        // Run via: swift run -c release MLXImageVerify
        .executableTarget(
            name: "MLXImageVerify",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "StableDiffusion", package: "mlx-swift-examples"),
            ],
            path: "Sources/MLXImageVerify",
        ),
        // Verifies the AVSpeech + Apple Vision + SFSpeechRecognizer
        // paths end-to-end without booting the full app. Run via:
        //   swift run -c release MLXOmniVerify tts "hello world"
        //   swift run -c release MLXOmniVerify vision /path/to/image.png
        .executableTarget(
            name: "MLXOmniVerify",
            path: "Sources/MLXOmniVerify",
        ),
    ],
)
