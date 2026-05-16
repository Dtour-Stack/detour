/*
 * ChatSurface — native SwiftUI chat. Two-pane:
 *   Left  : channels sidebar + inbox (Detour Squirrel, Discord, Telegram,
 *           iMessage, X DMs)
 *   Right : selected conversation transcript + composer with attach,
 *           image-gen, mic, speech, model picker, skills + plugins menus.
 *
 * Data flow:
 *   - eval.send RPC → AgentRuntime → chatDelta / chatComplete events
 *     stream into the right-pane transcript live.
 *   - Voice input: AVAudioEngine + SFSpeechRecognizer captures from the
 *     system mic, live-transcribes into the composer.
 *   - TTS: when speech toggle is on, every assistant chatComplete is
 *     piped through AVSpeechSynthesizer.
 *   - Image generation: composer has an "Generate image" button that
 *     calls the GENERATE_IMAGE action via the eval RPC; the resulting
 *     URL is dropped into the transcript as an inline message.
 *   - Model picker: writes DETOUR_MODEL_<TYPE>_PROVIDER via the
 *     settings.set RPC (same path the tray AI submenu uses).
 *   - Skills + plugins: popover lists every registered action / plugin
 *     with on/off toggles. Toggles write per-name override settings
 *     the agent honors at action-dispatch time.
 *
 * Liquid Glass throughout (.glassEffect). Channel icons use SF Symbols +
 * brand-tone tints; swap in real brand SVGs by dropping the file into
 * build-assets/swiftun-shell/Resources/ and using Image("discord-mark").
 */

import AppKit
import AVFoundation
import Foundation
import Speech
import SwiftUI
import UniformTypeIdentifiers

/// Resolve the eval API token. Used by every /api/eval/* call in this
/// file. Checks env var first, then ~/.detour/.env, then process env's
/// DETOUR_EVAL_TOKEN key.
fileprivate func resolveEvalToken() -> String? {
    if let env = ProcessInfo.processInfo.environment["DETOUR_EVAL_TOKEN"], !env.isEmpty {
        return env
    }
    let home = FileManager.default.homeDirectoryForCurrentUser
    let envFile = home.appendingPathComponent(".detour/.env")
    if let content = try? String(contentsOf: envFile, encoding: .utf8) {
        for line in content.split(separator: "\n") {
            if line.hasPrefix("DETOUR_EVAL_TOKEN=") {
                let v = String(line.dropFirst("DETOUR_EVAL_TOKEN=".count))
                let trimmed = v.trimmingCharacters(in: CharacterSet(charactersIn: "\"' \r\t"))
                if !trimmed.isEmpty { return trimmed }
            }
        }
    }
    // Also check the repo .env (dev mode)
    let repoEnv = home.appendingPathComponent("detour/.env")
    if let content = try? String(contentsOf: repoEnv, encoding: .utf8) {
        for line in content.split(separator: "\n") {
            if line.hasPrefix("DETOUR_EVAL_TOKEN=") {
                let v = String(line.dropFirst("DETOUR_EVAL_TOKEN=".count))
                let trimmed = v.trimmingCharacters(in: CharacterSet(charactersIn: "\"' \r\t"))
                if !trimmed.isEmpty { return trimmed }
            }
        }
    }
    return nil
}

// MARK: - Model types

enum ChatRole: String { case user, assistant, system }

struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let role: ChatRole
    var text: String
    var inFlight: Bool = false
    /// Attached file URL (local), if user attached one with this turn.
    var attachmentURL: URL? = nil
    /// Generated image URL, if this message was the result of GENERATE_IMAGE.
    var generatedImageURL: URL? = nil
}

/// The "channel" the user is conversing through. For the in-app
/// Detour Squirrel chat this is .detour (uses eval.send). The external
/// channels (Discord etc.) show their feed from the channel gateway
/// when wired up — for now they show a coming-soon empty state +
/// route the user to the Pensieve channel feed for the source data.
enum ChatChannel: String, CaseIterable, Identifiable, Hashable {
    case inbox      = "inbox"
    case detour     = "detour"
    case discord    = "discord"
    case telegram   = "telegram"
    case imessage   = "imessage"
    case x          = "x"

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .inbox: return "Inbox"
        case .detour: return "Detour Squirrel"
        case .discord: return "Discord"
        case .telegram: return "Telegram"
        case .imessage: return "iMessage"
        case .x: return "X"
        }
    }
    /// SF Symbol used for the channel icon. Swap to a bundled brand SVG
    /// by replacing the case's return value with Image("discord-mark")
    /// in ChannelIcon below.
    var systemImage: String {
        switch self {
        case .inbox: return "tray.full.fill"
        case .detour: return "puzzlepiece.fill"
        case .discord: return "bubble.left.and.bubble.right.fill"
        case .telegram: return "paperplane.fill"
        case .imessage: return "message.fill"
        case .x: return "xmark.app.fill"
        }
    }
    /// Brand tint. These are approximations — real brand SVGs would
    /// carry their own colors.
    var tint: Color {
        switch self {
        case .inbox: return .accentColor
        case .detour: return .orange
        case .discord: return Color(red: 0.345, green: 0.396, blue: 0.949)  // Blurple
        case .telegram: return Color(red: 0.149, green: 0.561, blue: 0.831) // TG blue
        case .imessage: return .green
        case .x: return .primary
        }
    }
}

// MARK: - View model

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var composer: String = ""
    @Published var sending: Bool = false
    @Published var error: String? = nil
    @Published var selectedChannel: ChatChannel = .detour
    @Published var attachmentURL: URL? = nil
    @Published var speechEnabled: Bool = false
    @Published var listening: Bool = false

    private var sseTask: URLSessionDataTask?
    private var sseSession: URLSession?
    private var streamBuffer = ""

    /// Live transcription via AVAudioEngine + SFSpeechRecognizer.
    /// The actual engine lives in MicDictation (non-isolated) so the
    /// recognizer/TCC callbacks — which fire from private dispatch
    /// queues — don't trip Swift 6's strict-concurrency runtime check.
    /// MicDictation pushes transcripts back through NotificationCenter
    /// (which predates Swift concurrency and never trips the check).
    private var mic = MicDictation()
    private var micTokens: [NSObjectProtocol] = []

    /// AVSpeech for TTS playback of assistant replies.
    private let synthesizer = AVSpeechSynthesizer()

    init() {
        startStream()
        let nc = NotificationCenter.default
        micTokens.append(nc.addObserver(forName: .micDictationTranscript, object: nil, queue: .main) { [weak self] note in
            guard let text = note.userInfo?["text"] as? String else { return }
            MainActor.assumeIsolated { self?.composer = text }
        })
        micTokens.append(nc.addObserver(forName: .micDictationEnded, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.listening = false }
        })
        micTokens.append(nc.addObserver(forName: .micDictationError, object: nil, queue: .main) { [weak self] note in
            let msg = (note.userInfo?["message"] as? String) ?? "Mic error"
            MainActor.assumeIsolated {
                self?.error = msg
                self?.listening = false
            }
        })
    }

    deinit {
        sseTask?.cancel()
        // micTokens cleanup is intentionally skipped in deinit — Swift 6
        // forbids touching the non-Sendable token array from a nonisolated
        // deinit. NotificationCenter holds weak observer refs anyway;
        // when self deallocs the observers become inert.
    }

    // MARK: - Send turn

    func send() {
        let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        composer = ""
        let attached = attachmentURL
        attachmentURL = nil
        messages.append(ChatMessage(role: .user, text: text, attachmentURL: attached))
        let placeholder = ChatMessage(role: .assistant, text: "", inFlight: true)
        messages.append(placeholder)
        sending = true
        error = nil

        guard let token = resolveEvalToken() else {
            self.error = "DETOUR_EVAL_TOKEN not set — set one in ~/.detour/.env"
            self.sending = false
            self.markLastFailed()
            return
        }

        Task { [weak self] in
            guard let self else { return }
            do {
                let reply = try await self.postSend(text: text, token: token)
                await MainActor.run {
                    if let idx = self.messages.lastIndex(where: { $0.role == .assistant && $0.inFlight }) {
                        if self.messages[idx].text.isEmpty {
                            self.messages[idx].text = reply
                        }
                        self.messages[idx].inFlight = false
                    }
                    self.sending = false
                    // Auto-speak the final reply if the user has speech toggled on.
                    if self.speechEnabled, let last = self.messages.last(where: { $0.role == .assistant && !$0.inFlight }) {
                        self.speak(last.text)
                    }
                }
            } catch {
                await MainActor.run {
                    self.error = "Send failed: \(error.localizedDescription)"
                    self.markLastFailed()
                }
            }
        }
    }

    private func markLastFailed() {
        if let idx = self.messages.lastIndex(where: { $0.role == .assistant && $0.inFlight }) {
            self.messages[idx].text = "(failed)"
            self.messages[idx].inFlight = false
        }
        self.sending = false
    }

    private func postSend(text: String, token: String) async throws -> String {
        let url = URL(string: "http://127.0.0.1:2138/api/eval/send")!
        var req = URLRequest(url: url, timeoutInterval: 120)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-Detour-Eval-Token")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["text": text, "wait": true])
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "ChatSurface", code: 1)
        }
        return (json["reply"] as? String) ?? ""
    }

    // MARK: - SSE stream → chatDelta / chatComplete

    private func startStream() {
        guard let token = resolveEvalToken() else { return }
        let url = URL(string: "http://127.0.0.1:2138/api/eval/events?names=chatDelta,chatComplete")!
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "X-Detour-Eval-Token")
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = TimeInterval.greatestFiniteMagnitude
        let delegate = SSEDelegate { [weak self] line in
            Task { @MainActor in self?.handleSSE(line: line) }
        }
        let session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
        sseSession = session
        sseTask = session.dataTask(with: req)
        sseTask?.resume()
    }

    private func handleSSE(line: String) {
        streamBuffer += line
        while let nl = streamBuffer.firstIndex(of: "\n") {
            let chunk = String(streamBuffer[..<nl])
            streamBuffer.removeSubrange(streamBuffer.startIndex...nl)
            if chunk.hasPrefix("event:") {
                continue
            }
            if chunk.hasPrefix("data: ") {
                let raw = String(chunk.dropFirst(6))
                guard let data = raw.data(using: .utf8),
                      let env = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let name = env["name"] as? String,
                      let payload = env["payload"] as? [String: Any]
                else { continue }
                switch name {
                case "chatDelta":
                    if let delta = payload["delta"] as? String, !delta.isEmpty {
                        if let idx = messages.lastIndex(where: { $0.role == .assistant && $0.inFlight }) {
                            messages[idx].text += delta
                        }
                    }
                case "chatComplete":
                    if let text = payload["text"] as? String,
                       let idx = messages.lastIndex(where: { $0.role == .assistant && $0.inFlight }) {
                        if messages[idx].text.isEmpty { messages[idx].text = text }
                        messages[idx].inFlight = false
                        if speechEnabled { speak(messages[idx].text) }
                    }
                    sending = false
                default: break
                }
            }
        }
    }

    // MARK: - Attachments

    func pickAttachment() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            attachmentURL = url
        }
    }

    // MARK: - Generate image

    func generateImageFromComposer() {
        let prompt = composer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else {
            error = "Type a prompt first, then click Generate."
            return
        }
        composer = ""
        messages.append(ChatMessage(role: .user, text: prompt))
        let placeholder = ChatMessage(role: .assistant, text: "Generating image…", inFlight: true)
        messages.append(placeholder)
        sending = true
        Task { [weak self] in
            guard let self else { return }
            do {
                let url = try await self.runImageAction(prompt: prompt)
                await MainActor.run {
                    if let idx = self.messages.lastIndex(where: { $0.role == .assistant && $0.inFlight }) {
                        self.messages[idx].text = "Generated image"
                        self.messages[idx].generatedImageURL = url
                        self.messages[idx].inFlight = false
                    }
                    self.sending = false
                }
            } catch {
                await MainActor.run {
                    self.error = "Image gen failed: \(error.localizedDescription)"
                    self.markLastFailed()
                }
            }
        }
    }

    private func runImageAction(prompt: String) async throws -> URL? {
        guard let token = resolveEvalToken() else {
            throw NSError(domain: "ChatSurface", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "DETOUR_EVAL_TOKEN missing"])
        }
        let url = URL(string: "http://127.0.0.1:2138/api/eval/action/run")!
        var req = URLRequest(url: url, timeoutInterval: 300)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-Detour-Eval-Token")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "name": "GENERATE_IMAGE",
            "options": ["prompt": prompt],
        ])
        let (data, _) = try await URLSession.shared.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let result = (json?["result"] as? [String: Any]) ?? [:]
        if let images = result["images"] as? [[String: Any]], let first = images.first,
           let path = (first["path"] as? String) ?? (first["url"] as? String) {
            return URL(fileURLWithPath: path.replacingOccurrences(of: "file://", with: ""))
        }
        if let urlStr = result["imageUrl"] as? String {
            return URL(string: urlStr)
        }
        return nil
    }

    // MARK: - Mic dictation
    //
    // The actual recognizer lives in MicDictation (below) which is
    // non-isolated. SwiftUI side calls mic.start() / mic.stop() and
    // listens for NotificationCenter events to update its @Published
    // composer. We never touch @MainActor state from inside the
    // SFSpeechRecognizer/TCC callbacks, so Swift 6's strict-concurrency
    // executor check (swift_task_checkIsolatedSwift) never fires.

    func toggleListening() {
        if listening {
            mic.stop()
            listening = false
        } else {
            listening = true
            mic.start()
        }
    }

    // MARK: - TTS

    private func speak(_ text: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        let utt = AVSpeechUtterance(string: cleaned)
        utt.voice = AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utt)
    }
}

// MARK: - MicDictation (non-isolated, NotificationCenter bridge)

extension Notification.Name {
    static let micDictationTranscript = Notification.Name("ai.detour.mic.transcript")
    static let micDictationEnded = Notification.Name("ai.detour.mic.ended")
    static let micDictationError = Notification.Name("ai.detour.mic.error")
}

/// Owns AVAudioEngine + SFSpeechRecognizer. Deliberately NOT @MainActor:
/// the TCC + recognizer callbacks fire from private dispatch queues and
/// Swift 6's strict concurrency runtime traps when an @MainActor type's
/// methods are touched from those callbacks. We bridge back to the UI
/// via NotificationCenter, which predates Swift concurrency and is not
/// subject to the executor check.
final class MicDictation: @unchecked Sendable {
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let stateLock = NSLock()

    func start() {
        let status = SFSpeechRecognizer.authorizationStatus()
        switch status {
        case .authorized:
            startEngine()
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                let raw = status.rawValue
                // We're on tccd's queue here. Don't touch any @MainActor
                // state. Just decide what to do next from the rawValue.
                guard raw == SFSpeechRecognizerAuthorizationStatus.authorized.rawValue else {
                    NotificationCenter.default.post(
                        name: .micDictationError,
                        object: nil,
                        userInfo: ["message": "Speech recognition not authorized."]
                    )
                    NotificationCenter.default.post(name: .micDictationEnded, object: nil)
                    return
                }
                self?.startEngine()
            }
        case .denied, .restricted:
            NotificationCenter.default.post(
                name: .micDictationError,
                object: nil,
                userInfo: ["message": "Speech recognition is disabled. Enable it in System Settings → Privacy → Speech Recognition."]
            )
            NotificationCenter.default.post(name: .micDictationEnded, object: nil)
        @unknown default:
            NotificationCenter.default.post(name: .micDictationEnded, object: nil)
        }
    }

    private func startEngine() {
        stateLock.lock()
        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else {
            stateLock.unlock()
            NotificationCenter.default.post(name: .micDictationError, object: nil,
                                            userInfo: ["message": "Speech recognizer unavailable."])
            NotificationCenter.default.post(name: .micDictationEnded, object: nil)
            return
        }
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            stateLock.unlock()
            NotificationCenter.default.post(name: .micDictationError, object: nil,
                                            userInfo: ["message": "Audio engine: \(error.localizedDescription)"])
            NotificationCenter.default.post(name: .micDictationEnded, object: nil)
            return
        }
        // Recognition callback fires on a private speech-recognition
        // queue. Extract primitives + post NotificationCenter.
        let task = recognizer.recognitionTask(with: request) { result, err in
            let transcript: String = result?.bestTranscription.formattedString ?? ""
            let isFinal: Bool = result?.isFinal ?? false
            let hasError: Bool = err != nil
            let errorMessage: String = err?.localizedDescription ?? ""
            if !transcript.isEmpty {
                NotificationCenter.default.post(
                    name: .micDictationTranscript,
                    object: nil,
                    userInfo: ["text": transcript]
                )
            }
            if hasError {
                NotificationCenter.default.post(
                    name: .micDictationError,
                    object: nil,
                    userInfo: ["message": errorMessage]
                )
            }
            if hasError || isFinal {
                NotificationCenter.default.post(name: .micDictationEnded, object: nil)
            }
        }
        audioEngine = engine
        recognitionRequest = request
        recognitionTask = task
        stateLock.unlock()
    }

    func stop() {
        stateLock.lock()
        let engine = audioEngine
        let req = recognitionRequest
        let task = recognitionTask
        audioEngine = nil
        recognitionRequest = nil
        recognitionTask = nil
        stateLock.unlock()
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        req?.endAudio()
        task?.cancel()
        NotificationCenter.default.post(name: .micDictationEnded, object: nil)
    }
}

// SSE delegate — split data into newline-delimited chunks.
private final class SSEDelegate: NSObject, URLSessionDataDelegate {
    let onLine: (String) -> Void
    init(onLine: @escaping (String) -> Void) { self.onLine = onLine }
    func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if let s = String(data: data, encoding: .utf8) { onLine(s) }
    }
}

// MARK: - Root view

struct ChatRootView: View {
    @StateObject private var vm = ChatViewModel()
    @State private var sidebarVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $sidebarVisibility) {
            ChatSidebar(selected: $vm.selectedChannel)
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 280)
        } detail: {
            VStack(spacing: 0) {
                ChatHeaderBar(channel: vm.selectedChannel, speechOn: vm.speechEnabled)
                Divider()
                ChatTranscript(vm: vm)
                Divider()
                ChatComposer(vm: vm)
            }
            .frame(minWidth: 600)
        }
        .frame(minWidth: 900, idealWidth: 1100, minHeight: 600, idealHeight: 760)
    }
}

// MARK: - Sidebar

private struct ChatSidebar: View {
    @Binding var selected: ChatChannel
    var body: some View {
        List(selection: $selected) {
            Section {
                ChannelRow(channel: .inbox).tag(ChatChannel.inbox)
            } header: { Text("") }
            Section("Channels") {
                ChannelRow(channel: .detour).tag(ChatChannel.detour)
                ChannelRow(channel: .discord).tag(ChatChannel.discord)
                ChannelRow(channel: .telegram).tag(ChatChannel.telegram)
                ChannelRow(channel: .imessage).tag(ChatChannel.imessage)
                ChannelRow(channel: .x).tag(ChatChannel.x)
            }
        }
        .listStyle(.sidebar)
    }
}

private struct ChannelRow: View {
    let channel: ChatChannel
    var body: some View {
        Label {
            Text(channel.displayName)
        } icon: {
            Image(systemName: channel.systemImage).foregroundStyle(channel.tint)
        }
    }
}

// MARK: - Header

private struct ChatHeaderBar: View {
    let channel: ChatChannel
    let speechOn: Bool
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: channel.systemImage)
                .foregroundStyle(channel.tint)
                .font(.system(size: 18, weight: .semibold))
            Text(channel.displayName).font(.headline)
            Spacer()
            if speechOn {
                Label("Speech on", systemImage: "speaker.wave.3.fill")
                    .font(.caption2).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .glassEffect(.regular, in: .capsule)
            }
            Text("native chat")
                .font(.caption2).foregroundStyle(.tertiary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .glassEffect(.regular, in: .capsule)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }
}

// MARK: - Transcript

private struct ChatTranscript: View {
    @ObservedObject var vm: ChatViewModel
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if vm.selectedChannel != .detour && vm.selectedChannel != .inbox {
                        ExternalChannelEmpty(channel: vm.selectedChannel)
                            .padding(40)
                    } else if vm.messages.isEmpty {
                        EmptyStateView(
                            title: vm.selectedChannel == .inbox ? "Inbox is empty" : "Say something to the agent",
                            subtitle: vm.selectedChannel == .inbox
                                ? "Inbox unifies notifications from Discord, Telegram, iMessage, X and the worker pool. Switch to Detour Squirrel to chat directly."
                                : "Replies stream live. Close this window and you'll get a notification when the agent finishes.",
                            systemImage: vm.selectedChannel == .inbox ? "tray" : "ellipsis.bubble",
                        )
                        .padding(40)
                    }
                    if let err = vm.error {
                        ChatErrorBubble(message: err)
                            .padding(.horizontal, 14)
                    }
                    if vm.selectedChannel == .detour {
                        ForEach(vm.messages) { msg in
                            ChatBubble(message: msg)
                                .padding(.horizontal, 14)
                                .id(msg.id)
                        }
                    }
                }
                .padding(.vertical, 14)
            }
            .onChange(of: vm.messages.count) { _ in
                if vm.selectedChannel == .detour, let last = vm.messages.last {
                    withAnimation(.easeOut(duration: 0.18)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }
}

/// Renders either the Connect panel (when no credentials yet) or the
/// live channel feed (when connected). Probes vault.has once on appear
/// to decide. Uses onAppear (not .task) because .task on a conditional
/// Group gets cancelled when the parent re-renders between states.
private struct ExternalChannelEmpty: View {
    let channel: ChatChannel
    @State private var connected: Bool? = nil
    @State private var probeTask: Task<Void, Never>? = nil

    private var envKeysForChannel: [String] {
        switch channel {
        case .discord: return ["DISCORD_API_TOKEN"]
        case .telegram: return ["TELEGRAM_BOT_TOKEN"]
        case .imessage: return []  // Apple permission-based — no env keys
        case .x: return ["X_AUTH_TOKEN", "X_CT0"]
        default: return []
        }
    }

    var body: some View {
        Group {
            if let connected = connected {
                if connected || channel == .imessage {
                    ChannelFeedView(channel: channel)
                } else {
                    switch channel {
                    case .x: XConnectPanel()
                    case .discord: DiscordConnectPanel()
                    case .telegram: TelegramConnectPanel()
                    case .imessage: IMessageConnectPanel()
                    default: GenericChannelEmpty(channel: channel)
                    }
                }
            } else {
                VStack(spacing: 8) {
                    ProgressView().controlSize(.regular)
                    Text("Checking \(channel.displayName) connection…")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            probeTask?.cancel()
            probeTask = Task { await checkConnection() }
        }
        .onDisappear { probeTask?.cancel(); probeTask = nil }
    }

    private func checkConnection() async {
        let keys = envKeysForChannel
        guard !keys.isEmpty else {
            await MainActor.run { connected = true }   // iMessage: no keys
            return
        }
        do {
            struct Resp: Decodable { let has: [String: Bool] }
            let resp = try await RPCClient.shared.callTyped(
                "vault.has",
                params: ["keys": keys],
                as: Resp.self,
            )
            let allPresent = keys.allSatisfy { resp.has[$0] ?? false }
            await MainActor.run { connected = allPresent }
        } catch {
            await MainActor.run { connected = false }
        }
    }
}

private struct GenericChannelEmpty: View {
    let channel: ChatChannel
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: channel.systemImage)
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(channel.tint)
            Text(channel.displayName).font(.title3).bold()
            Text("Incoming \(channel.displayName) messages route through the agent's Inbox. Configure the \(channel.displayName) plugin in Settings → Providers; recent threads will then show up here.")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
            Button("Open Settings → Providers") {
                WindowFactory.shared.openSettings(tab: "configuration:providers")
            }.buttonStyle(.borderedProminent)
        }
    }
}

/// X (Twitter) uses cookie auth — auth_token + ct0 cookies — NOT a
/// bearer token. The user signs in to x.com in a browser, exports the
/// two cookies via Cookie-Editor (or pastes them from the browser
/// DevTools), and Detour uses the SAME unofficial GraphQL API the
/// x.com web client uses. Matches the existing plugin-x-tweets contract.
private struct XConnectPanel: View {
    @State private var authToken: String = ""
    @State private var ct0: String = ""
    @State private var saving: Bool = false
    @State private var status: String? = nil
    @State private var hasExisting: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: ChatChannel.x.systemImage)
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(ChatChannel.x.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect X").font(.title3).bold()
                    Text("Sign in via cookies (same flow as the X plugin)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if hasExisting {
                    Label("Connected", systemImage: "checkmark.seal.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .glassEffect(.regular, in: .capsule)
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("How to get the cookies").font(.headline)
                Text("1. Sign in at x.com in any browser.\n2. Install the Cookie-Editor extension (or open DevTools → Application → Cookies → x.com).\n3. Copy the value of the `auth_token` cookie into the first field below.\n4. Copy the value of the `ct0` cookie into the second field.\n5. Click Connect. Detour uses these via the same unofficial GraphQL endpoints the x.com web client uses.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("auth_token").font(.caption).foregroundStyle(.secondary)
                SecureField("auth_token cookie value", text: $authToken)
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                Text("ct0").font(.caption).foregroundStyle(.secondary)
                SecureField("ct0 cookie value", text: $ct0)
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
            }
            HStack {
                Button(action: save) {
                    if saving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(hasExisting ? "Update cookies" : "Connect")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || authToken.trimmingCharacters(in: .whitespaces).isEmpty || ct0.trimmingCharacters(in: .whitespaces).isEmpty)
                if hasExisting {
                    Button("Disconnect", role: .destructive) { clear() }
                        .disabled(saving)
                }
                Spacer()
                if let status = status {
                    Text(status).font(.caption).foregroundStyle(status.hasPrefix("✓") ? .green : .orange)
                }
            }
            Text("Cookies are stored in the macOS keychain via Detour's vault. Same path as the rest of your provider credentials — the plugin-x-tweets runtime reads X_AUTH_TOKEN and X_CT0 from there.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(24)
        .frame(maxWidth: 640, alignment: .leading)
        .onAppear { refreshState() }
    }

    private func refreshState() {
        Task {
            let configured = await xCookiesConfigured()
            await MainActor.run { hasExisting = configured }
        }
    }

    private func save() {
        let a = authToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let c = ct0.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !a.isEmpty, !c.isEmpty else { return }
        saving = true
        status = nil
        Task {
            let ok = await saveXCookies(authToken: a, ct0: c)
            await MainActor.run {
                saving = false
                if ok {
                    status = "✓ Cookies saved to vault"
                    hasExisting = true
                    authToken = ""
                    ct0 = ""
                } else {
                    status = "⚠ Save failed — check that the agent is running"
                }
            }
        }
    }

    private func clear() {
        saving = true
        Task {
            let ok = await clearXCookies()
            await MainActor.run {
                saving = false
                if ok {
                    status = "✓ Disconnected"
                    hasExisting = false
                }
            }
        }
    }
}

// MARK: - Channel feed view (used once a channel is connected)

struct InboxItemWire: Decodable, Identifiable {
    let id: String
    let time: Double
    let kind: String
    let status: String
    let title: String
    let body: String
    let source: String
    let channel: String?
    let fromHandle: String?
    let replyText: String?
}

private struct ChannelFeedView: View {
    let channel: ChatChannel
    @State private var items: [InboxItemWire] = []
    @State private var loading: Bool = true
    @State private var lastError: String? = nil
    @State private var showSettings: Bool = false
    @State private var pollTask: Task<Void, Never>? = nil
    private let pollSeconds: TimeInterval = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Sub-header: status pill + actions only (the channel
            // icon + name already live in the outer ChatHeaderBar).
            HStack(spacing: 8) {
                Label("Connected", systemImage: "checkmark.seal.fill")
                    .font(.caption2).foregroundStyle(.green)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .glassEffect(.regular, in: .capsule)
                Spacer()
                Button(action: { Task { await refresh() } }) {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
                Button(action: { showSettings = true }) {
                    Image(systemName: "gear")
                }
                .buttonStyle(.borderless)
                .help("Re-enter credentials")
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            Divider()

            if loading && items.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    ProgressView().controlSize(.regular)
                    Text("Loading \(channel.displayName) feed…")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
            } else if items.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "tray")
                        .font(.system(size: 40, weight: .light))
                        .foregroundStyle(.tertiary)
                    Text("No \(channel.displayName) messages yet")
                        .font(.callout).foregroundStyle(.secondary)
                    Text("When someone messages you on \(channel.displayName), it'll appear here. The agent will respond per your settings.")
                        .font(.caption).foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(items) { item in
                            InboxFeedRow(item: item)
                            Divider()
                        }
                    }
                }
            }
            if let err = lastError {
                Text(err)
                    .font(.caption2).foregroundStyle(.orange)
                    .padding(.horizontal, 14).padding(.vertical, 4)
            }
        }
        .sheet(isPresented: $showSettings) {
            VStack(spacing: 0) {
                HStack {
                    Text("\(channel.displayName) settings").font(.headline)
                    Spacer()
                    Button("Done") { showSettings = false }
                        .buttonStyle(.borderedProminent)
                }.padding(14)
                Divider()
                connectPanelForCurrentChannel
                    .frame(minWidth: 560, minHeight: 420)
            }
        }
        .onAppear {
            // Single owner for the load + polling lifecycle. .task on a
            // conditional Group was getting cancelled when the parent
            // re-rendered between connection states (nil → true) —
            // the user saw the spinner forever because the refresh
            // never finished. Doing it from onAppear with a stored
            // Task survives re-renders, and we cancel it on disappear.
            pollTask?.cancel()
            pollTask = Task {
                await refresh()
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: UInt64(pollSeconds * 1_000_000_000))
                    if Task.isCancelled { break }
                    await refresh()
                }
            }
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private var connectPanelForCurrentChannel: some View {
        Group {
            switch channel {
            case .discord: DiscordConnectPanel()
            case .telegram: TelegramConnectPanel()
            case .imessage: IMessageConnectPanel()
            case .x: XConnectPanel()
            default: EmptyView()
            }
        }
    }

    private func refresh() async {
        do {
            struct Resp: Decodable {
                let items: [InboxItemWire]
                let total: Int
            }
            let channelKey: String = {
                switch channel {
                case .discord: return "discord"
                case .telegram: return "telegram"
                case .imessage: return "imessage"
                case .x: return "x"
                default: return ""
                }
            }()
            let resp = try await RPCClient.shared.callTyped("inbox.list", params: [
                "channel": channelKey, "limit": 50,
            ], as: Resp.self)
            await MainActor.run {
                self.items = resp.items
                self.loading = false
                self.lastError = nil
            }
        } catch {
            await MainActor.run {
                self.loading = false
                self.lastError = "Feed unavailable: \(error.localizedDescription)"
            }
        }
    }
}

private struct InboxFeedRow: View {
    let item: InboxItemWire
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.title).font(.callout).fontWeight(.medium)
                    if let handle = item.fromHandle, !handle.isEmpty {
                        Text("from \(handle)").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(relativeTime).font(.caption2).foregroundStyle(.tertiary)
                }
                Text(item.body)
                    .font(.callout).foregroundStyle(.secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)
                if let reply = item.replyText, !reply.isEmpty {
                    HStack(alignment: .top, spacing: 4) {
                        Image(systemName: "arrowshape.turn.up.left")
                            .font(.caption2).foregroundStyle(.tertiary)
                        Text(reply).font(.caption).foregroundStyle(.tertiary).lineLimit(2)
                    }
                    .padding(.top, 2)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var statusColor: Color {
        switch item.status {
        case "pending": return .orange
        case "acting": return .yellow
        case "acted": return .green
        case "acknowledged": return .blue
        case "dismissed": return .secondary
        default: return .secondary
        }
    }

    private var relativeTime: String {
        let date = Date(timeIntervalSince1970: item.time / 1000)
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Discord / Telegram (single-token paste flows)

/// Shared single-token Connect panel: paste one secret value, store it
/// in the vault under the given env key. Used by Discord + Telegram.
private struct SingleTokenConnectPanel: View {
    let channel: ChatChannel
    let envKey: String
    let secretLabel: String
    let helpLines: [String]
    let footnote: String

    @State private var value: String = ""
    @State private var saving: Bool = false
    @State private var status: String? = nil
    @State private var hasExisting: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: channel.systemImage)
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(channel.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect \(channel.displayName)").font(.title3).bold()
                    Text("Paste your \(channel.displayName) bot token")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if hasExisting {
                    Label("Connected", systemImage: "checkmark.seal.fill")
                        .font(.caption).foregroundStyle(.green)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .glassEffect(.regular, in: .capsule)
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                Text("How to get a bot token").font(.headline)
                ForEach(helpLines.indices, id: \.self) { i in
                    Text(helpLines[i]).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(secretLabel).font(.caption).foregroundStyle(.secondary)
                SecureField(secretLabel, text: $value)
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
            }
            HStack {
                Button(action: save) {
                    if saving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(hasExisting ? "Update token" : "Connect")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || value.trimmingCharacters(in: .whitespaces).isEmpty)
                if hasExisting {
                    Button("Disconnect", role: .destructive) { clear() }
                        .disabled(saving)
                }
                Spacer()
                if let status = status {
                    Text(status).font(.caption).foregroundStyle(status.hasPrefix("✓") ? .green : .orange)
                }
            }
            Text(footnote).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(24)
        .frame(maxWidth: 640, alignment: .leading)
        .onAppear { refreshState() }
    }

    private func refreshState() {
        Task {
            let has = await vaultHas(key: envKey)
            await MainActor.run { hasExisting = has }
        }
    }

    private func save() {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty else { return }
        saving = true
        status = nil
        Task {
            let ok = await vaultSet(key: envKey, value: v)
            await MainActor.run {
                saving = false
                if ok {
                    status = "✓ Token saved to vault"
                    hasExisting = true
                    value = ""
                } else {
                    status = "⚠ Save failed — make sure the agent is running"
                }
            }
        }
    }

    private func clear() {
        saving = true
        Task {
            let ok = await vaultRemove(keys: [envKey])
            await MainActor.run {
                saving = false
                if ok {
                    status = "✓ Disconnected"
                    hasExisting = false
                }
            }
        }
    }
}

private struct DiscordConnectPanel: View {
    var body: some View {
        SingleTokenConnectPanel(
            channel: .discord,
            envKey: "DISCORD_API_TOKEN",
            secretLabel: "Bot token",
            helpLines: [
                "1. Go to discord.com/developers/applications and click New Application.",
                "2. Open Bot → Reset Token → copy the token.",
                "3. Under OAuth2 → URL Generator, pick scope `bot` + the permissions you want, open the generated URL, and invite the bot to your server.",
                "4. Paste the bot token below and click Connect.",
            ],
            footnote: "Stored in the macOS keychain as DISCORD_API_TOKEN. plugin-discord reads this and joins every server the bot has been invited to."
        )
    }
}

private struct TelegramConnectPanel: View {
    var body: some View {
        SingleTokenConnectPanel(
            channel: .telegram,
            envKey: "TELEGRAM_BOT_TOKEN",
            secretLabel: "Bot token",
            helpLines: [
                "1. Open Telegram and message @BotFather.",
                "2. Send /newbot, pick a name + username (must end in `bot`).",
                "3. BotFather replies with the bot token — paste it below.",
                "4. Click Connect. Then message your new bot from any Telegram client to start a thread.",
            ],
            footnote: "Stored in the macOS keychain as TELEGRAM_BOT_TOKEN. plugin-telegram polls Telegram's getUpdates with this token."
        )
    }
}

// MARK: - iMessage (system permission, no token)

private struct IMessageConnectPanel: View {
    @State private var hasAutomation: Bool? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: ChatChannel.imessage.systemImage)
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(ChatChannel.imessage.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect iMessage").font(.title3).bold()
                    Text("Uses Messages.app on this Mac — no token needed")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let ok = hasAutomation {
                    if ok {
                        Label("Connected", systemImage: "checkmark.seal.fill")
                            .font(.caption).foregroundStyle(.green)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .glassEffect(.regular, in: .capsule)
                    } else {
                        Label("Permission needed", systemImage: "exclamationmark.shield.fill")
                            .font(.caption).foregroundStyle(.orange)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .glassEffect(.regular, in: .capsule)
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("How it works").font(.headline)
                Text("Detour uses Apple's AppleScript bridge to read incoming iMessages and send replies through Messages.app. There's no bot token — it talks to your existing Messages.app the same way Shortcuts does.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Grant Automation permission").font(.headline).padding(.top, 6)
                Text("System Settings → Privacy & Security → Automation → Detour → enable Messages. Without this, Detour can't read or send iMessages.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Open System Settings → Privacy") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.borderedProminent)
                Button("Re-check") { check() }
                Spacer()
            }
            Text("Detour's iMessage plugin polls Messages.app's local chat.db (read-only) and sends via AppleScript. No data leaves the device for iMessage routing.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(24)
        .frame(maxWidth: 640, alignment: .leading)
        .onAppear { check() }
    }

    private func check() {
        Task {
            // Lightweight probe: try running a no-op Messages query. If
            // Automation isn't granted, AppleScript returns errAEEventNotPermitted (-1743).
            let granted = await imessageAutomationGranted()
            await MainActor.run { hasAutomation = granted }
        }
    }
}

fileprivate func imessageAutomationGranted() async -> Bool {
    await Task.detached { () -> Bool in
        let scriptSrc = "tell application \"Messages\" to return name"
        guard let script = NSAppleScript(source: scriptSrc) else { return false }
        var err: NSDictionary? = nil
        _ = script.executeAndReturnError(&err)
        // If error code is -1743 (errAEEventNotPermitted) → permission denied.
        // If error is nil OR it's some other error (e.g. Messages not running but accessible) → permission granted enough to ask.
        guard let err = err else { return true }
        let code = (err[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
        return code != -1743
    }.value
}

// MARK: - Vault RPC helpers (used by all Connect panels)

fileprivate func vaultHas(key: String) async -> Bool {
    do {
        struct Resp: Decodable { let has: [String: Bool] }
        let resp = try await RPCClient.shared.callTyped("vault.has", params: ["keys": [key]], as: Resp.self)
        return resp.has[key] ?? false
    } catch {
        return false
    }
}

fileprivate func vaultSet(key: String, value: String) async -> Bool {
    do {
        _ = try await RPCClient.shared.call("vault.set", params: [
            "entries": [["key": key, "value": value]],
        ])
        return true
    } catch {
        return false
    }
}

fileprivate func vaultRemove(keys: [String]) async -> Bool {
    do {
        _ = try await RPCClient.shared.call("vault.remove", params: ["keys": keys])
        return true
    } catch {
        return false
    }
}

/// Check whether the vault already has the X auth cookies (via local
/// RPC socket — no token gate needed since the socket is unix-only).
fileprivate func xCookiesConfigured() async -> Bool {
    do {
        struct Resp: Decodable { let has: [String: Bool] }
        let resp = try await RPCClient.shared.callTyped("vault.has", params: ["keys": ["X_AUTH_TOKEN", "X_CT0"]], as: Resp.self)
        return (resp.has["X_AUTH_TOKEN"] ?? false) && (resp.has["X_CT0"] ?? false)
    } catch {
        return false
    }
}

fileprivate func saveXCookies(authToken: String, ct0: String) async -> Bool {
    let entries: [[String: String]] = [
        ["key": "X_AUTH_TOKEN", "value": authToken],
        ["key": "X_CT0", "value": ct0],
    ]
    do {
        _ = try await RPCClient.shared.call("vault.set", params: ["entries": entries])
        return true
    } catch {
        return false
    }
}

fileprivate func clearXCookies() async -> Bool {
    do {
        _ = try await RPCClient.shared.call("vault.remove", params: ["keys": ["X_AUTH_TOKEN", "X_CT0"]])
        return true
    } catch {
        return false
    }
}

private struct ChatBubble: View {
    let message: ChatMessage
    var body: some View {
        HStack(alignment: .top) {
            if message.role == .user { Spacer(minLength: 60) }
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(message.role == .assistant ? "Detour"
                         : message.role == .system ? "System" : "You")
                        .font(.caption2).foregroundStyle(.secondary)
                    if message.inFlight {
                        ProgressView().controlSize(.mini)
                    }
                }
                if let imageURL = message.generatedImageURL,
                   let nsImg = NSImage(contentsOf: imageURL) {
                    Image(nsImage: nsImg)
                        .resizable().scaledToFit()
                        .frame(maxWidth: 360, maxHeight: 360)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .glassEffect(.regular, in: .rect(cornerRadius: 14))
                }
                if let att = message.attachmentURL {
                    HStack(spacing: 6) {
                        Image(systemName: "paperclip").foregroundStyle(.secondary)
                        Text(att.lastPathComponent).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .glassEffect(.regular, in: .capsule)
                }
                if !message.text.isEmpty || message.inFlight {
                    Text(message.text.isEmpty && message.inFlight ? "…" : message.text)
                        .font(.body)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .glassEffect(.regular, in: .rect(cornerRadius: 14))
                }
            }
            if message.role != .user { Spacer(minLength: 60) }
        }
    }
}

private struct ChatErrorBubble: View {
    let message: String
    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.caption).textSelection(.enabled)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 10))
    }
}

// MARK: - Composer

private struct ChatComposer: View {
    @ObservedObject var vm: ChatViewModel
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 8) {
            ComposerToolbar(vm: vm)
            if let att = vm.attachmentURL {
                HStack(spacing: 6) {
                    Image(systemName: "paperclip").foregroundStyle(.secondary)
                    Text(att.lastPathComponent).font(.caption)
                    Spacer()
                    Button(action: { vm.attachmentURL = nil }) {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .glassEffect(.regular, in: .capsule)
                .padding(.horizontal, 14)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextEditor(text: $vm.composer)
                    .font(.body)
                    .focused($composerFocused)
                    .frame(minHeight: 36, maxHeight: 140)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .glassEffect(.regular, in: .rect(cornerRadius: 12))
                    .onSubmit { vm.send() }
                Button(action: { vm.send() }) {
                    Image(systemName: "arrow.up.circle.fill")
                        .resizable().frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .disabled(vm.composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || vm.sending)
                .keyboardShortcut(.return, modifiers: .command)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 12)
        }
        .onAppear { composerFocused = true }
    }
}

private struct ComposerToolbar: View {
    @ObservedObject var vm: ChatViewModel
    @State private var showModelPicker = false
    @State private var showSkillsPicker = false
    @State private var showPluginsPicker = false

    var body: some View {
        HStack(spacing: 8) {
            // Attach file
            ToolbarIconButton(systemName: "paperclip.circle.fill", help: "Attach a file") {
                vm.pickAttachment()
            }
            // Image generation (prompt becomes the user message, response is an inline image)
            ToolbarIconButton(systemName: "sparkles", help: "Generate image from composer prompt") {
                vm.generateImageFromComposer()
            }
            // Mic (push-to-talk dictation)
            ToolbarIconButton(systemName: vm.listening ? "mic.circle.fill" : "mic", help: vm.listening ? "Stop dictation" : "Start dictation") {
                vm.toggleListening()
            }
            .foregroundStyle(vm.listening ? .red : .primary)
            // Speech (auto-TTS for replies)
            ToolbarIconButton(systemName: vm.speechEnabled ? "speaker.wave.3.fill" : "speaker.slash", help: vm.speechEnabled ? "Speech on — assistant replies will be read aloud" : "Speech off") {
                vm.speechEnabled.toggle()
            }
            .foregroundStyle(vm.speechEnabled ? Color.accentColor : .primary)
            Spacer()
            // Model picker
            ModelMenu()
            // Skills + plugins popovers
            ToolbarIconButton(systemName: "link.circle.fill", help: "Skills — open / disable per agent") {
                WindowFactory.shared.openSettings(tab: "configuration:skills")
            }
            ToolbarIconButton(systemName: "puzzlepiece.fill", help: "Plugins — enable / disable") {
                WindowFactory.shared.openSettings(tab: "configuration:agent-permissions")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
    }
}

private struct ToolbarIconButton: View {
    let systemName: String
    let help: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .medium))
                .frame(width: 32, height: 32)
                .glassEffect(.regular, in: .circle)
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// Model picker — surfaces the routing options for the chat path
/// (the "active provider" — Anthropic, OpenAI, OpenRouter, ElizaCloud)
/// and lets the user switch by writing the activeProviderId via the
/// existing PROVIDER_SET_ACTIVE detour-URL action.
private struct ModelMenu: View {
    @StateObject private var client = DetourClient()
    var body: some View {
        Menu {
            Section("Chat provider") {
                ForEach(client.snapshot?.providers ?? [], id: \.id) { p in
                    Button(action: {
                        let encoded = p.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? p.id
                        if let url = URL(string: "detour://action?name=PROVIDER_SET_ACTIVE&id=\(encoded)") {
                            NSWorkspace.shared.open(url)
                        }
                    }) {
                        Label(p.label, systemImage: p.active ? "checkmark.circle.fill" : "circle")
                    }
                }
            }
            Divider()
            Button("Open routing settings…") {
                WindowFactory.shared.openSettings(tab: "configuration:providers")
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "cpu")
                Text(activeProviderLabel)
                    .lineLimit(1).truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(.caption2)
            }
            .font(.callout)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .glassEffect(.regular, in: .capsule)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Active chat model. Switches the agent's preferred LLM provider.")
        .onAppear { client.startPolling() }
    }
    private var activeProviderLabel: String {
        if let active = client.snapshot?.providers.first(where: { $0.active }) {
            return active.label
        }
        return "Pick model"
    }
}
