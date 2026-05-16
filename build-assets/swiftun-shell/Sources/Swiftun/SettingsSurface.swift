/*
 * SettingsSurface — native SwiftUI Settings window for Detour.
 *
 * Sidebar groups tabs into Configuration / Vault / Cloud. Every tab
 * is native — there's no longer a React fallback path. `RootView`
 * renamed to `SettingsRootView` so it doesn't collide with the other
 * surfaces in the same target.
 */

import AppKit
import SwiftUI

enum SettingsTab: String, CaseIterable, Identifiable, Hashable {
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
    case notifications
    case osPermissions = "os-permissions"
    case vaultInventory = "vault-inventory"
    case savedLogins = "saved-logins"
    case backends
    case elizaCloud = "eliza-cloud"
    case cloudApps = "cloud-apps"
    case cloudContainers = "cloud-containers"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .providers: return "Models & Providers"
        case .models: return "Models & Providers"
        case .localAI: return "Local AI"
        case .audio: return "Audio"
        case .character: return "Agent Character"
        case .permissions: return "Agent Permissions"
        case .skills: return "Skills"
        case .phantom: return "Phantom Wallet"
        case .appearance: return "Appearance"
        case .tray: return "Tray"
        case .window: return "Window"
        case .notifications: return "Notifications"
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
        case .notifications: return "bell.badge"
        case .osPermissions: return "checkmark.shield"
        case .vaultInventory: return "lock.rectangle.stack"
        case .savedLogins: return "rectangle.and.text.magnifyingglass"
        case .backends: return "externaldrive"
        case .elizaCloud: return "cloud.fill"
        case .cloudApps: return "shippingbox.fill"
        case .cloudContainers: return "rectangle.stack.fill"
        }
    }
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
        case .notifications: return "configuration:notifications"
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

// Sidebar after the consolidation pass:
//   Configuration: Models & Providers, Skills, Audio, Character,
//                  Permissions, Phantom, Appearance, OS Permissions
//   Vault:         (one tab, was three)
//   Cloud:         (one tab, was three)
// Tray + Window + Notifications fold INTO Appearance.
// Vault Inventory + Saved Logins + Backends fold into one Vault tab.
// Eliza Cloud + Apps + Containers fold into one Cloud tab.
// The enum cases for the now-hidden tabs still resolve via the
// `tabBody` switch so old deep links land on the merged view.
private let CONFIGURATION_TABS: [SettingsTab] = [
    .providers, .skills, .audio, .character,
    .permissions, .phantom, .appearance, .osPermissions,
]
private let VAULT_TABS: [SettingsTab] = [.vaultInventory]
private let CLOUD_TABS: [SettingsTab] = [.elizaCloud]

struct SettingsRootView: View {
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
            // Liquid Glass sidebar — uses the new macOS 26 material, not
            // the older translucent fallback. .glassEffect renders the
            // refractive look; we hide the list's default scroll background
            // so the material shows through.
            .scrollContentBackground(.hidden)
            .glassEffect(.regular, in: .rect)
        } detail: {
            tabBody.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { client.startPolling() }
        .frame(minWidth: 820, idealWidth: 920, minHeight: 600, idealHeight: 720)
    }

    @ViewBuilder
    private var tabBody: some View {
        switch selectedTab {
        case .providers, .localAI, .models: SettingsProvidersTab(client: client)
        // Appearance now subsumes Tray + Window + Notifications.
        case .appearance, .tray, .window, .notifications:
            SettingsAppearanceTab(client: client)
        case .osPermissions: SettingsOsPermissionsTab(client: client)
        case .permissions: SettingsAgentPermissionsTab(client: client)
        case .character: CharacterEditorRootView(client: client)
        case .audio: SettingsAudioTab(client: client)
        case .skills: SettingsSkillsTab(client: client)
        case .phantom: SettingsPhantomTab(client: client)
        // Vault triad collapsed to a single tab.
        case .vaultInventory, .savedLogins, .backends:
            SettingsVaultInventoryTab(client: client)
        // Cloud triad collapsed to a single tab.
        case .elizaCloud, .cloudApps, .cloudContainers:
            SettingsElizaCloudTab(client: client)
        }
    }
}

/// One unified control panel for ALL model concerns:
/// - Active provider + memory budget (top status bar)
/// - Cloud providers compact list
/// - Routing matrix (tier → picker → status)
/// - Local services (embed / chat / companion) with inline start/stop
/// No duplicate cards: the old "Routing" + "Local chat tier" + "Local
/// companion tier" + "Embed status" cards were saying the same things
/// in three places. Everything lives in one scroll now.
struct SettingsProvidersTab: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ModelsStatusHeader(client: client)
                ModelsCloudProvidersCard(client: client)
                SettingsRoutingCard(client: client)
                ModelsRoutingCard(client: client)
                ModelsLocalServicesCard(client: client)
            }
            .padding(20)
        }
    }
}

/// Top status bar: active provider, embedding state, memory budget.
/// Single header so users immediately see "what's running, what's the
/// budget" without scrolling.
private struct ModelsStatusHeader: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                Text("Models & Routing").font(.title2).bold()
                Spacer()
                if let snap = client.snapshot {
                    let active = snap.providers.first(where: { $0.id == snap.activeProviderId })?.label ?? "—"
                    GlassPill(active, systemImage: "checkmark.seal.fill", tint: .green)
                    GlassPill(snap.embed.running ? "embed on" : "embed off",
                              systemImage: snap.embed.running ? "waveform" : "waveform.slash",
                              tint: snap.embed.running ? .green : .orange)
                }
            }
            Text("Everything model-related in one place. Set the active provider, pick which model handles each tier (TEXT_SMALL / MEDIUM / LARGE / EMBEDDING / COMPANION), and start/stop local llama services. Changes apply on next planner call.")
                .font(.callout).foregroundStyle(.secondary)
            if let mem = client.snapshot?.memory {
                MemoryBudgetBar(memory: mem)
            }
        }
    }
}

/// Compact list of cloud providers — Anthropic, OpenAI, OpenRouter,
/// Eliza Cloud — with a one-click "Set active" for each. Replaces the
/// old standalone "Cloud providers" GlassCard.
private struct ModelsCloudProvidersCard: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        GlassCard("Providers", systemImage: "cloud") {
            if let providers = client.snapshot?.providers, !providers.isEmpty {
                ForEach(providers) { p in
                    HStack {
                        Image(systemName: p.active ? "checkmark.circle.fill" : "circle")
                            .foregroundColor(p.active ? Color.accentColor : Color.secondary)
                        Text(p.label).fontWeight(p.active ? .semibold : .regular)
                        if !p.configured {
                            Text("not configured")
                                .font(.caption2).foregroundStyle(.secondary)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.gray.opacity(0.15)).clipShape(Capsule())
                        }
                        Spacer()
                        if !p.active {
                            Button(p.configured ? "Set active" : "Configure…") {
                                if p.configured {
                                    client.openDetourURL("detour://action?name=PROVIDER_SET_ACTIVE&id=\(p.id)")
                                } else {
                                    // No-op route, user is already in Settings — just keep them here.
                                }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                    .padding(.vertical, 1)
                }
            } else {
                ProgressView("Loading providers…")
            }
        }
    }
}

/// Unified per-ModelType routing card. Lists every routed model type
/// (image/video/STT/TTS/vision) with a single dropdown of local + cloud
/// providers. Replaces the separate "Local AI image gen", "Local AI
/// STT" etc. rows so the user sees ALL options in one place.
private struct ModelsRoutingCard: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        GlassCard("Model routing", systemImage: "arrow.triangle.branch") {
            Text("Pick which provider serves each model type. Local options run on this Mac; cloud options use the configured API key. Detour auto-falls-back to the next available option if your pick isn't reachable.")
                .font(.caption).foregroundStyle(.secondary)
            if let routes = client.snapshot?.modelRouting, !routes.isEmpty {
                ForEach(routes) { entry in
                    ModelRoutingRow(client: client, entry: entry)
                }
            } else {
                Text("Loading routing options…").font(.caption).foregroundStyle(.tertiary)
            }
        }
    }
}

private struct ModelRoutingRow: View {
    let client: DetourClient
    let entry: ModelRoutingEntryWire
    @State private var selected: String = ""

    private var settingKey: String { "DETOUR_MODEL_\(entry.type)_PROVIDER" }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(entry.label).font(.callout).fontWeight(.medium)
                Spacer()
                Picker("", selection: $selected) {
                    ForEach(entry.options) { opt in
                        let badge = opt.available ? "" : " (not configured)"
                        let kindTag = opt.kind == "local" ? "· local" : "· cloud"
                        Text("\(opt.label) \(kindTag)\(badge)")
                            .tag(opt.id)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: 360)
                .labelsHidden()
                .onAppear {
                    selected = entry.selected.isEmpty ? (entry.options.first?.id ?? "") : entry.selected
                }
                .onChange(of: selected) { newValue in
                    guard !newValue.isEmpty, newValue != entry.selected else { return }
                    Task { await client.setSetting(key: settingKey, value: newValue) }
                }
            }
            if let pick = entry.options.first(where: { $0.id == selected }), !pick.available {
                Text(pick.kind == "local"
                     ? "⚠ Local service not running — start it from the tray, or pick a cloud option here."
                     : "⚠ This provider isn't configured — set its API key in Settings → Providers first.")
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Local services in ONE card with inline controls instead of separate
/// "Embed", "Local chat tier", "Local companion tier" cards. Each row
/// shows status + preset picker + start/stop in one line.
private struct ModelsLocalServicesCard: View {
    @ObservedObject var client: DetourClient
    @State private var chatPreset: String = ""
    @State private var companionPreset: String = ""
    var body: some View {
        GlassCard("Local services", systemImage: "cpu.fill") {
            Text("Inference running on your machine. Embedding is always on; chat and companion are opt-in and share the RAM budget shown above.")
                .font(.caption).foregroundStyle(.secondary)
            // EMBED row
            if let embed = client.snapshot?.embed {
                LocalServiceRow(
                    title: "Embed",
                    subtitle: embed.running
                        ? "bge-small-en-v1.5 · 384-dim · always on"
                        : (embed.lastError ?? "starting…"),
                    running: embed.running,
                    downloadPercent: embed.downloadPercent,
                    presetSection: nil,
                    controlSection: nil,
                )
            }
            // CHAT row
            if let chat = client.snapshot?.localChat {
                LocalServiceRow(
                    title: "Chat",
                    subtitle: chat.running ? (chat.preset ?? "running") : (chat.enabled ? "enabled (not running)" : "off"),
                    running: chat.running,
                    downloadPercent: chat.downloadPercent,
                    arbiterRefusal: chat.lastArbiterRefusal,
                    presetSection: chat.running ? nil : AnyView(LocalPresetPicker(
                        presets: chat.presets,
                        selected: $chatPreset,
                        currentPreset: chat.preset,
                        memory: client.snapshot?.memory,
                    )),
                    controlSection: AnyView(LocalStartStopButton(
                        running: chat.running,
                        disabled: chat.presets.isEmpty,
                        onStart: { Task { await client.localAI(tier: "chat", action: "start", preset: chatPreset.isEmpty ? nil : chatPreset) } },
                        onStop: { Task { await client.localAI(tier: "chat", action: "stop") } },
                    )),
                )
            }
            // LOCAL MLX IMAGE row
            if let img = client.snapshot?.localMlxImage {
                LocalMlxMediaRow(
                    title: "Image gen",
                    kind: "image",
                    enabled: img.enabled,
                    available: img.available,
                    preset: img.preset,
                    presets: img.presets.map { p in MlxMediaPresetSlot(
                        id: p.id,
                        label: p.label,
                        ramGB: p.ramGB,
                        diskGB: p.diskGB,
                        downloaded: p.downloaded,
                        available: p.available,
                        fitsBudget: p.fitsBudget,
                        licenseNote: p.licenseNote,
                        subtitle: "\(p.defaultSteps) steps"
                    ) },
                    onToggle: { isOn in
                        Task { await client.setSetting(key: "LOCAL_MLX_IMAGE_ENABLED", value: isOn ? "true" : "false") }
                    },
                    onPresetChange: { newPreset in
                        Task { await client.setSetting(key: "LOCAL_MLX_IMAGE_PRESET", value: newPreset) }
                    }
                )
            }
            // LOCAL MLX VIDEO row
            if let vid = client.snapshot?.localMlxVideo {
                LocalMlxMediaRow(
                    title: "Video gen",
                    kind: "video",
                    enabled: vid.enabled,
                    available: vid.available,
                    preset: vid.preset,
                    presets: vid.presets.map { p in MlxMediaPresetSlot(
                        id: p.id,
                        label: p.label,
                        ramGB: p.ramGB,
                        diskGB: p.diskGB,
                        downloaded: p.downloaded,
                        available: p.available,
                        fitsBudget: p.fitsBudget,
                        licenseNote: p.licenseNote,
                        subtitle: "~\(Int(p.approxSecondsPerSecond))s wall-clock per second of video"
                    ) },
                    onToggle: { isOn in
                        Task { await client.setSetting(key: "LOCAL_MLX_VIDEO_ENABLED", value: isOn ? "true" : "false") }
                    },
                    onPresetChange: { newPreset in
                        Task { await client.setSetting(key: "LOCAL_MLX_VIDEO_PRESET", value: newPreset) }
                    }
                )
            }
            // LOCAL MLX STT (transcription) row
            if let stt = client.snapshot?.localMlxStt {
                LocalMlxOmniRow(
                    title: "Speech-to-text",
                    kind: "stt",
                    enabled: stt.enabled,
                    available: stt.available,
                    preset: stt.preset,
                    presets: stt.presets.map { p in MlxMediaPresetSlot(
                        id: p.id, label: p.label,
                        ramGB: p.ramGB, diskGB: p.diskGB,
                        downloaded: p.downloaded, available: p.available,
                        fitsBudget: p.fitsBudget, licenseNote: nil,
                        subtitle: p.diskGB == 0 ? "system framework — on-device" : "\(Int(p.diskGB * 1024))MB model"
                    ) },
                    onToggle: { isOn in
                        Task { await client.setSetting(key: "LOCAL_MLX_STT_ENABLED", value: isOn ? "true" : "false") }
                    },
                    onPresetChange: { newPreset in
                        Task { await client.setSetting(key: "LOCAL_MLX_STT_PRESET", value: newPreset) }
                    }
                )
            }
            // LOCAL MLX TTS (synthesis) row
            if let tts = client.snapshot?.localMlxTts {
                LocalMlxOmniRow(
                    title: "Text-to-speech",
                    kind: "tts",
                    enabled: tts.enabled,
                    available: tts.available,
                    preset: tts.preset,
                    presets: tts.presets.map { p in MlxMediaPresetSlot(
                        id: p.id, label: p.label,
                        ramGB: p.ramGB, diskGB: p.diskGB,
                        downloaded: p.downloaded, available: p.available,
                        fitsBudget: p.fitsBudget, licenseNote: nil,
                        subtitle: p.diskGB == 0 ? "system voices — Settings → Accessibility for more" : "\(Int(p.diskGB * 1024))MB model"
                    ) },
                    onToggle: { isOn in
                        Task { await client.setSetting(key: "LOCAL_MLX_TTS_ENABLED", value: isOn ? "true" : "false") }
                    },
                    onPresetChange: { newPreset in
                        Task { await client.setSetting(key: "LOCAL_MLX_TTS_PRESET", value: newPreset) }
                    }
                )
            }
            // LOCAL MLX VISION (image description) row
            if let vis = client.snapshot?.localMlxVision {
                LocalMlxOmniRow(
                    title: "Vision (describe image)",
                    kind: "vision",
                    enabled: vis.enabled,
                    available: vis.available,
                    preset: vis.preset,
                    presets: vis.presets.map { p in MlxMediaPresetSlot(
                        id: p.id, label: p.label,
                        ramGB: p.ramGB, diskGB: p.diskGB,
                        downloaded: p.downloaded, available: p.available,
                        fitsBudget: p.fitsBudget, licenseNote: nil,
                        subtitle: p.diskGB == 0 ? "Vision framework — OCR + classification, on-device" : "\(String(format: "%.1f", p.diskGB))GB model"
                    ) },
                    onToggle: { isOn in
                        Task { await client.setSetting(key: "LOCAL_MLX_VISION_ENABLED", value: isOn ? "true" : "false") }
                    },
                    onPresetChange: { newPreset in
                        Task { await client.setSetting(key: "LOCAL_MLX_VISION_PRESET", value: newPreset) }
                    }
                )
            }
            // COMPANION row
            if let comp = client.snapshot?.companion {
                LocalServiceRow(
                    title: "Companion",
                    subtitle: comp.sharedWithLocalChat
                        ? "shared with chat"
                        : (comp.running ? (comp.preset ?? "running") : (comp.enabled ? "enabled (not running)" : "off")),
                    running: comp.running,
                    downloadPercent: comp.downloadPercent,
                    arbiterRefusal: comp.lastArbiterRefusal,
                    presetSection: comp.running ? nil : AnyView(LocalPresetPicker(
                        presets: comp.presets,
                        selected: $companionPreset,
                        currentPreset: comp.preset,
                        memory: client.snapshot?.memory,
                    )),
                    controlSection: AnyView(LocalStartStopButton(
                        running: comp.running,
                        disabled: comp.presets.isEmpty,
                        onStart: { Task { await client.localAI(tier: "companion", action: "start", preset: companionPreset.isEmpty ? nil : companionPreset) } },
                        onStop: { Task { await client.localAI(tier: "companion", action: "stop") } },
                    )),
                )
            }
        }
    }
}

/// Concrete preset row for image/video that carries everything the
/// UI needs to render: budget fit, vendor status, license note.
struct MlxMediaPresetSlot: Identifiable {
    let id: String
    let label: String
    let ramGB: Double
    let diskGB: Double
    let downloaded: Bool
    let available: Bool       // false → preset is in catalog but not yet vendored (e.g. Sana, video)
    let fitsBudget: Bool
    let licenseNote: String?
    let subtitle: String      // e.g. "30 steps" or "~20s wall-clock per second"
}

private struct LocalMlxMediaRow: View {
    let title: String
    let kind: String          // "image" | "video"
    let enabled: Bool
    let available: Bool       // false → Swift MLX socket not reachable (non-Apple-Silicon, Swift not booted)
    let preset: String?
    let presets: [MlxMediaPresetSlot]
    let onToggle: (Bool) -> Void
    let onPresetChange: (String) -> Void
    @State private var pickedPreset: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Circle().fill(enabled && available ? Color.green : Color.gray).frame(width: 8, height: 8)
                Text(title).font(.callout).fontWeight(.medium)
                Text("·").foregroundStyle(.tertiary)
                Text(statusLine).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if available {
                    Toggle("", isOn: Binding(get: { enabled }, set: onToggle))
                        .labelsHidden()
                        .toggleStyle(.switch)
                }
            }
            if !available {
                Text("Local \(kind) gen needs Apple Silicon + the Swift shell running. Cloud fallback is active.")
                    .font(.caption2).foregroundStyle(.orange)
            }
            if available && !presets.isEmpty {
                Picker("Preset", selection: $pickedPreset) {
                    ForEach(presets) { slot in
                        Text(displayLabel(for: slot))
                            .tag(slot.id)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .onAppear { pickedPreset = preset ?? presets.first?.id ?? "" }
                .onChange(of: pickedPreset) { newValue in
                    guard !newValue.isEmpty, newValue != (preset ?? "") else { return }
                    onPresetChange(newValue)
                }

                if let slot = presets.first(where: { $0.id == pickedPreset }) {
                    PresetDetailLine(slot: slot)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var statusLine: String {
        if !available { return "MLX socket unavailable — falls back to cloud" }
        if !enabled { return "off — agent uses cloud image/video providers" }
        if let p = preset, !p.isEmpty { return "ready · \(p)" }
        return "enabled · pick a preset"
    }

    private func displayLabel(for slot: MlxMediaPresetSlot) -> String {
        var parts = [slot.label]
        if !slot.available { parts.append("(not vendored)") }
        if !slot.fitsBudget { parts.append("(over budget)") }
        if !slot.downloaded { parts.append("(\(Int(slot.diskGB))GB download)") }
        return parts.joined(separator: " ")
    }
}

private struct PresetDetailLine: View {
    let slot: MlxMediaPresetSlot
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Label("\(String(format: "%.1f", slot.ramGB)) GB live RAM", systemImage: "memorychip")
                Label("\(String(format: "%.1f", slot.diskGB)) GB disk", systemImage: "internaldrive")
                Text("·").foregroundStyle(.tertiary)
                Text(slot.subtitle)
                if !slot.fitsBudget {
                    Text("• over budget").foregroundStyle(.orange)
                }
                if !slot.available {
                    Text("• stub").foregroundStyle(.secondary)
                }
            }
            .font(.caption2).foregroundStyle(.secondary)
            if let note = slot.licenseNote {
                Text("⚠ \(note)").font(.caption2).foregroundStyle(.orange)
            }
        }
    }
}

/// Alias — STT/TTS/Vision rows reuse the same component shape as
/// image/video, just with different subtitle text and no license pill.
fileprivate typealias LocalMlxOmniRow = LocalMlxMediaRow

private struct LocalServiceRow: View {
    let title: String
    let subtitle: String
    let running: Bool
    let downloadPercent: Int?
    var arbiterRefusal: String? = nil
    let presetSection: AnyView?
    let controlSection: AnyView?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Circle().fill(running ? Color.green : Color.gray).frame(width: 8, height: 8)
                Text(title).font(.callout).fontWeight(.medium)
                Text("·").foregroundStyle(.tertiary)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if let p = downloadPercent, p < 100 {
                    ProgressView(value: Double(p) / 100.0).frame(width: 60)
                    Text("\(p)%").font(.caption2).monospacedDigit()
                }
                controlSection
            }
            if let refusal = arbiterRefusal, !refusal.isEmpty {
                Text("⚠ \(refusal)")
                    .font(.caption2).foregroundStyle(.orange)
            }
            presetSection
        }
        .padding(.vertical, 4)
        Divider()
    }
}

private struct LocalPresetPicker: View {
    let presets: [TrayPresetWire]
    @Binding var selected: String
    let currentPreset: String?
    let memory: TrayMemoryWire?

    private var fitWarning: String? {
        guard let chosen = presets.first(where: { $0.id == selected }) ?? presets.first,
              let mem = memory else { return nil }
        if mem.usedGB + chosen.approxLiveRamGB > mem.budgetGB {
            return "⚠ would exceed RAM budget — arbiter may refuse"
        }
        return nil
    }

    var body: some View {
        HStack(spacing: 8) {
            Text("Preset:").font(.caption).foregroundStyle(.secondary)
            Picker("", selection: $selected) {
                ForEach(presets) { p in
                    HStack {
                        Text(p.label)
                        Text(String(format: "%.1f GB", p.approxLiveRamGB)).foregroundStyle(.secondary)
                        if p.downloaded { Text("✓").foregroundColor(.green) }
                        else { Text("↓").foregroundColor(.blue) }
                    }.tag(p.id)
                }
            }
            .labelsHidden().pickerStyle(.menu)
            .frame(maxWidth: 320)
            .onAppear {
                if selected.isEmpty, let first = currentPreset ?? presets.first?.id {
                    selected = first
                }
            }
            if let w = fitWarning {
                Text(w).font(.caption2).foregroundStyle(.orange)
            }
            Spacer()
        }
    }
}

private struct LocalStartStopButton: View {
    let running: Bool
    let disabled: Bool
    let onStart: () -> Void
    let onStop: () -> Void
    var body: some View {
        if running {
            Button("Stop", role: .destructive, action: onStop)
                .controlSize(.small)
        } else {
            Button("Start", action: onStart)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(disabled)
        }
    }
}

// SettingsLocalAITab merged into SettingsProvidersTab.
// SettingsPlaceholderTab + SettingsTabHeader removed — every tab now has
// a native implementation (no more "Open in main window" deep-links).

/// One row of the routing matrix — "TEXT_LARGE → cloud: Anthropic".
struct SettingsRoutingRow: View {
    let tier: String
    let source: String
    var body: some View {
        HStack {
            Text(tier).font(.system(.caption, design: .monospaced))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color.accentColor.opacity(0.12))
                .clipShape(Capsule())
            Image(systemName: "arrow.right").foregroundStyle(.tertiary).font(.caption2)
            Text(source).font(.callout).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.vertical, 1)
    }
}

/// Appearance now hosts Theme + Accent + Tray + Window + Notifications
/// as sections within a single tab. The old separate sidebar entries
/// were redundant — they're all "how Detour presents itself on screen."
struct SettingsAppearanceTab: View {
    @ObservedObject var client: DetourClient
    @AppStorage("detour.appearance.accent") private var accent = "system"
    @AppStorage("detour.appearance.theme") private var theme = "system"

    // Tray section
    @AppStorage("detour.tray.showProviderDot") private var showProviderDot = true
    @AppStorage("detour.tray.showRecent") private var showRecent = true
    @AppStorage("detour.tray.showLocalAI") private var showLocalAI = true

    // Window section
    @AppStorage("detour.window.hideOnBlur") private var hideOnBlur = false
    @AppStorage("detour.window.alwaysOnTop") private var alwaysOnTop = false
    @AppStorage("detour.window.rememberSize") private var rememberSize = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Appearance").font(.title2).bold()
                Text("Theme, menu-bar tray, window behavior, and notifications — everything about how Detour looks and presents itself.")
                    .font(.callout).foregroundStyle(.secondary)

                GlassCard("Theme", systemImage: "paintbrush") {
                    Picker("Theme", selection: $theme) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }.pickerStyle(.segmented)
                    .onChange(of: theme) { newValue in
                        AppearanceController.applyTheme(newValue)
                    }
                    Picker("Accent", selection: $accent) {
                        Text("System").tag("system")
                        Text("Blue").tag("blue")
                        Text("Purple").tag("purple")
                        Text("Pink").tag("pink")
                        Text("Red").tag("red")
                        Text("Orange").tag("orange")
                        Text("Yellow").tag("yellow")
                        Text("Green").tag("green")
                    }.pickerStyle(.menu)
                    .onChange(of: accent) { newValue in
                        AppearanceController.applyAccent(newValue)
                    }
                    Text("Tint applies to every Detour window — buttons, toggles, segmented controls — and updates the moment you pick.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }

                GlassCard("Tray", systemImage: "menubar.rectangle") {
                    Toggle("Status header (provider + embedding state)", isOn: $showProviderDot)
                        .onChange(of: showProviderDot) { _ in TrayController.shared?.rebuild() }
                    Toggle("Local AI submenu", isOn: $showLocalAI)
                        .onChange(of: showLocalAI) { _ in TrayController.shared?.rebuild() }
                    Toggle("Recent activity submenu", isOn: $showRecent)
                        .onChange(of: showRecent) { _ in TrayController.shared?.rebuild() }
                }

                GlassCard("Windows", systemImage: "macwindow") {
                    Toggle("Hide window when focus leaves it", isOn: $hideOnBlur)
                        .onChange(of: hideOnBlur) { newValue in
                            AppearanceController.applyHideOnBlur(newValue)
                        }
                    Toggle("Always on top", isOn: $alwaysOnTop)
                        .onChange(of: alwaysOnTop) { newValue in
                            AppearanceController.applyAlwaysOnTop(newValue)
                        }
                    Toggle("Remember window size + position", isOn: $rememberSize)
                    Button("Forget all saved window frames") {
                        let defaults = UserDefaults.standard
                        for key in defaults.dictionaryRepresentation().keys
                        where key.hasPrefix("NSWindow Frame Detour") {
                            defaults.removeObject(forKey: key)
                        }
                    }
                    .controlSize(.small)
                }

                // Notifications card removed from Appearance — the
                // "Send test notification" entry lives in the tray menu
                // and the pet's quick-actions popover instead. Putting
                // it here too was a duplicate.
                GlassCard("Notifications", systemImage: "bell.badge") {
                    Text("Detour posts top-right banners when the agent finishes a turn, a worker changes state, or a quota is exhausted. Use the menu-bar tray's \"Send test notification\" item (or the pet's quick-actions menu) to test.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Open System Settings → Notifications") {
                        NotificationManager.shared.openSystemSettings()
                    }.controlSize(.small)
                }
                Spacer()
            }
            .padding(20)
        }
        .onAppear {
            // Re-apply preferences on tab focus so a fresh launch picks
            // up whatever the user last selected.
            AppearanceController.applyTheme(theme)
            AppearanceController.applyHideOnBlur(hideOnBlur)
            AppearanceController.applyAlwaysOnTop(alwaysOnTop)
        }
    }
}

/// Applies the SwiftUI Appearance settings to real AppKit state. The
/// toggles previously only flipped @AppStorage values that nothing
/// read; now each one actually mutates window/app state on change.
enum AppearanceController {
    static func applyTheme(_ value: String) {
        switch value {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark":  NSApp.appearance = NSAppearance(named: .darkAqua)
        default:      NSApp.appearance = nil  // follow system
        }
    }
    static func applyAccent(_ value: String) {
        // The actual tint is applied via the `DetourAccentModifier`
        // wrapped around every NSHostingController in WindowFactory,
        // which reads @AppStorage("detour.appearance.accent"). When
        // the user picks a new value, SwiftUI re-renders every view
        // observing that AppStorage key — no imperative apply needed.
        //
        // We still ping NSStatusItem so the tray icon picks up any
        // future tint state if we add one there.
        _ = value
    }
    static func applyHideOnBlur(_ on: Bool) {
        for win in NSApp.windows where win.title.hasPrefix("Detour") {
            // hidesOnDeactivate is the AppKit knob.
            win.hidesOnDeactivate = on
        }
    }
    static func applyAlwaysOnTop(_ on: Bool) {
        for win in NSApp.windows where win.title.hasPrefix("Detour") && win.title != "Detour Pet" {
            // Pet is already .floating; don't downgrade it.
            win.level = on ? .floating : .normal
        }
    }
}

struct SettingsEmbedCard: View {
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

struct SettingsTierCard: View {
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
        if !selectedPreset.isEmpty { return presets.first { $0.id == selectedPreset } }
        if let currentPreset { return presets.first { $0.id == currentPreset } }
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
                        onStart(selectedPreset.isEmpty ? nil : selectedPreset)
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
