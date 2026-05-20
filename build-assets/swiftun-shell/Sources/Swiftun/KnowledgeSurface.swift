/*
 * KnowledgeSurface — consolidated read-mostly browser combining what
 * used to be two separate windows (Activity + Pensieve) into one. The
 * sidebar is unified: trajectories / logs / runtime live alongside
 * memories / search / relationships. Two windows worth of fragmentation
 * collapses into a single Liquid Glass sidebar with a single detail pane.
 *
 * Both Activity and Pensieve windows still exist (for back-compat with
 * existing tray menu items + `detour://window?target=…`), but they now
 * open this same consolidated view scoped to the right starting tab.
 */

import AppKit
import SwiftUI

enum KnowledgeSection: String, CaseIterable, Identifiable, Hashable {
    case trajectories, logs, runtime
    case memories, search, relationships
    var id: String { rawValue }
    var label: String {
        switch self {
        case .trajectories: return "Trajectories"
        case .logs: return "Logs"
        case .runtime: return "Runtime"
        case .memories: return "Memories"
        case .search: return "Search"
        case .relationships: return "Relationships"
        }
    }
    var systemImage: String {
        switch self {
        case .trajectories: return "list.bullet.indent"
        case .logs: return "text.alignleft"
        case .runtime: return "gear.circle"
        case .memories: return "brain"
        case .search: return "magnifyingglass"
        case .relationships: return "person.2.fill"
        }
    }
    var group: String {
        switch self {
        case .trajectories, .logs, .runtime: return "Activity"
        case .memories, .search, .relationships: return "Pensieve"
        }
    }
}

struct KnowledgeRootView: View {
    @StateObject private var client = DetourClient()
    @State private var section: KnowledgeSection
    init(initial: KnowledgeSection = .trajectories) {
        self._section = State(initialValue: initial)
    }
    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                Section("Activity") {
                    ForEach(KnowledgeSection.allCases.filter { $0.group == "Activity" }) { s in
                        Label(s.label, systemImage: s.systemImage).tag(s)
                    }
                }
                Section("Pensieve") {
                    ForEach(KnowledgeSection.allCases.filter { $0.group == "Pensieve" }) { s in
                        Label(s.label, systemImage: s.systemImage).tag(s)
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 200)
            .scrollContentBackground(.hidden)
            .glassEffect(.regular, in: .rect)
        } detail: {
            Group {
                switch section {
                case .trajectories: ActivityTrajectoriesView(client: client)
                case .logs: ActivityLogsView(client: client)
                case .runtime: ActivityRuntimeView(client: client)
                case .memories: PensieveMemoriesView(client: client)
                case .search: PensieveSearchView(client: client)
                case .relationships: PensieveRelationshipsView(client: client)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { client.startPolling() }
        .frame(minWidth: 960, idealWidth: 1180, minHeight: 640, idealHeight: 780)
    }
}
