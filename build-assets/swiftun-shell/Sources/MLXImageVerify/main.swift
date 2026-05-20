/*
 * MLXImageVerify — minimal end-to-end check that the MLX
 * StableDiffusion chain actually generates a PNG. Mirrors the
 * exact API calls MLXImageService.swift makes, but standalone
 * (no NSApp, no tray, no sockets, no eliza).
 *
 * First run downloads ~4GB of SD 2.1 base weights into
 * ~/.detour/mlx-models. Subsequent runs reuse the cache. Output
 * lands at ~/.detour/mlx-verify-<timestamp>.png.
 *
 *   swift run -c release MLXImageVerify "a forest at dawn, watercolor"
 */

import CoreGraphics
import Foundation
import Hub
import ImageIO
import MLX
import MLXNN
import MLXRandom
import StableDiffusion
import UniformTypeIdentifiers

let prompt = CommandLine.arguments.dropFirst().first ?? "a small green squirrel wearing a detective hat, oil painting"

NSLog("[verify] prompt: \(prompt)")

let modelsRoot: URL = {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let dir = home.appendingPathComponent(".detour/mlx-models", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}()

let outRoot: URL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".detour", isDirectory: true)

// Honor HF token from ~/.cache/huggingface/token if present.
// Pass it explicitly via hfToken: to bypass any env-detection
// ambiguity (and also set HF_TOKEN for the underlying http calls).
let tokenPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".cache/huggingface/token")
var hfToken: String? = nil
if let raw = try? String(contentsOf: tokenPath, encoding: .utf8) {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
        hfToken = trimmed
        setenv("HF_TOKEN", trimmed, 1)
        NSLog("[verify] HF token loaded (\(trimmed.count) chars) from ~/.cache/huggingface/token")
    }
}

let hub = HubApi(downloadBase: modelsRoot, hfToken: hfToken)
// Use SD 2.1 base for quality (vs SDXL Turbo's speed). Gated model —
// needs the HF token loaded above.
let cfg = StableDiffusionConfiguration.Preset.base.configuration

NSLog("[verify] modelsRoot=\(modelsRoot.path)")
NSLog("[verify] using preset: stable-diffusion-2-1-base (gated, HF token required)")
NSLog("[verify] starting download (one-time, ~4-5GB)...")

let started = Date()

Task { @MainActor in
    do {
        try await cfg.download(hub: hub) { @Sendable progress in
            let pct = Int(progress.fractionCompleted * 100)
            NSLog("[verify] download \(pct)%")
        }
        NSLog("[verify] download complete in \(Int(Date().timeIntervalSince(started)))s")

        let loadCfg = LoadConfiguration(float16: true, quantize: false)
        guard let generator = try cfg.textToImageGenerator(hub: hub, configuration: loadCfg) else {
            NSLog("[verify] FAIL: factory returned nil")
            exit(1)
        }
        NSLog("[verify] ensuring weights loaded...")
        generator.ensureLoaded()

        // SD 2.1 base recipe: cfg=7.5, 30 steps. Slower than Turbo but
        // sharper rendering. 30 × ~1s/step on M-series.
        let params = EvaluateParameters(
            cfgWeight: 7.5,
            steps: 30,
            imageCount: 1,
            decodingBatchSize: 1,
            latentSize: [64, 64],   // 512x512 image
            seed: 42,
            prompt: prompt,
            negativePrompt: ""
        )

        NSLog("[verify] sampling (SD 2.1 base, 30 steps, cfg=7.5)...")
        let sampleStart = Date()
        let iterator = generator.generateLatents(parameters: params)
        var lastLatent: MLXArray? = nil
        var step = 0
        for latent in iterator {
            MLX.eval(latent)
            lastLatent = latent
            step += 1
            if step % 5 == 0 { NSLog("[verify] step \(step)/30") }
        }
        guard let final = lastLatent else {
            NSLog("[verify] FAIL: no latents produced")
            exit(1)
        }
        NSLog("[verify] sampling done in \(Int(Date().timeIntervalSince(sampleStart)))s; decoding...")
        let image = generator.decode(xt: final)
        MLX.eval(image)
        NSLog("[verify] image shape: \(image.shape)")

        let pngData = try encodeMLXArrayToPNG(array: image)
        let stamp = Int(Date().timeIntervalSince1970)
        let outPath = outRoot.appendingPathComponent("mlx-verify-\(stamp).png")
        try pngData.write(to: outPath)
        NSLog("[verify] OK: wrote \(pngData.count) bytes to \(outPath.path)")
        NSLog("[verify] TOTAL elapsed: \(Int(Date().timeIntervalSince(started)))s")
        exit(0)
    } catch {
        NSLog("[verify] FAIL: \(error.localizedDescription)")
        exit(1)
    }
}

dispatchMain()

func encodeMLXArrayToPNG(array: MLXArray) throws -> Data {
    let clamped = MLX.clip(array, min: MLXArray(0.0), max: MLXArray(1.0))
    let scaled = clamped * 255.0
    let shape = scaled.shape
    let h: Int; let w: Int
    if shape.count == 4 { h = shape[1]; w = shape[2] }
    else if shape.count == 3 { h = shape[0]; w = shape[1] }
    else { throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "unexpected shape \(shape)"]) }
    let bytes: [UInt8] = scaled.asType(.uint8).asArray(UInt8.self)
    let bytesPerRow = w * 3
    guard let provider = CGDataProvider(data: Data(bytes) as CFData) else {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "CGDataProvider failed"])
    }
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let cgImage = CGImage(
        width: w, height: h,
        bitsPerComponent: 8, bitsPerPixel: 24,
        bytesPerRow: bytesPerRow,
        space: cs,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
        provider: provider, decode: nil, shouldInterpolate: true,
        intent: .defaultIntent
    ) else {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "CGImage failed"])
    }
    let mutableData = CFDataCreateMutable(nil, 0)!
    guard let dest = CGImageDestinationCreateWithData(
        mutableData, UTType.png.identifier as CFString, 1, nil
    ) else {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "CGImageDestination failed"])
    }
    CGImageDestinationAddImage(dest, cgImage, nil)
    guard CGImageDestinationFinalize(dest) else {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "finalize failed"])
    }
    return mutableData as Data
}
