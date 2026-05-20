/*
 * CharacterEditor — native Settings → Character editor. Loads the
 * AgentCharacterConfig from /api/eval/character, lets the user edit
 * every section directly, persists via POST. Each list section has a
 * "Generate" button that asks the agent itself to produce N new
 * entries for that section, then appends them after a quick approval.
 *
 * Sections:
 *   - Identity   (name, username, system)
 *   - Bio        ([String])
 *   - Lore       ([String])
 *   - Adjectives ([String])
 *   - Topics     ([String])
 *   - Style      (style.all, style.chat, style.post — each [String])
 *   - Post examples    ([String])
 *   - Message examples (currently read-only summary; full editing
 *     requires a more complex schema and lives in the agent JSON)
 *
 * On save, the bun-side ConfigService writes ~/.detour/config.json
 * and the next character rebuild (via runtime.buildCharacter) picks
 * the changes up automatically.
 */

import AppKit
import SwiftUI

struct CharacterStyleWire: Codable, Equatable {
    var all: [String]
    var chat: [String]
    var post: [String]
}

struct CharacterWire: Codable, Equatable {
    var name: String
    var username: String
    var system: String
    var bio: [String]
    var lore: [String]
    var adjectives: [String]
    var topics: [String]
    var style: CharacterStyleWire
    var postExamples: [String]
}

@MainActor
final class CharacterEditorViewModel: ObservableObject {
    @Published var character: CharacterWire? = nil
    @Published var loading = false
    @Published var saving = false
    @Published var status: String? = nil
    @Published var generatingSection: String? = nil

    /// Suggestions returned by /api/eval/character/generate awaiting
    /// user approval before they're appended. Keyed by section id.
    @Published var pendingSuggestions: [String: [String]] = [:]

    let client: DetourClient

    init(client: DetourClient) {
        self.client = client
    }

    func load() async {
        await MainActor.run { loading = true; status = nil }
        struct Wrap: Decodable { let character: CharacterWire }
        if let w: Wrap = await client.getEvalJSON("api/eval/character", as: Wrap.self) {
            await MainActor.run {
                character = w.character
                loading = false
            }
        } else {
            await MainActor.run {
                status = "Couldn't load character — DETOUR_EVAL_TOKEN not set?"
                loading = false
            }
        }
    }

    func save() async {
        guard let c = character else { return }
        await MainActor.run { saving = true; status = nil }
        let body: [String: Any] = [
            "name": c.name,
            "username": c.username,
            "system": c.system,
            "bio": c.bio,
            "lore": c.lore,
            "adjectives": c.adjectives,
            "topics": c.topics,
            "style": [
                "all": c.style.all,
                "chat": c.style.chat,
                "post": c.style.post,
            ],
            "postExamples": c.postExamples,
        ]
        let ok = await client.postEval("api/eval/character", body: body)
        await MainActor.run {
            saving = false
            status = ok ? "Saved." : "Save failed."
        }
    }

    func generate(section: String, existing: [String], count: Int = 3, hint: String = "") async {
        await MainActor.run {
            generatingSection = section
            status = nil
        }
        let body: [String: Any] = [
            "section": section,
            "existing": existing,
            "count": count,
            "hint": hint,
        ]
        // Use a custom post with parsing since postEval discards body.
        let url = URL(string: "http://127.0.0.1:2138/api/eval/character/generate")!
        var req = URLRequest(url: url, timeoutInterval: 90)
        req.httpMethod = "POST"
        let token = client.evalTokenPublic
        if let t = token { req.addValue(t, forHTTPHeaderField: "x-detour-eval-token") }
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            struct Resp: Decodable { let ok: Bool; let suggestions: [String]?; let error: String? }
            let resp = try JSONDecoder().decode(Resp.self, from: data)
            if resp.ok, let suggestions = resp.suggestions {
                await MainActor.run {
                    pendingSuggestions[section] = suggestions
                    generatingSection = nil
                }
            } else {
                await MainActor.run {
                    status = resp.error ?? "Generation failed."
                    generatingSection = nil
                }
            }
        } catch {
            await MainActor.run {
                status = "Generation failed: \(error.localizedDescription)"
                generatingSection = nil
            }
        }
    }

    func acceptSuggestion(section: String, suggestion: String) {
        guard var c = character else { return }
        switch section {
        case "bio": c.bio.append(suggestion)
        case "lore": c.lore.append(suggestion)
        case "adjectives": c.adjectives.append(suggestion)
        case "topics": c.topics.append(suggestion)
        case "style.all": c.style.all.append(suggestion)
        case "style.chat": c.style.chat.append(suggestion)
        case "style.post": c.style.post.append(suggestion)
        case "postExamples": c.postExamples.append(suggestion)
        default: break
        }
        character = c
        // Remove the accepted suggestion from the pending list.
        if var list = pendingSuggestions[section] {
            list.removeAll { $0 == suggestion }
            if list.isEmpty { pendingSuggestions.removeValue(forKey: section) }
            else { pendingSuggestions[section] = list }
        }
    }

    func discardSuggestions(section: String) {
        pendingSuggestions.removeValue(forKey: section)
    }
}

struct CharacterEditorRootView: View {
    @StateObject private var vm: CharacterEditorViewModel
    init(client: DetourClient) {
        _vm = StateObject(wrappedValue: CharacterEditorViewModel(client: client))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Agent Character").font(.title2).bold()
                    Spacer()
                    if vm.saving { ProgressView().controlSize(.small) }
                    Button("Save", action: { Task { await vm.save() } })
                        .buttonStyle(.borderedProminent)
                        .disabled(vm.character == nil || vm.saving)
                }
                if let s = vm.status {
                    Text(s).font(.caption).foregroundStyle(.secondary)
                }
                if vm.loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let _ = vm.character {
                    CharacterIdentityCard(vm: vm)
                    CharacterListSection(vm: vm, title: "Bio", systemImage: "person.text.rectangle", section: "bio", values: bioBinding())
                    CharacterListSection(vm: vm, title: "Lore", systemImage: "book", section: "lore", values: loreBinding())
                    CharacterListSection(vm: vm, title: "Adjectives", systemImage: "tag", section: "adjectives", values: adjectivesBinding(), short: true)
                    CharacterListSection(vm: vm, title: "Topics", systemImage: "number", section: "topics", values: topicsBinding(), short: true)
                    CharacterListSection(vm: vm, title: "Style — all surfaces", systemImage: "paintpalette", section: "style.all", values: styleAllBinding())
                    CharacterListSection(vm: vm, title: "Style — chat", systemImage: "ellipsis.bubble", section: "style.chat", values: styleChatBinding())
                    CharacterListSection(vm: vm, title: "Style — posts", systemImage: "megaphone", section: "style.post", values: stylePostBinding())
                    CharacterListSection(vm: vm, title: "Post examples", systemImage: "doc.text", section: "postExamples", values: postExamplesBinding())
                } else {
                    Text("Character not loaded.").foregroundStyle(.secondary)
                }
            }
            .padding(20)
        }
        .task { await vm.load() }
    }

    // Bindings into the optional CharacterWire — guard each one to
    // tolerate a transient nil during initial load.
    private func bioBinding() -> Binding<[String]> {
        Binding(get: { vm.character?.bio ?? [] },
                set: { v in if vm.character != nil { vm.character!.bio = v } })
    }
    private func loreBinding() -> Binding<[String]> {
        Binding(get: { vm.character?.lore ?? [] },
                set: { v in if vm.character != nil { vm.character!.lore = v } })
    }
    private func adjectivesBinding() -> Binding<[String]> {
        Binding(get: { vm.character?.adjectives ?? [] },
                set: { v in if vm.character != nil { vm.character!.adjectives = v } })
    }
    private func topicsBinding() -> Binding<[String]> {
        Binding(get: { vm.character?.topics ?? [] },
                set: { v in if vm.character != nil { vm.character!.topics = v } })
    }
    private func styleAllBinding() -> Binding<[String]> {
        Binding(get: { vm.character?.style.all ?? [] },
                set: { v in if vm.character != nil { vm.character!.style.all = v } })
    }
    private func styleChatBinding() -> Binding<[String]> {
        Binding(get: { vm.character?.style.chat ?? [] },
                set: { v in if vm.character != nil { vm.character!.style.chat = v } })
    }
    private func stylePostBinding() -> Binding<[String]> {
        Binding(get: { vm.character?.style.post ?? [] },
                set: { v in if vm.character != nil { vm.character!.style.post = v } })
    }
    private func postExamplesBinding() -> Binding<[String]> {
        Binding(get: { vm.character?.postExamples ?? [] },
                set: { v in if vm.character != nil { vm.character!.postExamples = v } })
    }
}

private struct CharacterIdentityCard: View {
    @ObservedObject var vm: CharacterEditorViewModel
    var body: some View {
        GlassCard("Identity", systemImage: "person.crop.circle") {
            if let c = vm.character {
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 6) {
                    GridRow {
                        Text("Name").font(.caption).foregroundStyle(.secondary).frame(width: 70, alignment: .leading)
                        TextField("Detour Squirrel", text: Binding(
                            get: { vm.character?.name ?? "" },
                            set: { vm.character?.name = $0 },
                        )).textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        Text("Handle").font(.caption).foregroundStyle(.secondary)
                        TextField("detour_squirrel", text: Binding(
                            get: { vm.character?.username ?? "" },
                            set: { vm.character?.username = $0 },
                        )).textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        Text("System").font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: Binding(
                            get: { vm.character?.system ?? "" },
                            set: { vm.character?.system = $0 },
                        ))
                        .font(.callout)
                        .frame(minHeight: 60, maxHeight: 120)
                        .scrollContentBackground(.hidden)
                        .padding(4)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.gray.opacity(0.3)))
                    }
                }
                let _ = c
            }
        }
    }
}

/// Editable string-array section. Renders one row per entry with an ✕
/// to remove, a + Add field at the bottom, and a Generate button that
/// asks the agent for `n` new ideas for this section.
private struct CharacterListSection: View {
    @ObservedObject var vm: CharacterEditorViewModel
    let title: String
    let systemImage: String
    let section: String
    @Binding var values: [String]
    var short: Bool = false  // capsule-style for adjectives/topics

    @State private var newEntry: String = ""
    @State private var generateHint: String = ""

    var body: some View {
        GlassCard(title, systemImage: systemImage) {
            // Existing entries
            if values.isEmpty {
                Text("(empty)").font(.caption).foregroundStyle(.tertiary)
            } else if short {
                FlowLayout(spacing: 6) {
                    ForEach(values.indices, id: \.self) { i in
                        HStack(spacing: 4) {
                            Text(values[i]).font(.caption)
                            Button(action: { values.remove(at: i) }) {
                                Image(systemName: "xmark").font(.caption2)
                            }.buttonStyle(.plain)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .glassEffect(.regular, in: .capsule)
                    }
                }
            } else {
                ForEach(values.indices, id: \.self) { i in
                    HStack(alignment: .top) {
                        Image(systemName: "circle.fill").font(.system(size: 4)).foregroundStyle(.tertiary).padding(.top, 7)
                        TextField("", text: Binding(
                            get: { values[i] },
                            set: { values[i] = $0 },
                        ), axis: .vertical)
                            .lineLimit(1...4)
                            .textFieldStyle(.plain)
                        Button(action: { values.remove(at: i) }) {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }.buttonStyle(.plain)
                    }
                    .padding(.vertical, 2)
                    Divider()
                }
            }

            // Pending AI suggestions
            if let suggestions = vm.pendingSuggestions[section], !suggestions.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Image(systemName: "sparkles").foregroundStyle(.yellow)
                        Text("AI suggestions").font(.caption).fontWeight(.medium)
                        Spacer()
                        Button("Discard all") { vm.discardSuggestions(section: section) }
                            .controlSize(.mini)
                    }
                    ForEach(suggestions, id: \.self) { s in
                        HStack(alignment: .top) {
                            Text(s).font(.callout).foregroundStyle(.primary)
                            Spacer()
                            Button("Add") { vm.acceptSuggestion(section: section, suggestion: s) }
                                .controlSize(.small)
                        }
                        .padding(8)
                        .background(Color.yellow.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
                .padding(.top, 4)
            }

            // Add row + Generate
            HStack {
                TextField("Add entry…", text: $newEntry)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { addNew() }
                Button("Add") { addNew() }
                    .disabled(newEntry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if vm.generatingSection == section {
                    ProgressView().controlSize(.mini)
                } else {
                    Button(action: { Task { await vm.generate(section: section, existing: values) } }) {
                        HStack(spacing: 4) {
                            Image(systemName: "sparkles")
                            Text("Generate")
                        }
                    }
                    .buttonStyle(.bordered)
                    .help("Ask the agent to propose new entries for this section")
                }
            }
        }
    }

    private func addNew() {
        let s = newEntry.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty {
            values.append(s)
            newEntry = ""
        }
    }
}

/// Simple flow layout for capsule-style short entries.
private struct FlowLayout: Layout {
    let spacing: CGFloat
    init(spacing: CGFloat = 6) { self.spacing = spacing }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var height: CGFloat = 0
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth + size.width > width {
                height += rowHeight + spacing
                rowWidth = size.width + spacing
                rowHeight = size.height
            } else {
                rowWidth += size.width + spacing
                rowHeight = max(rowHeight, size.height)
            }
        }
        height += rowHeight
        return CGSize(width: width.isFinite ? width : rowWidth, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x: CGFloat = bounds.minX
        var y: CGFloat = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
