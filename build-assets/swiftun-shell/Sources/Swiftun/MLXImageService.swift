/*
 * MLXImageService — local text-to-image inference on Apple Silicon
 * via MLX. Symmetric with MLXInferenceService (LLM path).
 *
 * Backend: mlx-swift-examples' `StableDiffusion` library product. The
 * actual API (verified against Libraries/StableDiffusion as of
 * 2026-05): use `StableDiffusionConfiguration.presetSDXLTurbo` /
 * `.presetStableDiffusion21Base`, call `.download(hub:)` to fetch
 * weights, then `.textToImageGenerator(hub:configuration:)` returns a
 * `TextToImageGenerator`. Iterate `generator.generateLatents(parameters:)`
 * (a `DenoiseIterator`) to denoise, then `generator.decode(xt:)` →
 * `MLXArray` shaped [B, H, W, 3] in [0, 1]. We encode to PNG.
 *
 * Sana vendor recipe — Sana is the *ideal* model for Apple Silicon
 * (smaller, faster, 4K capable). No verified MLX port exists yet. When
 * one lands or we vendor:
 *
 *   1. Reference: https://github.com/NVlabs/Sana. Architecture is
 *      Linear DiT + 32× DC-AE + Gemma text encoder. Sana-Sprint is the
 *      1–4 step variant (sub-second on M-series).
 *
 *   2. Port into Sources/Swiftun/mlx-vendor/sana/:
 *        - LinearDiT.swift     (~500 LOC, linear-attention backbone)
 *        - DCAE32x.swift       (~300 LOC, 32× spatial autoencoder)
 *        - GemmaTextEncoder    (~200 LOC; tokenizer via swift-transformers)
 *
 *   3. Weights from HF: Efficient-Large-Model/Sana_1600M_*. Convert to
 *      MLX safetensors via the Python tooling in NVlabs/Sana then
 *      mirror to mlx-community/.
 *
 *   4. Add a sana-1.6b case alongside the SD presets and route
 *      generate() to a sanaSample() instead of runStableDiffusion().
 *
 *   5. License: CC-BY-NC base weights — flagged in the preset descr
 *      so commercial paths (Milady) don't accidentally enable it.
 *
 * Memory: MLX shares the unified pool; the arbiter in CompanionService
 * is authoritative — refuse to load when local-chat + companion
 * already consume the budget.
 */

import CoreGraphics
import Foundation
import ImageIO
import MLX
import MLXNN
import MLXRandom
@preconcurrency import StableDiffusion
import UniformTypeIdentifiers

import Hub

@MainActor
final class MLXImageService {
    static let shared = MLXImageService()

    enum AvailabilityState {
        case available
        case unsupportedHardware
    }

    struct ImagePreset {
        let id: String
        let label: String
        let modelID: String
        let approxLiveRamGB: Double
        let approxDiskGB: Double
        let defaultSteps: Int
        let defaultCfg: Float
        let defaultSize: (width: Int, height: Int)
        let licenseNote: String?
        let sdPreset: StableDiffusionConfiguration.Preset?  // nil → not-yet-vendored
    }

    struct GenerateOptions {
        let presetId: String
        let prompt: String
        let negativePrompt: String?
        let size: (width: Int, height: Int)?   // nil → preset default
        let steps: Int?                        // nil → preset default
        let cfgWeight: Float?                  // nil → preset default
        let seed: UInt64?
        /// Memory already used by bun's LLM stack (chat + companion).
        /// Threaded through to MLXMemoryArbiter so the gate sees the
        /// complete unified-memory picture, not just MLX state.
        let llmUsedGB: Double?
    }

    struct GeneratedImage {
        let pngData: Data
        let width: Int
        let height: Int
        let contentType: String
        let durationMs: Int
        let model: String
    }

    /// Available presets. SD ones actually run today via mlx-swift-
    /// examples. Sana is in the catalog as documentation-of-intent;
    /// generate() throws .notImplemented for sana-* until the port lands.
    nonisolated static let presets: [ImagePreset] = [
        ImagePreset(
            id: "sd-2.1-base",
            label: "Stable Diffusion 2.1 base (MLX)",
            modelID: "stabilityai/stable-diffusion-2-1-base",
            approxLiveRamGB: 3.5, approxDiskGB: 4.5,
            defaultSteps: 30, defaultCfg: 7.5,
            defaultSize: (width: 512, height: 512),
            licenseNote: nil,
            sdPreset: .base
        ),
        ImagePreset(
            id: "sdxl-turbo",
            label: "SDXL Turbo (4-step, MLX)",
            modelID: "stabilityai/sdxl-turbo",
            approxLiveRamGB: 6.5, approxDiskGB: 7.5,
            defaultSteps: 4, defaultCfg: 0,
            defaultSize: (width: 512, height: 512),
            licenseNote: nil,
            sdPreset: .sdxlTurbo
        ),
        ImagePreset(
            id: "sana-1.6b",
            label: "Sana 1.6B (pending MLX port)",
            modelID: "Efficient-Large-Model/Sana_1600M_1024px",
            approxLiveRamGB: 4.0, approxDiskGB: 3.2,
            defaultSteps: 20, defaultCfg: 4.5,
            defaultSize: (width: 1024, height: 1024),
            licenseNote: "CC-BY-NC base weights — non-commercial only",
            sdPreset: nil
        ),
    ]

    var availability: AvailabilityState {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { rawBuf -> String in
            let buf = rawBuf.bindMemory(to: CChar.self).baseAddress!
            return String(cString: buf)
        }
        return machine.hasPrefix("arm64") ? .available : .unsupportedHardware
    }

    /// Cached generators per preset id (avoids reloading weights for
    /// every call). Live RAM for these is non-trivial — UI surfaces
    /// `unloadAll()` when the user wants to free memory.
    private var generators: [String: any TextToImageGenerator] = [:]

    func unloadAll() {
        generators.removeAll()
        NSLog("[MLXImageService] unloaded all cached generators")
    }

    /// True if a preset is currently warm in the generator cache.
    /// Used by MLXMemoryArbiter to compute alreadyLoadedGB.
    func isPresetLoaded(_ presetId: String) -> Bool {
        generators[presetId] != nil
    }

    /// Cached HubApi pointing at ~/.detour/mlx-models so we share the
    /// same directory the LLM path uses. Loads ~/.cache/huggingface/
    /// token if present so gated repos (Stability / Meta-Llama / etc.)
    /// download correctly without needing HF_TOKEN env propagation.
    private lazy var hub: HubApi = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent(".detour/mlx-models", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tokenPath = home.appendingPathComponent(".cache/huggingface/token")
        var hfToken: String? = nil
        if let raw = try? String(contentsOf: tokenPath, encoding: .utf8) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { hfToken = trimmed }
        }
        return HubApi(downloadBase: dir, hfToken: hfToken)
    }()

    func isDownloaded(presetId: String) -> Bool {
        guard let preset = MLXImageService.presets.first(where: { $0.id == presetId }) else {
            return false
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent(".detour/mlx-models/\(preset.modelID)")
        // Heuristic: a model dir with the unet weights present means downloaded.
        let unetWeights = dir.appendingPathComponent("unet/diffusion_pytorch_model.safetensors")
        return FileManager.default.fileExists(atPath: unetWeights.path)
    }

    func generate(options: GenerateOptions) async throws -> GeneratedImage {
        if availability == .unsupportedHardware {
            throw MLXImageError.unsupportedHardware
        }
        guard let preset = MLXImageService.presets.first(where: { $0.id == options.presetId }) else {
            throw MLXImageError.unknownPreset(options.presetId)
        }
        guard preset.sdPreset != nil else {
            throw MLXImageError.notImplemented(
                "\(preset.id) is documented but not yet vendored. See MLXImageService.swift header. " +
                "Use sd-2.1-base or sdxl-turbo for working local generation."
            )
        }
        let started = Date()
        let generator = try await loadGenerator(preset: preset, extraReservedGB: options.llmUsedGB ?? 0)
        let pngData = try await runStableDiffusion(
            generator: generator,
            preset: preset,
            options: options
        )
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        let size = options.size ?? preset.defaultSize
        NSLog("[MLXImageService] \(preset.id) generated \(size.width)x\(size.height) in \(ms)ms")
        return GeneratedImage(
            pngData: pngData,
            width: size.width, height: size.height,
            contentType: "image/png",
            durationMs: ms,
            model: preset.modelID
        )
    }

    private func loadGenerator(preset: ImagePreset, extraReservedGB: Double = 0) async throws -> any TextToImageGenerator {
        if let cached = generators[preset.id] { return cached }
        // Hard memory gate — don't even try to download/load if the
        // unified-memory budget would be exceeded. Surfaces a
        // user-readable error so the eliza handler can fall back to
        // cloud rather than crash the system. extraReservedGB carries
        // bun's LLM-stack usedGB so the gate isn't blind to chat
        // models loaded outside MLX.
        try MLXMemoryArbiter.shared.gateImage(preset: preset, extraReservedGB: extraReservedGB)
        guard let sdPreset = preset.sdPreset else {
            throw MLXImageError.notImplemented("no SD preset binding for \(preset.id)")
        }
        let cfg = sdPreset.configuration
        do {
            // Capture only Sendable values inside the progress closure
            // (Progress + String + Int are fine; preset itself isn't
            // Sendable across the actor boundary).
            let presetId = preset.id
            try await cfg.download(hub: hub) { @Sendable progress in
                NSLog("[MLXImageService] \(presetId) download \(Int(progress.fractionCompleted * 100))%")
            }
        } catch {
            throw MLXImageError.modelLoadFailed("download \(preset.id): \(error.localizedDescription)")
        }
        let loadConfig = LoadConfiguration(float16: true, quantize: false)
        guard let generator = try cfg.textToImageGenerator(hub: hub, configuration: loadConfig) else {
            throw MLXImageError.modelLoadFailed("generator factory returned nil for \(preset.id)")
        }
        generator.ensureLoaded()
        generators[preset.id] = generator
        return generator
    }

    private func runStableDiffusion(
        generator: any TextToImageGenerator,
        preset: ImagePreset,
        options: GenerateOptions
    ) async throws -> Data {
        let size = options.size ?? preset.defaultSize
        let steps = options.steps ?? preset.defaultSteps
        let cfg = options.cfgWeight ?? preset.defaultCfg
        // SD latent is 8x smaller than the output image.
        let latentH = max(8, size.height / 8)
        let latentW = max(8, size.width / 8)
        let seed = options.seed ?? UInt64.random(in: 0..<UInt64.max)

        let params = EvaluateParameters(
            cfgWeight: cfg,
            steps: steps,
            imageCount: 1,
            decodingBatchSize: 1,
            latentSize: [latentH, latentW],
            seed: seed,
            prompt: options.prompt,
            negativePrompt: options.negativePrompt ?? ""
        )
        let iterator = generator.generateLatents(parameters: params)
        var lastLatent: MLXArray? = nil
        for latent in iterator {
            MLX.eval(latent)
            lastLatent = latent
        }
        guard let final = lastLatent else {
            throw MLXImageError.inferenceFailed("denoiser produced no latents")
        }
        let imageArray = generator.decode(xt: final)
        MLX.eval(imageArray)
        return try Self.encodeMLXArrayToPNG(array: imageArray)
    }

    /// MLXArray [1, H, W, 3] float in [0,1] → PNG bytes.
    static func encodeMLXArrayToPNG(array: MLXArray) throws -> Data {
        let clamped = MLX.clip(array, min: MLXArray(0.0), max: MLXArray(1.0))
        let scaled = clamped * 255.0
        let shape = scaled.shape
        let h: Int
        let w: Int
        if shape.count == 4 {
            h = shape[1]; w = shape[2]
        } else if shape.count == 3 {
            h = shape[0]; w = shape[1]
        } else {
            throw MLXImageError.inferenceFailed("unexpected image array shape \(shape)")
        }
        let bytes: [UInt8] = scaled.asType(.uint8).asArray(UInt8.self)
        let bytesPerRow = w * 3
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else {
            throw MLXImageError.inferenceFailed("CGDataProvider failed")
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
            throw MLXImageError.inferenceFailed("CGImage construction failed")
        }
        return try cgImageToPNG(cgImage)
    }

    private static func cgImageToPNG(_ image: CGImage) throws -> Data {
        let mutableData = CFDataCreateMutable(nil, 0)!
        guard let dest = CGImageDestinationCreateWithData(
            mutableData, UTType.png.identifier as CFString, 1, nil
        ) else {
            throw MLXImageError.inferenceFailed("CGImageDestination failed")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            throw MLXImageError.inferenceFailed("CGImageDestinationFinalize failed")
        }
        return mutableData as Data
    }
}

enum MLXImageError: LocalizedError {
    case unsupportedHardware
    case unknownPreset(String)
    case notImplemented(String)
    case modelLoadFailed(String)
    case inferenceFailed(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedHardware:
            return "MLX image inference requires Apple Silicon."
        case .unknownPreset(let id):
            return "Unknown image preset: \(id)"
        case .notImplemented(let m):
            return "Not implemented: \(m)"
        case .modelLoadFailed(let m):
            return "Model load failed: \(m)"
        case .inferenceFailed(let m):
            return "Inference failed: \(m)"
        }
    }
}
