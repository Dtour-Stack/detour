/*
 * MLXVisionService — local image-description / vision-LLM on Apple
 * Silicon. Implements ModelType.IMAGE_DESCRIPTION's local path.
 *
 * Architecture: hybrid. The "apple-vision" preset uses Apple's Vision
 * framework — OCR (VNRecognizeTextRequest), saliency, classification
 * (VNClassifyImageRequest), face detection, etc. Zero install, real,
 * on-device, free. Quality is "great for OCR + categorical labels,"
 * not "novel free-form description." For free-form captions the
 * Qwen3-VL preset is the upgrade path.
 *
 * Why Apple Vision first: the most common agent vision need is
 * "what's on the screen?" or "transcribe text in this image" — both
 * solved better by Apple Vision than by any LLM-based VLM. Vision
 * framework runs in milliseconds, doesn't need a 2GB model load.
 *
 * Vendor recipe for Qwen3-VL-MLX (free-form caption):
 *   - HF: mlx-community/Qwen3-VL-4B-Instruct-4bit (~2.5 GB, 11k dl/mo)
 *   - Reference: Apple's MLX-VLM repo + the Python mlx-examples/qwen2-vl
 *   - Swift port: ~1000 LOC — vision encoder + MMRoPE + LM, plus image
 *     preprocessing (PIL → MLXArray). Similar order of magnitude to
 *     Qwen3 LLM forward-pass.
 *   - Drop into Sources/Swiftun/mlx-vendor/qwen-vl/ and replace the
 *     .qwen3vl4b case in runVisionDescribe() with the call.
 */

import CoreImage
import Foundation
import Vision

@MainActor
final class MLXVisionService {
    static let shared = MLXVisionService()

    enum AvailabilityState {
        case available
        case unsupportedHardware
    }

    struct VisionPreset {
        let id: String
        let label: String
        let modelID: String?
        let approxLiveRamGB: Double
        let approxDiskGB: Double
        let strengths: String     // human-readable; what this preset is good at
        let vendored: Bool
    }

    struct DescribeOptions {
        let presetId: String
        let imageBase64: String   // PNG or JPEG bytes
        let mimeType: String?
        let prompt: String?       // free-form prompt (used only by VLM presets)
    }

    struct VisionResult {
        let description: String
        let title: String
        let detectedText: String?
        let labels: [(label: String, confidence: Float)]
        let durationMs: Int
        let model: String
    }

    nonisolated static let presets: [VisionPreset] = [
        VisionPreset(
            id: "apple-vision",
            label: "Apple Vision (OCR + classification, on-device)",
            modelID: nil,
            approxLiveRamGB: 0.3, approxDiskGB: 0,
            strengths: "OCR (excellent), object labels, faces/text detection",
            vendored: true
        ),
        VisionPreset(
            id: "qwen3-vl-4b",
            label: "Qwen3-VL 4B (MLX, pending vendor)",
            modelID: "mlx-community/Qwen3-VL-4B-Instruct-4bit",
            approxLiveRamGB: 4.0, approxDiskGB: 2.5,
            strengths: "Free-form captions, prompt-conditioned image Q&A",
            vendored: false
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

    func describe(options: DescribeOptions) async throws -> VisionResult {
        guard let preset = MLXVisionService.presets.first(where: { $0.id == options.presetId }) else {
            throw MLXVisionError.unknownPreset(options.presetId)
        }
        if !preset.vendored {
            throw MLXVisionError.notImplemented(
                "\(preset.label) — MLX port pending vendor. Use 'apple-vision' for working on-device " +
                "OCR + classification. See MLXVisionService.swift header for the vendor recipe."
            )
        }
        switch preset.id {
        case "apple-vision": return try await runAppleVision(options: options)
        default: throw MLXVisionError.notImplemented("preset \(preset.id) handler missing")
        }
    }

    private func runAppleVision(options: DescribeOptions) async throws -> VisionResult {
        guard let imageData = Data(base64Encoded: options.imageBase64) else {
            throw MLXVisionError.badImage("imageBase64 not base64-decodable")
        }
        guard let ciImage = CIImage(data: imageData) else {
            throw MLXVisionError.badImage("CIImage init failed (corrupt or unsupported format)")
        }
        let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
        let started = Date()

        // Run OCR + classification in parallel.
        let textReq = VNRecognizeTextRequest()
        textReq.recognitionLevel = .accurate
        textReq.usesLanguageCorrection = true

        let classifyReq = VNClassifyImageRequest()

        do {
            try handler.perform([textReq, classifyReq])
        } catch {
            throw MLXVisionError.inferenceFailed(error.localizedDescription)
        }

        let detectedText: String? = (textReq.results ?? [])
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
            .nilIfEmpty()

        let topLabels: [(label: String, confidence: Float)] = (classifyReq.results ?? [])
            .filter { $0.confidence > 0.25 }
            .prefix(8)
            .map { (label: $0.identifier, confidence: $0.confidence) }

        // Compose a description in the shape the eliza
        // ImageDescriptionResult expects: { title, description }.
        let title: String = {
            if let firstLabel = topLabels.first?.label {
                return firstLabel.replacingOccurrences(of: "_", with: " ").capitalized
            }
            if detectedText != nil {
                return "Document or text"
            }
            return "Image"
        }()

        var parts: [String] = []
        if !topLabels.isEmpty {
            parts.append("Contents: " + topLabels.map { "\($0.label) (\(Int($0.confidence * 100))%)" }.joined(separator: ", "))
        }
        if let text = detectedText, !text.isEmpty {
            // Cap the OCR text so the description doesn't balloon for screenshots.
            let snippet = text.count > 480 ? String(text.prefix(480)) + "…" : text
            parts.append("Detected text:\n\(snippet)")
        }
        if parts.isEmpty {
            parts.append("Image with no high-confidence labels and no detectable text.")
        }
        let description = parts.joined(separator: "\n\n")
        return VisionResult(
            description: description,
            title: title,
            detectedText: detectedText,
            labels: topLabels,
            durationMs: Int(Date().timeIntervalSince(started) * 1000),
            model: "apple-vision"
        )
    }
}

private extension String {
    func nilIfEmpty() -> String? { isEmpty ? nil : self }
}

enum MLXVisionError: LocalizedError {
    case unsupportedHardware
    case unknownPreset(String)
    case notImplemented(String)
    case badImage(String)
    case inferenceFailed(String)
    var errorDescription: String? {
        switch self {
        case .unsupportedHardware: return "Local vision requires Apple Silicon."
        case .unknownPreset(let id): return "Unknown vision preset: \(id)"
        case .notImplemented(let m): return m
        case .badImage(let m): return "Bad image: \(m)"
        case .inferenceFailed(let m): return "Vision inference failed: \(m)"
        }
    }
}
