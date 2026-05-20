/*
 * SettingsTabs — native SwiftUI implementations for every tab in the
 * unified Detour Settings window. Replaces the "open in main view"
 * placeholder fallbacks. Each tab reads from /api/tray-state or the
 * eval API (memories/entities/logs); write operations route through
 * `detour://action?name=…` for now, dispatched in-process via
 * /api/url-scheme/dispatch.
 *
 * Surface coverage:
 *   Configuration: Providers, Models, LocalAI, Audio, Character,
 *                  Agent Permissions, Skills, Phantom, Appearance,
 *                  Tray, Window, OS Permissions
 *   Vault:         Inventory, Saved Logins, Backends
 *   Cloud:         Eliza Cloud, Apps, Containers
 *
 * Tabs with no live bun endpoint yet render the current configured
 * state (read from tray-state + env hints) plus inline controls — no
 * more "use the main view" buttons.
 */

import AppKit
import AVFoundation
import SwiftUI

// MARK: - Models & Routing

struct SettingsModelsTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Models & Routing").font(.title2).bold()
                Text("How Detour picks an LLM for each tier (TEXT_SMALL / MEDIUM / LARGE / EMBEDDING) per provider, plus the fallback chain.")
                    .font(.callout).foregroundStyle(.secondary)
                if let snap = client.snapshot {
                    SettingsCardBox(title: "Active provider") {
                        HStack {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                            Text(snap.providers.first(where: { $0.id == snap.activeProviderId })?.label
                                 ?? snap.activeProviderId ?? "—")
                                .font(.headline)
                            Spacer()
                            Text(snap.activeProviderId ?? "—")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    SettingsCardBox(title: "All providers") {
                        ForEach(snap.providers) { p in
                            HStack {
                                Image(systemName: p.active ? "checkmark.circle.fill"
                                      : (p.configured ? "circle" : "circle.dotted"))
                                    .foregroundColor(p.active ? Color.green : (p.configured ? Color.secondary : Color.gray))
                                Text(p.label).fontWeight(p.active ? .semibold : .regular)
                                Spacer()
                                if !p.configured {
                                    Text("not configured").font(.caption2)
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(.gray.opacity(0.15)).clipShape(Capsule())
                                } else if !p.active {
                                    Button("Set active") {
                                        client.openDetourURL("detour://action?name=PROVIDER_SET_ACTIVE&id=\(p.id)")
                                    }.buttonStyle(.borderless)
                                }
                            }
                        }
                    }
                    SettingsCardBox(title: "Embedding") {
                        HStack(spacing: 10) {
                            Circle().fill(snap.embed.running ? Color.green : Color.gray).frame(width: 8, height: 8)
                            Text(snap.embed.running ? "local: bge-small-en-v1.5 (384-dim)" : (snap.embed.lastError ?? "starting…"))
                                .font(.callout)
                            Spacer()
                        }
                    }
                } else {
                    ProgressView()
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

// MARK: - Tray

// SettingsTrayTab / SettingsWindowTab / SettingsNotificationsTab still
// exist but are no longer wired to the sidebar — SettingsAppearanceTab
// (in SettingsSurface.swift) renders all three as sections in one tab.

struct SettingsTrayTab: View {
    @ObservedObject var client: DetourClient
    @AppStorage("detour.tray.showProviderDot") private var showProviderDot = true
    @AppStorage("detour.tray.showRecent") private var showRecent = true
    @AppStorage("detour.tray.showLocalAI") private var showLocalAI = true
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Tray").font(.title2).bold()
                Text("Customize the menu-bar icon's NSMenu. Changes apply on next render (the tray polls bun every 4s).")
                    .font(.callout).foregroundStyle(.secondary)
                SettingsCardBox(title: "Visible sections") {
                    Toggle("Status header (provider + embedding state)", isOn: $showProviderDot)
                    Toggle("Local AI submenu", isOn: $showLocalAI)
                    Toggle("Recent activity submenu", isOn: $showRecent)
                }
                SettingsCardBox(title: "Current snapshot") {
                    if let snap = client.snapshot {
                        Text("Provider: \(snap.providers.first(where: { $0.id == snap.activeProviderId })?.label ?? "—")")
                            .font(.callout)
                        if let mem = snap.memory {
                            MemoryBudgetBar(memory: mem)
                        }
                        HStack {
                            StatusPill(label: "Embed", on: snap.embed.running, subtitle: nil)
                            StatusPill(label: "Chat", on: snap.localChat.running, subtitle: snap.localChat.preset)
                            StatusPill(label: "Companion", on: snap.companion.running, subtitle: snap.companion.preset)
                        }
                    } else {
                        ProgressView()
                    }
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

// MARK: - Window

struct SettingsWindowTab: View {
    @ObservedObject var client: DetourClient
    @AppStorage("detour.window.hideOnBlur") private var hideOnBlur = false
    @AppStorage("detour.window.alwaysOnTop") private var alwaysOnTop = false
    @AppStorage("detour.window.rememberSize") private var rememberSize = true
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Window").font(.title2).bold()
                Text("Per-window behavior for the SwiftUI surfaces (Settings, Activity, Pensieve, …). Window state is autosaved to UserDefaults under each window's frame autosave name.")
                    .font(.callout).foregroundStyle(.secondary)
                SettingsCardBox(title: "Behavior") {
                    Toggle("Hide window when focus leaves it", isOn: $hideOnBlur)
                    Toggle("Always on top", isOn: $alwaysOnTop)
                    Toggle("Remember window size + position", isOn: $rememberSize)
                }
                SettingsCardBox(title: "Reset state") {
                    Button("Forget all saved window frames") {
                        let defaults = UserDefaults.standard
                        for key in defaults.dictionaryRepresentation().keys
                        where key.hasPrefix("NSWindow Frame Detour") {
                            defaults.removeObject(forKey: key)
                        }
                    }
                    Text("Next time you open a window it'll be centered at its default size.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

// MARK: - OS Permissions

struct SettingsOsPermissionsTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("OS Permissions").font(.title2).bold()
                Text("macOS TCC entries the agent uses. We can't query them programmatically without prompting — these buttons open the System Settings pane directly so you can review/revoke.")
                    .font(.callout).foregroundStyle(.secondary)
                SettingsCardBox(title: "TCC panes") {
                    SettingsTccRow(label: "Accessibility (window control, key sending)",
                                   url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                    SettingsTccRow(label: "Automation (AppleScript dispatch)",
                                   url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
                    SettingsTccRow(label: "Screen Recording",
                                   url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                    SettingsTccRow(label: "Files & Folders",
                                   url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
                    SettingsTccRow(label: "Camera",
                                   url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
                    SettingsTccRow(label: "Microphone",
                                   url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
                    SettingsTccRow(label: "Contacts",
                                   url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts")
                    SettingsTccRow(label: "Calendars",
                                   url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

struct SettingsTccRow: View {
    let label: String
    let url: String
    var body: some View {
        HStack {
            Image(systemName: "checkmark.shield").foregroundStyle(.secondary)
            Text(label)
            Spacer()
            Button("Open…") {
                if let u = URL(string: url) {
                    NSWorkspace.shared.open(u)
                }
            }.controlSize(.small)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Agent Permissions

struct SettingsAgentPermissionsTab: View {
    @ObservedObject var client: DetourClient
    @AppStorage("detour.agent.vaultRead") private var vaultRead = true
    @AppStorage("detour.agent.vaultWrite") private var vaultWrite = false
    @AppStorage("detour.agent.browserUse") private var browserUse = true
    @AppStorage("detour.agent.computerUse") private var computerUse = false
    @AppStorage("detour.agent.codingTools") private var codingTools = true
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Agent Permissions").font(.title2).bold()
                Text("Scope of trust granted to Detour Squirrel. These flags gate destructive or sensitive actions at the runtime layer.")
                    .font(.callout).foregroundStyle(.secondary)
                SettingsCardBox(title: "Capabilities") {
                    Toggle("Vault read (load secrets into action params)", isOn: $vaultRead)
                    Toggle("Vault write (store new secrets via VAULT_PUT)", isOn: $vaultWrite)
                    Toggle("Browser use (agent-browser actions)", isOn: $browserUse)
                    Toggle("Computer use (mouse / keyboard automation)", isOn: $computerUse)
                    Toggle("Coding tools (Claude Code / Codex / Aider spawn)", isOn: $codingTools)
                }
                SettingsCardBox(title: "Risky-action gating") {
                    Text("Destructive actions (DELETE, FORCE_PUSH, vault edits) always prompt regardless of these toggles. The flags above are coarse scopes; per-action gates run on top.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

// MARK: - Character

struct SettingsCharacterTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Agent Character").font(.title2).bold()
                Text("Bio, lore, voice templates — the agent's persona. The current build ships with Detour Squirrel's identity bundled in the knowledge pack; editing happens via the character file under ~/.detour/character.json.")
                    .font(.callout).foregroundStyle(.secondary)
                SettingsCardBox(title: "Character file") {
                    HStack {
                        Image(systemName: "doc.text").foregroundStyle(.secondary)
                        Text("~/.detour/character.json").font(.system(.callout, design: .monospaced))
                        Spacer()
                        Button("Reveal in Finder") {
                            let path = (NSString(string: "~/.detour/character.json").expandingTildeInPath)
                            NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: NSString(string: "~/.detour").expandingTildeInPath)
                        }.controlSize(.small)
                    }
                }
                SettingsCardBox(title: "Knowledge pack") {
                    Text("Detour Squirrel's bundled knowledge (bio.md, x-voice.md, ecosystem.md, identity.md, …) loads from Resources/app/knowledge/detour-squirrel/ on boot. Memories ingested from these files surface in Pensieve.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Open Pensieve → Memories") {
                        WindowFactory.shared.openPensieve()
                    }.controlSize(.small)
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

// MARK: - Audio

struct SettingsAudioTab: View {
    @ObservedObject var client: DetourClient
    @AppStorage("detour.audio.ttsProvider") private var ttsProvider = "system"
    @AppStorage("detour.audio.voiceId") private var voiceId = ""
    @AppStorage("detour.audio.testText") private var testText = "Detour Squirrel checking in."
    @State private var lastTestStatus: String? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Audio").font(.title2).bold()
                Text("Voice synthesis + audio generation. The system voice uses macOS AVSpeechSynthesizer and works offline; the other providers need API keys in `~/.detour/.env`.")
                    .font(.callout).foregroundStyle(.secondary)
                GlassCard("TTS provider") {
                    Picker("Provider", selection: $ttsProvider) {
                        Text("macOS system voice").tag("system")
                        Text("ElevenLabs").tag("elevenlabs")
                        Text("Cartesia").tag("cartesia")
                        Text("OpenAI TTS").tag("openai")
                    }.pickerStyle(.menu)
                    if ttsProvider != "system" {
                        TextField("Voice ID (provider-specific)", text: $voiceId).textFieldStyle(.roundedBorder)
                    }
                }
                GlassCard("Test") {
                    TextField("Test phrase", text: $testText).textFieldStyle(.roundedBorder)
                    HStack {
                        Button("Speak now") { runTest() }.buttonStyle(.borderedProminent)
                        if let s = lastTestStatus {
                            Text(s).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer()
            }
            .padding(20)
        }
    }

    private func runTest() {
        if ttsProvider == "system" {
            let utterance = AVSpeechUtterance(string: testText)
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
            AudioSpeaker.shared.synth.speak(utterance)
            lastTestStatus = "spoke via macOS"
        } else {
            // Cloud providers: route through the agent's TTS action.
            // The agent renders to a temp file and (per the *-media
            // plugins) plays it back via the OS audio path.
            client.openDetourURL("detour://action?name=AUDIO_GENERATE_SPEECH&text=\(testText.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")&voice=\(voiceId)")
            lastTestStatus = "queued via agent (\(ttsProvider))"
        }
    }
}

/// Long-lived speech synthesizer — AVSpeechSynthesizer stops speaking
/// when its containing view is destroyed if it's a @State. Keep one
/// process-scoped instance so the test phrase always completes.
final class AudioSpeaker: @unchecked Sendable {
    static let shared = AudioSpeaker()
    let synth = AVSpeechSynthesizer()
    private init() {}
}

// MARK: - Skills

struct SettingsSkillsTab: View {
    @ObservedObject var client: DetourClient
    @State private var skills: [NativeSkill] = []
    @State private var filter: String = ""

    private var filtered: [NativeSkill] {
        if filter.isEmpty { return skills }
        let q = filter.lowercased()
        return skills.filter { s in
            s.id.lowercased().contains(q) ||
            s.description.lowercased().contains(q)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Skills").font(.title2).bold()
                    Spacer()
                    TextField("Filter…", text: $filter).textFieldStyle(.roundedBorder).frame(width: 200)
                    Button(action: { refresh() }) {
                        Image(systemName: "arrow.clockwise")
                    }.buttonStyle(.borderless)
                }
                Text("Bundled and user-installed agent plugins. Toggle to enable/disable. Disabled plugins won't load on next agent boot. Read natively from SKILL.md files on disk — no HTTP roundtrip.")
                    .font(.callout).foregroundStyle(.secondary)
                GlassCard("Installed plugins") {
                    if filtered.isEmpty {
                        Text("No skills found.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(filtered) { s in
                            NativeSkillRow(skill: s, onToggle: { newValue in
                                _ = NativeSkillsReader.setEnabled(s.id, enabled: newValue)
                                refresh()
                            })
                        }
                    }
                }
                Spacer()
            }
            .padding(20)
        }
        .onAppear { refresh() }
    }

    private func refresh() {
        skills = NativeSkillsReader.list()
    }
}

struct NativeSkillRow: View {
    let skill: NativeSkill
    let onToggle: (Bool) -> Void
    @State private var enabled: Bool
    init(skill: NativeSkill, onToggle: @escaping (Bool) -> Void) {
        self.skill = skill
        self.onToggle = onToggle
        self._enabled = State(initialValue: skill.enabled)
    }
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if let emoji = skill.emoji, !emoji.isEmpty {
                Text(emoji).font(.title3).frame(width: 28)
            } else {
                Image(systemName: enabled ? "wrench.and.screwdriver.fill" : "wrench.and.screwdriver")
                    .foregroundStyle(enabled ? Color.accentColor : .secondary)
                    .frame(width: 28)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(skill.id).font(.callout).fontWeight(.medium)
                Text(skill.description.isEmpty ? skill.baseDir : skill.description)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            Toggle("", isOn: $enabled)
                .labelsHidden()
                .onChange(of: enabled) { _, newValue in onToggle(newValue) }
        }
        .padding(.vertical, 4)
    }
}

struct SettingsSkillWire: Decodable, Identifiable {
    let id: String         // plugin name
    let label: String
    let description: String?
    let enabled: Bool
    let actionCount: Int?
}

struct SettingsSkillRow: View {
    let skill: SettingsSkillWire
    let client: DetourClient
    let refresh: () async -> Void
    @State private var enabled: Bool
    init(skill: SettingsSkillWire, client: DetourClient, refresh: @escaping () async -> Void) {
        self.skill = skill
        self.client = client
        self.refresh = refresh
        self._enabled = State(initialValue: skill.enabled)
    }
    var body: some View {
        HStack {
            Image(systemName: enabled ? "wrench.and.screwdriver.fill" : "wrench.and.screwdriver")
                .foregroundStyle(enabled ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 1) {
                HStack {
                    Text(skill.label.isEmpty ? skill.id : skill.label).font(.callout).fontWeight(.medium)
                    if let n = skill.actionCount, n > 0 {
                        Text("\(n) action\(n == 1 ? "" : "s")")
                            .font(.caption2).foregroundStyle(.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.gray.opacity(0.15))
                            .clipShape(Capsule())
                    }
                }
                Text(skill.description ?? skill.id)
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            Toggle("", isOn: $enabled)
                .labelsHidden()
                .onChange(of: enabled) { _, newValue in
                    Task {
                        await client.postEval("api/eval/skills/\(skill.id)",
                                              body: ["enabled": newValue])
                        await refresh()
                    }
                }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Phantom Wallet

struct SettingsPhantomTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Phantom Wallet").font(.title2).bold()
                Text("Embedded Phantom Connect for Solana + EVM. User custody — the agent never sees private keys. Use the Phantom Portal config helpers to set up Allowed Origins / Redirect URLs.")
                    .font(.callout).foregroundStyle(.secondary)
                SettingsCardBox(title: "Portal config") {
                    Text("Required Phantom Portal entries (paste into portal.phantom.com):")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Text("Allowed origins").font(.callout)
                        Spacer()
                        Text("http://localhost:2138, views://main").font(.system(.caption, design: .monospaced))
                    }
                    HStack {
                        Text("Redirect URLs").font(.callout)
                        Spacer()
                        Text("detour://phantom/callback").font(.system(.caption, design: .monospaced))
                    }
                }
                SettingsCardBox(title: "Connect") {
                    Text("Phantom Connect runs only inside the main React shell today (the agent-browser webview is bundle-isolated). Tap to open it.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Open agent browser") { WindowFactory.shared.open(target: "browser") }.controlSize(.small)
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

// MARK: - Vault tabs

/// Vault tab — now consolidates Inventory + Saved Logins + Backends in
/// one scrolling view. Three sidebar entries became one.
struct SettingsVaultInventoryTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Vault").font(.title2).bold()
                Text("Encrypted credential store: secrets, saved logins, password-manager backends. Everything decrypted via the system Keychain master key.")
                    .font(.callout).foregroundStyle(.secondary)

                GlassCard("Storage", systemImage: "lock.rectangle.stack") {
                    HStack {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                        Text("~/.detour/vault/").font(.system(.callout, design: .monospaced))
                        Spacer()
                        Button("Reveal") {
                            let path = NSString(string: "~/.detour/vault").expandingTildeInPath
                            NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: NSString(string: "~/.detour").expandingTildeInPath)
                        }.controlSize(.small)
                    }
                    Text("Master key cached for the process lifetime via the `security` framework, locked to the active macOS user account.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                GlassCard("Saved logins", systemImage: "rectangle.and.text.magnifyingglass") {
                    Text("Browser autofill credentials surfaced to the agent. Detail editing happens directly in your password manager — Detour reads on demand.")
                        .font(.caption).foregroundStyle(.secondary)
                    SettingsInfoRow(icon: "key", title: "1Password", subtitle: "via Connect Server token (vault key `op.token`)")
                    SettingsInfoRow(icon: "key", title: "Bitwarden", subtitle: "via session token (`bw unlock` → vault key `bw.session`)")
                    SettingsInfoRow(icon: "key", title: "in-house", subtitle: "encrypted JSON at ~/.detour/vault/logins.enc")
                }

                GlassCard("Backends", systemImage: "shippingbox") {
                    Text("Password-manager backends Detour can read from. Toggle by putting the matching credential in the vault.")
                        .font(.caption).foregroundStyle(.secondary)
                    SettingsInfoRow(icon: "checkmark.circle", title: "1Password", subtitle: "Active when `op.token` is set")
                    SettingsInfoRow(icon: "checkmark.circle", title: "Bitwarden", subtitle: "Active when `bw.session` is set")
                    SettingsInfoRow(icon: "circle", title: "ProtonPass", subtitle: "No native integration — use 1Password or Bitwarden")
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

struct SettingsSavedLoginsTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Saved Logins").font(.title2).bold()
                Text("Browser autofill credentials surfaced to the agent (1Password / Bitwarden / in-house). The native catalog isn't ported yet — for now, manage entries directly in your password manager.")
                    .font(.callout).foregroundStyle(.secondary)
                SettingsCardBox(title: "Sources") {
                    SettingsInfoRow(icon: "key", title: "1Password", subtitle: "via 1Password Connect Server token")
                    SettingsInfoRow(icon: "key", title: "Bitwarden", subtitle: "via session token (bw unlock)")
                    SettingsInfoRow(icon: "key", title: "in-house", subtitle: "encrypted JSON in ~/.detour/vault/logins.enc")
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

struct SettingsBackendsTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Backends").font(.title2).bold()
                Text("Enable and sign in to password-manager backends so saved logins flow into the agent.")
                    .font(.callout).foregroundStyle(.secondary)
                SettingsCardBox(title: "Available backends") {
                    SettingsInfoRow(icon: "shippingbox", title: "1Password", subtitle: "Connect token in vault key `op.token`")
                    SettingsInfoRow(icon: "shippingbox", title: "Bitwarden", subtitle: "Session in vault key `bw.session`")
                    SettingsInfoRow(icon: "shippingbox", title: "ProtonPass", subtitle: "Not currently supported — use 1Password or Bitwarden")
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

// MARK: - Cloud

/// Cloud tab — consolidates Eliza Cloud auth + Apps + Containers in
/// one view. Three sidebar entries became one.
struct SettingsElizaCloudTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Cloud").font(.title2).bold()
                Text("Eliza Cloud auth, managed app deployments, and managed container runtime. All cloud-managed surfaces of Detour in one place.")
                    .font(.callout).foregroundStyle(.secondary)

                GlassCard("Eliza Cloud", systemImage: "cloud") {
                    let configured = client.snapshot?.providers.first(where: { $0.id == "elizacloud" })?.configured ?? false
                    HStack {
                        Image(systemName: configured ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(configured ? Color.green : .secondary)
                        Text("Status: \(configured ? "signed in" : "signed out")").font(.callout)
                        Spacer()
                        Button(configured ? "Sign out" : "Sign in…") {
                            client.openDetourURL("detour://action?name=ELIZACLOUD_AUTH_TOGGLE")
                        }.controlSize(.small)
                    }
                    Text("OAuth opens in your default browser; the token lands at `~/.eliza/auth` and is shared with any other Eliza app on this Mac.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                GlassCard("Managed apps", systemImage: "shippingbox.fill") {
                    Text("Spawned by the agent via `SPAWN_CLOUD_AGENT`. Listing the live deployments isn't wired to a native endpoint yet — the agent surfaces them in chat.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("No deployments visible.")
                        .font(.caption).foregroundStyle(.tertiary)
                }

                GlassCard("Containers", systemImage: "rectangle.stack.fill") {
                    Text("Managed container runtime. The agent's cloud-orchestrator plugin lists / starts / stops containers via the CLOUD_LIST_CONTAINERS / CLOUD_RUN_CONTAINER actions — invoke from chat or click below.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("List containers") {
                            client.openDetourURL("detour://action?name=CLOUD_LIST_CONTAINERS")
                        }.controlSize(.small)
                        Button("List apps") {
                            client.openDetourURL("detour://action?name=CLOUD_LIST_APPS")
                        }.controlSize(.small)
                    }
                }
                Spacer()
            }
            .padding(20)
        }
    }
}

// SettingsCloudAppsTab + SettingsCloudContainersTab removed in the
// 2026-05 consolidation — both Cloud surfaces are folded into the one
// SettingsElizaCloudTab "Cloud" view (Eliza Cloud auth + Apps section
// + Containers section in a single scrolling card). Routing in
// SettingsSurface.tabBody points .elizaCloud / .cloudApps /
// .cloudContainers all at SettingsElizaCloudTab.

// MARK: - Notifications

struct SettingsNotificationsTab: View {
    @State private var status: String = "—"
    @State private var lastTestResult: String? = nil
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Notifications").font(.title2).bold()
                Text("Detour posts native macOS notifications (top-right of your screen) when the agent finishes a turn, a sub-agent state changes, or something fails in the background — same delivery as Mail/Slack/X.")
                    .font(.callout).foregroundStyle(.secondary)

                GlassCard("Test", systemImage: "bell.badge") {
                    Text("Press the button — a banner should appear top-right within 1–2 seconds. If nothing shows, check the authorization status below.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("Send test notification") {
                            Task {
                                let result = await NotificationManager.shared.sendTestNotification()
                                await MainActor.run { lastTestResult = result }
                            }
                        }.buttonStyle(.borderedProminent)
                        if let r = lastTestResult {
                            Text(r).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Button("Open System Settings → Notifications") {
                        NotificationManager.shared.openSystemSettings()
                    }.controlSize(.small)
                }

                GlassCard("What triggers a notification", systemImage: "list.bullet") {
                    SettingsInfoRow(icon: "checkmark.bubble", title: "Detour replied",
                                    subtitle: "After every chat turn the agent completes (chatComplete)")
                    SettingsInfoRow(icon: "person.crop.circle.badge.checkmark", title: "Sub-agent finished",
                                    subtitle: "Worker reached completed / failed / blocked state (workerStatusUpdate)")
                    SettingsInfoRow(icon: "exclamationmark.triangle", title: "Trajectory failed",
                                    subtitle: "Action planner exhausted retries (trajectoryFailed)")
                    SettingsInfoRow(icon: "creditcard", title: "Provider quota exhausted",
                                    subtitle: "Switch provider in Settings → Providers")
                    SettingsInfoRow(icon: "sparkles", title: "Detour reflected",
                                    subtitle: "Dreaming applied a persona/behavior tweak (dreamApplied)")
                }

                GlassCard("Why might banners not show?", systemImage: "questionmark.circle") {
                    Text("• Authorization denied at first launch → open System Settings via the button above and flip the Detour toggle on.")
                        .font(.caption)
                    Text("• Focus / Do Not Disturb active — banners are queued until your focus ends.")
                        .font(.caption)
                    Text("• Ad-hoc-signed builds (our dev path) need the app launched from a stable location — moving Detour.app to /Applications fixes some flaky cases.")
                        .font(.caption)
                }

                Spacer()
            }
            .padding(20)
        }
    }
}

// MARK: - Misc info-only row used by Vault / Backends placeholders.
struct SettingsInfoRow: View {
    let icon: String
    let title: String
    let subtitle: String
    var body: some View {
        HStack {
            Image(systemName: icon).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.callout).fontWeight(.medium)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 1)
    }
}

// MARK: - Shared card primitive (now Liquid Glass)

/// Liquid-Glass-backed card. Identical surface to the older overlay-stroke
/// box — call sites stay untouched, the material updates everywhere.
struct SettingsCardBox<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        GlassCard(title) { content }
    }
}
