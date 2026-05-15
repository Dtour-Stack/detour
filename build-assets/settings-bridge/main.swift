/*
 * DetourSettings — native SwiftUI Settings window for Detour.
 *
 * Companion architecture (same as DetourBridge + DetourTray):
 *   - LSUIElement = YES → no Dock icon, no menu bar, just a window.
 *   - Talks to the Bun runtime over 127.0.0.1:2138 — same surface the
 *     React UI uses. No special IPC; the wire is the HTTP/RPC layer
 *     we already designed.
 *   - Auto-exits when its window is closed AND Detour is unreachable.
 *
 * Initial scope (intentionally narrow — the React Settings stays as
 * fallback for everything else):
 *   - Providers tab           (read state, switch active, deep-link
 *                              into React for setup of new keys)
 *   - Local AI tab            (full control: start/stop, preset
 *                              picker, download progress, memory
 *                              budget bar)
 *   - Tray tab                (slots / pills / status label / widget)
 *
 * Everything else opens the corresponding tab in the React Settings
 * via a `detour://settings?tab=...` URL.
 */

import AppKit
import SwiftUI

// MARK: - Wire types

struct TrayProvider: Decodable, Identifiable {
    let id: String
    let label: String
    let active: Bool
    let configured: Bool
}

struct TrayEmbed: Decodable {
    let running: Bool
    let downloadPercent: Int?
    let lastError: String?
}

struct TrayPreset: Decodable, Identifiable {
    let id: String
    let label: String
    let approxLiveRamGB: Double
    let approxDiskGB: Double
    let downloaded: Bool
}

struct TrayLocalChat: Decodable {
    let enabled: Bool
    let running: Bool
    let preset: String?
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let lastArbiterRefusal: String?
    let presets: [TrayPreset]
}

struct TrayCompanion: Decodable {
    let enabled: Bool
    let running: Bool
    let preset: String?
    let sharedWithLocalChat: Bool
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let lastArbiterRefusal: String?
    let presets: [TrayPreset]
}

struct TrayMemory: Decodable {
    let totalGB: Double
    let headroomGB: Double
    let budgetGB: Double
    let usedGB: Double
}

struct TrayTrajectory: Decodable, Identifiable {
    let id: String
    let source: String?
    let startTime: Double?
    let status: String?
}

struct TraySnapshot: Decodable {
    let activeProviderId: String?
    let providers: [TrayProvider]
    let embed: TrayEmbed
    let localChat: TrayLocalChat
    let companion: TrayCompanion
    let memory: TrayMemory?
    let recentTrajectories: [TrayTrajectory]
}

// MARK: - Backend client

@MainActor
final class DetourClient: ObservableObject {
    @Published var snapshot: TraySnapshot? = nil
    @Published var lastError: String? = nil
    private let baseURL = URL(string: "http://127.0.0.1:2138")!
    private var timer: Timer?

    func startPolling() {
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
    }

    func poll() {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/tray-state"), timeoutInterval: 3.0)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { [weak self] data, _, err in
            guard let self else { return }
            Task { @MainActor in
                if let data, err == nil {
                    do {
                        let snap = try JSONDecoder().decode(TraySnapshot.self, from: data)
                        self.snapshot = snap
                        self.lastError = nil
                    } catch {
                        self.lastError = "decode failed: \(error.localizedDescription)"
                    }
                } else if let err {
                    self.lastError = "unreachable: \(err.localizedDescription)"
                }
            }
        }.resume()
    }

    /// POST /api/local-ai/{tier}/{action} — start (with optional
    /// preset) or stop the local-chat or companion tier.
    func localAI(tier: String, action: String, preset: String? = nil) async {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/local-ai/\(tier)/\(action)"))
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "content-type")
        if let preset, !preset.isEmpty {
            let body = try? JSONSerialization.data(withJSONObject: ["preset": preset])
            req.httpBody = body
        } else {
            req.httpBody = "{}".data(using: .utf8)
        }
        _ = try? await URLSession.shared.data(for: req)
        // Poke an immediate poll so the UI reflects the change quickly.
        await MainActor.run { self.poll() }
    }

    /// Open a `detour://` URL via NSWorkspace.
    func openDetourURL(_ urlString: String) {
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - Tab enum

enum SettingsTab: String, CaseIterable, Identifiable {
    case providers
    case localAI = "local-ai"
    case tray
    var id: String { rawValue }
    var label: String {
        switch self {
        case .providers: return "Providers"
        case .localAI: return "Local AI"
        case .tray: return "Tray"
        }
    }
    var systemImage: String {
        switch self {
        case .providers: return "key.fill"
        case .localAI: return "cpu.fill"
        case .tray: return "menubar.rectangle"
        }
    }
}

// MARK: - Root view

struct RootView: View {
    @StateObject private var client = DetourClient()
    @State private var selectedTab: SettingsTab = .localAI

    var body: some View {
        NavigationSplitView {
            List(SettingsTab.allCases, selection: $selectedTab) { tab in
                Label(tab.label, systemImage: tab.systemImage).tag(tab)
            }
            .listStyle(.sidebar)
            .frame(minWidth: 180)

            Section("Open in main window") {
                Button("Agent Character", action: { client.openDetourURL("detour://settings?tab=configuration:character") })
                Button("Agent Permissions", action: { client.openDetourURL("detour://settings?tab=configuration:agent") })
                Button("Models & Routing", action: { client.openDetourURL("detour://settings?tab=configuration:models") })
                Button("Audio", action: { client.openDetourURL("detour://settings?tab=configuration:audio") })
                Button("Skills", action: { client.openDetourURL("detour://settings?tab=configuration:skills") })
                Button("Vault", action: { client.openDetourURL("detour://settings?tab=vault:inventory") })
                Button("Phantom Wallet", action: { client.openDetourURL("detour://settings?tab=configuration:phantom") })
                Button("OS Permissions", action: { client.openDetourURL("detour://settings?tab=configuration:os") })
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
            .buttonStyle(.plain)
            .font(.system(size: 11))
        } detail: {
            switch selectedTab {
            case .providers: ProvidersTabView(client: client)
            case .localAI: LocalAITabView(client: client)
            case .tray: TrayTabView(client: client)
            }
        }
        .onAppear { client.startPolling() }
        .frame(minWidth: 720, idealWidth: 820, minHeight: 540, idealHeight: 640)
    }
}

// MARK: - Providers tab

struct ProvidersTabView: View {
    @ObservedObject var client: DetourClient

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Providers").font(.title2).bold()
                Spacer()
                Button("Manage in main window…") {
                    client.openDetourURL("detour://settings?tab=configuration:providers")
                }
            }
            Text("Pick the LLM provider Detour uses by default. ✓ marks the active one; greyed rows aren't configured yet — set them up in the main window.")
                .font(.callout).foregroundStyle(.secondary)

            if let providers = client.snapshot?.providers, !providers.isEmpty {
                List(providers) { p in
                    HStack {
                        Image(systemName: p.active ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(p.active ? Color.accentColor : .secondary)
                        Text(p.label)
                            .fontWeight(p.active ? .semibold : .regular)
                        if !p.configured {
                            Text("not configured")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.gray.opacity(0.15))
                                .clipShape(Capsule())
                        }
                        Spacer()
                        if !p.active && p.configured {
                            Button("Set active") {
                                client.openDetourURL("detour://action?name=PROVIDER_SET_ACTIVE&id=\(p.id)")
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
            } else {
                ProgressView("Loading providers…")
            }
            Spacer()
        }
        .padding(20)
    }
}

// MARK: - Local AI tab

struct LocalAITabView: View {
    @ObservedObject var client: DetourClient
    @State private var chatPresetChoice: String = ""
    @State private var companionPresetChoice: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Local AI").font(.title2).bold()
                Text("Run inference on your machine. The embedding server is always on; chat and companion are opt-in and share a RAM budget.")
                    .font(.callout).foregroundStyle(.secondary)

                if let mem = client.snapshot?.memory {
                    MemoryBudgetCard(memory: mem)
                }

                if let embed = client.snapshot?.embed {
                    EmbedCard(embed: embed)
                }

                if let chat = client.snapshot?.localChat {
                    TierCard(
                        title: "Chat tier",
                        running: chat.running,
                        preset: chat.preset,
                        downloadPercent: chat.downloadPercent,
                        downloadedBytes: chat.downloadedBytes,
                        totalBytes: chat.totalBytes,
                        arbiterRefusal: chat.lastArbiterRefusal,
                        presets: chat.presets,
                        sharedWithLocalChat: false,
                        selectedPreset: $chatPresetChoice,
                        onStart: { preset in
                            Task { await client.localAI(tier: "chat", action: "start", preset: preset) }
                        },
                        onStop: { Task { await client.localAI(tier: "chat", action: "stop") } },
                        memory: client.snapshot?.memory,
                    )
                }

                if let comp = client.snapshot?.companion {
                    TierCard(
                        title: "Companion tier",
                        running: comp.running,
                        preset: comp.preset,
                        downloadPercent: comp.downloadPercent,
                        downloadedBytes: comp.downloadedBytes,
                        totalBytes: comp.totalBytes,
                        arbiterRefusal: comp.lastArbiterRefusal,
                        presets: comp.presets,
                        sharedWithLocalChat: comp.sharedWithLocalChat,
                        selectedPreset: $companionPresetChoice,
                        onStart: { preset in
                            Task { await client.localAI(tier: "companion", action: "start", preset: preset) }
                        },
                        onStop: { Task { await client.localAI(tier: "companion", action: "stop") } },
                        memory: client.snapshot?.memory,
                    )
                }
            }
            .padding(20)
        }
    }
}

struct MemoryBudgetCard: View {
    let memory: TrayMemory
    private var fraction: Double {
        memory.budgetGB > 0 ? min(1.0, memory.usedGB / memory.budgetGB) : 0
    }
    private var tone: Color {
        fraction >= 0.9 ? .red : fraction >= 0.7 ? .orange : .green
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("RAM budget").font(.headline)
                Spacer()
                Text(String(format: "%.1f / %.1f GB · %.1f GB held back",
                            memory.usedGB, memory.budgetGB, memory.headroomGB))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: fraction)
                .tint(tone)
        }
        .padding(14)
        .background(Color.gray.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct EmbedCard: View {
    let embed: TrayEmbed
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(embed.running ? Color.green : Color.gray).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text("Embedding server").font(.headline)
                Text(embed.running
                     ? "Local llama.cpp embeddings (bge-small-en-v1.5, 384-dim)"
                     : (embed.lastError ?? "starting…"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let pct = embed.downloadPercent, pct < 100 {
                ProgressView(value: Double(pct) / 100.0).frame(width: 80)
                Text("\(pct)%").font(.caption).monospacedDigit()
            } else if embed.running {
                Text("running").font(.caption).foregroundStyle(.green)
            }
        }
        .padding(14)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.2)))
    }
}

struct TierCard: View {
    let title: String
    let running: Bool
    let preset: String?
    let downloadPercent: Int?
    let downloadedBytes: Int?
    let totalBytes: Int?
    let arbiterRefusal: String?
    let presets: [TrayPreset]
    let sharedWithLocalChat: Bool
    @Binding var selectedPreset: String
    let onStart: (String?) -> Void
    let onStop: () -> Void
    let memory: TrayMemory?

    private var resolvedPreset: TrayPreset? {
        if !selectedPreset.isEmpty {
            return presets.first { $0.id == selectedPreset }
        }
        if let preset {
            return presets.first { $0.id == preset }
        }
        return presets.first
    }

    private var fitWarning: String? {
        guard let p = resolvedPreset, let mem = memory else { return nil }
        let projected = mem.usedGB + p.approxLiveRamGB
        if projected > mem.budgetGB {
            return String(format: "would use %.1f GB; budget is %.1f GB",
                          projected, mem.budgetGB)
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Circle().fill(running ? Color.green : Color.gray).frame(width: 8, height: 8)
                Text(title).font(.headline)
                if sharedWithLocalChat {
                    Text("shared with chat")
                        .font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.indigo.opacity(0.15))
                        .foregroundStyle(.indigo)
                        .clipShape(Capsule())
                }
                Spacer()
                if running {
                    Button("Stop", role: .destructive, action: onStop)
                } else {
                    Button("Start") {
                        let preset = selectedPreset.isEmpty ? nil : selectedPreset
                        onStart(preset)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(presets.isEmpty)
                }
            }

            if running, let preset {
                Text("Running: \(preset)").font(.caption).foregroundStyle(.secondary)
            }

            if let dl = downloadPercent, dl < 100 {
                HStack {
                    Text("Downloading model").font(.caption)
                    ProgressView(value: Double(dl) / 100.0)
                    Text("\(dl)%").font(.caption).monospacedDigit()
                }
            }

            if let refusal = arbiterRefusal, !refusal.isEmpty {
                Text("⚠ Last start refused: \(refusal)")
                    .font(.caption).foregroundStyle(.orange)
                    .padding(8)
                    .background(Color.orange.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            if !running && !presets.isEmpty {
                HStack(alignment: .top) {
                    Text("Preset:").font(.subheadline)
                    Picker("", selection: $selectedPreset) {
                        ForEach(presets) { p in
                            HStack {
                                Text(p.label)
                                Text(String(format: "%.1f GB", p.approxLiveRamGB))
                                    .foregroundStyle(.secondary)
                                if p.downloaded {
                                    Text("✓").foregroundStyle(.green)
                                } else {
                                    Text("↓").foregroundStyle(.blue)
                                }
                            }.tag(p.id)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .onAppear {
                        if selectedPreset.isEmpty, let first = preset ?? presets.first?.id {
                            selectedPreset = first
                        }
                    }
                }
                if let warn = fitWarning {
                    Text("⚠ \(warn) — start may be refused").font(.caption).foregroundStyle(.orange)
                }
                if let p = resolvedPreset, !p.downloaded {
                    Text("Model is \(String(format: "%.1f GB", p.approxDiskGB)) — first start downloads from Hugging Face.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.2)))
    }
}

// MARK: - Tray tab

struct TrayTabView: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Tray").font(.title2).bold()
                Spacer()
                Button("Edit in main window…") {
                    client.openDetourURL("detour://settings?tab=configuration:tray")
                }
            }
            Text("The menu-bar tray + status widget are configured in the main React Settings window. This panel will be ported here later.")
                .font(.callout).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(20)
    }
}

// MARK: - App boot

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_: Notification) {
        let contentView = RootView()
        let host = NSHostingController(rootView: contentView)
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false,
        )
        win.title = "Detour Settings"
        win.center()
        win.contentViewController = host
        win.setFrameAutosaveName("DetourSettingsWindow")
        win.isReleasedWhenClosed = false
        win.makeKeyAndOrderFront(nil)
        window = win

        // When the window closes, exit the app — DetourSettings is a
        // single-window companion. Detour spawns a new instance on the
        // next `detour://settings` URL.
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: win,
            queue: .main,
        ) { _ in
            NSApplication.shared.terminate(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
