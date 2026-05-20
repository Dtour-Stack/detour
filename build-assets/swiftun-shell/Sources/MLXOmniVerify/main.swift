/*
 * MLXOmniVerify — proves the on-device omni paths (TTS, Vision, STT)
 * work end-to-end. Mirrors MLXImageVerify but uses only the Apple
 * frameworks (no MLX dependency needed for these — they're shipped).
 *
 * Usage:
 *   MLXOmniVerify tts "hello world"
 *   MLXOmniVerify vision /path/to/image.png
 *   MLXOmniVerify stt /path/to/audio.wav      (requires user-granted permission)
 *
 * Outputs land at ~/.detour/mlx-verify-omni-<kind>-<timestamp>.{aiff|json}.
 */

import AVFoundation
import CoreImage
import Foundation
import Speech
import Vision

// MARK: - TTS

func runTts(text: String) async throws {
    NSLog("[omni-verify/tts] synthesizing: \(text)")
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
    let synth = AVSpeechSynthesizer()

    final class Sink: @unchecked Sendable {
        var buffers: [AVAudioPCMBuffer] = []
        var format: AVAudioFormat? = nil
        var done = false
    }
    let sink = Sink()
    let q = DispatchQueue(label: "ai.detour.verify.tts.sink")

    let collector: @Sendable (AVAudioBuffer) -> Void = { buf in
        guard let pcm = buf as? AVAudioPCMBuffer else { return }
        // Zero-length buffer = synth finished. Mark done.
        if pcm.frameLength == 0 {
            q.sync { sink.done = true }
            return
        }
        guard let copy = AVAudioPCMBuffer(pcmFormat: pcm.format, frameCapacity: pcm.frameLength) else { return }
        copy.frameLength = pcm.frameLength
        let channels = Int(pcm.format.channelCount)
        let frames = Int(pcm.frameLength)
        if let src = pcm.floatChannelData, let dst = copy.floatChannelData {
            for c in 0..<channels { memcpy(dst[c], src[c], frames * MemoryLayout<Float>.size) }
        } else if let src = pcm.int16ChannelData, let dst = copy.int16ChannelData {
            for c in 0..<channels { memcpy(dst[c], src[c], frames * MemoryLayout<Int16>.size) }
        }
        q.sync {
            if sink.format == nil { sink.format = pcm.format }
            sink.buffers.append(copy)
        }
    }

    let started = Date()
    synth.write(utterance, toBufferCallback: collector)
    // Poll for the done flag the synth sets via the zero-length buffer.
    let deadline = Date().addingTimeInterval(60)
    while !q.sync(execute: { sink.done }) {
        if Date() > deadline {
            throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "synthesizer timed out after 60s"])
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }

    let (buffers, format) = q.sync { (sink.buffers, sink.format) }
    guard let fmt = format, !buffers.isEmpty else {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "no audio produced"])
    }
    let totalFrames = buffers.reduce(AVAudioFrameCount(0)) { $0 + $1.frameLength }
    let dur = Double(totalFrames) / fmt.sampleRate
    let outURL = outRoot.appendingPathComponent("mlx-verify-omni-tts-\(stamp).aiff")
    let outFile = try AVAudioFile(
        forWriting: outURL, settings: fmt.settings,
        commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved
    )
    for buf in buffers { try outFile.write(from: buf) }
    let ms = Int(Date().timeIntervalSince(started) * 1000)
    let attrs = try FileManager.default.attributesOfItem(atPath: outURL.path)
    let size = (attrs[.size] as? Int) ?? 0
    NSLog("[omni-verify/tts] OK: \(size) bytes (\(String(format: "%.2f", dur))s audio) written to \(outURL.path) in \(ms)ms")
}

// MARK: - Vision

func runVision(path: String) async throws {
    if path.isEmpty {
        // Generate a tiny test image so we always have something to feed.
        let tmpImg = outRoot.appendingPathComponent("mlx-verify-omni-vision-input-\(stamp).png")
        guard let data = makeTextImageData(text: "Hello, Detour. This is a vision test.") else {
            throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "could not generate test image"])
        }
        try data.write(to: tmpImg)
        NSLog("[omni-verify/vision] generated test image at \(tmpImg.path)")
        try await runVisionAt(path: tmpImg.path)
    } else {
        try await runVisionAt(path: path)
    }
}

func runVisionAt(path: String) async throws {
    guard let imageData = FileManager.default.contents(atPath: path) else {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "image not found: \(path)"])
    }
    guard let ci = CIImage(data: imageData) else {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "CIImage init failed"])
    }
    NSLog("[omni-verify/vision] analyzing \(path)…")
    let handler = VNImageRequestHandler(ciImage: ci, options: [:])
    let textReq = VNRecognizeTextRequest()
    textReq.recognitionLevel = .accurate
    let classify = VNClassifyImageRequest()
    let started = Date()
    try handler.perform([textReq, classify])
    let detected = (textReq.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: " ")
    let labels = (classify.results ?? [])
        .filter { $0.confidence > 0.25 }
        .prefix(5)
        .map { "\($0.identifier)(\(Int($0.confidence * 100))%)" }
        .joined(separator: ", ")
    let ms = Int(Date().timeIntervalSince(started) * 1000)
    let report = [
        "input: \(path)",
        "elapsed: \(ms)ms",
        "ocr: \(detected.isEmpty ? "<empty>" : detected)",
        "labels: \(labels.isEmpty ? "<none>" : labels)",
    ].joined(separator: "\n")
    NSLog("[omni-verify/vision] OK\n\(report)")
    let outURL = outRoot.appendingPathComponent("mlx-verify-omni-vision-\(stamp).txt")
    try report.write(to: outURL, atomically: true, encoding: .utf8)
}

func makeTextImageData(text: String) -> Data? {
    let size = CGSize(width: 600, height: 200)
    let bytesPerRow = Int(size.width) * 4
    let space = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: Int(size.width), height: Int(size.height),
        bitsPerComponent: 8, bytesPerRow: bytesPerRow,
        space: space,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue).rawValue
    ) else { return nil }
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.fill(CGRect(origin: .zero, size: size))
    ctx.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
    // Use CoreText to draw the string.
    let attrs: [NSAttributedString.Key: Any] = [
        kCTFontAttributeName as NSAttributedString.Key: CTFontCreateWithName("Helvetica" as CFString, 24, nil),
        kCTForegroundColorAttributeName as NSAttributedString.Key: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    ctx.textPosition = CGPoint(x: 20, y: size.height / 2 - 12)
    CTLineDraw(line, ctx)
    guard let cg = ctx.makeImage() else { return nil }
    let mutData = CFDataCreateMutable(nil, 0)!
    guard let dest = CGImageDestinationCreateWithData(mutData, "public.png" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, cg, nil)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return mutData as Data
}

// MARK: - STT

func runStt(path: String) async throws {
    if path.isEmpty {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "stt requires a path to a wav/aiff/m4a file"])
    }
    NSLog("[omni-verify/stt] checking permission…")
    let auth = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
        SFSpeechRecognizer.requestAuthorization { status in cont.resume(returning: status) }
    }
    guard auth == .authorized else {
        throw NSError(domain: "verify", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Speech recognition not authorized (\(auth.rawValue)). Grant in System Settings → Privacy & Security → Speech Recognition."
        ])
    }
    let url = URL(fileURLWithPath: path)
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
        throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "recognizer unavailable"])
    }
    let req = SFSpeechURLRecognitionRequest(url: url)
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    req.shouldReportPartialResults = false
    let started = Date()
    struct Done: Sendable { let text: String; let segs: Int }
    let result: Done = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Done, Error>) in
        recognizer.recognitionTask(with: req) { res, err in
            if let err { cont.resume(throwing: err); return }
            if let res, res.isFinal {
                cont.resume(returning: Done(text: res.bestTranscription.formattedString, segs: res.bestTranscription.segments.count))
            }
        }
    }
    let ms = Int(Date().timeIntervalSince(started) * 1000)
    NSLog("[omni-verify/stt] OK \(result.segs) segments in \(ms)ms")
    let report = "input: \(path)\nelapsed: \(ms)ms\ntext: \(result.text)"
    let outURL = outRoot.appendingPathComponent("mlx-verify-omni-stt-\(stamp).txt")
    try report.write(to: outURL, atomically: true, encoding: .utf8)
}

let args = CommandLine.arguments.dropFirst()
guard let kind = args.first else {
    print("Usage: MLXOmniVerify <tts|vision|stt> <input>")
    exit(2)
}
let inputArg = args.dropFirst().first ?? ""
let outRoot = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".detour", isDirectory: true)
try? FileManager.default.createDirectory(at: outRoot, withIntermediateDirectories: true)
let stamp = Int(Date().timeIntervalSince1970)

Task {
    do {
        switch kind {
        case "tts": try await runTts(text: inputArg.isEmpty ? "Hello from Detour's local TTS path." : inputArg)
        case "vision": try await runVision(path: inputArg)
        case "stt": try await runStt(path: inputArg)
        default:
            print("unknown kind: \(kind)")
            exit(2)
        }
        exit(0)
    } catch {
        NSLog("[omni-verify] FAIL: \(error.localizedDescription)")
        exit(1)
    }
}
dispatchMain()
