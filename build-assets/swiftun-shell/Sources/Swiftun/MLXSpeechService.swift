/*
 * MLXSpeechService — local text-to-speech on Apple Silicon.
 *
 * Architecture: hybrid like MLXTranscriptionService. The "avspeech"
 * preset uses Apple's AVSpeechSynthesizer (zero install, on-device,
 * dozens of high-quality system voices). Future MLX presets
 * (Kokoro-82M, Bark-MLX) live as documented stubs.
 *
 * Why AVSpeech first: macOS ships system voices that include
 * neural-quality Premium and Enhanced variants (downloaded via
 * System Settings → Accessibility → Spoken Content). Free, fast,
 * already there.
 *
 * Vendor recipe for Kokoro-MLX (when wanted):
 *   - HF: mlx-community/Kokoro-82M-bf16 (~160 MB, 750k dl/mo)
 *   - Reference (Python): hexgrad/Kokoro-82M
 *   - Architecture: StyleTTS2 — much simpler than full diffusion TTS
 *   - ~600 LOC Swift port; weights are clean MLX safetensors
 *   - Real-time on M-series, multiple voices, very high quality
 *   - Drop into Sources/Swiftun/mlx-vendor/kokoro/ and replace the
 *     .kokoro82m case in runMLXSynthesize() with the call.
 */

import AVFoundation
import Foundation

@MainActor
final class MLXSpeechService {
    static let shared = MLXSpeechService()

    enum AvailabilityState {
        case available
        case unsupportedHardware
    }

    struct SpeechPreset {
        let id: String
        let label: String
        let modelID: String?
        let approxLiveRamGB: Double
        let approxDiskGB: Double
        let vendored: Bool
    }

    struct SynthesizeOptions {
        let presetId: String
        let text: String
        let voice: String?     // e.g. "com.apple.voice.compact.en-US.Samantha"
        let rate: Float?       // AVSpeechUtterance.rate (default 0.5)
        let pitch: Float?      // AVSpeechUtterance.pitchMultiplier (default 1.0)
    }

    struct SynthesizedAudio {
        let audioData: Data        // AIFF
        let contentType: String    // "audio/aiff"
        let durationSeconds: Double
        let durationMs: Int        // wall-clock to synthesize
        let voice: String
        let model: String
    }

    nonisolated static let presets: [SpeechPreset] = [
        SpeechPreset(
            id: "avspeech",
            label: "macOS System Voices (AVSpeechSynthesizer)",
            modelID: nil,
            approxLiveRamGB: 0.2, approxDiskGB: 0,
            vendored: true
        ),
        SpeechPreset(
            id: "kokoro-82m",
            label: "Kokoro 82M (MLX, pending vendor)",
            modelID: "mlx-community/Kokoro-82M-bf16",
            approxLiveRamGB: 0.5, approxDiskGB: 0.16,
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

    /// Enumerate the system voices the user actually has installed.
    /// Useful for the Settings picker — listed under the avspeech preset.
    func availableSystemVoices() -> [(id: String, name: String, lang: String, quality: String)] {
        AVSpeechSynthesisVoice.speechVoices().map { v in
            let quality: String
            switch v.quality {
            case .default: quality = "default"
            case .enhanced: quality = "enhanced"
            case .premium: quality = "premium"
            @unknown default: quality = "default"
            }
            return (id: v.identifier, name: v.name, lang: v.language, quality: quality)
        }
    }

    func synthesize(options: SynthesizeOptions) async throws -> SynthesizedAudio {
        guard let preset = MLXSpeechService.presets.first(where: { $0.id == options.presetId }) else {
            throw MLXSpeechError.unknownPreset(options.presetId)
        }
        if !preset.vendored {
            throw MLXSpeechError.notImplemented(
                "\(preset.label) — MLX port pending vendor. Use 'avspeech' for working on-device synthesis. " +
                "See MLXSpeechService.swift header for the vendor recipe."
            )
        }
        switch preset.id {
        case "avspeech": return try await runAVSpeech(options: options)
        default: throw MLXSpeechError.notImplemented("preset \(preset.id) handler missing")
        }
    }

    private func runAVSpeech(options: SynthesizeOptions) async throws -> SynthesizedAudio {
        let utterance = AVSpeechUtterance(string: options.text)
        if let voiceID = options.voice, let voice = AVSpeechSynthesisVoice(identifier: voiceID) {
            utterance.voice = voice
        } else {
            // Default to the system's preferred English voice.
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        }
        if let rate = options.rate { utterance.rate = rate }
        if let pitch = options.pitch { utterance.pitchMultiplier = pitch }

        // AVSpeechSynthesizer.write(_:toBufferCallback:) yields AVAudioPCMBuffers.
        // We accumulate samples, then encode to AIFF via AVAudioFile.
        // The callback is @Sendable so we route through a locked holder.
        let synth = AVSpeechSynthesizer()
        let started = Date()

        // Serial queue isolates the @Sendable callback from the @MainActor
        // read path without using locks that are unavailable in async ctx.
        // The zero-length buffer is the synth's done signal — NOT
        // `isSpeaking`, which can be false before the first buffer
        // arrives (verifier exposed this).
        final class Sink: @unchecked Sendable {
            var buffers: [AVAudioPCMBuffer] = []
            var format: AVAudioFormat? = nil
            var done = false
        }
        let sink = Sink()
        let sinkQueue = DispatchQueue(label: "ai.detour.tts.sink")

        let collector: @Sendable (AVAudioBuffer) -> Void = { buf in
            guard let pcm = buf as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                sinkQueue.sync { sink.done = true }
                return
            }
            // Deep-copy before queue handoff (synth may reuse storage).
            guard let copy = AVAudioPCMBuffer(pcmFormat: pcm.format, frameCapacity: pcm.frameLength) else { return }
            copy.frameLength = pcm.frameLength
            let channels = Int(pcm.format.channelCount)
            let frames = Int(pcm.frameLength)
            if let src = pcm.floatChannelData, let dst = copy.floatChannelData {
                for c in 0..<channels { memcpy(dst[c], src[c], frames * MemoryLayout<Float>.size) }
            } else if let src = pcm.int16ChannelData, let dst = copy.int16ChannelData {
                for c in 0..<channels { memcpy(dst[c], src[c], frames * MemoryLayout<Int16>.size) }
            }
            sinkQueue.sync {
                if sink.format == nil { sink.format = pcm.format }
                sink.buffers.append(copy)
            }
        }

        synth.write(utterance, toBufferCallback: collector)
        let deadline = Date().addingTimeInterval(60)
        while !sinkQueue.sync(execute: { sink.done }) {
            if Date() > deadline {
                throw MLXSpeechError.inferenceFailed("synthesizer timed out after 60s")
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        let (buffers, format) = sinkQueue.sync { (sink.buffers, sink.format) }
        guard let fmt = format, !buffers.isEmpty else {
            throw MLXSpeechError.inferenceFailed("synthesizer produced no audio")
        }

        // Compute total frames + write AIFF.
        let totalFrames = buffers.reduce(AVAudioFrameCount(0)) { $0 + $1.frameLength }
        let outURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("detour-tts-\(UUID().uuidString).aiff")
        defer { try? FileManager.default.removeItem(at: outURL) }

        let outFile: AVAudioFile
        do {
            outFile = try AVAudioFile(
                forWriting: outURL,
                settings: fmt.settings,
                commonFormat: fmt.commonFormat,
                interleaved: fmt.isInterleaved
            )
        } catch {
            throw MLXSpeechError.inferenceFailed("AVAudioFile create: \(error.localizedDescription)")
        }
        for buf in buffers {
            do { try outFile.write(from: buf) } catch {
                throw MLXSpeechError.inferenceFailed("AVAudioFile write: \(error.localizedDescription)")
            }
        }
        let durationSeconds = Double(totalFrames) / fmt.sampleRate
        let data = try Data(contentsOf: outURL)
        return SynthesizedAudio(
            audioData: data,
            contentType: "audio/aiff",
            durationSeconds: durationSeconds,
            durationMs: Int(Date().timeIntervalSince(started) * 1000),
            voice: utterance.voice?.identifier ?? "system",
            model: "avspeech"
        )
    }
}

enum MLXSpeechError: LocalizedError {
    case unsupportedHardware
    case unknownPreset(String)
    case notImplemented(String)
    case inferenceFailed(String)
    var errorDescription: String? {
        switch self {
        case .unsupportedHardware: return "Local TTS requires Apple Silicon."
        case .unknownPreset(let id): return "Unknown TTS preset: \(id)"
        case .notImplemented(let m): return m
        case .inferenceFailed(let m): return "Synthesis failed: \(m)"
        }
    }
}
