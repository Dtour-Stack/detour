/*
 * MLXMemoryArbiter — single source of truth for whether a given MLX
 * preset (image or video) is allowed to load on this machine.
 *
 * Apple Silicon uses a unified memory architecture — GPU + CPU share
 * the same RAM pool. A 16GB M-series Mac that's already running 8GB
 * worth of "everything else" (OS, browsers, the agent's Bun process,
 * local-chat companion model) has *zero* headroom for a 25GB
 * HunyuanVideo load. Without a gate we'd page to disk, lock up the
 * whole system, or crash.
 *
 * Budget arithmetic (all values in GB of unified memory):
 *
 *   physical          = ProcessInfo.physicalMemory
 *   reservedForSystem = 8 GB  (OS + Detour itself + browser + slack…)
 *   available         = physical - reservedForSystem
 *   alreadyLoaded     = sum of cached MLX preset RAM costs
 *   wantToLoad        = candidate preset's approxLiveRamGB
 *
 * If `alreadyLoaded + wantToLoad > available`, refuse with a clear,
 * user-facing message ("preset needs X GB; you have Y GB free after
 * the chat model and OS reservation"). Caller can `unloadAll()` to
 * free space, then retry.
 *
 * This arbiter is intentionally Swift-side. The bun plugin asks via
 * RPC (`mlx.health` returns the budget breakdown), so the eliza
 * handler can pre-flight and surface a useful error before the heavy
 * call lands.
 */

import Foundation

@MainActor
final class MLXMemoryArbiter {
    static let shared = MLXMemoryArbiter()

    /// GB reserved for the OS + other apps + Detour itself (UI, RPC,
    /// Bun subprocess + eliza runtime, local-chat companion, …).
    /// Tuned empirically. On 16GB Macs this leaves 10GB for MLX work,
    /// which is enough to load LTX-Video 2B (~10GB) — the cheapest
    /// open video model — but not Mochi-1 or HunyuanVideo. User can
    /// override via `DETOUR_MLX_RESERVED_GB` env var if they want a
    /// different tradeoff.
    var reservedForSystemGB: Double {
        if let raw = ProcessInfo.processInfo.environment["DETOUR_MLX_RESERVED_GB"],
           let v = Double(raw), v >= 2.0, v <= 12.0 {
            return v
        }
        return 6.0
    }

    var physicalMemoryGB: Double {
        Double(ProcessInfo.processInfo.physicalMemory) / 1024 / 1024 / 1024
    }

    /// Best-effort estimate of how much MLX-attributable memory is
    /// currently held. Walks both image and video service caches.
    var alreadyLoadedGB: Double {
        let imagePresets = MLXImageService.presets
        let loadedImageBytes = imagePresets
            .filter { preset in MLXImageService.shared.isPresetLoaded(preset.id) }
            .reduce(0.0) { $0 + $1.approxLiveRamGB }
        // Video service is stub-only today, so no contribution. Keep
        // the symmetry for when video is vendored.
        return loadedImageBytes
    }

    var availableGB: Double {
        max(0, physicalMemoryGB - reservedForSystemGB)
    }

    var headroomGB: Double {
        max(0, availableGB - alreadyLoadedGB)
    }

    /// Throws if loading the preset would exceed budget. Returns
    /// silently if the load is safe.
    ///
    /// `extraReservedGB` is the bun-side LLM arbiter's `usedGB` —
    /// memory already held by chat + companion models. Counting this
    /// here closes the gap where a 14B chat could OOM the system when
    /// we green-lit SDXL on a 16GB Mac.
    func gateImage(preset: MLXImageService.ImagePreset, extraReservedGB: Double = 0) throws {
        try gate(label: preset.label, requiredGB: preset.approxLiveRamGB, extraReservedGB: extraReservedGB)
    }

    func gateVideo(preset: MLXVideoService.VideoPreset, extraReservedGB: Double = 0) throws {
        try gate(label: preset.label, requiredGB: preset.approxLiveRamGB, extraReservedGB: extraReservedGB)
    }

    private func gate(label: String, requiredGB: Double, extraReservedGB: Double) throws {
        let trueAvail = max(0, availableGB - alreadyLoadedGB - extraReservedGB)
        if requiredGB > trueAvail {
            let msg = String(
                format: "%@ needs ~%.1f GB unified memory but only %.1f GB is free " +
                        "(physical %.0f GB, %.0f GB reserved for system + agent, " +
                        "%.1f GB already used by MLX models, %.1f GB already used by LLM stack). " +
                        "Call mlx.image.unload to free space, or pick a smaller preset.",
                label, requiredGB, trueAvail, physicalMemoryGB, reservedForSystemGB,
                alreadyLoadedGB, extraReservedGB
            )
            throw MLXMemoryError.budgetExceeded(msg)
        }
    }

    /// Snapshot for mlx.health and the tray-state UI. Returned as a
    /// concrete Sendable struct so callers can return it across actor
    /// boundaries without `[String: Any]` Sendable warnings.
    struct Snapshot: Sendable {
        let physicalGB: Double
        let reservedForSystemGB: Double
        let availableGB: Double
        let alreadyLoadedGB: Double
        let headroomGB: Double
        func toDict() -> [String: Double] {
            [
                "physicalGB": physicalGB,
                "reservedForSystemGB": reservedForSystemGB,
                "availableGB": availableGB,
                "alreadyLoadedGB": alreadyLoadedGB,
                "headroomGB": headroomGB,
            ]
        }
    }
    func snapshot() -> Snapshot {
        Snapshot(
            physicalGB: physicalMemoryGB,
            reservedForSystemGB: reservedForSystemGB,
            availableGB: availableGB,
            alreadyLoadedGB: alreadyLoadedGB,
            headroomGB: headroomGB
        )
    }
}

enum MLXMemoryError: LocalizedError {
    case budgetExceeded(String)
    var errorDescription: String? {
        switch self {
        case .budgetExceeded(let m): return m
        }
    }
}
