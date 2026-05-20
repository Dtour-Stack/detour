/*
 * WorkspaceSurface — native SwiftUI replacement for the React workspace.
 * Sidebar lists project folders under ~/.detour/projects and active
 * coding-agent sessions. Detail pane shows project file tree + recent
 * activity. Click a project → opens in Finder or the user's editor of
 * choice (handled by `open`).
 */

import AppKit
import SwiftUI

struct WorkspaceProject: Identifiable, Hashable {
    let id: String        // absolute path
    let name: String
    let modifiedAt: Date
    let isGitRepo: Bool
}

@MainActor
final class WorkspaceViewModel: ObservableObject {
    @Published var projects: [WorkspaceProject] = []
    @Published var loading = false
    @Published var error: String? = nil

    private var projectsRoot: URL {
        // AGENT_PROJECT_NEW scaffolds into ~/.detour/agent-sandbox/projects/
        // — matches DETOUR_AGENT_SANDBOX in runtime.ts. The older
        // ~/.detour/projects path is a hand-rolled location nothing
        // populates.
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".detour")
            .appendingPathComponent("agent-sandbox")
            .appendingPathComponent("projects")
    }

    func refresh() {
        loading = true
        error = nil
        let root = projectsRoot
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var collected: [WorkspaceProject] = []
            let fm = FileManager.default
            if fm.fileExists(atPath: root.path) {
                if let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey], options: [.skipsHiddenFiles]) {
                    for url in entries {
                        let vals = try? url.resourceValues(forKeys: [.isDirectoryKey, .contentModificationDateKey])
                        guard vals?.isDirectory == true else { continue }
                        let modified = vals?.contentModificationDate ?? Date.distantPast
                        let isGit = fm.fileExists(atPath: url.appendingPathComponent(".git").path)
                        collected.append(WorkspaceProject(
                            id: url.path,
                            name: url.lastPathComponent,
                            modifiedAt: modified,
                            isGitRepo: isGit,
                        ))
                    }
                }
            }
            collected.sort { $0.modifiedAt > $1.modifiedAt }
            Task { @MainActor in
                if !fm.fileExists(atPath: root.path) {
                    self.error = "~/.detour/projects doesn't exist yet — the coding-tools plugin creates it on first use."
                }
                self.projects = collected
                self.loading = false
            }
        }
    }
}

struct WorkspaceRootView: View {
    @StateObject private var vm = WorkspaceViewModel()
    @State private var selected: WorkspaceProject? = nil
    @State private var showingNewProject = false
    @State private var showingSpawnAgent = false

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Projects").font(.headline)
                    Spacer()
                    Button(action: { showingNewProject = true }) {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.borderless)
                    .help("New project")
                    Button(action: { showingSpawnAgent = true }) {
                        Image(systemName: "person.badge.plus")
                    }
                    .buttonStyle(.borderless)
                    .help("Spawn coding sub-agent")
                    Button(action: { vm.refresh() }) {
                        Image(systemName: "arrow.clockwise")
                    }.buttonStyle(.borderless)
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                Divider()
                if vm.loading && vm.projects.isEmpty {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.projects.isEmpty {
                    EmptyStateView(
                        title: "No projects yet",
                        subtitle: vm.error ?? "Coding-tools sessions land under ~/.detour/projects.",
                        systemImage: "folder",
                    ).padding()
                } else {
                    List(vm.projects, selection: $selected) { p in
                        WorkspaceProjectRow(project: p).tag(p)
                    }
                    .listStyle(.sidebar)
                }
            }
            .frame(minWidth: 260)
            .scrollContentBackground(.hidden)
            .glassEffect(.regular, in: .rect)
        } detail: {
            if let p = selected {
                WorkspaceProjectDetail(project: p)
            } else {
                EmptyStateView(title: "Pick a project",
                               subtitle: "The agent's coding sessions appear in the sidebar.",
                               systemImage: "folder.badge.gearshape")
            }
        }
        .frame(minWidth: 960, idealWidth: 1280, minHeight: 600, idealHeight: 800)
        .onAppear { vm.refresh() }
        .sheet(isPresented: $showingNewProject) {
            NewProjectSheet(onCreated: {
                showingNewProject = false
                vm.refresh()
            }, onCancel: { showingNewProject = false })
        }
        .sheet(isPresented: $showingSpawnAgent) {
            SpawnAgentSheet(onSpawned: { showingSpawnAgent = false },
                            onCancel: { showingSpawnAgent = false })
        }
    }
}

/// Sheet: name + brief + project type → POST /api/eval/action/run
/// with AGENT_PROJECT_NEW. The agent scaffolds the project in
/// ~/.detour/projects/<slug>/ and replies with the slug.
private struct NewProjectSheet: View {
    let onCreated: () -> Void
    let onCancel: () -> Void

    @State private var name: String = ""
    @State private var brief: String = ""
    @State private var projectType: String = "page"
    @State private var submitting: Bool = false
    @State private var status: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New project").font(.title3).bold()
            Text("Detour scaffolds a fresh project under ~/.detour/projects/<slug>/ using AGENT_PROJECT_NEW. The agent picks a slug from the name.")
                .font(.caption).foregroundStyle(.secondary)

            GlassCard("Basics", systemImage: "doc.badge.plus") {
                TextField("Name (e.g. \"detour fanmade lore tracker\")", text: $name)
                    .textFieldStyle(.roundedBorder)
                Picker("Type", selection: $projectType) {
                    Text("page — single HTML/JS").tag("page")
                    Text("app — full multi-file project").tag("app")
                    Text("carrot — sandboxed worker plugin").tag("carrot")
                }.pickerStyle(.menu)
                TextEditor(text: $brief)
                    .font(.body)
                    .frame(minHeight: 100, maxHeight: 180)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.gray.opacity(0.3)))
                Text("Brief — what should the project DO? The agent reads this.")
                    .font(.caption2).foregroundStyle(.tertiary)
            }

            if let s = status {
                Text(s).font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                Button(action: submit) {
                    HStack(spacing: 6) {
                        if submitting { ProgressView().controlSize(.mini) }
                        Text("Create")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || submitting)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func submit() {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBrief = brief.trimmingCharacters(in: .whitespacesAndNewlines)
        submitting = true
        status = nil
        Task {
            let ok = await runAgentAction(name: "AGENT_PROJECT_NEW", options: [
                "name": trimmedName,
                "description": trimmedBrief,
                "type": projectType,
            ])
            await MainActor.run {
                submitting = false
                if ok.ok {
                    status = "Created. Slug: \(ok.slug ?? "(see project list)")"
                    onCreated()
                } else {
                    status = "Failed: \(ok.error ?? "unknown error")"
                }
            }
        }
    }
}

/// Sheet: spawn a coding sub-agent with a one-line task description.
/// Calls SPAWN_AGENT (or CREATE_TASK for multi-step jobs).
private struct SpawnAgentSheet: View {
    let onSpawned: () -> Void
    let onCancel: () -> Void

    @State private var task: String = ""
    @State private var kind: String = "spawn"
    @State private var workingDir: String = ""
    @State private var submitting: Bool = false
    @State private var status: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Spawn coding sub-agent").font(.title3).bold()
            Text("Detour spawns a dedicated task agent that can write code, run shell, edit files. Inherits the active conversation goal.")
                .font(.caption).foregroundStyle(.secondary)

            GlassCard("Task", systemImage: "person.badge.plus") {
                Picker("Mode", selection: $kind) {
                    Text("Spawn agent (single focused task)").tag("spawn")
                    Text("Create task (multi-step async)").tag("create")
                }.pickerStyle(.segmented)
                TextEditor(text: $task)
                    .font(.body)
                    .frame(minHeight: 100, maxHeight: 220)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.gray.opacity(0.3)))
                Text("Describe what the agent should do, plainly. The brief is the prompt.")
                    .font(.caption2).foregroundStyle(.tertiary)
                TextField("Working directory (optional)", text: $workingDir)
                    .textFieldStyle(.roundedBorder)
            }

            if let s = status {
                Text(s).font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                Button(action: submit) {
                    HStack(spacing: 6) {
                        if submitting { ProgressView().controlSize(.mini) }
                        Text("Spawn")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(task.trimmingCharacters(in: .whitespaces).isEmpty || submitting)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func submit() {
        let trimmed = task.trimmingCharacters(in: .whitespacesAndNewlines)
        submitting = true
        status = nil
        Task {
            var options: [String: Any] = ["task": trimmed, "brief": trimmed]
            if !workingDir.isEmpty { options["cwd"] = workingDir }
            let actionName = kind == "create" ? "CREATE_TASK" : "SPAWN_AGENT"
            let ok = await runAgentAction(name: actionName, options: options)
            await MainActor.run {
                submitting = false
                if ok.ok {
                    status = "Spawned. Watch progress in Knowledge → Trajectories."
                    onSpawned()
                } else {
                    status = "Failed: \(ok.error ?? "unknown error")"
                }
            }
        }
    }
}

/// Drive an agent action via /api/eval/action/run. Returns a tagged
/// result so the sheets can show success / failure.
struct AgentActionResult {
    let ok: Bool
    let slug: String?
    let error: String?
}

func runAgentAction(name: String, options: [String: Any]) async -> AgentActionResult {
    let token: String? = {
        if let env = ProcessInfo.processInfo.environment["DETOUR_EVAL_TOKEN"], !env.isEmpty { return env }
        let path = NSString(string: "~/.detour/.env").expandingTildeInPath
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("DETOUR_EVAL_TOKEN=") {
                var v = String(t.dropFirst("DETOUR_EVAL_TOKEN=".count))
                if (v.hasPrefix("\"") && v.hasSuffix("\"")) || (v.hasPrefix("'") && v.hasSuffix("'")) {
                    v = String(v.dropFirst().dropLast())
                }
                return v.isEmpty ? nil : v
            }
        }
        return nil
    }()
    guard let token else {
        return AgentActionResult(ok: false, slug: nil, error: "DETOUR_EVAL_TOKEN not set")
    }
    let body: [String: Any] = ["name": name, "options": options]
    var req = URLRequest(url: URL(string: "http://127.0.0.1:2138/api/eval/action/run")!,
                         timeoutInterval: 120)
    req.httpMethod = "POST"
    req.addValue(token, forHTTPHeaderField: "x-detour-eval-token")
    req.addValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return AgentActionResult(ok: false, slug: nil, error: "non-JSON reply")
        }
        let ok = (obj["ok"] as? Bool) ?? false
        let result = obj["result"] as? [String: Any]
        let slug = result?["slug"] as? String
        return AgentActionResult(
            ok: ok,
            slug: slug,
            error: ok ? nil : (obj["error"] as? String ?? "unknown error"),
        )
    } catch {
        return AgentActionResult(ok: false, slug: nil, error: error.localizedDescription)
    }
}

private struct WorkspaceProjectRow: View {
    let project: WorkspaceProject
    var body: some View {
        HStack {
            Image(systemName: project.isGitRepo ? "arrow.triangle.branch" : "folder")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(project.name).font(.callout).fontWeight(.medium)
                Text(project.modifiedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}

private struct WorkspaceProjectDetail: View {
    let project: WorkspaceProject
    @State private var entries: [URL] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name).font(.title2).bold()
                        Text(project.id)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                    }
                    Spacer()
                    Button("Open in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.id)])
                    }
                    Button("Open in editor") {
                        let url = URL(fileURLWithPath: project.id)
                        NSWorkspace.shared.open(url)
                    }.buttonStyle(.borderedProminent)
                }

                GlassCard("Top-level entries", systemImage: "list.bullet") {
                    if entries.isEmpty {
                        Text("(empty)").font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(entries.prefix(40), id: \.self) { url in
                            HStack {
                                Image(systemName: isDir(url) ? "folder" : "doc")
                                    .foregroundStyle(.secondary)
                                Text(url.lastPathComponent).font(.callout)
                                Spacer()
                            }
                            .padding(.vertical, 1)
                        }
                        if entries.count > 40 {
                            Text("…and \(entries.count - 40) more")
                                .font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                }

                GlassCard("Tell the agent…", systemImage: "ellipsis.bubble") {
                    Text("Open the chat window and reference this project by name (\"continue the work on \(project.name)…\"). The coding-tools plugin picks up the directory from there.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Open chat") { WindowFactory.shared.open(target: "chat") }
                        .controlSize(.small)
                }
                Spacer()
            }
            .padding(20)
        }
        .onAppear { loadEntries() }
        .onChange(of: project.id) { _, _ in loadEntries() }
    }

    private func isDir(_ url: URL) -> Bool {
        let vals = try? url.resourceValues(forKeys: [.isDirectoryKey])
        return vals?.isDirectory == true
    }

    private func loadEntries() {
        DispatchQueue.global(qos: .userInitiated).async {
            let url = URL(fileURLWithPath: project.id)
            let kids = (try? FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles],
            )) ?? []
            DispatchQueue.main.async {
                self.entries = kids.sorted { $0.lastPathComponent.lowercased() < $1.lastPathComponent.lowercased() }
            }
        }
    }
}
