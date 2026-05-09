/**
 * WorkspaceView — agentic IDE shell. Left rail lists projects (mapped
 * to AGENT_PROJECT_NEW outputs), top bar has Agent | Editor toggle +
 * project picker. Editor mode pairs a file tree with Monaco, plus a
 * diff view and a git panel for staging/committing. Agent mode is a
 * placeholder for now (Running / Blocked / Unassigned buckets).
 *
 * Auto-git: writes go through agentProjectWriteFile with autoStage=true.
 * Committing is explicit via the commit button (so the user batches
 * related edits) — not a per-save commit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useDetourTheme } from "../useDetourTheme";
import { rpc } from "../rpc";
import { onChatComplete, onChatDelta, onChatError } from "../rpc-listeners/chat";
import type {
	AgentProjectFileNode,
	AgentProjectGitCommit,
	AgentProjectGitFileStatus,
	AgentProjectSummary,
	WorkspaceIDEAvailability,
	WorkspaceIDEId,
} from "../../shared/rpc/agent-projects";

type EditorSource = "in-app" | WorkspaceIDEId;
const EDITOR_SOURCE_LABELS: Record<EditorSource, string> = {
	"in-app": "In-app",
	vscode: "VS Code",
	cursor: "Cursor",
	windsurf: "Windsurf",
};

type Mode = "agent" | "editor";

const MONACO_LANG_FROM_EXT: Record<string, string> = {
	ts: "typescript", tsx: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json",
	html: "html", htm: "html",
	css: "css",
	md: "markdown", markdown: "markdown",
	yml: "yaml", yaml: "yaml",
	sh: "shell", bash: "shell",
	py: "python",
	go: "go",
	rs: "rust",
	toml: "ini",
};

function langForPath(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return MONACO_LANG_FROM_EXT[ext] ?? "plaintext";
}

export function WorkspaceView() {
	useDetourTheme();
	const [projects, setProjects] = useState<AgentProjectSummary[]>([]);
	const [activeSlug, setActiveSlug] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>("editor");
	const [error, setError] = useState<string | null>(null);
	const [showNew, setShowNew] = useState(false);

	const loadProjects = useCallback(async () => {
		try {
			const r = await rpc.request.agentProjectList({});
			setProjects(r.projects);
			if (!activeSlug && r.projects.length > 0) setActiveSlug(r.projects[0].slug);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [activeSlug]);

	useEffect(() => {
		void loadProjects();
		const t = setInterval(loadProjects, 8000);
		return () => clearInterval(t);
	}, [loadProjects]);

	const active = useMemo(() => projects.find((p) => p.slug === activeSlug) ?? null, [projects, activeSlug]);

	const handleCreated = useCallback((project: AgentProjectSummary) => {
		setProjects((prev) => {
			const filtered = prev.filter((p) => p.slug !== project.slug);
			return [project, ...filtered];
		});
		setActiveSlug(project.slug);
		setShowNew(false);
	}, []);

	return (
		<div className="workspace-shell">
			<aside className="workspace-rail">
				<div className="workspace-rail-head">
					<div className="window-brand">Workspace</div>
				</div>
				<div className="workspace-rail-section">
					<div className="workspace-rail-label-row">
						<span className="workspace-rail-label">Spaces</span>
						<div className="workspace-rail-actions">
							<button
								type="button"
								className="workspace-rail-add"
								onClick={async () => {
									try {
										const r = await rpc.request.agentProjectImport({});
										if (r.ok) handleCreated(r.project);
										else if (!("cancelled" in r) || !r.cancelled) {
											setError("error" in r ? r.error : "Import failed");
										}
									} catch (e) {
										setError(e instanceof Error ? e.message : String(e));
									}
								}}
								title="Import existing folder as a project"
							>
								↥
							</button>
							<button type="button" className="workspace-rail-add" onClick={() => setShowNew(true)} title="New space">
								+
							</button>
						</div>
					</div>
					{projects.length === 0 && (
						<div className="hint" style={{ padding: "0 10px" }}>
							No projects yet. Click <strong>+</strong> above to create one, or have the agent run AGENT_PROJECT_NEW.
						</div>
					)}
					{projects.map((p) => (
						<button
							key={p.slug}
							type="button"
							className={`workspace-space ${activeSlug === p.slug ? "active" : ""}`}
							onClick={() => setActiveSlug(p.slug)}
							title={p.description}
						>
							<span className={`space-glyph type-${p.type}`} aria-hidden>{p.type === "app" ? "A" : "P"}</span>
							<span className="space-meta">
								<span className="space-name">{p.name}</span>
								<span className="space-sub">{p.type}{p.deployedAppId ? " • deployed" : ""}</span>
							</span>
						</button>
					))}
				</div>
			</aside>

			{showNew && <NewSpaceModal onClose={() => setShowNew(false)} onCreated={handleCreated} />}

			<header className="workspace-topbar">
				<div className="workspace-mode-toggle">
					<button type="button" className={mode === "agent" ? "active" : ""} onClick={() => setMode("agent")}>Agent</button>
					<button type="button" className={mode === "editor" ? "active" : ""} onClick={() => setMode("editor")}>Editor</button>
				</div>
				<div className="workspace-context">
					{active ? (
						<span title={active.description}>{active.name}</span>
					) : (
						<span className="hint">No space selected</span>
					)}
				</div>
				<div className="workspace-topbar-actions">
					<button
						type="button"
						className="btn-secondary"
						onClick={() => rpc.request.portlessOpen({}).catch(() => {})}
						title="Open the Portless route manager (manage preview URL routing)"
					>
						Portless
					</button>
					{active && (
						<button
							type="button"
							className="btn-secondary"
							onClick={async () => {
								try {
									await rpc.request.agentProjectOpenInFinder({ slug: active.slug });
									setError(null);
								} catch (e) {
									const msg = e instanceof Error ? e.message : String(e);
									console.error("[workspace] reveal failed:", msg);
									setError(`Reveal failed: ${msg}`);
								}
							}}
						>
							Reveal
						</button>
					)}
				</div>
			</header>

			<main className="workspace-body">
				{error && <div className="banner error" style={{ margin: 12 }}>{error}</div>}
				{!active && <div className="empty">Select a space to begin.</div>}
				{active && mode === "editor" && <EditorPane key={active.slug} slug={active.slug} />}
				{active && mode === "agent" && <AgentPane key={active.slug} slug={active.slug} project={active} />}
			</main>
		</div>
	);
}

// ── Editor pane ────────────────────────────────────────────────────────

function EditorPane({ slug }: { slug: string }) {
	const [source, setSource] = useState<EditorSource>(() => {
		try { return (localStorage.getItem(`workspace.editorSource.${slug}`) as EditorSource) || "in-app"; }
		catch { return "in-app"; }
	});
	useEffect(() => {
		try { localStorage.setItem(`workspace.editorSource.${slug}`, source); } catch { /* ignore */ }
	}, [slug, source]);

	return (
		<div className="editor-pane">
			<EditorSourceBar slug={slug} source={source} onChange={setSource} />
			{source === "in-app" ? <InAppEditor slug={slug} /> : <ExternalEditorPanel slug={slug} ide={source} />}
		</div>
	);
}

function EditorSourceBar({
	slug: _slug,
	source,
	onChange,
}: {
	slug: string;
	source: EditorSource;
	onChange: (s: EditorSource) => void;
}) {
	const [ides, setIdes] = useState<WorkspaceIDEAvailability[]>([]);

	useEffect(() => {
		let cancelled = false;
		void rpc.request.workspaceDetectIDEs({}).then((r) => {
			if (!cancelled) setIdes(r.ides);
		}).catch(() => { /* ignore */ });
		return () => { cancelled = true; };
	}, []);

	const options: { id: EditorSource; label: string; disabled: boolean; hint?: string }[] = [
		{ id: "in-app", label: "In-app", disabled: false },
		...ides.map((i) => ({
			id: i.id,
			label: i.label,
			disabled: !i.installed,
			hint: i.installed ? `${i.method ?? "launch"}` : "not installed",
		})),
	];

	return (
		<div className="editor-source-bar">
			<span className="editor-source-label">Editor:</span>
			<div className="editor-source-pills">
				{options.map((o) => (
					<button
						key={o.id}
						type="button"
						className={`editor-source-pill ${source === o.id ? "active" : ""}`}
						disabled={o.disabled}
						onClick={() => onChange(o.id)}
						title={o.hint ?? ""}
					>
						{o.label}
					</button>
				))}
			</div>
		</div>
	);
}

function ExternalEditorPanel({ slug, ide }: { slug: string; ide: WorkspaceIDEId }) {
	const [status, setStatus] = useState<"idle" | "launching" | "launched" | "error">("idle");
	const [method, setMethod] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const launch = useCallback(async () => {
		setStatus("launching");
		setError(null);
		try {
			const r = await rpc.request.workspaceLaunchInIDE({ slug, ide });
			setMethod(r.method);
			setStatus("launched");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setStatus("error");
		}
	}, [slug, ide]);

	useEffect(() => { void launch(); }, [launch]);

	return (
		<div className="external-editor">
			<div className="external-editor-card">
				<h3>{EDITOR_SOURCE_LABELS[ide]}</h3>
				{status === "launching" && <p className="hint">Opening project in {EDITOR_SOURCE_LABELS[ide]}…</p>}
				{status === "launched" && (
					<>
						<p className="hint">Project opened via <code>{method}</code>. Edit there; switch to Agent mode here to drive the agent.</p>
						<div className="row" style={{ gap: 8, justifyContent: "center" }}>
							<button type="button" className="btn-primary" onClick={() => void launch()}>Reopen</button>
							<button
								type="button"
								className="btn-secondary"
								onClick={async () => {
									try {
										await rpc.request.agentProjectOpenInFinder({ slug });
										setError(null);
									} catch (e) {
										const msg = e instanceof Error ? e.message : String(e);
										console.error("[workspace] reveal failed:", msg);
										setError(`Reveal failed: ${msg}`);
									}
								}}
							>
								Reveal folder
							</button>
						</div>
					</>
				)}
				{status === "error" && (
					<>
						<div className="banner error" style={{ margin: "8px 0" }}>{error}</div>
						<button type="button" className="btn-primary" onClick={() => void launch()}>Try again</button>
					</>
				)}
			</div>
		</div>
	);
}

type EditorTab = {
	path: string;
	original: string;
	draft: string;
	savedAt: number | null;
};

function InAppEditor({ slug }: { slug: string }) {
	const [tree, setTree] = useState<AgentProjectFileNode | null>(null);
	const [projectDirAbs, setProjectDirAbs] = useState<string | null>(null);
	// Tabs are an ordered list (preserves user reorder via clicks) +
	// a Map for fast lookup. activePath drives which tab the editor
	// renders. Save / close key off activePath; the file tree clicks
	// either open a new tab or focus the existing one.
	const [tabs, setTabs] = useState<EditorTab[]>([]);
	const [activePath, setActivePath] = useState<string | null>(null);
	const [showDiff, setShowDiff] = useState(false);
	const [showPreview, setShowPreview] = useState(false);
	const [previewNonce, setPreviewNonce] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [gitStatus, setGitStatus] = useState<AgentProjectGitFileStatus[]>([]);
	const [branch, setBranch] = useState<string | null>(null);
	const [commitMsg, setCommitMsg] = useState("");
	const [log, setLog] = useState<AgentProjectGitCommit[]>([]);
	const [showQuickOpen, setShowQuickOpen] = useState(false);
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; type: "file" | "dir" } | null>(null);

	const activeTab = useMemo(() => tabs.find((t) => t.path === activePath) ?? null, [tabs, activePath]);
	const draft = activeTab?.draft ?? "";
	const original = activeTab?.original ?? "";
	const savedAt = activeTab?.savedAt ?? null;

	const loadTree = useCallback(async () => {
		try {
			const r = await rpc.request.agentProjectListFiles({ slug });
			setTree(r.tree);
			setProjectDirAbs(r.dir);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [slug]);

	const loadGit = useCallback(async () => {
		try {
			const [s, l] = await Promise.all([
				rpc.request.agentProjectGitStatus({ slug }),
				rpc.request.agentProjectGitLog({ slug, limit: 12 }),
			]);
			setGitStatus(s.files);
			setBranch(s.branch);
			setLog(l.commits);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [slug]);

	useEffect(() => {
		void loadTree();
		void loadGit();
	}, [loadTree, loadGit]);

	const openFile = useCallback(async (path: string) => {
		// Already open → just focus.
		if (tabs.some((t) => t.path === path)) {
			setActivePath(path);
			return;
		}
		try {
			const r = await rpc.request.agentProjectReadFile({ slug, path });
			setTabs((prev) => [...prev, { path, original: r.content, draft: r.content, savedAt: null }]);
			setActivePath(path);
			setShowDiff(false);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [slug, tabs]);

	const setDraft = useCallback((next: string) => {
		setTabs((prev) => prev.map((t) => t.path === activePath ? { ...t, draft: next } : t));
	}, [activePath]);

	const dirty = activeTab !== null && activeTab.draft !== activeTab.original;

	const save = useCallback(async () => {
		if (!activeTab) return;
		try {
			await rpc.request.agentProjectWriteFile({ slug, path: activeTab.path, content: activeTab.draft, autoStage: true });
			const now = Date.now();
			setTabs((prev) => prev.map((t) => t.path === activeTab.path ? { ...t, original: activeTab.draft, savedAt: now } : t));
			setPreviewNonce((n) => n + 1);
			void loadGit();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [activeTab, slug, loadGit]);

	const closeTab = useCallback((path: string) => {
		const tab = tabs.find((t) => t.path === path);
		if (tab && tab.draft !== tab.original) {
			if (!confirm(`Close ${path}? Unsaved changes will be lost.`)) return;
		}
		setTabs((prev) => {
			const filtered = prev.filter((t) => t.path !== path);
			if (path === activePath) {
				const idx = prev.findIndex((t) => t.path === path);
				const next = filtered[idx] ?? filtered[idx - 1] ?? null;
				setActivePath(next?.path ?? null);
			}
			return filtered;
		});
	}, [tabs, activePath]);

	// Detect a preview-able HTML in the project tree. Static pages have
	// index.html at root; carrots have web/index.html. Next.js scaffolds
	// have no static entry (dev server required) — preview unavailable.
	const fileUrl = useMemo<string | null>(() => {
		if (!tree?.children || !projectDirAbs) return null;
		let relPath: string | null = null;
		const rootMatch = tree.children.find((c) => c.path === "index.html" && c.type === "file");
		if (rootMatch) {
			relPath = "index.html";
		} else {
			const web = tree.children.find((c) => c.path === "web" && c.type === "dir");
			if (web?.children?.some((c) => c.name === "index.html" && c.type === "file")) {
				relPath = "web/index.html";
			}
		}
		if (!relPath) return null;
		return `file://${projectDirAbs}/${relPath}`;
	}, [tree, projectDirAbs]);

	// Preferred preview URL: real HTTP via portless when the user has
	// started the preview server. Falls back to file:// for quick render
	// without a server.
	const [serverUrl, setServerUrl] = useState<string | null>(null);
	const previewUrl = serverUrl ?? fileUrl;

	const startPreviewServer = useCallback(async () => {
		try {
			const r = await rpc.request.agentProjectStartPreview({ slug });
			setServerUrl(r.url);
		} catch (e) {
			setError(`Preview server failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}, [slug]);

	const stopPreviewServer = useCallback(async () => {
		try {
			await rpc.request.agentProjectStopPreview({ slug });
			setServerUrl(null);
		} catch { /* ignore */ }
	}, [slug]);

	// When the user re-saves a file, bump the preview iframe so they see the change.
	useEffect(() => {
		if (savedAt) setPreviewNonce((n) => n + 1);
	}, [savedAt]);

	// Keyboard shortcuts. ⌘S save, ⌘W close active tab, ⌘P quick open.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const meta = e.metaKey || e.ctrlKey;
			if (!meta) return;
			const k = e.key.toLowerCase();
			if (k === "s") {
				e.preventDefault();
				if (dirty) void save();
			} else if (k === "w") {
				e.preventDefault();
				if (activePath) closeTab(activePath);
			} else if (k === "p") {
				e.preventDefault();
				setShowQuickOpen((s) => !s);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dirty, save, activePath, closeTab]);

	const commit = useCallback(async () => {
		if (commitMsg.trim().length === 0) return;
		try {
			await rpc.request.agentProjectGitCommit({ slug, message: commitMsg.trim() });
			setCommitMsg("");
			void loadGit();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [commitMsg, slug, loadGit]);

	const stagedCount = gitStatus.filter((f) => f.staged).length;
	const lang = activePath ? langForPath(activePath) : "plaintext";

	// Flat file list for quick-open: walk the tree and collect all files.
	const allFiles = useMemo<string[]>(() => {
		if (!tree) return [];
		const out: string[] = [];
		const walk = (n: AgentProjectFileNode) => {
			if (n.type === "file") out.push(n.path);
			else for (const c of n.children ?? []) walk(c);
		};
		walk(tree);
		return out;
	}, [tree]);

	// Tree clicks should also pop up the context menu on right-click.
	const onTreeContext = useCallback((path: string, type: "file" | "dir", ev: React.MouseEvent) => {
		ev.preventDefault();
		setContextMenu({ x: ev.clientX, y: ev.clientY, path, type });
	}, []);
	useEffect(() => {
		const close = () => setContextMenu(null);
		window.addEventListener("click", close);
		return () => window.removeEventListener("click", close);
	}, []);

	return (
		<div className="workspace-editor">
			<aside className="workspace-files">
				<div className="workspace-files-head">
					<span>Files</span>
					<button type="button" className="btn-icon" onClick={() => void loadTree()} title="Refresh">↻</button>
				</div>
				<div className="workspace-files-tree">
					{tree && <TreeNode node={tree} depth={0} openPath={activePath} onOpen={openFile} onContext={onTreeContext} gitStatus={gitStatus} />}
				</div>
				<div className="workspace-git">
					<div className="workspace-git-head">
						<span>Git{branch ? ` · ${branch}` : ""}</span>
						<button type="button" className="btn-icon" onClick={() => void loadGit()} title="Refresh">↻</button>
					</div>
					{gitStatus.length === 0 && <div className="hint" style={{ padding: "4px 8px" }}>Working tree clean.</div>}
					{gitStatus.length > 0 && (
						<>
							<div className="workspace-git-files">
								{gitStatus.map((f) => (
									<div key={f.path} className={`git-file ${f.staged ? "staged" : "unstaged"}`} title={`${f.status}${f.staged ? " (staged)" : ""}`}>
										<span className={`git-glyph status-${f.status}`}>{glyphFor(f.status)}</span>
										<span className="git-path">{f.path}</span>
									</div>
								))}
							</div>
							<form className="workspace-commit" onSubmit={(e) => { e.preventDefault(); void commit(); }}>
								<input
									className="input"
									type="text"
									placeholder={stagedCount > 0 ? `Commit ${stagedCount} file(s)...` : "Stage files first"}
									value={commitMsg}
									onChange={(e) => setCommitMsg(e.target.value)}
									disabled={stagedCount === 0}
								/>
								<button type="submit" className="btn-primary" disabled={stagedCount === 0 || commitMsg.trim().length === 0}>
									Commit
								</button>
							</form>
						</>
					)}
					{log.length > 0 && (
						<div className="workspace-git-log">
							<div className="workspace-git-log-head">Recent commits</div>
							{log.map((c) => (
								<div key={c.sha} className="git-commit" title={`${c.author} · ${new Date(c.timestamp * 1000).toLocaleString()}`}>
									<span className="commit-sha">{c.sha.slice(0, 7)}</span>
									<span className="commit-subject">{c.subject}</span>
								</div>
							))}
						</div>
					)}
				</div>
			</aside>

			<section className="workspace-canvas">
				{tabs.length > 0 && (
					<div className="canvas-tabstrip">
						{tabs.map((t) => (
							<div
								key={t.path}
								className={`canvas-tab ${t.path === activePath ? "active" : ""} ${t.draft !== t.original ? "dirty" : ""}`}
								onClick={() => setActivePath(t.path)}
								title={t.path}
							>
								<span className="canvas-tab-name">{t.path.split("/").pop()}</span>
								<button
									type="button"
									className="canvas-tab-close"
									onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
									aria-label={`Close ${t.path}`}
								>
									{t.draft !== t.original ? "●" : "×"}
								</button>
							</div>
						))}
					</div>
				)}
				{!activePath && <div className="empty">Open a file to start editing.</div>}
				{serverUrl && (
					<div className="canvas-server-banner">
						<span className="hint">Live preview:</span>
						<a
							href="#"
							onClick={(e) => { e.preventDefault(); rpc.request.externalOpen({ url: serverUrl }).catch(() => {}); }}
							className="canvas-server-url"
						>
							{serverUrl}
						</a>
						<button
							type="button"
							className="btn-icon"
							title="Copy URL"
							onClick={() => navigator.clipboard?.writeText(serverUrl).catch(() => {})}
						>
							⧉
						</button>
						<button
							type="button"
							className="btn-icon"
							title="Open in system browser"
							onClick={() => rpc.request.externalOpen({ url: serverUrl }).catch(() => {})}
						>
							↗
						</button>
					</div>
				)}
				{activePath && (
					<>
						<div className="workspace-canvas-head">
							<span className="canvas-path">{activePath}</span>
							<span className="canvas-status">
								{dirty ? "● modified" : savedAt ? `saved ${timeAgo(savedAt)}` : ""}
							</span>
							<div className="canvas-actions">
								<button
									type="button"
									className={showPreview ? "btn-secondary active" : "btn-secondary"}
									onClick={() => setShowPreview((p) => !p)}
									disabled={!previewUrl}
									title={previewUrl ? "Toggle live preview" : "No previewable HTML in this project"}
								>
									{showPreview ? "Hide preview" : "Preview"}
								</button>
								<button
									type="button"
									className={serverUrl ? "btn-secondary active" : "btn-secondary"}
									onClick={() => serverUrl ? void stopPreviewServer() : void startPreviewServer()}
									title={serverUrl ? "Stop the local HTTP preview server" : "Start a local HTTP preview server (portless URL)"}
								>
									{serverUrl ? "Stop server" : "Start server"}
								</button>
								<button
									type="button"
									className={showDiff ? "btn-secondary active" : "btn-secondary"}
									onClick={() => setShowDiff((d) => !d)}
									disabled={!dirty}
								>
									{showDiff ? "Hide diff" : "Show diff"}
								</button>
								<button
									type="button"
									className="btn-primary"
									onClick={() => void save()}
									disabled={!dirty}
								>
									Save (⌘S)
								</button>
							</div>
						</div>
						<div className={`workspace-canvas-editor ${showPreview && previewUrl ? "with-preview" : ""}`}>
							<div className="canvas-code">
								{showDiff ? (
									<DiffEditor
										original={original}
										modified={draft}
										language={lang}
										theme="vs-dark"
										options={{ readOnly: false, renderSideBySide: true, minimap: { enabled: false } }}
										onMount={(editor) => {
											const m = editor.getModifiedEditor();
											m.onDidChangeModelContent(() => {
												const value = m.getValue();
												setDraft(value);
											});
										}}
									/>
								) : (
									<Editor
										path={activePath}
										language={lang}
										value={draft}
										onChange={(v) => setDraft(v ?? "")}
										theme="vs-dark"
										options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true, tabSize: 2 }}
									/>
								)}
							</div>
							{showPreview && previewUrl && (
								<div className="canvas-preview">
									<div className="canvas-preview-head">
										<span className="canvas-preview-url">{previewUrl.replace(/^file:\/\//, "")}</span>
										{serverUrl && (
											<button
												type="button"
												className="btn-icon"
												onClick={() => rpc.request.externalOpen({ url: serverUrl }).catch(() => {})}
												title="Open the live URL in your system browser (Safari / Chrome)"
											>
												↗
											</button>
										)}
										<button
											type="button"
											className="btn-icon"
											onClick={() => setPreviewNonce((n) => n + 1)}
											title="Reload preview"
										>
											↻
										</button>
									</div>
									<iframe
										key={`${previewUrl}#${previewNonce}`}
										src={previewUrl}
										className="canvas-preview-frame"
										sandbox="allow-scripts allow-same-origin"
										title="Project preview"
									/>
								</div>
							)}
						</div>
					</>
				)}
				{error && <div className="banner error" style={{ margin: 8 }}>{error}</div>}
			</section>
			{showQuickOpen && (
				<QuickOpen
					files={allFiles}
					onPick={(p) => { setShowQuickOpen(false); void openFile(p); }}
					onClose={() => setShowQuickOpen(false)}
				/>
			)}
			{contextMenu && (
				<TreeContextMenu
					slug={slug}
					ctx={contextMenu}
					onClose={() => setContextMenu(null)}
					onTreeChanged={() => { setContextMenu(null); void loadTree(); void loadGit(); }}
					onOpenFile={openFile}
				/>
			)}
		</div>
	);
}

function QuickOpen({
	files,
	onPick,
	onClose,
}: {
	files: string[];
	onPick: (path: string) => void;
	onClose: () => void;
}) {
	const [q, setQ] = useState("");
	const [idx, setIdx] = useState(0);
	const filtered = useMemo(() => {
		const needle = q.trim().toLowerCase();
		if (!needle) return files.slice(0, 40);
		// Cheap scoring: prefer matches in the basename, then in the path,
		// then anywhere. Penalize length.
		const scored: Array<{ path: string; score: number }> = [];
		for (const p of files) {
			const lower = p.toLowerCase();
			const base = (lower.split("/").pop() ?? lower);
			let score = -1;
			if (base.startsWith(needle)) score = 100;
			else if (base.includes(needle)) score = 80;
			else if (lower.includes(needle)) score = 50;
			if (score >= 0) {
				score -= Math.min(30, p.length / 4);
				scored.push({ path: p, score });
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, 40).map((s) => s.path);
	}, [q, files]);

	useEffect(() => {
		if (idx >= filtered.length) setIdx(Math.max(0, filtered.length - 1));
	}, [filtered, idx]);

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div
				className="quick-open"
				onClick={(e) => e.stopPropagation()}
			>
				<input
					autoFocus
					className="input"
					value={q}
					onChange={(e) => { setQ(e.target.value); setIdx(0); }}
					placeholder="Search files…  (↑↓ to navigate, Enter to open, Esc to close)"
					onKeyDown={(e) => {
						if (e.key === "Escape") { e.preventDefault(); onClose(); }
						else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(filtered.length - 1, i + 1)); }
						else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
						else if (e.key === "Enter") { e.preventDefault(); const p = filtered[idx]; if (p) onPick(p); }
					}}
				/>
				<div className="quick-open-list">
					{filtered.length === 0 && <div className="hint" style={{ padding: 12 }}>No matches.</div>}
					{filtered.map((p, i) => (
						<div
							key={p}
							className={`quick-open-row ${i === idx ? "active" : ""}`}
							onClick={() => onPick(p)}
							onMouseEnter={() => setIdx(i)}
						>
							<span className="quick-open-name">{p.split("/").pop()}</span>
							<span className="quick-open-path">{p}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function TreeContextMenu({
	slug,
	ctx,
	onClose,
	onTreeChanged,
	onOpenFile,
}: {
	slug: string;
	ctx: { x: number; y: number; path: string; type: "file" | "dir" };
	onClose: () => void;
	onTreeChanged: () => void;
	onOpenFile: (path: string) => Promise<void> | void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const newFile = async () => {
		const name = prompt(`New file under ${ctx.type === "dir" ? ctx.path : ctx.path.split("/").slice(0, -1).join("/") || "/"}:`);
		if (!name) return;
		const parent = ctx.type === "dir" ? ctx.path : ctx.path.split("/").slice(0, -1).join("/");
		const newPath = parent ? `${parent}/${name}` : name;
		setBusy("newFile");
		try {
			await rpc.request.agentProjectCreateFile({ slug, path: newPath, content: "" });
			await onOpenFile(newPath);
			onTreeChanged();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(null);
		}
	};
	const newFolder = async () => {
		const name = prompt(`New folder under ${ctx.type === "dir" ? ctx.path : ctx.path.split("/").slice(0, -1).join("/") || "/"}:`);
		if (!name) return;
		const parent = ctx.type === "dir" ? ctx.path : ctx.path.split("/").slice(0, -1).join("/");
		const newPath = parent ? `${parent}/${name}` : name;
		setBusy("newFolder");
		try {
			await rpc.request.agentProjectCreateFolder({ slug, path: newPath });
			onTreeChanged();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(null);
		}
	};
	const renameEntry = async () => {
		const next = prompt(`Rename ${ctx.path} to:`, ctx.path);
		if (!next || next === ctx.path) return;
		setBusy("rename");
		try {
			await rpc.request.agentProjectRenameEntry({ slug, oldPath: ctx.path, newPath: next });
			onTreeChanged();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(null);
		}
	};
	const deleteEntry = async () => {
		if (!confirm(`Delete ${ctx.path}? This is irreversible.`)) return;
		setBusy("delete");
		try {
			await rpc.request.agentProjectDeleteEntry({ slug, path: ctx.path });
			onTreeChanged();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(null);
		}
	};
	const copyPath = async () => {
		try { await navigator.clipboard?.writeText(ctx.path); } catch { /* ignore */ }
		onClose();
	};

	return (
		<div
			className="tree-context-menu"
			style={{ left: ctx.x, top: ctx.y }}
			onClick={(e) => e.stopPropagation()}
			onContextMenu={(e) => e.preventDefault()}
		>
			<button type="button" className="tree-cm-btn" onClick={newFile} disabled={busy !== null}>New file…</button>
			<button type="button" className="tree-cm-btn" onClick={newFolder} disabled={busy !== null}>New folder…</button>
			<div className="tree-cm-sep" />
			<button type="button" className="tree-cm-btn" onClick={renameEntry} disabled={busy !== null}>Rename…</button>
			<button type="button" className="tree-cm-btn danger" onClick={deleteEntry} disabled={busy !== null}>Delete</button>
			<div className="tree-cm-sep" />
			<button type="button" className="tree-cm-btn" onClick={copyPath}>Copy path</button>
			{error && <div className="banner error" style={{ margin: 4, fontSize: 11 }}>{error}</div>}
		</div>
	);
}

function TreeNode({
	node,
	depth,
	openPath,
	onOpen,
	onContext,
	gitStatus,
}: {
	node: AgentProjectFileNode;
	depth: number;
	openPath: string | null;
	onOpen: (path: string) => void;
	onContext: (path: string, type: "file" | "dir", ev: React.MouseEvent) => void;
	gitStatus: AgentProjectGitFileStatus[];
}) {
	const [expanded, setExpanded] = useState(depth < 1);
	const indent = { paddingLeft: 8 + depth * 12 };
	const isModified = gitStatus.some((f) => f.path === node.path && (f.status === "modified" || f.status === "added"));
	if (node.type === "dir") {
		if (depth === 0) {
			return (
				<>
					{node.children?.map((c) => (
						<TreeNode key={c.path} node={c} depth={depth} openPath={openPath} onOpen={onOpen} onContext={onContext} gitStatus={gitStatus} />
					))}
				</>
			);
		}
		return (
			<>
				<button
					type="button"
					className="tree-node tree-dir"
					style={indent}
					onClick={() => setExpanded((x) => !x)}
					onContextMenu={(e) => onContext(node.path, "dir", e)}
				>
					<span className="tree-arrow">{expanded ? "▾" : "▸"}</span>
					<span className="tree-name">{node.name}</span>
				</button>
				{expanded && node.children?.map((c) => (
					<TreeNode key={c.path} node={c} depth={depth + 1} openPath={openPath} onOpen={onOpen} onContext={onContext} gitStatus={gitStatus} />
				))}
			</>
		);
	}
	return (
		<button
			type="button"
			className={`tree-node tree-file ${openPath === node.path ? "active" : ""} ${isModified ? "modified" : ""}`}
			style={indent}
			onClick={() => onOpen(node.path)}
			onContextMenu={(e) => onContext(node.path, "file", e)}
		>
			<span className="tree-arrow" />
			<span className="tree-name">{node.name}</span>
			{isModified && <span className="tree-dot" aria-hidden>●</span>}
		</button>
	);
}

function glyphFor(status: AgentProjectGitFileStatus["status"]): string {
	switch (status) {
		case "modified": return "M";
		case "added": return "+";
		case "deleted": return "−";
		case "renamed": return "R";
		case "untracked": return "?";
		default: return "·";
	}
}

function timeAgo(ts: number): string {
	const sec = Math.max(1, Math.round((Date.now() - ts) / 1000));
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
	return `${Math.round(sec / 3600)}h ago`;
}

// ── Agent pane (chat panel scoped to the active project) ──────────────

type Bubble = {
	id: string;
	role: "user" | "assistant" | "error";
	text: string;
	thinking?: boolean;
};

function AgentPane({ slug, project }: { slug: string; project: AgentProjectSummary | null }) {
	const convId = `workspace:${slug}`;
	const storageKey = `workspace.chat.${slug}`;
	// Lazy initial — read prior conversation from localStorage so opening
	// a project resumes where the agent left off. Cap at 200 bubbles to
	// keep the storage write/read cheap; older history scrolls out.
	const [bubbles, setBubbles] = useState<Bubble[]>(() => {
		try {
			const raw = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.slice(-200) : [];
		} catch {
			return [];
		}
	});
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [projectDirAbs, setProjectDirAbs] = useState<string | null>(null);
	const assistantId = useRef<string | null>(null);
	const bottomRef = useRef<HTMLDivElement>(null);

	// Persist per-project — write on every bubble change. Drop the
	// "thinking" state from saved bubbles so we don't restore a stale
	// spinner when the project re-opens.
	useEffect(() => {
		try {
			const sanitized = bubbles
				.map((b) => ({ ...b, thinking: false }))
				.filter((b) => b.text.length > 0 || b.role !== "assistant");
			localStorage.setItem(storageKey, JSON.stringify(sanitized.slice(-200)));
		} catch { /* quota / privacy mode — ignore */ }
	}, [bubbles, storageKey]);

	// Resolve the absolute project dir once per slug so we can include it
	// in auto-context. The dir is what the agent uses as the default cwd
	// for FILE/BASH calls (and what it should pass to git/etc).
	useEffect(() => {
		let cancelled = false;
		void rpc.request.agentProjectListFiles({ slug })
			.then((r) => { if (!cancelled) setProjectDirAbs(r.dir); })
			.catch(() => { /* ignore */ });
		return () => { cancelled = true; };
	}, [slug]);

	// Listen to chat stream messages, filtered to this project's convId.
	useEffect(() => {
		const offDelta = onChatDelta((msg) => {
			if (msg.convId !== convId) return;
			setBubbles((bs) =>
				bs.map((b) =>
					b.id === assistantId.current
						? { ...b, text: b.text + msg.delta, thinking: false }
						: b,
				),
			);
		});
		const offComplete = onChatComplete((msg) => {
			if (msg.convId !== convId) return;
			setPending(false);
			assistantId.current = null;
		});
		const offError = onChatError((msg) => {
			if (msg.convId !== convId) return;
			setBubbles((bs) => [...bs, { id: uid(), role: "error", text: msg.message }]);
			setPending(false);
			assistantId.current = null;
		});
		return () => { offDelta(); offComplete(); offError(); };
	}, [convId]);

	// On slug change: rehydrate bubbles from the new project's storage.
	// Reset transient state (draft / pending / assistantId) since those
	// are tied to the previous project's in-flight turn.
	useEffect(() => {
		try {
			const raw = localStorage.getItem(storageKey);
			const parsed = raw ? JSON.parse(raw) : [];
			setBubbles(Array.isArray(parsed) ? parsed.slice(-200) : []);
		} catch {
			setBubbles([]);
		}
		setDraft("");
		setPending(false);
		setError(null);
		assistantId.current = null;
	}, [convId, storageKey]);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [bubbles.length]);

	const send = useCallback(async () => {
		const trimmed = draft.trim();
		if (!trimmed || pending) return;
		setError(null);
		// Auto-inject project context so the agent knows where it's working
		// without the user having to repeat it every turn. The `dir` line is
		// the absolute path on disk — FILE/BASH calls should default to it.
		const ctxLines = project
			? [
				`[workspace:${project.slug}]`,
				`project: "${project.name}" (${project.type}${project.template ? `/${project.template}` : ""})`,
				`description: ${project.description}`,
				...(projectDirAbs ? [`dir: ${projectDirAbs}`] : []),
				"Use FILE/BASH/EDIT/GREP/GLOB against this project's dir. Pass absolute paths anchored at `dir` above. Run shell commands with this dir as cwd. Spawn AGENT_PROJECT_NEW only if the user asks for a new space.",
			]
			: [`[workspace:${slug}]`];
		const text = `${ctxLines.join("\n")}\n\n---\n${trimmed}`;
		const userId = uid();
		const assistantBubble: Bubble = { id: uid(), role: "assistant", text: "", thinking: true };
		assistantId.current = assistantBubble.id;
		setBubbles((bs) => [...bs, { id: userId, role: "user", text: trimmed }, assistantBubble]);
		setDraft("");
		setPending(true);
		try {
			await rpc.request.chatSend({ convId, text });
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			setError(m);
			setBubbles((bs) => bs.map((b) => b.id === assistantBubble.id ? { ...b, role: "error", text: m, thinking: false } : b));
			setPending(false);
			assistantId.current = null;
		}
	}, [convId, draft, pending, project, slug]);

	return (
		<div className="workspace-agent">
			<header className="workspace-agent-head">
				<div style={{ flex: 1 }}>
					<strong>Coding chat</strong>
					<div className="hint">
						Drive the agent on <code>{project?.name ?? slug}</code>. Tools: FILE / BASH / EDIT / GLOB / GREP / WEB_FETCH / git. {bubbles.length > 0 && <span>· {bubbles.length} prior turns restored</span>}
					</div>
				</div>
				{bubbles.length > 0 && (
					<button
						type="button"
						className="btn-secondary"
						onClick={() => {
							if (!confirm("Clear this project's chat history?")) return;
							setBubbles([]);
							try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
						}}
						title="Clear saved chat for this project"
					>
						Clear
					</button>
				)}
			</header>
			<div className="workspace-agent-feed">
				{bubbles.length === 0 && (
					<div className="empty" style={{ padding: 24, textAlign: "center" }}>
						Ask the agent to add a feature, refactor a file, run a test, or scaffold something new in this space.
					</div>
				)}
				{bubbles.map((b) => (
					<div key={b.id} className={`workspace-agent-bubble role-${b.role}`}>
						{b.thinking ? <span className="hint">thinking…</span> : <pre className="workspace-agent-text">{b.text}</pre>}
					</div>
				))}
				<div ref={bottomRef} />
			</div>
			{error && <div className="banner error" style={{ margin: "0 12px 8px" }}>{error}</div>}
			<form
				className="workspace-agent-composer"
				onSubmit={(e) => { e.preventDefault(); void send(); }}
			>
				<textarea
					className="input"
					rows={3}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void send();
						}
					}}
					placeholder={`Ask the agent to work on "${project?.name ?? slug}"…  (⌘↵ to send)`}
					disabled={pending}
				/>
				<button type="submit" className="btn-primary" disabled={pending || draft.trim().length === 0}>
					{pending ? "Working…" : "Send"}
				</button>
			</form>
		</div>
	);
}

function uid() {
	return Math.random().toString(36).slice(2, 10);
}

// ── New Space modal ────────────────────────────────────────────────────

type TemplateOption = {
	id: "nextjs" | "carrot" | "static";
	type: "app" | "page";
	label: string;
	description: string;
	glyph: string;
	tint: "accent" | "ok" | "info";
};

const TEMPLATE_OPTIONS: TemplateOption[] = [
	{
		id: "nextjs",
		type: "app",
		label: "Next.js + Tailwind",
		description: "Next 16 · React 19 · Tailwind v4. Best for component-rich UIs and v0-style apps.",
		glyph: "N",
		tint: "accent",
	},
	{
		id: "carrot",
		type: "app",
		label: "Carrot (worker + web)",
		description: "Minimal worker.ts + web/index.html. Backend-capable, deploys as a sandboxed carrot.",
		glyph: "C",
		tint: "info",
	},
	{
		id: "static",
		type: "page",
		label: "Static page",
		description: "Plain HTML/CSS/JS. Sandboxed preview, no build step.",
		glyph: "P",
		tint: "ok",
	},
];

function NewSpaceModal({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (p: AgentProjectSummary) => void;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [templateId, setTemplateId] = useState<TemplateOption["id"]>("nextjs");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const tpl = TEMPLATE_OPTIONS.find((t) => t.id === templateId)!;

	const submit = async (e?: React.FormEvent) => {
		e?.preventDefault();
		if (!name.trim() || !description.trim()) {
			setError("Name and description are required.");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const r = await rpc.request.agentProjectCreate({
				name: name.trim(),
				description: description.trim(),
				type: tpl.type,
				template: tpl.id,
			});
			onCreated(r.project);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setSubmitting(false);
		}
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
				<header className="modal-head">
					<h3>New space</h3>
					<button type="button" className="btn-icon" onClick={onClose} aria-label="Close">×</button>
				</header>
				<div className="modal-body">
					<label className="field">
						<span className="field-label">Name</span>
						<input
							className="input"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. Color Palette Picker"
							autoFocus
							maxLength={100}
						/>
					</label>
					<label className="field">
						<span className="field-label">Description</span>
						<textarea
							className="input"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="What does it do? 1-2 sentences."
							rows={3}
						/>
					</label>
					<div className="field">
						<span className="field-label">Template</span>
						<div className="template-grid">
							{TEMPLATE_OPTIONS.map((t) => (
								<button
									key={t.id}
									type="button"
									className={`template-card ${templateId === t.id ? "active" : ""}`}
									onClick={() => setTemplateId(t.id)}
								>
									<span className={`template-card-glyph tint-${t.tint}`}>{t.glyph}</span>
									<span className="template-card-meta">
										<strong>{t.label}</strong>
										<span className="hint">{t.description}</span>
									</span>
								</button>
							))}
						</div>
					</div>
					{error && <div className="banner error" style={{ margin: 0 }}>{error}</div>}
				</div>
				<footer className="modal-foot">
					<button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
					<button type="submit" className="btn-primary" disabled={submitting || !name.trim() || !description.trim()}>
						{submitting ? "Creating…" : "Create"}
					</button>
				</footer>
			</form>
		</div>
	);
}

// Disable Monaco workers (the bundled worker-loader doesn't ship in our
// HTML shell). Monaco falls back to running tokenization on the main
// thread, which is fine for project-scale files.
if (typeof window !== "undefined") {
	(window as unknown as { MonacoEnvironment?: { getWorker?: unknown } }).MonacoEnvironment = {
		getWorker: () => ({ postMessage() {}, terminate() {} }),
	};
}
