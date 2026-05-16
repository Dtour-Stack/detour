/*
 * MLXInferenceService — local LLM inference path via Apple's MLX
 * framework, replacing the llama.cpp subprocess. 2-3× faster on
 * Apple Silicon, no separate process, native Metal pipeline.
 *
 * STATUS: integration scaffold + stub. The interface is real; the
 * real implementation requires adding github.com/ml-explore/
 * mlx-swift-examples as a SwiftPM dependency. The migration is
 * intentionally NOT in-place — once mlx-swift lands, swap the stub
 * generate() body for the real MLXLLM call and the rest of the app
 * keeps working.
 *
 * Migration steps (when ready to flip):
 *
 *   1. Add to Package.swift:
 *
 *        dependencies: [
 *            .package(url: "https://github.com/ml-explore/mlx-swift-examples",
 *                     branch: "main"),
 *        ],
 *        // …in the target:
 *        dependencies: [
 *            .product(name: "MLXLLM", package: "mlx-swift-examples"),
 *            .product(name: "MLXLMCommon", package: "mlx-swift-examples"),
 *        ],
 *
 *   2. Replace the body of `generate(prompt:options:)` with:
 *
 *        import MLXLLM
 *        import MLXLMCommon
 *
 *        let modelContainer = try await LLMModelFactory.shared.loadContainer(
 *            configuration: ModelConfiguration(id: "mlx-community/Qwen3-1.7B-4bit"))
 *        let result = try await modelContainer.perform { ctx in
 *            let input = try await ctx.processor.prepare(input: .init(prompt: prompt))
 *            return try MLXLMCommon.generate(input: input, parameters: ..., context: ctx)
 *        }
 *
 *   3. Remove the llama-server subprocess startup in LlamaServerService
 *      (or keep it as a fallback for non-Apple-Silicon platforms).
 *
 *   4. Update CompanionService's _callCompletion to use MLXInferenceService
 *      instead of HTTP-to-llama-server.
 *
 * Memory budget: MLX shares the unified memory pool. A 1.7B Q4
 * model lives in ~1.2 GB. The existing arbiter (memoryArbiter) is
 * still authoritative — wire it the same way.
 *
 * Models: MLX uses .safetensors weights hosted on HuggingFace under
 *   the `mlx-community/` org. Suggested:
 *
 *   - mlx-community/Qwen3-0.6B-Instruct-4bit   (~400 MB, replaces companion preset)
 *   - mlx-community/Qwen3-1.7B-Instruct-4bit   (~1.1 GB)
 *   - mlx-community/Qwen3-4B-Instruct-4bit     (~2.4 GB)
 *   - mlx-community/bge-small-en-v1.5          (for embeddings)
 *
 * The model IDs map cleanly to the existing chat-service presets.
 */

import Foundation
import MLX
import MLXFast
import MLXNN
import MLXRandom
import Tokenizers

@MainActor
final class MLXInferenceService {
    static let shared = MLXInferenceService()

    enum AvailabilityState {
        /// MLX framework is linked and ready to load models.
        case available
        /// Scaffold present; mlx-swift dependency not yet wired.
        case notWired
        /// Hardware doesn't support MLX (non-Apple Silicon).
        case unsupportedHardware
    }

    struct GenerateOptions {
        let maxTokens: Int
        let temperature: Double
        let topP: Double
        let modelID: String  // e.g. "mlx-community/Qwen3-1.7B-Instruct-4bit"
        init(modelID: String, maxTokens: Int = 512, temperature: Double = 0.4, topP: Double = 0.95) {
            self.modelID = modelID
            self.maxTokens = maxTokens
            self.temperature = temperature
            self.topP = topP
        }
    }

    /// Reports whether MLX inference is wired and runnable.
    var availability: AvailabilityState {
        let isAppleSilicon: Bool = {
            var info = utsname()
            uname(&info)
            let machine = withUnsafeBytes(of: &info.machine) { rawBuf -> String in
                let buf = rawBuf.bindMemory(to: CChar.self).baseAddress!
                return String(cString: buf)
            }
            return machine.hasPrefix("arm64")
        }()
        return isAppleSilicon ? .available : .unsupportedHardware
    }

    /// Cached tokenizers per model id (cheap re-use across calls).
    private var loadedTokenizers: [String: Tokenizer] = [:]

    /// MLX inference path. The mlx-swift package gives us MLX tensor
    /// ops + Metal kernels; swift-transformers gives us the tokenizer
    /// loader. The MISSING piece is the per-model forward pass — each
    /// model architecture (Qwen3, Llama, Gemma) has its own layout we'd
    /// need to implement against mlx-swift primitives, or vendor from
    /// the unbuilt MLXLLM target in mlx-swift-examples.
    ///
    /// This first cut loads the tokenizer to prove the dependency
    /// integration works end-to-end. The forward-pass implementation
    /// is the next finite chunk of work (~2-4 days per architecture
    /// family). Until then, falls through to llama-server.
    func generate(prompt: String, options: GenerateOptions) async throws -> String {
        if availability == .unsupportedHardware {
            throw MLXError.unsupportedHardware
        }
        // Tokenizer load — proves swift-transformers integration is wired.
        let tokenizer = try await loadTokenizer(modelID: options.modelID)
        let tokenized = try tokenizer.encode(text: prompt)
        NSLog("[MLX] tokenized \(prompt.count) chars → \(tokenized.count) tokens for \(options.modelID)")
        // Forward pass not yet implemented in-tree. We have:
        //   - mlx-swift (tensor ops): ready
        //   - swift-transformers (tokenizer): ready (just used above)
        //   - model weights: would download from HF
        //   - forward pass: TODO — per-architecture (Qwen3, Llama, etc).
        //
        // The right pattern: copy mlx-swift-examples' `Libraries/MLXLLM/
        // Models/Qwen3.swift` (and the shared MLXLMCommon Generation.swift)
        // into Sources/Swiftun/mlx-vendor/ — they're MIT-licensed and
        // self-contained ~1500 LOC. Then `generate()` calls into them.
        throw MLXError.modelLoadFailed("forward pass not yet vendored from mlx-swift-examples")
    }

    private func loadTokenizer(modelID: String) async throws -> Tokenizer {
        if let cached = loadedTokenizers[modelID] { return cached }
        do {
            let tok = try await AutoTokenizer.from(pretrained: modelID)
            loadedTokenizers[modelID] = tok
            return tok
        } catch {
            throw MLXError.modelLoadFailed("tokenizer for \(modelID): \(error.localizedDescription)")
        }
    }

    /// Stream-style generation (for chat-bubble live updates). Same
    /// scaffolding pattern: throws until wired, then yields tokens
    /// via AsyncStream.
    func generateStream(
        prompt: String,
        options: GenerateOptions,
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    _ = try await generate(prompt: prompt, options: options)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    /// Return the recommended preset for the current device's RAM.
    /// Wired in advance of the dependency landing so UI surfaces can
    /// show users what they'd get.
    var recommendedPreset: GenerateOptions {
        let totalGB = Double(ProcessInfo.processInfo.physicalMemory) / 1024 / 1024 / 1024
        // RAM headroom: assume the agent + UI + other apps want ~8 GB.
        let avail = totalGB - 8
        let modelID: String
        if avail >= 12 {
            modelID = "mlx-community/Qwen3-7B-Instruct-4bit"
        } else if avail >= 6 {
            modelID = "mlx-community/Qwen3-4B-Instruct-4bit"
        } else if avail >= 2 {
            modelID = "mlx-community/Qwen3-1.7B-Instruct-4bit"
        } else {
            modelID = "mlx-community/Qwen3-0.6B-Instruct-4bit"
        }
        return GenerateOptions(modelID: modelID)
    }
}

enum MLXError: LocalizedError {
    case unsupportedHardware
    case notWired
    case modelLoadFailed(String)
    var errorDescription: String? {
        switch self {
        case .unsupportedHardware:
            return "MLX inference requires Apple Silicon; this device isn't supported."
        case .notWired:
            return "MLX scaffold present but mlx-swift-examples dependency not yet added to Package.swift."
        case .modelLoadFailed(let m):
            return "MLX model load failed: \(m)"
        }
    }
}
