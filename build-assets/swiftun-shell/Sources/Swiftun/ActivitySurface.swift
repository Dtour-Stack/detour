/*
 * ActivitySurface — native SwiftUI window for browsing trajectories,
 * logs, and runtime state. Lifted from the (now retired) stand-alone
 * DetourActivity.app into the unified Detour binary.
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

struct ActivityRootView: View {
    @StateObject private var client = DetourClient()
    @State private var section: ActivitySection = .trajectories

    var body: some View {
        NavigationSplitView {
            List(ActivitySection.allCases, selection: $section) { s in
                Label(s.label, systemImage: s.systemImage).tag(s)
            }
            .listStyle(.sidebar)
            .frame(minWidth: 180)
        } detail: {
            switch section {
            case .trajectories: ActivityTrajectoriesView(client: client)
            case .logs: ActivityLogsView(client: client)
            case .runtime: ActivityRuntimeView(client: client)
            }
        }
        .onAppear { client.startPolling() }
        .frame(minWidth: 920, idealWidth: 1100, minHeight: 600, idealHeight: 760)
    }
}

struct ActivityTrajectoriesView: View {
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
                        ActivityTrajectoryRow(item: t).tag(t.id)
                    }
                    .listStyle(.inset)
                }
            }
            .frame(minWidth: 320, idealWidth: 380)

            ScrollView {
                if let s = selected {
                    ActivityTrajectoryDetailView(item: s, detail: detail)
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

struct ActivityTrajectoryRow: View {
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

struct ActivityTrajectoryDetailView: View {
    let item: ActivityTrajectoryListItemWire
    let detail: ActivityTrajectoryDetailWire?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(item.source ?? "turn").font(.title3).bold()
            HStack(spacing: 12) {
                if let ms = item.durationMs { metric("Duration", "\(Int(ms))ms") }
                if let llms = item.llmCallCount { metric("LLM calls", String(llms)) }
                if let prompt = item.totalPromptTokens { metric("Prompt tok", String(prompt)) }
                if let comp = item.totalCompletionTokens { metric("Completion tok", String(comp)) }
            }
            if let d = detail {
                if !d.actions.isEmpty {
                    sectionHeader("Actions")
                    ForEach(d.actions) { a in ActivityActionAttemptRow(action: a) }
                }
                if !d.llmCalls.isEmpty {
                    sectionHeader("LLM calls")
                    ForEach(d.llmCalls) { c in ActivityLlmCallRow(call: c) }
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
    private func sectionHeader(_ s: String) -> some View {
        Text(s).font(.caption).foregroundStyle(.secondary).padding(.top, 8)
    }
}

struct ActivityActionAttemptRow: View {
    let action: ActivityActionAttemptWire
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: (action.success ?? false) ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle((action.success ?? false) ? .green : .red)
            VStack(alignment: .leading, spacing: 2) {
                Text(action.actionName ?? "(unknown)").font(.system(.body, weight: .medium))
                if let r = action.reasoning, !r.isEmpty {
                    Text(r).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                }
                if let err = action.error, !err.isEmpty {
                    Text(err).font(.caption).foregroundStyle(.red)
                }
            }
            Spacer()
            Text("#\(action.stepNumber)").font(.system(.caption, design: .monospaced)).foregroundStyle(.tertiary)
        }
        .padding(8)
        .background(Color.gray.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct ActivityLlmCallRow: View {
    let call: ActivityLlmCallWire
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: { expanded.toggle() }) {
                HStack {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").foregroundStyle(.secondary)
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
                if let r = call.reasoning, !r.isEmpty { snippet("Reasoning", r) }
                if let u = call.userPrompt, !u.isEmpty { snippet("User prompt", u) }
                if let resp = call.response, !resp.isEmpty { snippet("Response", resp) }
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
                .padding(6).background(Color.black.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
    }
}

/// Live log tail backed by /api/eval/logs. Polls every 2s for new
/// entries — the bun log service keeps a ring buffer, so we just pull
/// the most recent N entries and dedupe by (time + msg) key.
struct ActivityLogsView: View {
    @ObservedObject var client: DetourClient
    @State private var entries: [ActivityLogEntryWire] = []
    @State private var loading = false
    @State private var loadError: String? = nil
    @State private var minLevel: Int = 20  // 20=info, 30=warn, 40=error
    @State private var follow = true
    @State private var pollTask: Task<Void, Never>? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Logs").font(.title2).bold()
                Spacer()
                Picker("Level", selection: $minLevel) {
                    Text("Trace").tag(10)
                    Text("Info").tag(20)
                    Text("Warn").tag(30)
                    Text("Error").tag(40)
                }.pickerStyle(.segmented).frame(width: 240)
                Toggle("Follow", isOn: $follow).toggleStyle(.checkbox)
                Button(action: { Task { await refresh() } }) {
                    Image(systemName: "arrow.clockwise")
                }.buttonStyle(.borderless)
            }
            .padding(14)
            Divider()
            if loading && entries.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = loadError, entries.isEmpty {
                ConnectionErrorBanner(message: err).padding(14)
            } else if entries.isEmpty {
                EmptyStateView(title: "No logs yet", systemImage: "text.alignleft")
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 1) {
                            ForEach(entries) { e in
                                ActivityLogRow(entry: e).id(e.id)
                            }
                        }
                        .padding(8)
                    }
                    .onChange(of: entries.count) { _ in
                        if follow, let last = entries.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .onAppear { startPolling() }
        .onDisappear { pollTask?.cancel() }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func refresh() async {
        loading = entries.isEmpty
        loadError = nil
        struct Wrap: Decodable { let entries: [ActivityLogEntryWire] }
        if let w: Wrap = await client.getEvalJSON(
            "api/eval/logs",
            query: ["limit": "500", "minLevel": String(minLevel)],
            as: Wrap.self,
        ) {
            await MainActor.run {
                entries = w.entries
                loading = false
            }
        } else {
            await MainActor.run {
                loadError = "Couldn't fetch logs. Check DETOUR_EVAL_TOKEN in .env."
                loading = false
            }
        }
    }
}

struct ActivityLogRow: View {
    let entry: ActivityLogEntryWire
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(timeStr(entry.time))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 70, alignment: .leading)
            Text(entry.levelName.uppercased())
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(levelColor(entry.level))
                .frame(width: 44, alignment: .leading)
            if let src = entry.source, !src.isEmpty {
                Text("[\(src)]")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 140, alignment: .leading)
            }
            Text(entry.msg)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(8)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1)
    }
    private func timeStr(_ ts: Double) -> String {
        let date = Date(timeIntervalSince1970: ts / 1000)
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: date)
    }
    private func levelColor(_ level: Int) -> Color {
        switch level {
        case 40...: return .red
        case 30..<40: return .orange
        case 20..<30: return .blue
        default: return .secondary
        }
    }
}

struct ActivityRuntimeView: View {
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
