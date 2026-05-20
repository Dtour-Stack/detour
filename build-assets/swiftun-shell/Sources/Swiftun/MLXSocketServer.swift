/*
 * MLXSocketServer — Unix domain socket that lets Bun dial INTO Swift
 * for GPU/MLX work. Mirror image of ~/.detour/rpc.sock (where Swift
 * dials Bun for UI/runtime calls). Two sockets, two directions —
 * isolation > elegance for compute paths that may hang.
 *
 * Wire format: newline-delimited JSON-RPC 2.0, identical to rpc-socket.ts.
 * Path: ~/.detour/mlx.sock
 *
 * Methods served:
 *
 *   mlx.image.presets
 *     → { presets: [{ id, label, modelID, ramGB, diskGB, defaultSteps,
 *                     downloaded, licenseNote? }] }
 *
 *   mlx.image.generate({ presetId, prompt, negativePrompt?, width?,
 *                        height?, steps?, cfg?, seed? })
 *     → { base64, contentType: "image/png", width, height, durationMs,
 *         model }
 *
 *   mlx.image.unload
 *     → { ok: true } -- frees cached generators
 *
 *   mlx.health
 *     → { ok: true, availability: "available" | "unsupportedHardware" }
 *
 * Notifications pushed (server → client, no id):
 *
 *   event.mlx.image.progress  { presetId, step, totalSteps }
 *   event.mlx.download.progress  { presetId, fraction }
 *
 * On the Bun side, src/bun/core/mlx-rpc-client.ts dials this socket
 * and exposes a typed call() wrapper that the local-mlx-image plugin
 * uses to register ModelType.IMAGE with the eliza runtime.
 */

import Darwin
import Foundation

final class MLXSocketServer: @unchecked Sendable {
    static let shared = MLXSocketServer()
    /// Protects the connections dict + listening flag + listenFD.
    /// All socket lifecycle mutations are serialised through this lock.
    /// The service-call dispatchers (which can be slow) run async on
    /// MainActor since the underlying MLXImage/MLXSpeech/MLXVision
    /// services are MainActor-isolated.
    private let stateLock = NSLock()

    /// Resolves ~/.detour/mlx.sock.
    private let socketPath: String = {
        let home = NSString(string: "~").expandingTildeInPath
        let dir = "\(home)/.detour"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return "\(dir)/mlx.sock"
    }()

    private var listenFD: Int32 = -1
    private var listening: Bool = false
    /// Dedicated to the blocking accept() loop only — never used for
    /// dispatch sources or per-connection reads, because accept() pins
    /// this queue and would starve every other source assigned to it.
    private var acceptQueue: DispatchQueue = DispatchQueue(label: "ai.detour.mlx.accept", qos: .userInitiated)
    /// Concurrent queue for the per-connection read dispatch sources.
    /// Separate from acceptQueue so reads don't get starved by the
    /// blocking accept() loop.
    private var ioQueue: DispatchQueue = DispatchQueue(label: "ai.detour.mlx.io", qos: .userInitiated, attributes: .concurrent)
    private var connections: [Int32: ConnectionState] = [:]

    /// Per-connection state. The dispatch source drives reads; buffer
    /// holds partial lines.
    private final class ConnectionState: @unchecked Sendable {
        let fd: Int32
        let readSource: DispatchSourceRead
        var buffer: Data = Data()
        init(fd: Int32, readSource: DispatchSourceRead) {
            self.fd = fd
            self.readSource = readSource
        }
    }

    func start() {
        stateLock.lock()
        if listening { stateLock.unlock(); return }
        stateLock.unlock()
        // Clean up a stale socket file.
        unlink(socketPath)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 {
            NSLog("[mlx-socket] socket() failed: \(String(cString: strerror(errno)))")
            return
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        if pathBytes.count > MemoryLayout.size(ofValue: addr.sun_path) {
            NSLog("[mlx-socket] path too long: \(socketPath)")
            close(fd)
            return
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { rawBuf in
            pathBytes.withUnsafeBytes { srcBuf in
                rawBuf.copyMemory(from: srcBuf)
            }
        }

        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, addrLen)
            }
        }
        if bindResult < 0 {
            NSLog("[mlx-socket] bind() failed: \(String(cString: strerror(errno)))")
            close(fd)
            return
        }
        if listen(fd, 8) < 0 {
            NSLog("[mlx-socket] listen() failed: \(String(cString: strerror(errno)))")
            close(fd)
            return
        }
        stateLock.lock()
        self.listenFD = fd
        self.listening = true
        stateLock.unlock()
        NSLog("[mlx-socket] listening on \(socketPath)")
        acceptLoop()
    }

    func stop() {
        stateLock.lock()
        listening = false
        let conns = connections
        connections.removeAll()
        let fd = listenFD
        listenFD = -1
        stateLock.unlock()
        for (_, state) in conns {
            state.readSource.cancel()
            close(state.fd)
        }
        if fd >= 0 { close(fd) }
        unlink(socketPath)
    }

    private func acceptLoop() {
        let fd = listenFD
        acceptQueue.async { [weak self] in
            guard let self else { return }
            while self.isListening() {
                let client = accept(fd, nil, nil)
                if client < 0 {
                    if errno == EINTR { continue }
                    NSLog("[mlx-socket] accept() failed: \(String(cString: strerror(errno)))")
                    break
                }
                self.openConnection(fd: client)
            }
        }
    }

    private func isListening() -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return listening
    }

    private func openConnection(fd: Int32) {
        // ioQueue is concurrent so multiple connections don't starve.
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: ioQueue)
        let state = ConnectionState(fd: fd, readSource: source)
        stateLock.lock(); connections[fd] = state; stateLock.unlock()
        source.setEventHandler { [weak self] in
            self?.drainConnection(fd: fd)
        }
        source.setCancelHandler {
            close(fd)
        }
        source.resume()
        NSLog("[mlx-socket] client connected fd=\(fd)")
    }

    private func drainConnection(fd: Int32) {
        stateLock.lock()
        let state = connections[fd]
        stateLock.unlock()
        guard let state else { return }
        var buf = [UInt8](repeating: 0, count: 65536)
        let n = read(fd, &buf, buf.count)
        NSLog("[mlx-socket] drainConnection fd=\(fd) read=\(n) buf=\(state.buffer.count)")
        if n <= 0 {
            state.readSource.cancel()
            stateLock.lock(); connections.removeValue(forKey: fd); stateLock.unlock()
            NSLog("[mlx-socket] client disconnected fd=\(fd) (n=\(n))")
            return
        }
        state.buffer.append(Data(buf[0..<n]))
        var dispatched = 0
        while let nlIdx = state.buffer.firstIndex(of: 0x0a) {
            let lineRange = state.buffer.startIndex..<nlIdx
            let lineData = state.buffer.subdata(in: lineRange)
            state.buffer.removeSubrange(state.buffer.startIndex...nlIdx)
            dispatched += 1
            Task {
                await self.handleRequest(fd: fd, lineData: lineData)
            }
        }
        if dispatched > 0 {
            NSLog("[mlx-socket] drainConnection fd=\(fd) dispatched \(dispatched) frames, residual=\(state.buffer.count)")
        }
    }

    /// Loop-write so partial-write doesn't drop the tail of large
    /// responses (a 379KB base64 audio frame exceeds the default 64KB
    /// Unix socket buffer). On EAGAIN we sleep briefly + retry.
    private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        var remaining = data
        var attempts = 0
        while !remaining.isEmpty {
            let n = remaining.withUnsafeBytes { rawBuf -> Int in
                Darwin.write(fd, rawBuf.baseAddress, rawBuf.count)
            }
            if n > 0 {
                remaining = remaining.subdata(in: n..<remaining.count)
                attempts = 0
                continue
            }
            let e = errno
            if e == EAGAIN || e == EWOULDBLOCK {
                attempts += 1
                if attempts > 100 { return false }
                usleep(5000)
                continue
            }
            if e == EINTR { continue }
            NSLog("[mlx-socket] write err fd=\(fd) errno=\(e)")
            return false
        }
        return true
    }

    private func writeFrame(_ fd: Int32, _ json: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: json) else { return }
        data.append(0x0a)
        _ = writeAll(fd, data)
    }

    private func handleRequest(fd: Int32, lineData: Data) async {
        guard let parsed = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
            writeFrame(fd, [
                "jsonrpc": "2.0",
                "id": NSNull(),
                "error": ["code": -32700, "message": "parse error"],
            ])
            return
        }
        let id = parsed["id"]
        let method = (parsed["method"] as? String) ?? ""
        let params = (parsed["params"] as? [String: Any]) ?? [:]
        NSLog("[mlx-socket] handleRequest fd=\(fd) method=\(method) id=\(String(describing: id))")
        do {
            let result = try await dispatch(method: method, params: params, fd: fd)
            NSLog("[mlx-socket] handleRequest fd=\(fd) method=\(method) ok, writing response")
            if let id = id, !(id is NSNull) {
                writeFrame(fd, [
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": result,
                ])
            }
        } catch {
            NSLog("[mlx-socket] handleRequest fd=\(fd) method=\(method) ERROR: \(error.localizedDescription)")
            if let id = id, !(id is NSNull) {
                writeFrame(fd, [
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": ["code": -32603, "message": error.localizedDescription],
                ])
            }
        }
    }

    /// Push a notification to every connected client. Used for download
    /// progress + denoiser step events.
    func broadcast(method: String, params: [String: Any]) {
        let frame: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        ]
        stateLock.lock()
        let fds = Array(connections.keys)
        stateLock.unlock()
        for fd in fds { writeFrame(fd, frame) }
    }

    // MARK: - Methods

    private func dispatch(method: String, params: [String: Any], fd: Int32) async throws -> Any {
        switch method {
        case "mlx.health":
            let avail: String
            switch await MLXImageService.shared.availability {
            case .available: avail = "available"
            case .unsupportedHardware: avail = "unsupportedHardware"
            }
            let snap = await MLXMemoryArbiter.shared.snapshot()
            return [
                "ok": true,
                "availability": avail,
                "memory": snap.toDict(),
            ]

        case "mlx.image.presets":
            // Snapshot the MainActor-isolated state once, then build the array.
            let headroom = await MLXMemoryArbiter.shared.headroomGB
            var downloadedMap: [String: Bool] = [:]
            for p in MLXImageService.presets {
                downloadedMap[p.id] = await MLXImageService.shared.isDownloaded(presetId: p.id)
            }
            let presets = MLXImageService.presets.map { p -> [String: Any] in
                var dict: [String: Any] = [
                    "id": p.id,
                    "label": p.label,
                    "modelID": p.modelID,
                    "ramGB": p.approxLiveRamGB,
                    "diskGB": p.approxDiskGB,
                    "defaultSteps": p.defaultSteps,
                    "downloaded": downloadedMap[p.id] ?? false,
                    "available": p.sdPreset != nil,
                    "fitsBudget": headroom >= p.approxLiveRamGB,
                ]
                if let note = p.licenseNote { dict["licenseNote"] = note }
                return dict
            }
            return ["presets": presets]

        case "mlx.image.unload":
            await MLXImageService.shared.unloadAll()
            return ["ok": true]

        case "mlx.image.generate":
            return try await runImageGenerate(params: params)

        case "mlx.video.presets":
            // Local video removed — always empty so the UI doesn't try
            // to render a section.
            return ["presets": [] as [Any]]

        case "mlx.stt.presets":
            return ["presets": MLXTranscriptionService.presets.map { p in
                [
                    "id": p.id,
                    "label": p.label,
                    "modelID": p.modelID ?? "",
                    "ramGB": p.approxLiveRamGB,
                    "diskGB": p.approxDiskGB,
                    "supportsStreaming": p.supportsStreaming,
                    "downloaded": p.vendored && (p.modelID == nil),
                    "available": p.vendored,
                    "fitsBudget": true,
                ]
            }]

        case "mlx.stt.transcribe":
            return try await runSttTranscribe(params: params)

        case "mlx.tts.presets":
            return ["presets": MLXSpeechService.presets.map { p in
                [
                    "id": p.id,
                    "label": p.label,
                    "modelID": p.modelID ?? "",
                    "ramGB": p.approxLiveRamGB,
                    "diskGB": p.approxDiskGB,
                    "downloaded": p.vendored && (p.modelID == nil),
                    "available": p.vendored,
                    "fitsBudget": true,
                ]
            }]

        case "mlx.tts.voices":
            let voices = await MLXSpeechService.shared.availableSystemVoices()
            return ["voices": voices.map { v in
                [
                    "id": v.id,
                    "name": v.name,
                    "lang": v.lang,
                    "quality": v.quality,
                ]
            }]

        case "mlx.tts.synthesize":
            return try await runTtsSynthesize(params: params)

        case "mlx.vision.presets":
            return ["presets": MLXVisionService.presets.map { p in
                [
                    "id": p.id,
                    "label": p.label,
                    "modelID": p.modelID ?? "",
                    "ramGB": p.approxLiveRamGB,
                    "diskGB": p.approxDiskGB,
                    "strengths": p.strengths,
                    "downloaded": p.vendored && (p.modelID == nil),
                    "available": p.vendored,
                    "fitsBudget": true,
                ]
            }]

        case "mlx.vision.describe":
            return try await runVisionDescribe(params: params)

        default:
            throw MLXSocketError.unknownMethod(method)
        }
    }

    private func runSttTranscribe(params: [String: Any]) async throws -> [String: Any] {
        guard let presetId = params["presetId"] as? String else { throw MLXSocketError.badParams("presetId required") }
        guard let audioBase64 = params["audioBase64"] as? String, !audioBase64.isEmpty else {
            throw MLXSocketError.badParams("audioBase64 required")
        }
        let mimeType = params["mimeType"] as? String
        let languageCode = params["languageCode"] as? String
        let options = MLXTranscriptionService.TranscribeOptions(
            presetId: presetId, audioBase64: audioBase64,
            mimeType: mimeType, languageCode: languageCode
        )
        let r = try await MLXTranscriptionService.shared.transcribe(options: options)
        return [
            "text": r.text,
            "language": r.language,
            "durationMs": r.durationMs,
            "model": r.model,
            "segments": r.segments.map { ["start": $0.start, "end": $0.end, "text": $0.text] },
        ]
    }

    private func runTtsSynthesize(params: [String: Any]) async throws -> [String: Any] {
        guard let presetId = params["presetId"] as? String else { throw MLXSocketError.badParams("presetId required") }
        guard let text = params["text"] as? String, !text.isEmpty else {
            throw MLXSocketError.badParams("text required")
        }
        let voice = params["voice"] as? String
        let rate = (params["rate"] as? Double).map { Float($0) }
        let pitch = (params["pitch"] as? Double).map { Float($0) }
        let options = MLXSpeechService.SynthesizeOptions(
            presetId: presetId, text: text, voice: voice, rate: rate, pitch: pitch
        )
        let r = try await MLXSpeechService.shared.synthesize(options: options)
        return [
            "base64": r.audioData.base64EncodedString(),
            "contentType": r.contentType,
            "durationSeconds": r.durationSeconds,
            "durationMs": r.durationMs,
            "voice": r.voice,
            "model": r.model,
        ]
    }

    private func runVisionDescribe(params: [String: Any]) async throws -> [String: Any] {
        guard let presetId = params["presetId"] as? String else { throw MLXSocketError.badParams("presetId required") }
        guard let imageBase64 = params["imageBase64"] as? String, !imageBase64.isEmpty else {
            throw MLXSocketError.badParams("imageBase64 required")
        }
        let mimeType = params["mimeType"] as? String
        let prompt = params["prompt"] as? String
        let options = MLXVisionService.DescribeOptions(
            presetId: presetId, imageBase64: imageBase64, mimeType: mimeType, prompt: prompt
        )
        let r = try await MLXVisionService.shared.describe(options: options)
        return [
            "title": r.title,
            "description": r.description,
            "detectedText": r.detectedText ?? "",
            "labels": r.labels.map { ["label": $0.label, "confidence": $0.confidence] },
            "durationMs": r.durationMs,
            "model": r.model,
        ]
    }

    // runVideoGenerate removed — local video isn't supported. Use the
    // bun-side GENERATE_VIDEO action (cloud Veo / Veo3 path).

    private func runImageGenerate(params: [String: Any]) async throws -> [String: Any] {
        guard let presetId = params["presetId"] as? String else {
            throw MLXSocketError.badParams("presetId required")
        }
        guard let prompt = params["prompt"] as? String, !prompt.isEmpty else {
            throw MLXSocketError.badParams("prompt required")
        }
        let negativePrompt = params["negativePrompt"] as? String
        let width = params["width"] as? Int
        let height = params["height"] as? Int
        let steps = params["steps"] as? Int
        let cfg = (params["cfg"] as? Double).map { Float($0) }
        let seed = (params["seed"] as? Int).map { UInt64($0) }
        let llmUsedGB = params["llmUsedGB"] as? Double
        let size: (width: Int, height: Int)? = (width != nil && height != nil)
            ? (width: width!, height: height!) : nil
        let options = MLXImageService.GenerateOptions(
            presetId: presetId,
            prompt: prompt,
            negativePrompt: negativePrompt,
            size: size,
            steps: steps,
            cfgWeight: cfg,
            seed: seed,
            llmUsedGB: llmUsedGB
        )
        let result = try await MLXImageService.shared.generate(options: options)
        return [
            "base64": result.pngData.base64EncodedString(),
            "contentType": result.contentType,
            "width": result.width,
            "height": result.height,
            "durationMs": result.durationMs,
            "model": result.model,
        ]
    }
}

enum MLXSocketError: LocalizedError {
    case unknownMethod(String)
    case badParams(String)
    var errorDescription: String? {
        switch self {
        case .unknownMethod(let m): return "Unknown MLX method: \(m)"
        case .badParams(let m): return "Bad params: \(m)"
        }
    }
}
