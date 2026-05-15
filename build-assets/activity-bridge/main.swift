/*
 * DetourActivity — native SwiftUI window for browsing trajectories,
 * logs, and runtime state. Initial scope: read-only browser. Edits +
 * autonomy toggles fall through to React via deep-link buttons.
 *
 * Talks to bun via /api/eval/trajectories + /api/eval/trajectory/:id —
 * those endpoints already require DETOUR_EVAL_TOKEN. DetourClient
 * reads it from .env on startup.
 */

import AppKit
import SwiftUI

enum ActivitySection: String, CaseIterable, Identifiable, Hashable {
    case trajectories, logs, runtime
    var id: String { rawValue }
    var label: String {
        switch self {
        case .trajectories: return "Trajectories"
        case .logs: return "Logs"
        case .runtime: return "Runtime"
        }
    }
    var systemImage: String {
        switch self {
        case .trajectories: return "list.bullet.indent"
        case .logs: return "text.alignleft"
        case .runtime: return "gear.circle"
        }
    }
}

struct RootView: View {
    @StateObject private var client = DetourClient()
    @State private var section: ActivitySection = .trajectories

    var body: some View {
        NavigationSplitView {
            List(ActivitySection.allCases, selection: $section) { s in
                Label(s.label, systemImage: s.systemImage).tag(s)
            }
            .listStyle(.sidebar)
            .frame(minWidth: 180)

            Section("Other surfaces") {
                DeepLinkButton(label: "Workspace", url: "detour://window?target=workspace", client: client)
                DeepLinkButton(label: "Pensieve", url: "detour://window?target=pensieve", client: client)
                DeepLinkButton(label: "Chat", url: "detour://window?target=chat", client: client)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        } detail: {
            switch section {
            case .trajectories: TrajectoriesView(client: client)
            case .logs: LogsView(client: client)
            case .runtime: RuntimeView(client: client)
            }
        }
        .onAppear { client.startPolling() }
        .frame(minWidth: 920, idealWidth: 1100, minHeight: 600, idealHeight: 760)
    }
}

// MARK: - Trajectories

struct TrajectoriesView: View {
    @ObservedObject var client: DetourClient
    @State private var list: [ActivityTrajectoryListItemWire] = []
    @State private var selected: ActivityTrajectoryListItemWire? = nil
    @State private var detail: ActivityTrajectoryDetailWire? = nil
    @State private var loading: Bool = false
    @State private var loadError: String? = nil

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Trajectories").font(.headline)
                    Spacer()
                    Button(action: { Task { await refresh() } }) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                }
                .padding(12)
                Divider()
                if loading && list.isEmpty {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = loadError, list.isEmpty {
                    ConnectionErrorBanner(message: err).padding(12)
                } else if list.isEmpty {
                    EmptyStateView(title: "No trajectories yet",
                                   subtitle: "Send a message in chat — turns will appear here.",
                                   systemImage: "tray")
                } else {
                    List(list, selection: Binding(
                        get: { selected?.id },
                        set: { newId in
                            selected = list.first { $0.id == newId }
                            if let s = selected { Task { await loadDetail(id: s.id) } }
                        },
                    )) { t in
                        TrajectoryRow(item: t).tag(t.id)
                    }
                    .listStyle(.inset)
                }
            }
            .frame(minWidth: 320, idealWidth: 380)

            // Detail pane
            ScrollView {
                if let s = selected {
                    TrajectoryDetailView(item: s, detail: detail)
                } else {
                    EmptyStateView(title: "Select a trajectory",
                                   systemImage: "doc.text.magnifyingglass")
                }
            }
            .frame(minWidth: 420)
        }
        .task { await refresh() }
    }

    private func refresh() async {
        loading = true
        loadError = nil
        let result: ActivityTrajectoryListResultWire? = await client.getEvalJSON(
            "api/eval/trajectories", query: ["limit": "100"],
            as: ActivityTrajectoryListResultWire.self,
        )
        await MainActor.run {
            if let r = result {
                list = r.trajectories
            } else {
                loadError = "Couldn't fetch trajectories. Check DETOUR_EVAL_TOKEN is set in .env."
            }
            loading = false
        }
    }

    private func loadDetail(id: String) async {
        detail = nil
        struct Wrap: Decodable { let detail: ActivityTrajectoryDetailWire? }
        if let w: Wrap = await client.getEvalJSON("api/eval/trajectory/\(id)", as: Wrap.self) {
            await MainActor.run { detail = w.detail }
        }
    }
}

struct TrajectoryRow: View {
    let item: ActivityTrajectoryListItemWire
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(item.source ?? "turn").font(.system(.body, weight: .medium))
                Spacer()
                if let ms = item.durationMs {
                    Text("\(Int(ms))ms")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
            HStack {
                if let st = item.status {
                    Text(st).font(.caption2)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(statusColor(st).opacity(0.15))
                        .foregroundStyle(statusColor(st))
                        .clipShape(Capsule())
                }
                if let llms = item.llmCallCount, llms > 0 {
                    Text("\(llms) LLM").font(.caption2).foregroundStyle(.secondary)
                }
                if let prompt = item.totalPromptTokens, let comp = item.totalCompletionTokens {
                    Text("\(prompt)+\(comp) tok").font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                if let ts = item.startTime {
                    Text(ts.relativeTimeAgo()).font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func statusColor(_ s: String) -> Color {
        switch s.lowercased() {
        case "completed", "success", "ok": return .green
        case "failed", "error": return .red
        case "pending", "in_progress": return .orange
        default: return .gray
        }
    }
}

struct TrajectoryDetailView: View {
    let item: ActivityTrajectoryListItemWire
    let detail: ActivityTrajectoryDetailWire?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(item.source ?? "turn").font(.title3).bold()
            HStack(spacing: 12) {
                if let ms = item.durationMs {
                    metric("Duration", "\(Int(ms))ms")
                }
                if let llms = item.llmCallCount {
                    metric("LLM calls", String(llms))
                }
                if let prompt = item.totalPromptTokens {
                    metric("Prompt tok", String(prompt))
                }
                if let comp = item.totalCompletionTokens {
                    metric("Completion tok", String(comp))
                }
            }
            if let d = detail {
                if !d.actions.isEmpty {
                    SectionHeader("Actions")
                    ForEach(d.actions) { a in
                        ActionAttemptRow(action: a)
                    }
                }
                if !d.llmCalls.isEmpty {
                    SectionHeader("LLM calls")
                    ForEach(d.llmCalls) { c in
                        LlmCallRow(call: c)
                    }
                }
            } else {
                ProgressView("Loading detail…").padding()
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func metric(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name.uppercased()).font(.system(size: 9, weight: .medium)).foregroundStyle(.tertiary)
            Text(value).font(.system(.body, design: .monospaced))
        }
    }

    @ViewBuilder
    private func SectionHeader(_ s: String) -> some View {
        Text(s).font(.caption).foregroundStyle(.secondary).padding(.top, 8)
    }
}

struct ActionAttemptRow: View {
    let action: ActivityActionAttemptWire
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: (action.success ?? false) ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle((action.success ?? false) ? .green : .red)
            VStack(alignment: .leading, spacing: 2) {
                Text(action.actionName ?? "(unknown)").font(.system(.body, weight: .medium))
                if let r = action.reasoning, !r.isEmpty {
                    Text(r).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if let err = action.error, !err.isEmpty {
                    Text(err).font(.caption).foregroundStyle(.red)
                }
            }
            Spacer()
            Text("#\(action.stepNumber)").font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .padding(8)
        .background(Color.gray.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct LlmCallRow: View {
    let call: ActivityLlmCallWire
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: { expanded.toggle() }) {
                HStack {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .foregroundStyle(.secondary)
                    Text(call.model).font(.system(.caption, design: .monospaced))
                    if let p = call.purpose, !p.isEmpty {
                        Text(p).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let prompt = call.promptTokens, let comp = call.completionTokens {
                        Text("\(prompt)+\(comp)tok").font(.caption2).foregroundStyle(.tertiary)
                    }
                    if let l = call.latencyMs {
                        Text("\(Int(l))ms").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
            .buttonStyle(.plain)
            if expanded {
                if let r = call.reasoning, !r.isEmpty {
                    snippet("Reasoning", r)
                }
                if let u = call.userPrompt, !u.isEmpty {
                    snippet("User prompt", u)
                }
                if let resp = call.response, !resp.isEmpty {
                    snippet("Response", resp)
                }
            }
        }
        .padding(8)
        .background(Color.gray.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
    @ViewBuilder
    private func snippet(_ name: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name.uppercased()).font(.system(size: 9, weight: .medium)).foregroundStyle(.tertiary)
            Text(text).font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
                .background(Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
    }
}

// MARK: - Logs

struct LogsView: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack {
            Text("Logs").font(.title2).bold().frame(maxWidth: .infinity, alignment: .leading).padding()
            Text("Live log tailing not yet ported — open the React Activity tab for now.")
                .font(.callout).foregroundStyle(.secondary).padding()
            Button("Open in main window") {
                client.openDetourURL("detour://window?target=activity")
            }
            Spacer()
        }
    }
}

// MARK: - Runtime

struct RuntimeView: View {
    @ObservedObject var client: DetourClient
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Runtime").font(.title2).bold()
            if let snap = client.snapshot {
                if let mem = snap.memory { MemoryBudgetBar(memory: mem) }
                Text("Provider: \(snap.activeProviderId ?? "—")").font(.callout)
                HStack {
                    StatusPill(label: "Embed", on: snap.embed.running, subtitle: snap.embed.lastError)
                    StatusPill(label: "Chat", on: snap.localChat.running, subtitle: snap.localChat.preset)
                    StatusPill(label: "Companion", on: snap.companion.running, subtitle: snap.companion.preset)
                }
            } else {
                ProgressView()
            }
            Spacer()
        }
        .padding(20)
    }
}

// MARK: - App boot

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    func applicationDidFinishLaunching(_: Notification) {
        let host = NSHostingController(rootView: RootView())
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false,
        )
        win.title = "Detour Activity"
        win.center()
        win.contentViewController = host
        win.setFrameAutosaveName("DetourActivityWindow")
        win.isReleasedWhenClosed = false
        win.makeKeyAndOrderFront(nil)
        window = win
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: win, queue: .main,
        ) { _ in NSApplication.shared.terminate(nil) }
        NSApp.activate(ignoringOtherApps: true)
    }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
