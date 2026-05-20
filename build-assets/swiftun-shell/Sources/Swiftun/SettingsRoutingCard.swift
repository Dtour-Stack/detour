/*
 * SettingsRoutingCard — editable model routing per tier.
 *
 * eliza's planner asks for models by tier (TEXT_LARGE, TEXT_SMALL,
 * EMBEDDING, …) and each registered provider exposes handlers for the
 * tiers it supports. Today the planner fails with "No handler found for
 * delegate type: TEXT_LARGE" when the active provider doesn't satisfy
 * the requested tier. This card lets the user assign each tier
 * explicitly:
 *   - SOURCE: local llama (when running), openrouter, anthropic,
 *             elizacloud, openai, codex
 *   - MODEL:  per-source model id (claude-3.7-sonnet, gpt-4o, …)
 *
 * Writes flow through POST /api/eval/models → ConfigService.setModels,
 * which immediately updates process.env so the next planner call uses
 * the new override.
 */

import SwiftUI

struct ModelConfigWire: Codable, Equatable {
    var codexLarge: String
    var codexSmall: String
    var codexImage: String
    var openRouterTextLarge: String
    var openRouterTextSmall: String
    var openRouterEmbedding: String
    var openRouterImage: String
    var openRouterVideo: String
    var openRouterVision: String
    var elizaCloudLarge: String
    var elizaCloudMedium: String
    var elizaCloudSmall: String
    var elizaCloudNano: String
    var elizaCloudMega: String
    var elizaCloudResponseHandler: String
    var elizaCloudImage: String
    var elizaCloudVideo: String
}

@MainActor
final class RoutingViewModel: ObservableObject {
    @Published var models: ModelConfigWire? = nil
    @Published var saving: Bool = false
    @Published var status: String? = nil
    @Published var plannerTier: String = ""  // "", "TEXT_SMALL", "TEXT_MEDIUM", "TEXT_LARGE"
    let client: DetourClient
    init(client: DetourClient) { self.client = client }

    func load() async {
        struct Wrap: Decodable { let models: ModelConfigWire }
        if let w: Wrap = await client.getEvalJSON("api/eval/models", as: Wrap.self) {
            await MainActor.run { self.models = w.models }
        }
        struct PinnedWrap: Decodable { let tier: String }
        if let p: PinnedWrap = await client.getEvalJSON("api/eval/planner-tier", as: PinnedWrap.self) {
            await MainActor.run { self.plannerTier = p.tier }
        }
    }

    func setPlannerTier(_ tier: String) async {
        await client.postEval("api/eval/planner-tier", body: ["tier": tier])
        await MainActor.run { self.plannerTier = tier; self.status = tier.isEmpty ? "Planner uses default tier cascade." : "Planner pinned to \(tier)." }
    }

    func save() async {
        guard let m = models else { return }
        await MainActor.run { saving = true }
        let body: [String: Any] = [
            "codexLarge": m.codexLarge, "codexSmall": m.codexSmall, "codexImage": m.codexImage,
            "openRouterTextLarge": m.openRouterTextLarge,
            "openRouterTextSmall": m.openRouterTextSmall,
            "openRouterEmbedding": m.openRouterEmbedding,
            "openRouterImage": m.openRouterImage,
            "openRouterVideo": m.openRouterVideo,
            "openRouterVision": m.openRouterVision,
            "elizaCloudLarge": m.elizaCloudLarge,
            "elizaCloudMedium": m.elizaCloudMedium,
            "elizaCloudSmall": m.elizaCloudSmall,
            "elizaCloudNano": m.elizaCloudNano,
            "elizaCloudMega": m.elizaCloudMega,
            "elizaCloudResponseHandler": m.elizaCloudResponseHandler,
            "elizaCloudImage": m.elizaCloudImage,
            "elizaCloudVideo": m.elizaCloudVideo,
        ]
        let ok = await client.postEval("api/eval/models", body: body)
        await MainActor.run {
            saving = false
            status = ok ? "Saved — planner will use new routing on next call." : "Save failed."
        }
    }
}

/// One pickable source for a tier. We don't enforce that every source
/// supports every tier — empty model ids are tolerated by the planner
/// (it falls back to provider default).
enum RoutingSource: String, CaseIterable, Identifiable, Hashable {
    case local
    case openrouter
    case anthropic
    case elizacloud
    case openai
    case codex
    var id: String { rawValue }
    var label: String {
        switch self {
        case .local: return "Local llama"
        case .openrouter: return "OpenRouter"
        case .anthropic: return "Anthropic"
        case .elizacloud: return "Eliza Cloud"
        case .openai: return "OpenAI"
        case .codex: return "Codex (ChatGPT subscription)"
        }
    }
}

struct SettingsRoutingCard: View {
    @ObservedObject var client: DetourClient
    @StateObject private var vm: RoutingViewModel

    init(client: DetourClient) {
        self.client = client
        _vm = StateObject(wrappedValue: RoutingViewModel(client: client))
    }

    var body: some View {
        GlassCard("Routing", systemImage: "rectangle.connected.to.line.below") {
            Text("Pick which source handles each model tier. \"Local llama\" routes through the local-chat / companion service when running — otherwise the listed cloud source.")
                .font(.caption).foregroundStyle(.secondary)

            // ── Planner tier pin: lets the user force the planner's
            // first-attempt tier. dpe-fallback cascades from here down.
            HStack {
                Text("Planner tier").font(.callout).fontWeight(.medium)
                Spacer()
                Picker("", selection: Binding(
                    get: { vm.plannerTier },
                    set: { tier in Task { await vm.setPlannerTier(tier) } },
                )) {
                    Text("Auto (cascade)").tag("")
                    Text("TEXT_SMALL").tag("TEXT_SMALL")
                    Text("TEXT_MEDIUM").tag("TEXT_MEDIUM")
                    Text("TEXT_LARGE").tag("TEXT_LARGE")
                }.pickerStyle(.menu).frame(width: 200)
            }
            Text("Pin the tier the planner asks for first. Auto lets the dpe-fallback cascade walk through TEXT_LARGE → TEXT_MEDIUM → TEXT_SMALL until one with a registered handler succeeds. Pick a smaller tier if your provider only supports small/medium.")
                .font(.caption2).foregroundStyle(.tertiary)
            Divider()

            if vm.models == nil {
                ProgressView().controlSize(.small)
            } else {
                RoutingTierRow(tier: "TEXT_SMALL",
                               currentSummary: smallSummary(),
                               localPreset: client.snapshot?.localChat.preset,
                               localRunning: client.snapshot?.localChat.running ?? false,
                               modelTier: .textSmall,
                               vm: vm,
                               binding: openRouterSmallBinding())
                RoutingTierRow(tier: "TEXT_MEDIUM",
                               currentSummary: mediumSummary(),
                               localPreset: client.snapshot?.localChat.preset,
                               localRunning: client.snapshot?.localChat.running ?? false,
                               modelTier: .textMedium,
                               vm: vm,
                               binding: elizaMediumBinding())
                RoutingTierRow(tier: "TEXT_LARGE",
                               currentSummary: largeSummary(),
                               localPreset: nil,
                               localRunning: false,
                               modelTier: .textLarge,
                               vm: vm,
                               binding: openRouterLargeBinding())
                RoutingTierRow(tier: "COMPANION",
                               currentSummary: companionSummary(),
                               localPreset: client.snapshot?.companion.preset,
                               localRunning: client.snapshot?.companion.running ?? false,
                               modelTier: .textSmall,
                               vm: vm,
                               binding: emptyBinding())
                RoutingTierRow(tier: "EMBEDDING",
                               currentSummary: embeddingSummary(),
                               localPreset: "bge-small-en-v1.5",
                               localRunning: client.snapshot?.embed.running ?? false,
                               modelTier: .embedding,
                               vm: vm,
                               binding: openRouterEmbeddingBinding())
            }

            HStack {
                if let s = vm.status {
                    Text(s).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if vm.saving { ProgressView().controlSize(.mini) }
                Button("Save routing", action: { Task { await vm.save() } })
                    .controlSize(.small)
                    .disabled(vm.models == nil || vm.saving)
            }
            .padding(.top, 4)
        }
        .task { await vm.load() }
    }

    private func smallSummary() -> String {
        let local = client.snapshot?.localChat.running == true
            ? "local: \(client.snapshot?.localChat.preset ?? "running")" : nil
        let or = vm.models?.openRouterTextSmall ?? ""
        return local ?? (or.isEmpty ? "cloud default" : "openrouter: \(or)")
    }
    private func mediumSummary() -> String {
        let local = client.snapshot?.localChat.running == true
            ? "local: \(client.snapshot?.localChat.preset ?? "running")" : nil
        let m = vm.models?.elizaCloudMedium ?? ""
        return local ?? (m.isEmpty ? "cloud default" : "elizacloud: \(m)")
    }
    private func largeSummary() -> String {
        let or = vm.models?.openRouterTextLarge ?? ""
        let ec = vm.models?.elizaCloudLarge ?? ""
        if !or.isEmpty { return "openrouter: \(or)" }
        if !ec.isEmpty { return "elizacloud: \(ec)" }
        return "active cloud provider's default"
    }
    private func companionSummary() -> String {
        if client.snapshot?.companion.running == true {
            return "local: \(client.snapshot?.companion.preset ?? "running")"
        }
        return "off"
    }
    private func embeddingSummary() -> String {
        let running = client.snapshot?.embed.running == true
        let or = vm.models?.openRouterEmbedding ?? ""
        if running { return "local: bge-small-en-v1.5 (384-dim)" }
        return or.isEmpty ? "starting…" : "openrouter: \(or)"
    }

    private func openRouterSmallBinding() -> Binding<String> {
        Binding(get: { vm.models?.openRouterTextSmall ?? "" },
                set: { if vm.models != nil { vm.models!.openRouterTextSmall = $0 } })
    }
    private func openRouterLargeBinding() -> Binding<String> {
        Binding(get: { vm.models?.openRouterTextLarge ?? "" },
                set: { if vm.models != nil { vm.models!.openRouterTextLarge = $0 } })
    }
    private func elizaMediumBinding() -> Binding<String> {
        Binding(get: { vm.models?.elizaCloudMedium ?? "" },
                set: { if vm.models != nil { vm.models!.elizaCloudMedium = $0 } })
    }
    private func openRouterEmbeddingBinding() -> Binding<String> {
        Binding(get: { vm.models?.openRouterEmbedding ?? "" },
                set: { if vm.models != nil { vm.models!.openRouterEmbedding = $0 } })
    }
    private func emptyBinding() -> Binding<String> {
        Binding(get: { "" }, set: { _ in })
    }
}

private struct RoutingTierRow: View {
    let tier: String
    let currentSummary: String
    let localPreset: String?
    let localRunning: Bool
    let modelTier: ModelTier
    @ObservedObject var vm: RoutingViewModel
    @Binding var binding: String
    @State private var showingCustom: Bool = false
    @State private var customId: String = ""

    /// Pull options from every provider catalog so the dropdown shows
    /// a unified picker. Local llama gets its own section at the top
    /// when applicable.
    private var groupedOptions: [(provider: String, options: [ModelOption])] {
        let providers: [(String, String)] = [
            ("local", "Local llama"),
            ("anthropic", "Anthropic"),
            ("openai", "OpenAI"),
            ("openrouter", "OpenRouter"),
            ("elizacloud", "Eliza Cloud"),
            ("codex", "Codex (ChatGPT)"),
        ]
        var groups: [(String, [ModelOption])] = []
        for (providerId, label) in providers {
            let opts = ModelCatalog.options(provider: providerId, tier: modelTier)
            if !opts.isEmpty {
                groups.append((label, opts))
            }
        }
        return groups
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(tier).font(.system(.caption, design: .monospaced))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.12)).clipShape(Capsule())
                Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.tertiary)
                Text(currentSummary).font(.callout)
                Spacer()
                if localRunning {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.caption)
                    Text("local available").font(.caption2).foregroundStyle(.secondary)
                }
            }
            HStack {
                Text("Override:").font(.caption).foregroundStyle(.secondary)
                Menu {
                    Button("Default (no override)") { binding = "" }
                    Divider()
                    ForEach(groupedOptions, id: \.provider) { group in
                        Section(group.provider) {
                            ForEach(group.options) { opt in
                                Button {
                                    binding = opt.id
                                } label: {
                                    if let note = opt.note {
                                        Text("\(opt.label) — \(note)")
                                    } else {
                                        Text(opt.label)
                                    }
                                }
                            }
                        }
                    }
                    Divider()
                    Button("Custom model id…") {
                        customId = binding
                        showingCustom = true
                    }
                } label: {
                    HStack {
                        Text(binding.isEmpty ? "Default" : binding)
                            .font(.caption).foregroundStyle(binding.isEmpty ? .secondary : .primary)
                            .lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(.gray.opacity(0.25)))
                }
                .menuStyle(.borderlessButton)
                .frame(maxWidth: 320, alignment: .leading)
            }
        }
        .padding(.vertical, 4)
        Divider()
        .sheet(isPresented: $showingCustom) {
            CustomModelIdSheet(initial: customId) { newValue in
                binding = newValue
                showingCustom = false
            } cancel: {
                showingCustom = false
            }
        }
    }
}

private struct CustomModelIdSheet: View {
    let initial: String
    let apply: (String) -> Void
    let cancel: () -> Void
    @State private var text: String = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Custom model id").font(.headline)
            Text("Paste a provider-specific model id. Use the exact string the provider expects (\"claude-sonnet-4-6\", \"openai/gpt-5\", etc.).")
                .font(.caption).foregroundStyle(.secondary)
            TextField("model id", text: $text)
                .textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("Cancel", action: cancel)
                Button("Apply") { apply(text) }
                    .buttonStyle(.borderedProminent)
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { text = initial }
    }
}
