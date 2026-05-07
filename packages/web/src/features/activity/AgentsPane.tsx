import { Terminal, WebSocketTransport, useTerminal } from "@wterm/react";
import "@wterm/react/css";
import type {
	WorkspaceAgentRecord,
	WorkspaceAgentsSnapshot,
	WorkspaceProjectFile,
	WorkspaceProjectFileNode,
	WorkspaceProjectRecord,
	WorkspaceProjectsSnapshot,
} from "@detour/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebClient } from "../../api/client";
import { useDetourTheme } from "../../useDetourTheme";
import { usePoller } from "./usePoller";

type AgentPanel = "terminal" | "preview" | "code";
type AgentEndpointConfig = {
	apiBase: string;
	streamBase: string;
	remote: boolean;
};

const DEFAULT_LOCAL_AGENT_API_BASE = "http://127.0.0.1:2138";
const BOOT_STATS = [
	["Runtime", "starting"],
	["Workspace", "standing by"],
	["Agents", "waiting"],
	["Streams", "local"],
] as const;
const BOOT_ACTIVITY = [
	"Core API handshake pending",
	"Workspace stream ready for logs",
	"Preview tab waiting for a project",
	"Terminal attached when agent starts",
];

function fmtTime(ts?: number): string {
	if (!ts) return "-";
	return new Date(ts).toLocaleString();
}

function fmtDuration(agent: WorkspaceAgentRecord): string {
	const end = agent.endedAt ?? Date.now();
	const ms = Math.max(0, end - agent.startedAt);
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}m`;
}

function fmtBytes(bytes?: number): string {
	if (bytes === undefined) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusTone(status: WorkspaceAgentRecord["status"]): string {
	if (status === "completed") return "ok";
	if (status === "failed") return "err";
	if (status === "running") return "info";
	return "muted";
}

function terminalText(text: string): string {
	return text.replace(/\r?\n/g, "\r\n");
}

function urlParam(name: string): string | null {
	const search = new URLSearchParams(window.location.search);
	const direct = search.get(name);
	if (direct) return direct;
	const hashQuery = window.location.hash.split("?")[1];
	if (!hashQuery) return null;
	return new URLSearchParams(hashQuery).get(name);
}

function cleanBase(value: string | null | undefined): string {
	return value?.trim().replace(/\/+$/, "") ?? "";
}

function wsBaseFromHttp(base: string): string {
	if (base) return base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
	return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

function isLocalHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function agentEndpoints(): AgentEndpointConfig {
	const env = import.meta.env as Record<string, string | undefined>;
	const explicitApiBase = cleanBase(urlParam("agentApi") ?? env.VITE_DETOUR_AGENT_API_URL);
	const explicitStreamBase = cleanBase(urlParam("agentWs") ?? env.VITE_DETOUR_AGENT_WS_URL);
	const localApiBase = isLocalHost(window.location.hostname) ? DEFAULT_LOCAL_AGENT_API_BASE : "";
	const streamBase = explicitStreamBase || wsBaseFromHttp(explicitApiBase || localApiBase);
	return {
		apiBase: explicitApiBase,
		streamBase,
		remote: Boolean(explicitApiBase || explicitStreamBase),
	};
}

function streamUrlFor(base: string, agentId: string): string {
	return `${base}/api/activity/workspace-agents/${encodeURIComponent(agentId)}/stream`;
}

function parentPath(path: string): string {
	const parts = path.split("/").filter(Boolean);
	parts.pop();
	return parts.join("/");
}

function projectPreview(project: WorkspaceProjectRecord | null, agent: WorkspaceAgentRecord | null): string | undefined {
	return agent?.previewUrl ?? project?.previewUrl;
}

export function AgentsView() {
	const endpoints = useMemo(() => agentEndpoints(), []);
	const client = useMemo(() => new WebClient(endpoints.apiBase), [endpoints.apiBase]);
	useDetourTheme(client);

	return <AgentsPane client={client} standalone streamBase={endpoints.streamBase} remote={endpoints.remote} />;
}

export function AgentsPane({
	client,
	standalone = false,
	streamBase,
	remote = false,
}: {
	client: WebClient;
	standalone?: boolean;
	streamBase?: string;
	remote?: boolean;
}) {
	const agentFetcher = useCallback(() => client.activityWorkspaceAgents(), [client]);
	const projectFetcher = useCallback(() => client.activityWorkspaceProjects(), [client]);
	const {
		data: agentData,
		error: agentError,
		refresh: refreshAgents,
	} = usePoller<WorkspaceAgentsSnapshot>(agentFetcher, 1500);
	const {
		data: projectData,
		error: projectError,
		refresh: refreshProjects,
	} = usePoller<WorkspaceProjectsSnapshot>(projectFetcher, 2000);
	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [panel, setPanel] = useState<AgentPanel>("terminal");
	const [deletingProject, setDeletingProject] = useState(false);
	const agents = agentData?.agents ?? [];
	const projects = projectData?.projects ?? [];
	const selectedProject = useMemo(
		() => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null,
		[projects, selectedProjectId],
	);
	const visibleAgents = useMemo(
		() => selectedProject
			? agents.filter((agent) => selectedProject.agentIds.includes(agent.id))
			: agents,
		[agents, selectedProject],
	);
	const selected = useMemo(
		() => visibleAgents.find((agent) => agent.id === selectedId) ?? visibleAgents[0] ?? null,
		[visibleAgents, selectedId],
	);
	const previewUrl = projectPreview(selectedProject, selected);
	const error = agentError ?? projectError;
	const refresh = useCallback(() => {
		refreshAgents();
		refreshProjects();
	}, [refreshAgents, refreshProjects]);
	const deleteSelectedProject = useCallback(async () => {
		if (!selectedProject) return;
		if (!confirm(`Delete managed project "${selectedProject.name}" and ${selectedProject.agentIds.length} session records?`)) return;
		setDeletingProject(true);
		try {
			await client.deleteWorkspaceProject(selectedProject.id);
			setSelectedProjectId(null);
			setSelectedId(null);
			refresh();
		} finally {
			setDeletingProject(false);
		}
	}, [client, refresh, selectedProject]);

	useEffect(() => {
		if (!selectedProjectId && projects.length > 0) setSelectedProjectId(projects[0].id);
	}, [projects, selectedProjectId]);

	useEffect(() => {
		if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) {
			setSelectedProjectId(projects[0]?.id ?? null);
		}
	}, [projects, selectedProjectId]);

	useEffect(() => {
		if (!selected || !visibleAgents.some((agent) => agent.id === selectedId)) {
			setSelectedId(visibleAgents[0]?.id ?? null);
		}
	}, [selected, selectedId, visibleAgents]);

	useEffect(() => {
		if (!selected) {
			setPanel("code");
			return;
		}
		setPanel(selected.status === "completed" && previewUrl ? "preview" : "terminal");
	}, [previewUrl, selected?.id]);

	if (standalone && error) return <PublicAgentsWorkbench status={error} />;
	if (standalone && !agentData && !projectData) return <PublicAgentsWorkbench />;
	if (error) return <div className="banner error">{error}</div>;

	return (
		<div className={standalone ? "agents-workbench standalone" : "agents-workbench"}>
			<aside className="agents-project-rail">
					<div className="agents-sidebar-head">
						<div>
							<div className="agents-kicker">Detour</div>
							<div className="agents-title">Workspace</div>
						</div>
						<button type="button" className="agents-icon-btn" onClick={refresh} title="Refresh">
							refresh
						</button>
						<button type="button" className="agents-icon-btn" onClick={deleteSelectedProject} disabled={!selectedProject || deletingProject} title="Delete selected managed project">
							delete
						</button>
					</div>
				<div className="agents-count">
					{projectData ? `${projects.length} projects` : "loading"} · {remote ? "remote" : "local"}
				</div>
				<div className="agents-project-list">
					{projects.map((project) => (
						<button
							key={project.id}
							type="button"
							className={selectedProject?.id === project.id ? "agent-project active" : "agent-project"}
							onClick={() => {
								setSelectedProjectId(project.id);
								setSelectedId(project.agentIds[0] ?? null);
							}}
						>
							<div className="agent-project-head">
								<span className={project.runningCount > 0 ? "agent-dot info" : "agent-dot ok"} />
								<span className="agent-project-name">{project.name}</span>
							</div>
							<div className="agent-project-path">{project.cwd}</div>
							<div className="agent-project-stats">
								<span>{project.agentIds.length} runs</span>
								<span>{project.runningCount} live</span>
								<span>{project.failedCount} failed</span>
							</div>
						</button>
					))}
					{projectData && projects.length === 0 && (
						<div className="agents-empty">
							No projects yet.
						</div>
					)}
				</div>
			</aside>
			<aside className="agents-sidebar">
				<div className="agents-sidebar-head compact">
					<div>
						<div className="agents-kicker">Agents</div>
						<div className="agents-title small">{selectedProject?.name ?? "Sessions"}</div>
					</div>
				</div>
				<div className="agents-count">
					{agentData ? `${visibleAgents.length} sessions` : "loading"}
				</div>
				<div className="agents-list">
					{visibleAgents.map((agent) => (
						<button
							key={agent.id}
							type="button"
							className={selected?.id === agent.id ? "agent-session active" : "agent-session"}
							onClick={() => setSelectedId(agent.id)}
						>
							<div className="agent-session-head">
								<span className={`agent-dot ${statusTone(agent.status)}`} />
								<span className="agent-session-status">{agent.status}</span>
								<span className="agent-session-provider">{agent.provider}</span>
							</div>
							<div className="agent-session-task">{agent.task}</div>
							<div className="agent-session-meta">
								<span>{agent.agentType}</span>
								<span>{fmtDuration(agent)}</span>
								<span>{fmtTime(agent.startedAt)}</span>
							</div>
						</button>
					))}
					{agentData && visibleAgents.length === 0 && (
						<div className="agents-empty">
							No sessions for this project.
						</div>
					)}
				</div>
			</aside>
			<main className="agents-stage">
				<div className="agents-command-bar">
					<div className="agents-command-copy">
						<div className="agents-agent-line">
							<span className={`agent-dot ${selected ? statusTone(selected.status) : "muted"}`} />
							<span>{selectedProject?.name ?? "Workspace"}</span>
							{selected && <span className="agents-muted">{selected.provider}/{selected.agentType}</span>}
							{selected && <span className="agents-muted">exit {selected.exitCode ?? "-"}</span>}
						</div>
						<div className="agents-path">{selectedProject?.cwd ?? "No project selected"}</div>
					</div>
					<div className="agents-tabs" role="tablist">
						<button
							type="button"
							className={panel === "terminal" ? "active" : ""}
							onClick={() => setPanel("terminal")}
							disabled={!selected}
						>
							Terminal
						</button>
						<button
							type="button"
							className={panel === "preview" ? "active" : ""}
							onClick={() => setPanel("preview")}
							disabled={!previewUrl}
						>
							Preview
						</button>
						<button
							type="button"
							className={panel === "code" ? "active" : ""}
							onClick={() => setPanel("code")}
							disabled={!selectedProject}
						>
							Code
						</button>
					</div>
				</div>
				<div className="agents-command">
					{selected ? `${selected.command} ${selected.args.join(" ")}` : "No active command"}
				</div>
				<div className="agents-panel">
					<div className={panel === "terminal" ? "agents-panel-active" : "agents-panel-hidden"}>
						{selected ? (
							<AgentLogTerminal
								client={client}
								agent={selected}
								streamUrl={streamBase ? streamUrlFor(streamBase, selected.id) : undefined}
							/>
						) : (
							<div className="agents-empty center">No terminal session selected.</div>
						)}
					</div>
					<div className={panel === "preview" ? "agents-panel-active" : "agents-panel-hidden"}>
						<AgentPreview previewUrl={previewUrl} />
					</div>
					<div className={panel === "code" ? "agents-panel-active" : "agents-panel-hidden"}>
						{selectedProject ? (
							<ProjectCodePanel client={client} project={selectedProject} />
						) : (
							<div className="agents-empty center">No project selected.</div>
						)}
					</div>
				</div>
			</main>
		</div>
	);
}

function PublicAgentsWorkbench({ status }: { status?: string }) {
	return (
		<main className="public-landing">
			<section className="public-workbench-shell" aria-label="Detour agent workbench">
				<aside className="public-workbench-rail">
					<div className="public-landing-kicker">Detour</div>
					<h1>Agent workbench</h1>
					<p>Live terminal, project preview, files, and activity once the local agent is online.</p>
				</aside>

				<div className="public-workbench-core">
					<div className="public-workbench-tabs">
						<span className="active">Terminal</span>
						<span>Preview</span>
						<span>Code</span>
					</div>
					<div className="public-workbench-stage">
						<div className="public-terminal">
							<div>$ detour workspace status</div>
							<div>connecting to local agent api on 127.0.0.1:2138</div>
							<div>waiting for runtime, providers, channels, and workspace agents</div>
							<div className="public-terminal-cursor">ready when Detour is</div>
						</div>
						<div className="public-preview">
							<div className="public-preview-window">
								<div className="public-preview-grid" />
							</div>
							<span>Preview mounts here after a project exposes one.</span>
						</div>
					</div>
				</div>

				<aside className="public-workbench-side">
					<div className="public-widget-grid">
						{BOOT_STATS.map(([label, value]) => (
							<div className="public-widget" key={label}>
								<span>{label}</span>
								<strong>{value}</strong>
							</div>
						))}
					</div>
					<div className="public-activity-card">
						<div className="public-activity-title">Activity</div>
						{BOOT_ACTIVITY.map((item) => (
							<div className="public-activity-row" key={item}>
								<span />
								{item}
							</div>
						))}
					</div>
				</aside>
			</section>
			<div className="public-landing-status">
				{status ?? "Agent backend unavailable from this browser. Start Detour locally to populate the live workspace."}
			</div>
		</main>
	);
}

function AgentPreview({ previewUrl }: { previewUrl?: string }) {
	if (!previewUrl) {
		return <div className="agents-preview-empty">No preview detected for this project.</div>;
	}
	return (
		<iframe
			className="agents-preview-frame"
			src={previewUrl}
			title="Project preview"
			allow="local-network-access"
			sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
		/>
	);
}

function ProjectCodePanel({
	client,
	project,
}: {
	client: WebClient;
	project: WorkspaceProjectRecord;
}) {
	const [dirPath, setDirPath] = useState("");
	const [entries, setEntries] = useState<WorkspaceProjectFileNode[]>([]);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [file, setFile] = useState<WorkspaceProjectFile | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const parts = dirPath.split("/").filter(Boolean);

	useEffect(() => {
		setDirPath("");
		setSelectedPath(null);
		setFile(null);
	}, [project.id]);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		client
			.activityWorkspaceProjectFiles(project.id, dirPath)
			.then((result) => {
				if (cancelled) return;
				setEntries(result.entries);
				setLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [client, dirPath, project.id]);

	useEffect(() => {
		if (!selectedPath) return;
		let cancelled = false;
		setError(null);
		client
			.activityWorkspaceProjectFile(project.id, selectedPath)
			.then((result) => {
				if (!cancelled) setFile(result);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [client, project.id, selectedPath]);

	return (
		<div className="agents-code">
			<div className="agents-file-browser">
				<div className="agents-breadcrumbs">
					<button type="button" onClick={() => setDirPath("")}>root</button>
					{parts.map((part, index) => {
						const path = parts.slice(0, index + 1).join("/");
						return (
							<button key={path} type="button" onClick={() => setDirPath(path)}>
								{part}
							</button>
						);
					})}
				</div>
				{dirPath && (
					<button type="button" className="agent-file-row parent" onClick={() => setDirPath(parentPath(dirPath))}>
						<span>..</span>
						<span />
					</button>
				)}
				<div className="agents-file-list">
					{entries.map((entry) => (
						<button
							key={entry.path}
							type="button"
							className={
								selectedPath === entry.path
									? "agent-file-row active"
									: "agent-file-row"
							}
							onClick={() => {
								if (entry.type === "directory") {
									setDirPath(entry.path);
									return;
								}
								setSelectedPath(entry.path);
							}}
						>
							<span className={entry.type === "directory" ? "agent-file-name dir" : "agent-file-name"}>
								{entry.name}
							</span>
							<span className="agent-file-size">{fmtBytes(entry.size)}</span>
						</button>
					))}
					{!loading && entries.length === 0 && (
						<div className="agents-empty">Empty directory.</div>
					)}
				</div>
			</div>
			<div className="agents-editor">
				<div className="agents-editor-head">
					<span>{file?.path ?? "Select a file"}</span>
					{file && <span>{file.language} · {fmtBytes(file.size)}</span>}
				</div>
				{error && <div className="banner error">{error}</div>}
				{file ? (
					<pre className="agents-code-pre">{file.content}{file.truncated ? "\n\n[truncated]" : ""}</pre>
				) : (
					<div className="agents-empty center">No file open.</div>
				)}
			</div>
		</div>
	);
}

function AgentLogTerminal({
	client,
	agent,
	streamUrl,
}: {
	client: WebClient;
	agent: WorkspaceAgentRecord;
	streamUrl?: string;
}) {
	const { ref, write } = useTerminal();
	const offsetRef = useRef(0);
	const activeAgentRef = useRef(agent.id);
	const transportRef = useRef<WebSocketTransport | null>(null);

	useEffect(() => {
		activeAgentRef.current = agent.id;
		offsetRef.current = 0;
		write("\x1b[2J\x1b[H");
		write(terminalText(`Detour workspace agent ${agent.id}\n`));
	}, [agent.id, write]);

	useEffect(() => {
		let cancelled = false;
		if (streamUrl) {
			const transport = new WebSocketTransport({
				url: streamUrl,
				reconnect: true,
				maxReconnectDelay: 5000,
				onData: (data) => {
					if (cancelled || activeAgentRef.current !== agent.id) return;
					if (typeof data === "string") write(terminalText(data));
					else write(data);
				},
				onOpen: () => {
					if (!cancelled) write(terminalText("[wterm stream connected]\n"));
				},
				onClose: () => {
					if (!cancelled) write(terminalText("\n[wterm stream disconnected]\n"));
				},
			});
			transportRef.current = transport;
			transport.connect();
			return () => {
				cancelled = true;
				transport.close();
				if (transportRef.current === transport) transportRef.current = null;
			};
		}
		const poll = async () => {
			try {
				const log = await client.activityWorkspaceAgentLog(
					agent.id,
					offsetRef.current,
				);
				if (cancelled || activeAgentRef.current !== agent.id) return;
				offsetRef.current = log.nextOffset;
				if (log.text) write(terminalText(log.text));
				if (log.truncated) {
					write(terminalText("\n[log window truncated]\n"));
				}
			} catch (err) {
				if (!cancelled) {
					write(
						terminalText(`\n[log read failed] ${err instanceof Error ? err.message : String(err)}\n`),
					);
				}
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), 1000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [agent.id, client, streamUrl, write]);

	return (
		<div className="agents-terminal-frame">
			<Terminal
				ref={ref}
				className="agents-terminal"
				cols={100}
				rows={28}
				autoResize
				cursorBlink={false}
				onData={() => {}}
				aria-readonly="true"
				theme="default"
			/>
		</div>
	);
}
