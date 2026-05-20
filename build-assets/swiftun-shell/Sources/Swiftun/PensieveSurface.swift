/*
 * PensieveSurface — native SwiftUI memory + relationship browser.
 *
 * Lifted from build-assets/pensieve-bridge/main.swift into the unified
 * Detour binary. Was previously a standalone app; the SwiftUI views
 * are unchanged, but the AppDelegate + boot code is removed (Swiftun's
 * AppDelegate owns lifecycle now) and `RootView` is renamed to
 * `PensieveRootView` to avoid colliding with the other surfaces.
 */

import AppKit
import SwiftUI

enum PensieveSection: String, CaseIterable, Identifiable, Hashable {
    case memories, search, relationships
    var id: String { rawValue }
    var label: String {
        switch self {
        case .memories: return "Memories"
        case .search: return "Search"
        case .relationships: return "Relationships"
        }
    }
    var systemImage: String {
        switch self {
        case .memories: return "brain"
        case .search: return "magnifyingglass"
        case .relationships: return "person.2.fill"
        }
    }
}

struct PensieveRootView: View {
    @StateObject private var client = DetourClient()
    @State private var section: PensieveSection = .memories
    var body: some View {
        NavigationSplitView {
            List(PensieveSection.allCases, selection: $section) { s in
                Label(s.label, systemImage: s.systemImage).tag(s)
            }
            .listStyle(.sidebar)
            .frame(minWidth: 180)
        } detail: {
            switch section {
            case .memories: PensieveMemoriesView(client: client)
            case .search: PensieveSearchView(client: client)
            case .relationships: PensieveRelationshipsView(client: client)
            }
        }
        .onAppear { client.startPolling() }
        .frame(minWidth: 920, idealWidth: 1080, minHeight: 600, idealHeight: 740)
    }
}

struct PensieveSearchView: View {
    @ObservedObject var client: DetourClient
    @State private var query: String = ""
    @State private var results: [PensieveMemorySummaryWire] = []
    @State private var searching = false
    @State private var lastError: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Search Pensieve").font(.title2).bold()
                Spacer()
            }
            .padding(14)
            HStack {
                TextField("e.g. project codename squirrel-alpha", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await runSearch() } }
                Button(action: { Task { await runSearch() } }) {
                    if searching { ProgressView().controlSize(.mini) }
                    else { Text("Search") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(query.isEmpty || searching)
            }
            .padding(.horizontal, 14)

            if let err = lastError {
                Text(err).font(.caption).foregroundStyle(.red).padding(14)
            }

            Divider().padding(.top, 14)
            if results.isEmpty && !searching && lastError == nil {
                EmptyStateView(
                    title: "Type a query above",
                    subtitle: "Embedding-backed semantic search via the in-process Pensieve store. Results stream back in <300ms.",
                    systemImage: "magnifyingglass",
                )
            } else {
                List(results) { m in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            if let type = m.type, !type.isEmpty {
                                Text(type).font(.caption2)
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(Color.accentColor.opacity(0.15))
                                    .clipShape(Capsule())
                            }
                            Text(m.path).font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.tertiary)
                            Spacer()
                            if let ts = m.createdAt {
                                Text(ts.relativeTimeAgo()).font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        Text(m.preview).font(.callout).lineLimit(3)
                    }
                    .padding(.vertical, 3)
                }
                .listStyle(.inset)
            }
        }
    }

    private func runSearch() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await MainActor.run { searching = true; lastError = nil }
        // RPC first (zero HTTP overhead). Falls through to HTTP if
        // socket isn't ready yet.
        struct Wrap: Decodable { let memories: [PensieveMemorySummaryWire] }
        do {
            let resp = try await RPCClient.shared.callTyped(
                "pensieve.memories.search",
                params: ["text": trimmed, "limit": 30],
                as: Wrap.self,
            )
            await MainActor.run {
                results = resp.memories
                searching = false
            }
        } catch {
            // HTTP fallback so search still works if RPC hasn't connected yet.
            if let w: Wrap = await client.getEvalJSON(
                "api/eval/memories",
                query: ["limit": "30"],
                as: Wrap.self,
            ) {
                await MainActor.run {
                    // Client-side filter as a degraded path.
                    let q = trimmed.lowercased()
                    results = w.memories.filter { $0.preview.lowercased().contains(q) }
                    searching = false
                }
            } else {
                await MainActor.run {
                    lastError = "Search unavailable: \(error.localizedDescription)"
                    searching = false
                }
            }
        }
    }
}

/// Memories list backed by /api/eval/memories. Token-gated under
/// DETOUR_EVAL_TOKEN — DetourClient handles auth. Refresh is manual to
/// avoid hammering the embeddings store on every focus event.
struct PensieveMemoriesView: View {
    @ObservedObject var client: DetourClient
    @State private var memories: [PensieveMemorySummaryWire] = []
    @State private var loading = false
    @State private var loadError: String? = nil
    @State private var filter: String = ""

    private var filtered: [PensieveMemorySummaryWire] {
        if filter.isEmpty { return memories }
        let q = filter.lowercased()
        return memories.filter { ($0.preview.lowercased().contains(q)) || ($0.type?.lowercased().contains(q) ?? false) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Memories").font(.title2).bold()
                Spacer()
                TextField("Filter…", text: $filter).textFieldStyle(.roundedBorder).frame(width: 200)
                Button(action: { Task { await refresh() } }) {
                    Image(systemName: "arrow.clockwise")
                }.buttonStyle(.borderless)
            }
            .padding(14)
            Divider()
            if loading && memories.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = loadError, memories.isEmpty {
                ConnectionErrorBanner(message: err).padding(14)
            } else if filtered.isEmpty {
                EmptyStateView(title: "No memories yet",
                               subtitle: "The agent records turns and reflections here as it runs.",
                               systemImage: "brain")
            } else {
                List(filtered) { m in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            if let type = m.type, !type.isEmpty {
                                Text(type).font(.caption2)
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(Color.accentColor.opacity(0.15))
                                    .clipShape(Capsule())
                            }
                            Text(m.path).font(.system(.caption, design: .monospaced)).foregroundStyle(.tertiary)
                            Spacer()
                            if let ts = m.createdAt {
                                Text(ts.relativeTimeAgo()).font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        Text(m.preview).font(.callout).lineLimit(3)
                    }
                    .padding(.vertical, 3)
                }
                .listStyle(.inset)
            }
        }
        .task { await refresh() }
    }

    private func refresh() async {
        loading = true
        loadError = nil
        struct Wrap: Decodable { let memories: [PensieveMemorySummaryWire] }
        if let w: Wrap = await client.getEvalJSON("api/eval/memories", query: ["limit": "100"], as: Wrap.self) {
            await MainActor.run {
                memories = w.memories
                loading = false
            }
        } else {
            await MainActor.run {
                loadError = "Couldn't fetch memories. Check DETOUR_EVAL_TOKEN in .env."
                loading = false
            }
        }
    }
}

/// Relationships browser backed by /api/eval/entities — lists persons
/// the agent knows about with memory + relationship counts.
struct PensieveRelationshipsView: View {
    @ObservedObject var client: DetourClient
    @State private var entities: [PensieveEntitySummaryWire] = []
    @State private var loading = false
    @State private var loadError: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Relationships").font(.title2).bold()
                Spacer()
                Button(action: { Task { await refresh() } }) {
                    Image(systemName: "arrow.clockwise")
                }.buttonStyle(.borderless)
            }
            .padding(14)
            Divider()
            if loading && entities.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = loadError, entities.isEmpty {
                ConnectionErrorBanner(message: err).padding(14)
            } else if entities.isEmpty {
                EmptyStateView(title: "No relationships yet",
                               subtitle: "People and tagged entities show up here as the agent observes them.",
                               systemImage: "person.2")
            } else {
                List(entities) { e in
                    HStack(spacing: 10) {
                        Image(systemName: "person.crop.circle").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(e.name ?? "(unnamed)")
                                .font(.system(.body, weight: .medium))
                            Text(e.id).font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            HStack(spacing: 8) {
                                Label("\(e.memoryCount)", systemImage: "brain")
                                Label("\(e.relationshipCount)", systemImage: "link")
                            }
                            .font(.caption).foregroundStyle(.secondary)
                            if let ts = e.lastSeen {
                                Text(ts.relativeTimeAgo()).font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .padding(.vertical, 3)
                }
                .listStyle(.inset)
            }
        }
        .task { await refresh() }
    }

    private func refresh() async {
        loading = true
        loadError = nil
        struct Wrap: Decodable { let entities: [PensieveEntitySummaryWire] }
        if let w: Wrap = await client.getEvalJSON("api/eval/entities", query: ["limit": "200"], as: Wrap.self) {
            await MainActor.run { entities = w.entities; loading = false }
        } else {
            await MainActor.run {
                loadError = "Couldn't fetch entities. Check DETOUR_EVAL_TOKEN in .env."
                loading = false
            }
        }
    }
}
