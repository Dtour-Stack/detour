/*
 * MLXVideoService — local text-to-video on Apple Silicon via MLX.
 * Mirror of MLXImageService — same API shape, different output.
 *
 * Status: scaffold + documented stub. The plumbing (Swift socket
 * server, bun-side RPC client, eliza plugin gate, gallery write) is
 * real and shipping. The model is the bottleneck — every credible
 * open text-to-video architecture in 2026 is either too large for
 * consumer Macs or has no clean MLX port:
 *
 *   - HunyuanVideo (Tencent, 13B):  ~25-30 GB live RAM, ~30 min for
 *     5s @ 720p on M2 Max. No MLX port.
 *   - Mochi-1 (Genmo, 10B):          ~24 GB live RAM, comparable
 *     wall-clock cost. PyTorch reference; no MLX port.
 *   - LTX-Video (Lightricks, 2B):    fastest open option (~30s for 4s
 *     @ 768p on H100). MPS path exists; MLX port pending.
 *   - AnimateDiff (extends SD):      smallest footprint but quality
 *     ceiling is low; some community MLX experiments.
 *   - Wan2.1 (Alibaba):              5-15 GB depending on resolution;
 *     PyTorch reference; no MLX port.
 *
 * Default for video stays cloud (Veo via OpenRouter, Veo3 via
 * ElizaCloud — wired in src/bun/plugins/media-generation/index.ts).
 * The local path here is a real scaffold ready for whichever model
 * gets a credible MLX port first.
 *
 * Vendor recipe (when a model lands):
 *   1. Choose architecture (likely LTX-Video for size/speed balance).
 *   2. Port the DiT + VAE-temporal-decoder + T5 text encoder into
 *      Sources/Swiftun/mlx-vendor/<model>/ (~1500-3000 LOC depending
 *      on choice).
 *   3. Weights from HF → convert to MLX safetensors → mirror to
 *      mlx-community/.
 *   4. Add a preset case here and replace the throw in
 *      runVideoGeneration() with the sampling loop.
 *   5. MP4 encoding: use AVAssetWriter (AVFoundation) to encode the
 *      decoded frame sequence to H.264/H.265 with the system codec.
 *      ~30 LOC, similar to encodeMLXArrayToPNG but for an MP4 stream.
 */

import Foundation
import MLX
import MLXNN

@MainActor
final class MLXVideoService {
    static let shared = MLXVideoService()

    enum AvailabilityState {
        case available
        case unsupportedHardware
    }

    struct VideoPreset {
        let id: String
        let label: String
        let modelID: String
        let approxLiveRamGB: Double
        let approxDiskGB: Double
        let defaultDurationSeconds: Double
        let defaultFps: Int
        let defaultSize: (width: Int, height: Int)
        let approxSecondsPerSecond: Double  // wall-clock / video-second
        let licenseNote: String?
        let vendored: Bool   // false → throws .notImplemented
    }

    struct GenerateOptions {
        let presetId: String
        let prompt: String
        let negativePrompt: String?
        let durationSeconds: Double?
        let fps: Int?
        let size: (width: Int, height: Int)?
        let seed: UInt64?
        let llmUsedGB: Double?
    }

    struct GeneratedVideo {
        let mp4Data: Data
        let width: Int
        let height: Int
        let durationSeconds: Double
        let fps: Int
        let contentType: String     // "video/mp4"
        let durationMs: Int
        let model: String
    }

    // Local video presets removed — true text-to-video (LTX, Mochi,
    // HunyuanVideo) isn't vendored to MLX-Swift yet, and the
    // SDXL-frame-stitch experiment proved unworkable: each SDXL Turbo
    // generation pegs the main thread for ~5-10s, and a 12-frame
    // sequence locks up the tray UI completely. Cloud (Veo via
    // OpenRouter, Veo3 via ElizaCloud) remains the practical video path
    // — it's already wired through media-generation/index.ts.
    nonisolated static let presets: [VideoPreset] = []

    var availability: AvailabilityState {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { rawBuf -> String in
            let buf = rawBuf.bindMemory(to: CChar.self).baseAddress!
            return String(cString: buf)
        }
        return machine.hasPrefix("arm64") ? .available : .unsupportedHardware
    }

    func isDownloaded(presetId: String) -> Bool {
        // sdxl-stitch reuses MLXImageService's SDXL Turbo weights so
        // it's downloaded whenever those are.
        if presetId == "sdxl-stitch" {
            return MLXImageService.shared.isDownloaded(presetId: "sdxl-turbo")
        }
        guard let _ = MLXVideoService.presets.first(where: { $0.id == presetId }) else {
            return false
        }
        return false
    }

    /// All local video paths are removed. This always throws — the
    /// VIDEO_GENERATION action in media-generation falls through to
    /// cloud (Veo via OpenRouter, Veo3 via ElizaCloud).
    func generate(options: GenerateOptions) async throws -> GeneratedVideo {
        throw MLXVideoError.notImplemented(
            "Local video isn't supported on this build. The agent will use cloud video " +
            "providers (OpenRouter Veo, ElizaCloud Veo3) instead."
        )
    }
}

enum MLXVideoError: LocalizedError {
    case unsupportedHardware
    case unknownPreset(String)
    case notImplemented(String)
    case modelLoadFailed(String)
    case inferenceFailed(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedHardware:
            return "MLX video inference requires Apple Silicon."
        case .unknownPreset(let id):
            return "Unknown video preset: \(id)"
        case .notImplemented(let m):
            return m
        case .modelLoadFailed(let m):
            return "Model load failed: \(m)"
        case .inferenceFailed(let m):
            return "Inference failed: \(m)"
        }
    }
}
