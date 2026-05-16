/*
 * ModelCatalog — curated list of currently-available models per
 * provider and tier. Used by the Settings → Models & Providers
 * routing card so each tier shows a real dropdown instead of an
 * empty text field with stale defaults.
 *
 * Last refreshed: 2026-05. Models are surfaced by provider id so the
 * routing card can show "OpenRouter → TEXT_LARGE" pickers populated
 * from the openrouter section, etc.
 *
 * To add a new model: append to the relevant tier array. Keep IDs
 * EXACTLY as the provider expects (anthropic accepts "claude-sonnet-4-6",
 * OpenRouter accepts "anthropic/claude-sonnet-4-6"). If the user wants
 * a model not in the curated list they can pick "Custom…" and paste it.
 */

import Foundation

struct ModelOption: Identifiable, Hashable {
    let id: String         // raw model id passed to the provider
    let label: String      // human-readable label for the UI
    let note: String?      // optional caveat ("free tier", "vision", etc)
}

enum ModelTier {
    case textLarge
    case textMedium
    case textSmall
    case embedding
    case image
    case video
    case vision
}

enum ModelCatalog {

    // MARK: - Anthropic (Claude 4.x family)
    static let anthropic: [ModelTier: [ModelOption]] = [
        .textLarge: [
            ModelOption(id: "claude-opus-4-7", label: "Claude Opus 4.7", note: "most capable"),
            ModelOption(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "balanced"),
        ],
        .textMedium: [
            ModelOption(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: nil),
            ModelOption(id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", note: "fast"),
        ],
        .textSmall: [
            ModelOption(id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", note: "fast / cheap"),
        ],
        .vision: [
            ModelOption(id: "claude-opus-4-7", label: "Claude Opus 4.7 (vision)", note: nil),
            ModelOption(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (vision)", note: nil),
        ],
    ]

    // MARK: - OpenAI (GPT-5.2 family + o4 reasoning, as of 2026-05)
    // Confirmed via the codex-chatgpt plugin (CODEX_MODEL_LARGE default
    // = "gpt-5.2"). Same models accessed via direct OpenAI API key or
    // ChatGPT subscription OAuth path.
    static let openai: [ModelTier: [ModelOption]] = [
        .textLarge: [
            ModelOption(id: "gpt-5.2", label: "GPT-5.2", note: "flagship reasoning"),
            ModelOption(id: "gpt-5.2-pro", label: "GPT-5.2 Pro", note: "highest capability"),
            ModelOption(id: "o4", label: "o4", note: "deep reasoning"),
        ],
        .textMedium: [
            ModelOption(id: "gpt-5.2", label: "GPT-5.2", note: nil),
            ModelOption(id: "gpt-5.2-mini", label: "GPT-5.2 mini", note: "fast"),
            ModelOption(id: "o4-mini", label: "o4-mini", note: "fast reasoning"),
        ],
        .textSmall: [
            ModelOption(id: "gpt-5.2-mini", label: "GPT-5.2 mini", note: nil),
            ModelOption(id: "gpt-5.2-nano", label: "GPT-5.2 nano", note: "fastest / cheapest"),
        ],
        .embedding: [
            ModelOption(id: "text-embedding-3-large", label: "text-embedding-3-large", note: "3072-dim"),
            ModelOption(id: "text-embedding-3-small", label: "text-embedding-3-small", note: "1536-dim"),
        ],
        .image: [
            ModelOption(id: "gpt-image-2", label: "GPT Image 2", note: "current"),
            ModelOption(id: "dall-e-3", label: "DALL-E 3", note: "legacy"),
        ],
        .vision: [
            ModelOption(id: "gpt-5.2", label: "GPT-5.2 (vision)", note: nil),
            ModelOption(id: "gpt-5.2-pro", label: "GPT-5.2 Pro (vision)", note: nil),
        ],
    ]

    // MARK: - OpenRouter (proxies many models)
    static let openrouter: [ModelTier: [ModelOption]] = [
        .textLarge: [
            ModelOption(id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7", note: nil),
            ModelOption(id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: nil),
            ModelOption(id: "openai/gpt-5", label: "GPT-5", note: nil),
            ModelOption(id: "google/gemini-3-pro", label: "Gemini 3 Pro", note: nil),
            ModelOption(id: "deepseek/deepseek-v4", label: "DeepSeek V4", note: nil),
            ModelOption(id: "meta-llama/llama-4-405b-instruct", label: "Llama 4 405B", note: nil),
            ModelOption(id: "x-ai/grok-4", label: "Grok 4", note: nil),
        ],
        .textMedium: [
            ModelOption(id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: nil),
            ModelOption(id: "openai/gpt-5-mini", label: "GPT-5 mini", note: nil),
            ModelOption(id: "google/gemini-3-flash", label: "Gemini 3 Flash", note: nil),
            ModelOption(id: "meta-llama/llama-4-70b-instruct", label: "Llama 4 70B", note: nil),
            ModelOption(id: "qwen/qwen3-72b-instruct", label: "Qwen 3 72B", note: nil),
        ],
        .textSmall: [
            ModelOption(id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", note: nil),
            ModelOption(id: "openai/gpt-5-nano", label: "GPT-5 nano", note: nil),
            ModelOption(id: "google/gemini-3-flash-lite", label: "Gemini 3 Flash Lite", note: nil),
            ModelOption(id: "meta-llama/llama-4-8b-instruct:free", label: "Llama 4 8B (free)", note: "free tier"),
            ModelOption(id: "qwen/qwen3-7b-instruct:free", label: "Qwen 3 7B (free)", note: "free tier"),
        ],
        .embedding: [
            ModelOption(id: "openai/text-embedding-3-large", label: "OpenAI text-embedding-3-large", note: "3072-dim"),
            ModelOption(id: "openai/text-embedding-3-small", label: "OpenAI text-embedding-3-small", note: "1536-dim"),
            ModelOption(id: "voyage/voyage-3", label: "Voyage 3", note: "1024-dim"),
            ModelOption(id: "cohere/embed-v4", label: "Cohere embed-v4", note: nil),
        ],
        .image: [
            ModelOption(id: "openai/gpt-image-2", label: "GPT Image 2", note: nil),
            ModelOption(id: "black-forest-labs/flux-1.2-pro", label: "FLUX 1.2 Pro", note: nil),
            ModelOption(id: "stability-ai/stable-diffusion-4", label: "Stable Diffusion 4", note: nil),
        ],
        .video: [
            ModelOption(id: "google/veo-3", label: "Veo 3", note: nil),
            ModelOption(id: "runway/gen-4", label: "Runway Gen-4", note: nil),
            ModelOption(id: "luma/dream-machine-3", label: "Luma Dream Machine 3", note: nil),
        ],
        .vision: [
            ModelOption(id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7", note: nil),
            ModelOption(id: "openai/gpt-5", label: "GPT-5", note: nil),
            ModelOption(id: "google/gemini-3-pro", label: "Gemini 3 Pro", note: nil),
        ],
    ]

    // MARK: - ElizaOS Cloud (their own tiered routing)
    static let elizacloud: [ModelTier: [ModelOption]] = [
        .textLarge: [
            ModelOption(id: "auto-large", label: "Auto-large (router picks)", note: nil),
            ModelOption(id: "claude-opus-4-7", label: "Claude Opus 4.7", note: nil),
            ModelOption(id: "gpt-5", label: "GPT-5", note: nil),
        ],
        .textMedium: [
            ModelOption(id: "auto-medium", label: "Auto-medium", note: nil),
            ModelOption(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: nil),
            ModelOption(id: "gpt-5-mini", label: "GPT-5 mini", note: nil),
        ],
        .textSmall: [
            ModelOption(id: "auto-small", label: "Auto-small", note: nil),
            ModelOption(id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: nil),
            ModelOption(id: "gpt-5-nano", label: "GPT-5 nano", note: nil),
        ],
        .embedding: [
            ModelOption(id: "auto-embedding", label: "Auto-embedding", note: nil),
            ModelOption(id: "text-embedding-3-large", label: "OpenAI 3-large", note: nil),
        ],
        .image: [
            ModelOption(id: "auto-image", label: "Auto-image", note: nil),
            ModelOption(id: "gpt-image-2", label: "GPT Image 2", note: nil),
            ModelOption(id: "flux-1.2-pro", label: "FLUX 1.2 Pro", note: nil),
        ],
        .video: [
            ModelOption(id: "auto-video", label: "Auto-video", note: nil),
            ModelOption(id: "veo-3", label: "Veo 3", note: nil),
        ],
    ]

    // MARK: - Codex (ChatGPT subscription via openai-codex plugin)
    static let codex: [ModelTier: [ModelOption]] = [
        .textLarge: [
            ModelOption(id: "gpt-5", label: "GPT-5", note: "via ChatGPT sub"),
            ModelOption(id: "o4", label: "o4 reasoning", note: nil),
        ],
        .textSmall: [
            ModelOption(id: "gpt-5-mini", label: "GPT-5 mini", note: nil),
            ModelOption(id: "gpt-5-nano", label: "GPT-5 nano", note: nil),
        ],
        .image: [
            ModelOption(id: "gpt-image-2", label: "GPT Image 2", note: nil),
        ],
    ]

    // MARK: - Local llama presets
    // These match the GGUF presets the bun side ships in
    // src/bun/core/llama/presets.ts. Surfaced here so the routing
    // picker can offer them as an option for TEXT_SMALL on local.
    static let local: [ModelTier: [ModelOption]] = [
        .textSmall: [
            ModelOption(id: "qwen3-0.6b", label: "Qwen3 0.6B", note: "fastest, ~1GB RAM"),
            ModelOption(id: "qwen3-1.7b", label: "Qwen3 1.7B", note: "~2GB"),
            ModelOption(id: "qwen3-4b", label: "Qwen3 4B", note: "~4GB"),
        ],
        .textMedium: [
            ModelOption(id: "qwen3-4b", label: "Qwen3 4B", note: "~4GB RAM"),
            ModelOption(id: "qwen3-8b", label: "Qwen3 8B", note: "~6GB"),
            ModelOption(id: "llama3.2-3b", label: "Llama 3.2 3B", note: nil),
        ],
        .textLarge: [
            ModelOption(id: "qwen3-14b", label: "Qwen3 14B", note: "~10GB"),
            ModelOption(id: "qwen3-32b", label: "Qwen3 32B", note: "~22GB"),
            ModelOption(id: "llama3.3-70b", label: "Llama 3.3 70B", note: "~45GB"),
        ],
        .embedding: [
            ModelOption(id: "bge-small-en-v1.5", label: "BGE Small EN v1.5", note: "384-dim, default"),
        ],
    ]

    /// Resolve the catalog for a given provider id. For OpenRouter we
    /// merge the live fetched catalog over the curated baseline so the
    /// dropdown always reflects the actual current model list.
    static func forProvider(_ id: String) -> [ModelTier: [ModelOption]] {
        switch id.lowercased() {
        case "anthropic": return anthropic
        case "openai": return openai
        case "openrouter":
            // Prefer the live-fetched catalog (refreshed in the
            // background); fall back to curated if the fetch hasn't
            // completed yet or the network is down. MainActor.assume
            // because this read happens from SwiftUI body re-renders
            // which are already on the main actor.
            let live = MainActor.assumeIsolated { LiveModelCatalog.shared.openrouter }
            return live.isEmpty ? openrouter : live
        case "elizacloud", "eliza-cloud": return elizacloud
        case "codex", "openai-codex": return codex
        case "local", "local-chat", "local-companion", "llama": return local
        default: return [:]
        }
    }

    /// Convenience accessor for the routing card. Returns the option
    /// list for a (provider, tier) pair, or [] if unknown.
    static func options(provider: String, tier: ModelTier) -> [ModelOption] {
        return forProvider(provider)[tier] ?? []
    }
}

/// Live-loaded model catalog. Right now this only refreshes the
/// OpenRouter list (their /v1/models endpoint is public and the
/// canonical source for current model IDs across every cloud
/// provider). Cached in memory + UserDefaults so the dropdown opens
/// instantly even on cold start.
@MainActor
final class LiveModelCatalog: ObservableObject, @unchecked Sendable {
    static let shared = LiveModelCatalog()
    @Published private(set) var openrouter: [ModelTier: [ModelOption]] = [:]
    @Published private(set) var lastRefreshedAt: Date? = nil
    @Published private(set) var refreshing: Bool = false

    private let cacheKey = "detour.modelCatalog.openrouter.v1"
    private let cacheStaleAfter: TimeInterval = 3600  // 1h

    init() {
        // Hydrate from disk so the picker has data on first paint.
        if let cached = readCache() {
            self.openrouter = cached.byTier
            self.lastRefreshedAt = cached.refreshedAt
        }
        // Background refresh — never blocks the UI.
        if shouldRefresh() {
            Task { await refresh() }
        }
    }

    func shouldRefresh() -> Bool {
        guard let last = lastRefreshedAt else { return true }
        return Date().timeIntervalSince(last) > cacheStaleAfter
    }

    /// Fetch openrouter.ai/api/v1/models and bucket each model into
    /// our tiers by heuristics (context length, name hints).
    func refresh() async {
        await MainActor.run { refreshing = true }
        defer { Task { @MainActor in refreshing = false } }
        guard let url = URL(string: "https://openrouter.ai/api/v1/models") else { return }
        do {
            var req = URLRequest(url: url, timeoutInterval: 8)
            req.addValue("Detour/1.0 (macOS)", forHTTPHeaderField: "User-Agent")
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                NSLog("[ModelCatalog] OpenRouter HTTP non-2xx")
                return
            }
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let raw = obj["data"] as? [[String: Any]] else { return }
            let bucketed = Self.bucket(rawModels: raw)
            await MainActor.run {
                self.openrouter = bucketed
                self.lastRefreshedAt = Date()
                self.writeCache(bucketed: bucketed, refreshedAt: Date())
            }
        } catch {
            NSLog("[ModelCatalog] OpenRouter refresh failed: \(error.localizedDescription)")
        }
    }

    /// Bucket each OpenRouter model into a tier:
    ///   - embedding  → tier=.embedding  (name contains "embed")
    ///   - image      → tier=.image      (name contains "image" / "dall-e" / "flux" / "diffusion")
    ///   - video      → tier=.video      (name contains "video" / "veo" / "runway" / "luma")
    ///   - text by context length:
    ///       > 200k tokens → textLarge
    ///       > 50k tokens  → textMedium
    ///       else          → textSmall
    /// Also surfaces every text model at all 3 text tiers so the user
    /// can pick e.g. a small model for TEXT_LARGE if they want.
    private static func bucket(rawModels: [[String: Any]]) -> [ModelTier: [ModelOption]] {
        var large: [ModelOption] = []
        var medium: [ModelOption] = []
        var small: [ModelOption] = []
        var embedding: [ModelOption] = []
        var image: [ModelOption] = []
        var video: [ModelOption] = []
        for m in rawModels {
            guard let id = m["id"] as? String else { continue }
            let name = (m["name"] as? String) ?? id
            let lower = id.lowercased()
            let pricing = m["pricing"] as? [String: Any]
            let promptCost = (pricing?["prompt"] as? String).flatMap(Double.init) ?? 0
            let isFree = promptCost == 0 && lower.contains(":free")
            let note: String? = isFree ? "free" : nil
            let opt = ModelOption(id: id, label: name, note: note)
            // Categorize
            if lower.contains("embed") {
                embedding.append(opt); continue
            }
            if lower.contains("dall-e") || lower.contains("flux") || lower.contains("stable-diffusion")
                || lower.contains("imagen") || lower.contains("gpt-image") || lower.contains("/image") {
                image.append(opt); continue
            }
            if lower.contains("veo") || lower.contains("runway") || lower.contains("luma")
                || lower.contains("/video") || lower.contains("gen-3") || lower.contains("gen-4") {
                video.append(opt); continue
            }
            // Text models by context length.
            let ctx = (m["context_length"] as? Int)
                ?? Int((m["context_length"] as? Double) ?? 0)
            if ctx >= 200_000 {
                large.append(opt)
            } else if ctx >= 50_000 {
                medium.append(opt)
            } else {
                small.append(opt)
            }
        }
        // Sort each tier: free-tier last, alphabetical otherwise.
        func sortTier(_ a: [ModelOption]) -> [ModelOption] {
            a.sorted { lhs, rhs in
                let lFree = lhs.note == "free"
                let rFree = rhs.note == "free"
                if lFree != rFree { return !lFree }
                return lhs.label.lowercased() < rhs.label.lowercased()
            }
        }
        return [
            .textLarge: sortTier(large),
            .textMedium: sortTier(medium),
            .textSmall: sortTier(small),
            .embedding: sortTier(embedding),
            .image: sortTier(image),
            .video: sortTier(video),
        ]
    }

    // MARK: - Persistence

    private struct CachedCatalog: Codable {
        let byTierFlat: [String: [[String: String?]]]
        let refreshedAt: Date
        var byTier: [ModelTier: [ModelOption]] {
            var out: [ModelTier: [ModelOption]] = [:]
            for (k, list) in byTierFlat {
                guard let tier = Self.tier(from: k) else { continue }
                out[tier] = list.compactMap { entry -> ModelOption? in
                    guard let id = entry["id"] as? String, let label = entry["label"] as? String else { return nil }
                    return ModelOption(id: id, label: label, note: entry["note"] as? String)
                }
            }
            return out
        }
        private static func tier(from key: String) -> ModelTier? {
            switch key {
            case "textLarge": return .textLarge
            case "textMedium": return .textMedium
            case "textSmall": return .textSmall
            case "embedding": return .embedding
            case "image": return .image
            case "video": return .video
            case "vision": return .vision
            default: return nil
            }
        }
    }

    private func readCache() -> (byTier: [ModelTier: [ModelOption]], refreshedAt: Date)? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey),
              let decoded = try? JSONDecoder().decode(CachedCatalog.self, from: data) else { return nil }
        return (decoded.byTier, decoded.refreshedAt)
    }

    private func writeCache(bucketed: [ModelTier: [ModelOption]], refreshedAt: Date) {
        var flat: [String: [[String: String?]]] = [:]
        for (tier, opts) in bucketed {
            let key: String
            switch tier {
            case .textLarge: key = "textLarge"
            case .textMedium: key = "textMedium"
            case .textSmall: key = "textSmall"
            case .embedding: key = "embedding"
            case .image: key = "image"
            case .video: key = "video"
            case .vision: key = "vision"
            }
            flat[key] = opts.map { ["id": $0.id, "label": $0.label, "note": $0.note] }
        }
        let payload = CachedCatalog(byTierFlat: flat, refreshedAt: refreshedAt)
        if let data = try? JSONEncoder().encode(payload) {
            UserDefaults.standard.set(data, forKey: cacheKey)
        }
    }
}
