/*
 * DetourSettings — native SwiftUI Settings window for Detour.
 *
 * Companion architecture (same as DetourBridge + DetourTray):
 *   - LSUIElement = YES → no Dock icon, just a window.
 *   - Talks to bun runtime over 127.0.0.1:2138 (DetourClient).
 *   - Auto-exits when window closes — Detour respawns on next
 *     `detour://settings` URL.
 *
 * Tabs (sidebar):
 *   Configuration: Providers, Models, Local AI, Audio, Character,
 *                  Agent Permissions, Skills, Phantom Wallet,
 *                  Appearance, Tray, Window, OS Permissions
 *   Vault:         Inventory, Saved Logins, Backends
 *   Cloud:         Eliza Cloud, Apps, Containers
 *
 * Form-based tabs render natively in SwiftUI. Heavier ones (Skills
 * marketplace, Saved Logins detail panes, Cloud auth flows) defer to
 * the React main window via deep-link buttons — we cover the surface
 * incrementally without blocking on every detail.
 */

import AppKit
import SwiftUI

// WireTypes.swift, DetourClient.swift, CommonViews.swift are compiled
// alongside this file by build.sh. Treat them as a local module.

// MARK: - Tab catalog

enum SettingsTab: String, CaseIterable, Identifiable, Hashable {
    // Configuration
    case providers
    case models
    case localAI = "local-ai"
    case audio
    case character
    case permissions
    case skills
    case phantom
    case appearance
    case tray
    case window
    case osPermissions = "os-permissions"
    // Vault
    case vaultInventory = "vault-inventory"
    case savedLogins = "saved-logins"
    case backends
    // Cloud
    case elizaCloud = "eliza-cloud"
    case cloudApps = "cloud-apps"
    case cloudContainers = "cloud-containers"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .providers: return "Providers"
        case .models: return "Models & Routing"
        case .localAI: return "Local AI"
        case .audio: return "Audio"
        case .character: return "Agent Character"
        case .permissions: return "Agent Permissions"
        case .skills: return "Skills"
        case .phantom: return "Phantom Wallet"
        case .appearance: return "Appearance"
        case .tray: return "Tray"
        case .window: return "Window"
        case .osPermissions: return "OS Permissions"
        case .vaultInventory: return "Inventory"
        case .savedLogins: return "Saved Logins"
        case .backends: return "Backends"
        case .elizaCloud: return "Eliza Cloud"
        case .cloudApps: return "Apps"
        case .cloudContainers: return "Containers"
        }
    }
    var systemImage: String {
        switch self {
        case .providers: return "key.fill"
        case .models: return "rectangle.connected.to.line.below"
        case .localAI: return "cpu.fill"
        case .audio: return "waveform"
        case .character: return "person.crop.rectangle"
        case .permissions: return "lock.shield"
        case .skills: return "wrench.and.screwdriver.fill"
        case .phantom: return "creditcard.fill"
        case .appearance: return "paintbrush.fill"
        case .tray: return "menubar.rectangle"
        case .window: return "macwindow"
        case .osPermissions: return "checkmark.shield"
        case .vaultInventory: return "lock.rectangle.stack"
        case .savedLogins: return "rectangle.and.text.magnifyingglass"
        case .backends: return "externaldrive"
        case .elizaCloud: return "cloud.fill"
        case .cloudApps: return "shippingbox.fill"
        case .cloudContainers: return "rectangle.stack.fill"
        }
    }
    /// `<section>:<tab>` route used by the React deep-link fallback.
    var reactDeepLink: String {
        switch self {
        case .providers: return "configuration:providers"
        case .models: return "configuration:models"
        case .localAI: return "configuration:local-ai"
        case .audio: return "configuration:audio"
        case .character: return "configuration:character"
        case .permissions: return "configuration:agent"
        case .skills: return "configuration:skills"
        case .phantom: return "configuration:phantom"
        case .appearance: return "configuration:appearance"
        case .tray: return "configuration:tray"
        case .window: return "configuration:window"
        case .osPermissions: return "configuration:os"
        case .vaultInventory: return "vault:inventory"
        case .savedLogins: return "vault:saved-logins"
        case .backends: return "vault:backends"
        case .elizaCloud: return "cloud:elizacloud"
        case .cloudApps: return "cloud:apps"
        case .cloudContainers: return "cloud:containers"
        }
    }
}

private let CONFIGURATION_TABS: [SettingsTab] = [
    .providers, .models, .localAI, .audio, .character, .permissions,
    .skills, .phantom, .appearance, .tray, .window, .osPermissions,
]
private let VAULT_TABS: [SettingsTab] = [.vaultInventory, .savedLogins, .backends]
private let CLOUD_TABS: [SettingsTab] = [.elizaCloud, .cloudApps, .cloudContainers]

// MARK: - Root view

struct RootView: View {
    @StateObject private var client = DetourClient()
    @State private var selectedTab: SettingsTab = .providers

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedTab) {
                Section("Configuration") {
                    ForEach(CONFIGURATION_TABS) { tab in
                        Label(tab.label, systemImage: tab.systemImage).tag(tab)
                    }
                }
                Section("Vault") {
                    ForEach(VAULT_TABS) { tab in
                        Label(tab.label, systemImage: tab.systemImage).tag(tab)
                    }
                }
                Section("Cloud") {
                    ForEach(CLOUD_TABS) { tab in
                        Label(tab.label, systemImage: tab.systemImage).tag(tab)
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 200)
        } detail: {
            tabBody
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { client.startPolling() }
        .frame(minWidth: 820, idealWidth: 920, minHeight: 600, idealHeight: 720)
    }

    @ViewBuilder
    private var tabBody: some View {
        switch selectedTab {
        case .providers: ProvidersTab(client: client)
        case .models: PlaceholderTab(client: client, tab: .models,
            summary: "Choose which model each tier (TEXT_SMALL/MEDIUM/LARGE/EMBEDDING) routes to per-provider, plus the fallback chain.")
        case .localAI: LocalAITab(client: client)
        case .audio: PlaceholderTab(client: client, tab: .audio,
            summary: "TTS, voice cloning, audio generation (ElevenLabs, Cartesia, etc.).")
        case .character: PlaceholderTab(client: client, tab: .character,
            summary: "Edit bio, lore, voice templates — the agent's identity.")
        case .permissions: PlaceholderTab(client: client, tab: .permissions,
            summary: "Vault read/write scope, browser-use, computer-use, coding-tool sandbox.")
        case .skills: PlaceholderTab(client: client, tab: .skills,
            summary: "Bundled + user-installed agent skills (the elizaOS marketplace).")
        case .phantom: PlaceholderTab(client: client, tab: .phantom,
            summary: "Embedded Phantom Connect (Solana + EVM). Portal config helpers.")
        case .appearance: AppearanceTab(client: client)
        case .tray: TrayPlaceholder(client: client)
        case .window: PlaceholderTab(client: client, tab: .window,
            summary: "Chat window size, hide-on-blur, always-on-top.")
        case .osPermissions: PlaceholderTab(client: client, tab: .osPermissions,
            summary: "macOS TCC: camera, microphone, screen recording, accessibility, automation.")
        case .vaultInventory: PlaceholderTab(client: client, tab: .vaultInventory,
            summary: "Every vault key — secrets, references, profiles.")
        case .savedLogins: PlaceholderTab(client: client, tab: .savedLogins,
            summary: "1Password / Bitwarden / in-house saved logins for browser autofill.")
        case .backends: PlaceholderTab(client: client, tab: .backends,
            summary: "Enable + sign in to 1Password, Bitwarden, ProtonPass.")
        case .elizaCloud: PlaceholderTab(client: client, tab: .elizaCloud,
            summary: "Eliza Cloud auth + live model catalog.")
        case .cloudApps: PlaceholderTab(client: client, tab: .cloudApps,
            summary: "Managed app deployments on Eliza Cloud.")
        case .cloudContainers: PlaceholderTab(client: client, tab: .cloudContainers,
            summary: "Managed container runtime status.")
        }
    }
}

// MARK: - Native tabs

struct ProvidersTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TabHeader(title: "Providers", deepLink: SettingsTab.providers.reactDeepLink, client: client)
            Text("Pick the LLM provider Detour uses by default. ✓ marks the active one; greyed rows aren't configured yet — set them up in the main window.")
                .font(.callout).foregroundStyle(.secondary)
            if let providers = client.snapshot?.providers, !providers.isEmpty {
                List(providers) { p in
                    HStack {
                        Image(systemName: p.active ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(p.active ? Color.accentColor : .secondary)
                        Text(p.label).fontWeight(p.active ? .semibold : .regular)
                        if !p.configured {
                            Text("not configured")
                                .font(.caption2).foregroundStyle(.secondary)
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
        }
        .padding(20)
    }
}

struct LocalAITab: View {
    @ObservedObject var client: DetourClient
    @State private var chatPreset: String = ""
    @State private var companionPreset: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                TabHeader(title: "Local AI", deepLink: SettingsTab.localAI.reactDeepLink, client: client)
                Text("Run inference on your machine. The embedding server is always on; chat and companion are opt-in and share a RAM budget.")
                    .font(.callout).foregroundStyle(.secondary)

                if let mem = client.snapshot?.memory {
                    MemoryBudgetBar(memory: mem)
                }
                if let embed = client.snapshot?.embed {
                    EmbedCard(embed: embed)
                }
                if let chat = client.snapshot?.localChat {
                    TierCard(
                        title: "Chat tier",
                        running: chat.running,
                        currentPreset: chat.preset,
                        downloadPercent: chat.downloadPercent,
                        arbiterRefusal: chat.lastArbiterRefusal,
                        presets: chat.presets,
                        sharedWithLocalChat: false,
                        selectedPreset: $chatPreset,
                        onStart: { preset in Task { await client.localAI(tier: "chat", action: "start", preset: preset) } },
                        onStop: { Task { await client.localAI(tier: "chat", action: "stop") } },
                        memory: client.snapshot?.memory,
                    )
                }
                if let comp = client.snapshot?.companion {
                    TierCard(
                        title: "Companion tier",
                        running: comp.running,
                        currentPreset: comp.preset,
                        downloadPercent: comp.downloadPercent,
                        arbiterRefusal: comp.lastArbiterRefusal,
                        presets: comp.presets,
                        sharedWithLocalChat: comp.sharedWithLocalChat,
                        selectedPreset: $companionPreset,
                        onStart: { preset in Task { await client.localAI(tier: "companion", action: "start", preset: preset) } },
                        onStop: { Task { await client.localAI(tier: "companion", action: "stop") } },
                        memory: client.snapshot?.memory,
                    )
                }
            }
            .padding(20)
        }
    }
}

struct AppearanceTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TabHeader(title: "Appearance", deepLink: SettingsTab.appearance.reactDeepLink, client: client)
            Text("Theme and accent color settings live in the React main window — the appearance preview is interactive there.")
                .font(.callout).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(20)
    }
}

struct TrayPlaceholder: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TabHeader(title: "Tray", deepLink: SettingsTab.tray.reactDeepLink, client: client)
            Text("Customize the menu-bar popover, status pills, and label mode in the React main window. Native port coming soon.")
                .font(.callout).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(20)
    }
}

struct PlaceholderTab: View {
    @ObservedObject var client: DetourClient
    let tab: SettingsTab
    let summary: String
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TabHeader(title: tab.label, deepLink: tab.reactDeepLink, client: client)
            Text(summary).font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("This tab is being migrated to native SwiftUI. For now the controls live in the main React Settings window.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Open in main window…") {
                    client.openDetourURL("detour://settings?tab=\(tab.reactDeepLink)")
                }
                .controlSize(.small)
            }
            .padding(12)
            .background(Color.gray.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            Spacer()
        }
        .padding(20)
    }
}

struct TabHeader: View {
    let title: String
    let deepLink: String
    let client: DetourClient
    var body: some View {
        HStack {
            Text(title).font(.title2).bold()
            Spacer()
            Button("Edit in main window…") {
                client.openDetourURL("detour://settings?tab=\(deepLink)")
            }
            .controlSize(.small)
        }
    }
}

// MARK: - Local AI helper views

struct EmbedCard: View {
    let embed: TrayEmbedWire
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
    let currentPreset: String?
    let downloadPercent: Int?
    let arbiterRefusal: String?
    let presets: [TrayPresetWire]
    let sharedWithLocalChat: Bool
    @Binding var selectedPreset: String
    let onStart: (String?) -> Void
    let onStop: () -> Void
    let memory: TrayMemoryWire?

    private var resolvedPreset: TrayPresetWire? {
        if !selectedPreset.isEmpty {
            return presets.first { $0.id == selectedPreset }
        }
        if let currentPreset {
            return presets.first { $0.id == currentPreset }
        }
        return presets.first
    }

    private var fitWarning: String? {
        guard let p = resolvedPreset, let mem = memory else { return nil }
        let projected = mem.usedGB + p.approxLiveRamGB
        if projected > mem.budgetGB {
            return String(format: "would use %.1f GB; budget is %.1f GB", projected, mem.budgetGB)
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
                        let p = selectedPreset.isEmpty ? nil : selectedPreset
                        onStart(p)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(presets.isEmpty)
                }
            }
            if running, let p = currentPreset {
                Text("Running: \(p)").font(.caption).foregroundStyle(.secondary)
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
                                Text(String(format: "%.1f GB", p.approxLiveRamGB)).foregroundStyle(.secondary)
                                if p.downloaded { Text("✓").foregroundStyle(.green) }
                                else { Text("↓").foregroundStyle(.blue) }
                            }.tag(p.id)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .onAppear {
                        if selectedPreset.isEmpty, let first = currentPreset ?? presets.first?.id {
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

// MARK: - App boot

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    func applicationDidFinishLaunching(_: Notification) {
        let host = NSHostingController(rootView: RootView())
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 920, height: 700),
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
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: win,
            queue: .main,
        ) { _ in NSApplication.shared.terminate(nil) }
        NSApp.activate(ignoringOtherApps: true)
    }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
