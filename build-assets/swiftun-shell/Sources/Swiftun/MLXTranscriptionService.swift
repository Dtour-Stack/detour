/*
 * MLXTranscriptionService — local speech-to-text on Apple Silicon.
 *
 * Architecture: hybrid. The "apple-speech" preset uses Apple's
 * built-in SFSpeechRecognizer (zero install, on-device since
 * macOS 12, ~real-time, supports 50+ languages). Future MLX
 * presets (whisper-large-v3-turbo, parakeet-tdt-0.6b-v3) live in
 * the catalog as documented stubs until vendored — same shape as
 * MLXImageService's Sana slot.
 *
 * Why Apple Speech first: it's already shipping, already real,
 * already permission-gated (user consents via NSSpeechRecognitionUsage
 * Description), and quality is competitive with Whisper-medium for
 * non-streaming use. For premium quality / non-English / very long
 * audio, the Whisper-MLX preset is the upgrade path.
 *
 * Vendor recipe for Whisper-MLX (when wanted):
 *   - HF: mlx-community/whisper-large-v3-turbo-4bit (~1.5 GB, 10× realtime)
 *   - Or:  mlx-community/parakeet-tdt-0.6b-v3 (NVIDIA, ~600 MB, 900k dl/mo)
 *   - Swift port options:
 *     * argmaxinc/WhisperKit (CoreML, Swift-native, ships today — easiest)
 *     * Custom MLX port via mlx-examples/whisper (Python reference, ~800 LOC)
 *   - Drop into Sources/Swiftun/mlx-vendor/whisper/ and replace
 *     the .whisperLargeV3Turbo case in runMLXTranscribe() with the call.
 */

import AVFoundation
import Foundation
import Speech

final class MLXTranscriptionService: @unchecked Sendable {
    static let shared = MLXTranscriptionService()
    private let stateLock = NSLock()

    enum AvailabilityState {
        case available
        case unsupportedHardware
        case permissionDenied
    }

    struct TranscriptionPreset {
        let id: String
        let label: String
        let modelID: String?     // nil for Apple-framework-only presets
        let approxLiveRamGB: Double
        let approxDiskGB: Double
        let supportsStreaming: Bool
        let vendored: Bool
    }

    struct TranscribeOptions {
        let presetId: String
        let audioBase64: String    // 16-bit PCM, m4a, wav, or aiff
        let mimeType: String?
        let languageCode: String?  // e.g. "en-US"
    }

    struct TranscribeResult {
        let text: String
        let segments: [(start: Double, end: Double, text: String)]
        let language: String
        let durationMs: Int
        let model: String
    }

    nonisolated static let presets: [TranscriptionPreset] = [
        TranscriptionPreset(
            id: "apple-speech",
            label: "Apple Speech (on-device)",
            modelID: nil,
            approxLiveRamGB: 0.3, approxDiskGB: 0,
            supportsStreaming: true,
            vendored: true   // shipped today
        ),
        TranscriptionPreset(
            id: "whisper-large-v3-turbo",
            label: "Whisper Large v3 Turbo (MLX, pending vendor)",
            modelID: "mlx-community/whisper-large-v3-turbo-4bit",
            approxLiveRamGB: 2.0, approxDiskGB: 1.6,
            supportsStreaming: false,
            vendored: false
        ),
        TranscriptionPreset(
            id: "parakeet-tdt-v3",
            label: "Parakeet TDT v3 (MLX, pending vendor)",
            modelID: "mlx-community/parakeet-tdt-0.6b-v3",
            approxLiveRamGB: 1.2, approxDiskGB: 0.7,
            supportsStreaming: false,
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
        guard machine.hasPrefix("arm64") else { return .unsupportedHardware }
        return .available
    }

    func transcribe(options: TranscribeOptions) async throws -> TranscribeResult {
        guard let preset = MLXTranscriptionService.presets.first(where: { $0.id == options.presetId }) else {
            throw MLXTranscriptionError.unknownPreset(options.presetId)
        }
        if !preset.vendored {
            throw MLXTranscriptionError.notImplemented(
                "\(preset.label) — MLX port pending vendor. Use 'apple-speech' for the working on-device path. " +
                "See MLXTranscriptionService.swift header for the vendor recipe."
            )
        }
        switch preset.id {
        case "apple-speech":
            return try await runAppleSpeech(options: options, preset: preset)
        default:
            throw MLXTranscriptionError.notImplemented("preset \(preset.id) handler missing")
        }
    }

    private func runAppleSpeech(
        options: TranscribeOptions,
        preset: TranscriptionPreset
    ) async throws -> TranscribeResult {
        // Request permission once. SFSpeechRecognizer drives the user-
        // consent prompt; subsequent calls reuse the granted status.
        let auth = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { status in cont.resume(returning: status) }
        }
        guard auth == .authorized else {
            throw MLXTranscriptionError.permissionDenied(
                "Speech recognition not authorized. Grant in System Settings → Privacy & Security → Speech Recognition."
            )
        }
        guard let pcm = Data(base64Encoded: options.audioBase64) else {
            throw MLXTranscriptionError.badAudio("audioBase64 not base64-decodable")
        }
        // Write to a temp file — SFSpeechURLRecognitionRequest needs a URL.
        let tmpURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("detour-stt-\(UUID().uuidString).\(extensionForMime(options.mimeType))")
        try pcm.write(to: tmpURL)
        defer { try? FileManager.default.removeItem(at: tmpURL) }

        let locale = Locale(identifier: options.languageCode ?? "en-US")
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            throw MLXTranscriptionError.unsupportedHardware
        }
        guard recognizer.isAvailable else {
            throw MLXTranscriptionError.unsupportedHardware
        }
        // Force on-device path so the audio bytes never leave the Mac.
        let request = SFSpeechURLRecognitionRequest(url: tmpURL)
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        request.shouldReportPartialResults = false

        let started = Date()
        // Pull the result's primitive fields out inside the callback to
        // avoid sending a non-Sendable SFSpeechRecognitionResult across.
        struct FinalTranscription: Sendable {
            let text: String
            let segments: [(start: Double, end: Double, text: String)]
        }
        let final: FinalTranscription = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<FinalTranscription, Error>) in
            recognizer.recognitionTask(with: request) { res, err in
                if let err {
                    cont.resume(throwing: err)
                    return
                }
                if let res, res.isFinal {
                    let best = res.bestTranscription
                    let segs = best.segments.map {
                        (start: $0.timestamp, end: $0.timestamp + $0.duration, text: $0.substring)
                    }
                    cont.resume(returning: FinalTranscription(text: best.formattedString, segments: segs))
                }
            }
        }
        let durationMs = Int(Date().timeIntervalSince(started) * 1000)
        let bestTranscriptionText = final.text
        let segments = final.segments
        return TranscribeResult(
            text: bestTranscriptionText,
            segments: segments,
            language: locale.identifier,
            durationMs: durationMs,
            model: "apple-speech"
        )
    }

    private func extensionForMime(_ mime: String?) -> String {
        switch (mime ?? "").lowercased() {
        case "audio/wav", "audio/x-wav": return "wav"
        case "audio/aiff", "audio/x-aiff": return "aiff"
        case "audio/mpeg", "audio/mp3": return "mp3"
        case "audio/m4a", "audio/x-m4a", "audio/mp4": return "m4a"
        case "audio/flac": return "flac"
        default: return "wav"
        }
    }
}

enum MLXTranscriptionError: LocalizedError {
    case unsupportedHardware
    case unknownPreset(String)
    case notImplemented(String)
    case permissionDenied(String)
    case badAudio(String)
    case inferenceFailed(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedHardware: return "Local STT requires Apple Silicon."
        case .unknownPreset(let id): return "Unknown STT preset: \(id)"
        case .notImplemented(let m): return m
        case .permissionDenied(let m): return m
        case .badAudio(let m): return "Bad audio: \(m)"
        case .inferenceFailed(let m): return "Transcription failed: \(m)"
        }
    }
}
