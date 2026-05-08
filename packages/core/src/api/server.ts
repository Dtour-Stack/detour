import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
	ActivityXAutonomyUpdate,
	BrowserCommand,
	BrowserCommandInput,
	BrowserCommandResult,
	ChatCommandInfo,
	ChroniclerConfig,
	CodexPetActivity,
	CodexPetAnimationState,
	CodexPetSpawnResponse,
	CodexPetSummary,
	CodexPetsResponse,
	ProviderId,
	SetActiveProviderBody,
	SetEnabledBackendsBody,
	SetProviderKeyBody,
	WindowOpenTarget,
	WorkspaceAgentRecord,
	WorkspaceAgentStatus,
	WorkspaceProjectFile,
	WorkspaceProjectFileNode,
	WorkspaceProjectFilesSnapshot,
	WorkspaceProjectRecord,
	WorkspaceProjectsSnapshot,
	WsClientMessage,
	WsServerMessage,
} from "@detour/shared";
import { ModelType, type Memory, type Service, type UUID } from "@elizaos/core";
import { listCodexPets, type PetSummary } from "@detour/plugin-codex-pets";
import type { Server, ServerWebSocket } from "bun";
import type { ActivityService } from "../activity";
import { xAutonomyRuntimeSettings } from "../activity/autonomy-service";
import type { AccountCredentialProvider, AuthService } from "../auth";
import { ALL_PROVIDER_IDS, PROVIDER_ENV } from "../auth";
import type { BackendOps, InstallableBackendId } from "../backend-ops";
import type { ChannelsService } from "../channels";
import type {
	ChannelGatewayService,
	GatewayChannel,
	GatewayDirection,
	ListOptions as GatewayListOptions,
} from "../channels/gateway";
import type { ConfigService } from "../config-service";
import { codexSkillChatCommands } from "../codex-skills";
import type { CronService } from "../cron-service";
import { runDiscordCatchUp } from "../discord-catchup";
import type { InboxKind, InboxService, InboxStatus } from "../inbox";
import type { LlamaServerService } from "../llama/server-service";
import { fetchOpenRouterModels } from "../openrouter-models";
import {
	listPermissions,
	openPermissionPane,
	type PermissionId,
} from "../os-permissions";
import type { OwnerBindService, OwnerConnector } from "../owner-bind";
import type { GraphFilter, PensieveService } from "../pensieve";
import { pensieveAudit } from "../pensieve";
import { KNOWN_MEMORY_TABLES } from "../pensieve/memory-service";
import type { RuntimeService } from "../runtime";
import { newTraceId, traceScope } from "../trace";
import {
	BACKEND_INSTALL_SPECS,
	type BackendId,
	buildInstallCommand,
	categorizeKey,
	currentPlatform,
	deleteSavedLogin,
	detectPackageManagers,
	inferProviderId,
	listVaultInventory,
	type RoutingConfig,
	readEntryMeta,
	readRoutingConfig,
	removeEntryMeta,
	resolveRunnableMethods,
	type SavedLogin,
	setEntryMeta,
	setSavedLogin,
	type VaultService,
	writeRoutingConfig,
} from "../vault";

const VERSION = "0.0.1";

type WsData =
	| { id: string; kind?: "app" }
	| { id: string; kind: "agent-log"; agentId: string; offset: number };

type Listener = (msg: WsServerMessage) => void;

type ApiResponseHelpers = {
	json(data: unknown, status?: number): Response;
	ok(): Response;
	error(message: string, status?: number): Response;
};

type ApiRequestContext = ApiResponseHelpers & {
	req: Request;
	url: URL;
	path: string;
};

type ApiRouteHandler = (ctx: ApiRequestContext) => Promise<Response | null>;

type RuntimeSkillRecord = {
	slug: string;
	name: string;
	description: string;
	source?: string;
	sourceDir?: string;
	path?: string;
	enabled?: boolean;
};

type RuntimeSkillsService = Service & {
	getLoadedSkills(): RuntimeSkillRecord[];
	getCatalogStats?(): {
		loaded: number;
		total: number;
		storageType: string;
	};
};

const BROWSER_CONTROL_GLOBAL = Symbol.for("detour.browser.control");
const MAX_BROWSER_COMMANDS = 100;
const WORKSPACE_AGENT_STATE_DIR = join(homedir(), ".detour", "workspace-agents");
const WORKSPACE_AGENT_STATE_FILE = join(WORKSPACE_AGENT_STATE_DIR, "sessions.json");
const WORKSPACE_PROJECT_ROOT = join(homedir(), ".detour", "workspace", "projects");
const MAX_WORKSPACE_AGENT_LOG_CHARS = 200_000;
const MAX_WORKSPACE_FILE_BYTES = 300_000;
const MAX_WORKSPACE_PREVIEW_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WORKSPACE_DIRECTORY_ENTRIES = 400;
const PREVIEW_URL_PATTERN =
	/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s\\"'<>),\]}]*)?/gi;
const GENERATED_PREVIEW_PATTERN =
	/DETOUR_GENERATED_PROJECT_OK\s+([^\s"'<>]+\.html)/i;
const WORKSPACE_IGNORED_ENTRIES = new Set([
	".git",
	".next",
	".turbo",
	".cache",
	"build",
	"coverage",
	"dist",
	"node_modules",
]);
const WORKSPACE_PREVIEW_ENTRYPOINTS = [
	"index.html",
	"public/index.html",
	"app/index.html",
	"src/index.html",
	"exports/index.html",
];
const PET_ATLAS = {
	columns: 8,
	rows: 9,
	cellWidth: 192,
	cellHeight: 208,
	width: 1536,
	height: 1872,
};
const PET_STATES = new Set<CodexPetAnimationState>([
	"idle",
	"running-right",
	"running-left",
	"waving",
	"jumping",
	"failed",
	"waiting",
	"running",
	"review",
]);
const INBOX_STATUSES = new Set([
	"pending",
	"acting",
	"acknowledged",
	"acted",
	"dismissed",
]);
const MEMORY_TABLES = new Set<string>(KNOWN_MEMORY_TABLES);
const WINDOW_OPEN_TARGETS = new Set<WindowOpenTarget>([
	"chat",
	"command-palette",
	"settings",
	"pensieve",
	"activity",
	"channels",
	"browser",
	"agents",
	"pet",
]);

function corsHeaders(contentType?: string): HeadersInit {
	return {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"access-control-allow-headers":
			"content-type, access-control-request-private-network, access-control-request-local-network",
		"access-control-allow-private-network": "true",
		"access-control-allow-local-network": "true",
		...(contentType ? { "content-type": contentType } : {}),
	};
}

const NATIVE_CHAT_COMMANDS: ChatCommandInfo[] = [
	{ name: "/browser", usage: "/browser <url or search>", description: "Open the agent browser.", insert: "/browser ", aliases: ["/open", "/web", "/internet"], source: "native" },
	{ name: "/inspect", usage: "/inspect", description: "Read the active browser tab.", insert: "/inspect", aliases: ["/read-page"], source: "native" },
	{ name: "/script", usage: "/script <javascript>", description: "Run JavaScript in the browser tab.", insert: "/script ", aliases: ["/js"], source: "native" },
	{ name: "/logins", usage: "/logins [domain]", description: "List saved logins from vault backends.", insert: "/logins ", aliases: ["/passwords"], source: "native" },
	{ name: "/login", usage: "/login <source> <identifier> [url]", description: "Fill a saved login in the browser.", insert: "/login 1password ", source: "native" },
	{ name: "/1password", usage: "/1password <identifier> [url]", description: "Fill a 1Password login in the browser.", insert: "/1password ", aliases: ["/op"], source: "native" },
	{ name: "/pet", usage: "/pet [name]", description: "Spawn or inspect a Codex pet.", insert: "/pet ", source: "native" },
	{ name: "/hatch", usage: "/hatch <concept>", description: "Start the full Codex pet hatch pipeline.", insert: "/hatch ", source: "native" },
	{ name: "/codex", usage: "/codex [cwd=/path] <task>", description: "Run a Codex coding subagent and wait for the result.", insert: "/codex ", aliases: ["/task"], source: "native" },
	{ name: "/claude", usage: "/claude [cwd=/path] <task>", description: "Run a Claude coding subagent and wait for the result.", insert: "/claude ", source: "native" },
	{ name: "/spawn-codex", usage: "/spawn-codex [cwd=/path] <task>", description: "Start a Codex coding subagent in the background.", insert: "/spawn-codex ", source: "native" },
	{ name: "/spawn-claude", usage: "/spawn-claude [cwd=/path] <task>", description: "Start a Claude coding subagent in the background.", insert: "/spawn-claude ", source: "native" },
	{ name: "/pet-animate", usage: "/pet-animate <pet> <state> <motion>", description: "Create or repair a pet animation row.", insert: "/pet-animate ", aliases: ["/animate-pet"], source: "native" },
	{ name: "/help", usage: "/help", description: "Show native chat commands.", insert: "/help", aliases: ["/commands"], source: "native" },
];

function chatCommands(): ChatCommandInfo[] {
	const byName = new Map<string, ChatCommandInfo>();
	for (const command of [...NATIVE_CHAT_COMMANDS, ...codexSkillChatCommands()]) {
		if (!byName.has(command.name)) byName.set(command.name, command);
	}
	return [...byName.values()];
}

function windowMessageForTarget(target: WindowOpenTarget): WsServerMessage {
	switch (target) {
		case "command-palette":
			return { kind: "ui:open-command-palette" };
		case "settings":
			return { kind: "ui:open-settings" };
		case "pensieve":
			return { kind: "ui:open-pensieve" };
		case "activity":
			return { kind: "ui:open-activity" };
		case "channels":
			return { kind: "ui:open-channels" };
		case "browser":
			return { kind: "ui:open-browser" };
		case "agents":
			return { kind: "ui:open-agents" };
		case "pet":
			return { kind: "ui:open-pet" };
		case "chat":
			return { kind: "ui:open-chat" };
	}
}

function parseWindowOpenTarget(value: unknown): WindowOpenTarget | null {
	if (typeof value !== "string") return null;
	for (const target of WINDOW_OPEN_TARGETS) {
		if (target === value) return target;
	}
	return null;
}

function parseInboxStatus(value: unknown): InboxStatus | null {
	return typeof value === "string" && INBOX_STATUSES.has(value)
		? (value as InboxStatus)
		: null;
}

function publicJson(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: corsHeaders("application/json"),
	});
}

function publicOptions(): Response {
	return new Response(null, {
		status: 204,
		headers: corsHeaders(),
	});
}

function publicError(message: string, status = 400): Response {
	return publicJson({ error: message }, status);
}

function parseMemoryTable(
	value: string | null,
): { ok: true; tableName?: string } | { ok: false; error: string } {
	if (!value) return { ok: true };
	if (!MEMORY_TABLES.has(value))
		return { ok: false, error: `unknown memory table: ${value}` };
	return { ok: true, tableName: value };
}

function parseBackendIds(values: string[]): BackendId[] | null {
	const enabled: BackendId[] = [];
	for (const value of values) {
		switch (value) {
			case "in-house":
			case "1password":
			case "protonpass":
			case "bitwarden":
				enabled.push(value);
				break;
			default:
				return null;
		}
	}
	return enabled;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function workspaceAgentStatus(value: unknown): WorkspaceAgentStatus | null {
	if (
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "stopped"
	) {
		return value;
	}
	return null;
}

function workspaceAgentProvider(value: unknown): WorkspaceAgentRecord["provider"] | null {
	if (value === "acpx" || value === "codex" || value === "claude") return value;
	return null;
}

function workspacePreviewUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
		return url.toString();
	} catch {
		return null;
	}
}

function previewUrlFromLog(logPath: string): string | null {
	if (!existsSync(logPath)) return null;
	const text = readFileSync(logPath, "utf8");
	for (const match of text.matchAll(PREVIEW_URL_PATTERN)) {
		const previewUrl = workspacePreviewUrl(match[0]);
		if (previewUrl) return previewUrl;
	}
	return null;
}

function agentMessageTextFromLog(text: string): string {
	const fragments: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("{")) continue;
		try {
			const event = recordValue(JSON.parse(line));
			const params = recordValue(event?.params);
			const update = recordValue(params?.update);
			const content = recordValue(update?.content);
			const fragment = stringValue(content?.text);
			if (
				update?.sessionUpdate === "agent_message_chunk" &&
				fragment !== null
			) {
				fragments.push(fragment);
			}
		} catch {
			continue;
		}
	}
	return fragments.join("");
}

function previewPathFromLog(logPath: string): string | null {
	if (!existsSync(logPath)) return null;
	const text = readFileSync(logPath, "utf8");
	const match = `${text}\n${agentMessageTextFromLog(text)}`.match(
		GENERATED_PREVIEW_PATTERN,
	);
	return match ? projectSubpath(match[1] ?? "") : null;
}

function workspaceProjectFilePreviewUrl(
	origin: string,
	cwd: string,
	pathValue: string,
): string {
	return `${origin}/api/activity/workspace-projects/${encodeURIComponent(workspaceProjectId(cwd))}/preview/${encodePreviewPath(pathValue)}`;
}

function parseWorkspaceAgent(
	value: unknown,
	origin?: string,
): WorkspaceAgentRecord | null {
	const source = recordValue(value);
	if (!source) return null;
	const id = stringValue(source.id);
	const provider = workspaceAgentProvider(source.provider);
	const agentType = stringValue(source.agentType);
	const task = stringValue(source.task);
	const cwd = stringValue(source.cwd);
	const status = workspaceAgentStatus(source.status);
	const command = stringValue(source.command);
	const startedAt = numberValue(source.startedAt);
	const logPath = stringValue(source.logPath);
	const args = Array.isArray(source.args)
		? source.args.map(stringValue).filter((item) => item !== null)
		: null;
	if (
		!id ||
		!provider ||
		!agentType ||
		!task ||
		!cwd ||
		!status ||
		!command ||
		!args ||
		!logPath ||
		startedAt === null
	) {
		return null;
	}
	const pid = numberValue(source.pid);
	const exitCode = source.exitCode === null ? null : numberValue(source.exitCode);
	const signal = stringValue(source.signal);
	const endedAt = numberValue(source.endedAt);
	const credentialAttempt = numberValue(source.credentialAttempt);
	const previewUrl = workspacePreviewUrl(source.previewUrl);
	const publicUrl = workspacePreviewUrl(source.publicUrl);
	const publicUrlProvider = source.publicUrlProvider === "ngrok" ? "ngrok" : null;
	const publicUrlPid = numberValue(source.publicUrlPid);
	const publicUrlStartedAt = numberValue(source.publicUrlStartedAt);
	const publicUrlError = stringValue(source.publicUrlError);
	const previewPath = previewPathFromLog(logPath);
	const generatedPreviewUrl = origin && previewPath
		? workspaceProjectFilePreviewUrl(origin, cwd, previewPath)
		: null;
	const detectedPreviewUrl = generatedPreviewUrl ?? previewUrl ?? previewUrlFromLog(logPath);
	return {
		id,
		provider,
		agentType,
		task,
		cwd,
		status,
		command,
		args,
		logPath,
		...(detectedPreviewUrl ? { previewUrl: detectedPreviewUrl } : {}),
		...(publicUrl ? { publicUrl } : {}),
		...(publicUrlProvider ? { publicUrlProvider } : {}),
		...(publicUrlPid !== null ? { publicUrlPid } : {}),
		...(publicUrlStartedAt !== null ? { publicUrlStartedAt } : {}),
		...(publicUrlError !== null ? { publicUrlError } : {}),
		startedAt,
		...(pid !== null ? { pid } : {}),
		...(exitCode !== null || source.exitCode === null ? { exitCode } : {}),
		...(signal !== null ? { signal } : {}),
		...(endedAt !== null ? { endedAt } : {}),
		...(credentialAttempt !== null ? { credentialAttempt } : {}),
	};
}

function readWorkspaceAgents(origin?: string): WorkspaceAgentRecord[] {
	if (!existsSync(WORKSPACE_AGENT_STATE_FILE)) return [];
	const parsed = recordValue(JSON.parse(readFileSync(WORKSPACE_AGENT_STATE_FILE, "utf8")));
	const rawAgents = Array.isArray(parsed?.agents) ? parsed.agents : [];
	return rawAgents
		.map((agent) => parseWorkspaceAgent(agent, origin))
		.filter((agent): agent is WorkspaceAgentRecord => agent !== null)
			.sort((a, b) => b.startedAt - a.startedAt);
}

function writeWorkspaceAgents(agents: WorkspaceAgentRecord[]): void {
	mkdirSync(WORKSPACE_AGENT_STATE_DIR, { recursive: true });
	writeFileSync(WORKSPACE_AGENT_STATE_FILE, JSON.stringify({ agents }, null, 2));
}

function safeWorkspaceAgentLogPath(agent: WorkspaceAgentRecord): string | null {
	const expected = join(WORKSPACE_AGENT_STATE_DIR, `${agent.id}.log`);
	return agent.logPath === expected ? expected : null;
}

function workspaceProjectId(cwd: string): string {
	return Buffer.from(cwd, "utf8").toString("base64url");
}

function isManagedWorkspaceProjectPath(cwd: string): boolean {
	const root = resolve(WORKSPACE_PROJECT_ROOT);
	const target = resolve(cwd);
	const rel = relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function previewContentType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
	if (ext === ".css") return "text/css; charset=utf-8";
	if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
	if (ext === ".json") return "application/json; charset=utf-8";
	if (ext === ".svg") return "image/svg+xml";
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	if (ext === ".ico") return "image/x-icon";
	return "text/plain; charset=utf-8";
}

function encodePreviewPath(pathValue: string): string {
	return pathValue.split("/").map(encodeURIComponent).join("/");
}

function scanPreviewEntrypoint(root: string): string | null {
	const queue: Array<{ absolute: string; relativePath: string; depth: number }> = [
		{ absolute: root, relativePath: "", depth: 0 },
	];
	let newest: { path: string; updatedAt: number } | null = null;
	let visited = 0;
	while (queue.length > 0 && visited < 1_500) {
		const current = queue.shift();
		if (!current) break;
		visited += 1;
		for (const entry of readdirSync(current.absolute, { withFileTypes: true })) {
			if (WORKSPACE_IGNORED_ENTRIES.has(entry.name)) continue;
			const absolute = join(current.absolute, entry.name);
			const relativePath = current.relativePath
				? `${current.relativePath}/${entry.name}`
				: entry.name;
			if (entry.isFile() && entry.name === "index.html") {
				const stat = statSync(absolute);
				if (!newest || stat.mtimeMs > newest.updatedAt) {
					newest = { path: relativePath, updatedAt: stat.mtimeMs };
				}
				continue;
			}
			if (entry.isDirectory() && current.depth < 4) {
				queue.push({ absolute, relativePath, depth: current.depth + 1 });
			}
		}
	}
	return newest?.path ?? null;
}

function workspacePreviewPath(cwd: string): string | null {
	if (!existsSync(cwd)) return null;
	const root = realpathSync(cwd);
	for (const candidate of WORKSPACE_PREVIEW_ENTRYPOINTS) {
		const absolute = resolve(root, candidate);
		if (existsSync(absolute) && statSync(absolute).isFile()) return candidate;
	}
	return scanPreviewEntrypoint(root);
}

function workspaceProjectPreviewUrl(
	origin: string | undefined,
	project: WorkspaceProjectRecord,
): string | null {
	if (!origin) return null;
	const previewPath = workspacePreviewPath(project.cwd);
	if (!previewPath) return null;
	return `${origin}/api/activity/workspace-projects/${encodeURIComponent(project.id)}/preview/${encodePreviewPath(previewPath)}`;
}

function readWorkspaceProjects(origin?: string): WorkspaceProjectRecord[] {
	const byCwd = new Map<string, WorkspaceProjectRecord>();
	for (const agent of readWorkspaceAgents(origin)) {
		const existing = byCwd.get(agent.cwd);
		if (!existing) {
			byCwd.set(agent.cwd, {
				id: workspaceProjectId(agent.cwd),
				name: basename(agent.cwd) || agent.cwd,
				cwd: agent.cwd,
				agentIds: [agent.id],
				runningCount: agent.status === "running" ? 1 : 0,
				completedCount: agent.status === "completed" ? 1 : 0,
				failedCount: agent.status === "failed" ? 1 : 0,
				latestStartedAt: agent.startedAt,
				...(agent.previewUrl ? { previewUrl: agent.previewUrl } : {}),
				...(agent.publicUrl ? { publicUrl: agent.publicUrl } : {}),
			});
			continue;
		}
		existing.agentIds.push(agent.id);
		if (agent.status === "running") existing.runningCount += 1;
		if (agent.status === "completed") existing.completedCount += 1;
		if (agent.status === "failed") existing.failedCount += 1;
		if (agent.startedAt > existing.latestStartedAt) {
			existing.latestStartedAt = agent.startedAt;
			if (agent.previewUrl) existing.previewUrl = agent.previewUrl;
			if (agent.publicUrl) existing.publicUrl = agent.publicUrl;
		}
	}
	const projects = [...byCwd.values()];
	for (const project of projects) {
		if (!project.previewUrl) {
			const previewUrl = workspaceProjectPreviewUrl(origin, project);
			if (previewUrl) project.previewUrl = previewUrl;
		}
	}
	return projects.sort((a, b) => b.latestStartedAt - a.latestStartedAt);
}

function resolveWorkspaceProject(
	projectId: string,
	origin?: string,
): WorkspaceProjectRecord | null {
	return readWorkspaceProjects(origin).find((project) => project.id === projectId) ?? null;
}

function deleteWorkspaceProject(projectId: string, origin?: string): { ok: true; projectId: string; cwd: string; deletedAgents: number; deletedProjectDir: boolean } | { ok: false; error: string; status: number } {
	const project = resolveWorkspaceProject(projectId, origin);
	if (!project) return { ok: false, error: "workspace project not found", status: 404 };
	if (project.runningCount > 0) return { ok: false, error: "workspace project has running agents", status: 409 };
	if (!isManagedWorkspaceProjectPath(project.cwd)) {
		return { ok: false, error: "only managed workspace projects can be deleted", status: 400 };
	}
	const agents = readWorkspaceAgents(origin);
	const deletedAgents = agents.filter((agent) => agent.cwd === project.cwd);
	writeWorkspaceAgents(agents.filter((agent) => agent.cwd !== project.cwd));
	for (const agent of deletedAgents) {
		const logPath = safeWorkspaceAgentLogPath(agent);
		if (logPath && existsSync(logPath)) unlinkSync(logPath);
	}
	const deletedProjectDir = existsSync(project.cwd);
	if (deletedProjectDir) rmSync(project.cwd, { recursive: true, force: true });
	return { ok: true, projectId, cwd: project.cwd, deletedAgents: deletedAgents.length, deletedProjectDir };
}

function projectSubpath(value: string | null): string {
	const cleaned = value?.trim().replace(/\\/g, "/") ?? "";
	return cleaned === "." ? "" : cleaned.replace(/^\/+/, "");
}

function safeProjectPath(project: WorkspaceProjectRecord, subpath: string): string | null {
	if (!existsSync(project.cwd)) return null;
	const root = realpathSync(project.cwd);
	const target = resolve(root, subpath);
	if (!existsSync(target)) return null;
	const realTarget = realpathSync(target);
	const rel = relative(root, realTarget);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
		return realTarget;
	}
	return null;
}

function languageForPath(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
	if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) return "javascript";
	if (lower.endsWith(".css")) return "css";
	if (lower.endsWith(".html")) return "html";
	if (lower.endsWith(".json")) return "json";
	if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
	if (lower.endsWith(".py")) return "python";
	if (lower.endsWith(".rs")) return "rust";
	if (lower.endsWith(".go")) return "go";
	if (lower.endsWith(".toml")) return "toml";
	if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
	if (lower.endsWith(".sh") || lower.endsWith(".zsh")) return "shell";
	return "text";
}

function readWorkspaceProjectFiles(
	project: WorkspaceProjectRecord,
	pathValue: string,
): WorkspaceProjectFilesSnapshot | { error: string; status: number } {
	const target = safeProjectPath(project, pathValue);
	if (!target) return { error: "project path not found", status: 404 };
	const stat = statSync(target);
	if (!stat.isDirectory()) return { error: "project path is not a directory", status: 400 };
	const root = realpathSync(project.cwd);
	const entries: WorkspaceProjectFileNode[] = readdirSync(target, { withFileTypes: true })
		.filter((entry) => !WORKSPACE_IGNORED_ENTRIES.has(entry.name))
		.slice(0, MAX_WORKSPACE_DIRECTORY_ENTRIES)
		.map((entry) => {
			const absolute = join(target, entry.name);
			const entryStat = statSync(absolute);
			const relPath = relative(root, realpathSync(absolute)).replace(/\\/g, "/");
			const type: WorkspaceProjectFileNode["type"] = entryStat.isDirectory()
				? "directory"
				: "file";
			return {
				name: entry.name,
				path: relPath,
				type,
				...(entryStat.isFile() ? { size: entryStat.size } : {}),
				updatedAt: entryStat.mtimeMs,
			};
		})
		.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	return { projectId: project.id, cwd: project.cwd, path: pathValue, entries };
}

function readWorkspaceProjectFile(
	project: WorkspaceProjectRecord,
	pathValue: string,
): WorkspaceProjectFile | { error: string; status: number } {
	if (!pathValue) return { error: "path required", status: 400 };
	const target = safeProjectPath(project, pathValue);
	if (!target) return { error: "project file not found", status: 404 };
	const stat = statSync(target);
	if (!stat.isFile()) return { error: "project path is not a file", status: 400 };
	if (stat.size > MAX_WORKSPACE_FILE_BYTES * 4) {
		return { error: "file too large for public preview", status: 413 };
	}
	const raw = readFileSync(target);
	if (raw.includes(0)) return { error: "binary files are not previewed", status: 415 };
	const content = raw.subarray(0, MAX_WORKSPACE_FILE_BYTES).toString("utf8");
	return {
		projectId: project.id,
		cwd: project.cwd,
		path: pathValue,
		name: basename(pathValue),
		language: languageForPath(pathValue),
		content,
		size: stat.size,
		updatedAt: stat.mtimeMs,
		truncated: raw.byteLength > MAX_WORKSPACE_FILE_BYTES,
	};
}

function workspaceProjectPreviewResponse(
	project: WorkspaceProjectRecord,
	pathValue: string,
): Response | { error: string; status: number } {
	const target = safeProjectPath(project, pathValue);
	if (!target) return { error: "preview file not found", status: 404 };
	const stat = statSync(target);
	if (!stat.isFile()) return { error: "preview path is not a file", status: 400 };
	if (stat.size > MAX_WORKSPACE_PREVIEW_FILE_BYTES) {
		return { error: "preview file too large", status: 413 };
	}
	return new Response(readFileSync(target), {
		status: 200,
		headers: corsHeaders(previewContentType(pathValue)),
	});
}

function recordValue(body: unknown): Record<string, unknown> | null {
	return body && typeof body === "object" && !Array.isArray(body)
		? (body as Record<string, unknown>)
		: null;
}

function optionalString(
	bag: Record<string, unknown>,
	key: string,
): string | undefined {
	return typeof bag[key] === "string" ? bag[key] : undefined;
}

function optionalNumber(
	bag: Record<string, unknown>,
	key: string,
): number | undefined {
	return typeof bag[key] === "number" ? bag[key] : undefined;
}

function optionalBoolean(
	bag: Record<string, unknown>,
	key: string,
): boolean | undefined {
	return typeof bag[key] === "boolean" ? bag[key] : undefined;
}

function optionalTypeError(
	bag: Record<string, unknown>,
	key: string,
	expected: "boolean" | "number",
): string | null {
	return bag[key] !== undefined && typeof bag[key] !== expected
		? `${key} must be ${expected}`
		: null;
}

function parseChroniclerConfig(
	raw: unknown,
):
	| { ok: true; body: Partial<ChroniclerConfig> }
	| { ok: false; error: string } {
	const body = recordValue(raw);
	if (!body) return { ok: false, error: "invalid chronicler config" };
	const typeError =
		optionalTypeError(body, "enabled", "boolean") ??
		optionalTypeError(body, "includeWindowTitles", "boolean") ??
		optionalTypeError(body, "intervalMs", "number") ??
		optionalTypeError(body, "maxWindowsPerScreen", "number");
	if (typeError) return { ok: false, error: typeError };
	return {
		ok: true,
		body: {
			...(optionalBoolean(body, "enabled") !== undefined
				? { enabled: optionalBoolean(body, "enabled") }
				: {}),
			...(optionalNumber(body, "intervalMs") !== undefined
				? { intervalMs: optionalNumber(body, "intervalMs") }
				: {}),
			...(optionalBoolean(body, "includeWindowTitles") !== undefined
				? { includeWindowTitles: optionalBoolean(body, "includeWindowTitles") }
				: {}),
			...(optionalNumber(body, "maxWindowsPerScreen") !== undefined
				? { maxWindowsPerScreen: optionalNumber(body, "maxWindowsPerScreen") }
				: {}),
		},
	};
}

type XAutonomyUpdateParseResult =
	| { ok: true; update: ActivityXAutonomyUpdate }
	| { ok: false; error: string };
type XAutonomyFieldResult<T> =
	| { ok: true; value?: T }
	| { ok: false; error: string };
type XAutonomyBooleanField =
	| "enabled"
	| "writeEnabled"
	| "statusPostingEnabled"
	| "discoveryEnabled"
	| "proactiveEngagementEnabled"
	| "followEnabled";
type XAutonomyNumberField =
	| "intervalMs"
	| "statusIntervalMs"
	| "discoveryIntervalMs"
	| "maxRepliesPerTick"
	| "maxDiscoveryPerTick";

const X_AUTONOMY_BOOLEAN_FIELDS: XAutonomyBooleanField[] = [
	"enabled",
	"writeEnabled",
	"statusPostingEnabled",
	"discoveryEnabled",
	"proactiveEngagementEnabled",
	"followEnabled",
];
const X_AUTONOMY_NUMBER_FIELDS: Array<{
	key: XAutonomyNumberField;
	min: number;
	max: number;
}> = [
	{ key: "intervalMs", min: 30_000, max: 30 * 60_000 },
	{ key: "statusIntervalMs", min: 15 * 60_000, max: 24 * 60 * 60_000 },
	{ key: "discoveryIntervalMs", min: 5 * 60_000, max: 24 * 60 * 60_000 },
	{ key: "maxRepliesPerTick", min: 1, max: 5 },
	{ key: "maxDiscoveryPerTick", min: 0, max: 8 },
];

function readBooleanUpdate(
	bag: Record<string, unknown>,
	key: string,
): XAutonomyFieldResult<boolean> {
	const value = bag[key];
	if (value === undefined) return { ok: true };
	if (typeof value !== "boolean")
		return { ok: false, error: `${key} must be boolean` };
	return { ok: true, value };
}

function readNumberUpdate(
	bag: Record<string, unknown>,
	key: string,
	min: number,
	max: number,
): XAutonomyFieldResult<number> {
	const value = bag[key];
	if (value === undefined) return { ok: true };
	if (typeof value !== "number" || !Number.isFinite(value))
		return { ok: false, error: `${key} must be a finite number` };
	return { ok: true, value: Math.max(min, Math.min(max, Math.round(value))) };
}

function readBooleanUpdates(
	bag: Record<string, unknown>,
): XAutonomyFieldResult<Partial<Record<XAutonomyBooleanField, boolean>>> {
	const values: Partial<Record<XAutonomyBooleanField, boolean>> = {};
	for (const key of X_AUTONOMY_BOOLEAN_FIELDS) {
		const parsed = readBooleanUpdate(bag, key);
		if (!parsed.ok) return parsed;
		if (parsed.value !== undefined) values[key] = parsed.value;
	}
	return { ok: true, value: values };
}

function readNumberUpdates(
	bag: Record<string, unknown>,
): XAutonomyFieldResult<Partial<Record<XAutonomyNumberField, number>>> {
	const values: Partial<Record<XAutonomyNumberField, number>> = {};
	for (const field of X_AUTONOMY_NUMBER_FIELDS) {
		const parsed = readNumberUpdate(bag, field.key, field.min, field.max);
		if (!parsed.ok) return parsed;
		if (parsed.value !== undefined) values[field.key] = parsed.value;
	}
	return { ok: true, value: values };
}

function readDiscoveryQueriesUpdate(
	bag: Record<string, unknown>,
): XAutonomyFieldResult<string[]> {
	if (bag.discoveryQueries !== undefined) {
		if (!Array.isArray(bag.discoveryQueries))
			return {
				ok: false,
				error: "discoveryQueries must be an array of strings",
			};
		const queries: string[] = [];
		for (const item of bag.discoveryQueries) {
			if (typeof item !== "string")
				return {
					ok: false,
					error: "discoveryQueries must be an array of strings",
				};
			const query = item.trim();
			if (query.length > 0) queries.push(query);
		}
		return { ok: true, value: queries.slice(0, 12) };
	}
	return { ok: true };
}

function parseXAutonomyUpdate(body: unknown): XAutonomyUpdateParseResult {
	const bag = recordValue(body);
	if (!bag) return { ok: false, error: "body must be an object" };
	const booleans = readBooleanUpdates(bag);
	if (!booleans.ok) return booleans;
	const numbers = readNumberUpdates(bag);
	if (!numbers.ok) return numbers;
	const discoveryQueries = readDiscoveryQueriesUpdate(bag);
	if (!discoveryQueries.ok) return discoveryQueries;

	return {
		ok: true,
		update: {
			...booleans.value,
			...numbers.value,
			...(discoveryQueries.value !== undefined
				? { discoveryQueries: discoveryQueries.value }
				: {}),
		},
	};
}

function searchString(url: URL, key: string): string | undefined {
	return url.searchParams.get(key) ?? undefined;
}

function searchNumber(url: URL, key: string): number | undefined {
	const value = url.searchParams.get(key);
	return value ? Number(value) : undefined;
}

function searchCsv(url: URL, key: string): string[] {
	return (url.searchParams.get(key) ?? "").split(",").filter(Boolean);
}

function gatewayListOptions(url: URL): GatewayListOptions {
	const opts: GatewayListOptions = {};
	const channel = searchString(url, "channel");
	const direction = searchString(url, "direction");
	if (channel) opts.channel = channel as GatewayChannel;
	if (direction) opts.direction = direction as GatewayDirection;
	const roomId = searchString(url, "roomId");
	const entityId = searchString(url, "entityId");
	const q = searchString(url, "q");
	const since = searchNumber(url, "since");
	const limit = searchNumber(url, "limit");
	if (roomId) opts.roomId = roomId;
	if (entityId) opts.entityId = entityId;
	if (q) opts.q = q;
	if (since !== undefined) opts.since = since;
	if (limit !== undefined) opts.limit = limit;
	return opts;
}

function pensieveGraphFilter(url: URL): GraphFilter {
	const filter: GraphFilter = {};
	const dateFrom = searchNumber(url, "dateFrom");
	const dateTo = searchNumber(url, "dateTo");
	const entityIds = searchCsv(url, "entityIds");
	const types = searchCsv(url, "types");
	const tags = searchCsv(url, "tags");
	if (dateFrom !== undefined) filter.dateFrom = dateFrom;
	if (dateTo !== undefined) filter.dateTo = dateTo;
	if (entityIds.length > 0) filter.entityIds = entityIds;
	if (types.length > 0) filter.types = types;
	if (tags.length > 0) filter.tags = tags;
	return filter;
}

function parseBrowserOpenCommand(
	bag: Record<string, unknown>,
): BrowserCommandInput | null {
	const url = optionalString(bag, "url")?.trim() ?? "";
	if (!url || url.length > 2048) return null;
	return {
		kind: "open",
		url,
		...(optionalBoolean(bag, "newTab") !== undefined
			? { newTab: optionalBoolean(bag, "newTab") }
			: {}),
		...(optionalString(bag, "tabId")
			? { tabId: optionalString(bag, "tabId") }
			: {}),
		source: "api",
	};
}

function parseBrowserInspectCommand(
	bag: Record<string, unknown>,
): BrowserCommandInput {
	return {
		kind: "inspect",
		...(optionalString(bag, "tabId")
			? { tabId: optionalString(bag, "tabId") }
			: {}),
		...(optionalNumber(bag, "timeoutMs") !== undefined
			? { timeoutMs: optionalNumber(bag, "timeoutMs") }
			: {}),
		source: "api",
	};
}

function parseBrowserScriptCommand(
	bag: Record<string, unknown>,
): BrowserCommandInput | null {
	const script = optionalString(bag, "script")?.trim() ?? "";
	if (!script || script.length > 100_000) return null;
	return {
		kind: "script",
		script,
		...(optionalString(bag, "tabId")
			? { tabId: optionalString(bag, "tabId") }
			: {}),
		...(optionalNumber(bag, "timeoutMs") !== undefined
			? { timeoutMs: optionalNumber(bag, "timeoutMs") }
			: {}),
		source: "api",
	};
}

function parseBrowserLoginCommand(
	bag: Record<string, unknown>,
): BrowserCommandInput | null {
	const source = bag.source;
	const identifier = optionalString(bag, "identifier")?.trim() ?? "";
	if (
		(source !== "in-house" &&
			source !== "1password" &&
			source !== "bitwarden") ||
		!identifier
	)
		return null;
	const targetUrl = optionalString(bag, "targetUrl")?.trim();
	return {
		kind: "fill-login",
		source,
		identifier,
		...(targetUrl ? { targetUrl } : {}),
		...(optionalBoolean(bag, "newTab") !== undefined
			? { newTab: optionalBoolean(bag, "newTab") }
			: {}),
		...(optionalString(bag, "tabId")
			? { tabId: optionalString(bag, "tabId") }
			: {}),
		...(optionalNumber(bag, "timeoutMs") !== undefined
			? { timeoutMs: optionalNumber(bag, "timeoutMs") }
			: {}),
	};
}

function parseBrowserCommandInput(body: unknown): BrowserCommandInput | null {
	const bag = recordValue(body);
	if (!bag) return null;
	switch (bag.kind) {
		case "open":
			return parseBrowserOpenCommand(bag);
		case "inspect":
			return parseBrowserInspectCommand(bag);
		case "script":
			return parseBrowserScriptCommand(bag);
		case "fill-login":
			return parseBrowserLoginCommand(bag);
		default:
			return null;
	}
}

type BrowserControlGlobal = {
	enqueue(command: BrowserCommandInput): BrowserCommand;
	enqueueAndWait(
		command: BrowserCommandInput,
		timeoutMs?: number,
	): Promise<BrowserCommandResult>;
};

type DebugEmbeddingBody = { text?: string; storeAs?: string };
type DebugEmbeddingRuntime = {
	useModel?: (type: string, params: { text: string }) => Promise<unknown>;
	getModel?: (type: string) => unknown;
	getService?: (type: string) => unknown;
	adapter?: { embeddingDimension?: string };
	createMemory?: (memory: Memory, table: string) => Promise<string>;
	updateMemory?: (memory: {
		id: string;
		embedding: number[];
	}) => Promise<boolean>;
	agentId?: UUID;
};
type DebugEmbeddingWriteResult = {
	ok: boolean;
	memoryId?: string;
	error?: string;
};
type DebugEmbeddingModelResult = {
	vector: number[];
	modelErr: string | null;
	durationMs: number;
};
type DebugImageBody = { prompt?: string; size?: string };
type DebugImageRuntime = {
	useModel?: (
		type: string,
		params: { prompt: string; size?: string },
	) => Promise<unknown>;
};
type GeneratedImage = {
	url: string;
	revisedPrompt?: string;
};

function embeddingVector(value: unknown): number[] {
	return Array.isArray(value)
		? value.filter((item): item is number => typeof item === "number")
		: [];
}

async function runDebugEmbeddingModel(
	runtime: DebugEmbeddingRuntime,
	text: string,
): Promise<DebugEmbeddingModelResult> {
	let raw: unknown = null;
	let modelErr: string | null = null;
	const t0 = Date.now();
	try {
		if (runtime.useModel)
			raw = await runtime.useModel("TEXT_EMBEDDING", { text });
	} catch (err) {
		modelErr = err instanceof Error ? err.message : String(err);
	}
	return {
		vector: embeddingVector(raw),
		modelErr,
		durationMs: Date.now() - t0,
	};
}

async function writeDebugEmbedding(
	runtime: DebugEmbeddingRuntime,
	body: DebugEmbeddingBody,
	text: string,
	embedding: number[],
): Promise<DebugEmbeddingWriteResult | null> {
	if (!body.storeAs || !runtime.createMemory || !runtime.updateMemory)
		return null;
	if (!runtime.agentId) return null;
	try {
		const memId = await runtime.createMemory(
			{
				entityId: runtime.agentId,
				roomId: runtime.agentId,
				agentId: runtime.agentId,
				content: { text, source: "debug" },
				createdAt: Date.now(),
			},
			body.storeAs,
		);
		await runtime.updateMemory({ id: memId, embedding });
		return { ok: true, memoryId: String(memId) };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function generatedImage(value: unknown): GeneratedImage | null {
	if (!Array.isArray(value)) return null;
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const bag = item as Record<string, unknown>;
		if (typeof bag.url !== "string" || bag.url.length === 0) continue;
		return {
			url: bag.url,
			...(typeof bag.revisedPrompt === "string"
				? { revisedPrompt: bag.revisedPrompt }
				: {}),
		};
	}
	return null;
}

function imageExtension(contentType: string): string {
	const subtype = contentType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
	if (!subtype) return "png";
	if (subtype === "jpeg") return "jpg";
	const safe = subtype.replace(/[^a-z0-9]/g, "");
	return safe.length > 0 ? safe : "png";
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

async function imageResponseFromUrl(url: string): Promise<Response> {
	const dataUrl = url.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
	if (dataUrl) {
		const contentType = dataUrl[1] ?? "image/png";
		const bytes = Buffer.from(dataUrl[2] ?? "", "base64");
		return new Response(copiedArrayBuffer(bytes), {
			headers: {
				"content-type": contentType,
				"content-disposition": `attachment; filename="detour-image-proof.${imageExtension(contentType)}"`,
			},
		});
	}
	if (/^https?:\/\//i.test(url)) {
		const image = await fetch(url);
		if (!image.ok) throw new Error(`image download failed: HTTP ${image.status}`);
		const contentType = image.headers.get("content-type") ?? "image/png";
		return new Response(await image.arrayBuffer(), {
			headers: {
				"content-type": contentType,
				"content-disposition": `attachment; filename="detour-image-proof.${imageExtension(contentType)}"`,
			},
		});
	}
	if (existsSync(url)) {
		const contentType = url.toLowerCase().endsWith(".jpg") || url.toLowerCase().endsWith(".jpeg")
			? "image/jpeg"
			: "image/png";
		return new Response(Bun.file(url), {
			headers: {
				"content-type": contentType,
				"content-disposition": `attachment; filename="detour-image-proof.${imageExtension(contentType)}"`,
			},
		});
	}
	throw new Error("image result URL was not fetchable");
}

export type WindowCommand =
	| { kind: "hide" }
	| { kind: "pin"; on: boolean }
	| { kind: "resize"; width: number; height: number };

export type WindowController = (cmd: WindowCommand) => void;

export class ApiServer {
	private server: Server<WsData> | null = null;
	private port = 0;
	private subscribers = new Map<string, ServerWebSocket<WsData>>();
	private lockFile = join(homedir(), ".detour", "runtime.json");
	private windowController: WindowController | null = null;
	private channelReloadTimer: ReturnType<typeof setTimeout> | null = null;
	private activePetId: string | null = null;
	private activePetStateOverride: { state: CodexPetAnimationState; expiresAt: number } | null = null;
	private browserCommands: BrowserCommand[] = [];
	private browserResults = new Map<string, BrowserCommandResult>();
	private agentStreamTimers = new Map<string, ReturnType<typeof setInterval>>();
	private activeChatTurns = new Map<
		string,
		{
			traceId: string;
			cancel: () => void;
		}
	>();
	private browserWaiters = new Map<
		string,
		{
			resolve: (result: BrowserCommandResult) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	private petSummary(pet: PetSummary): CodexPetSummary {
		return {
			...pet,
			spritesheetUrl: `/api/pets/${encodeURIComponent(pet.id)}/spritesheet`,
			atlas: PET_ATLAS,
		};
	}

	private petsResponse(): CodexPetsResponse {
		const result = listCodexPets();
		return {
			pets: result.pets.map((pet) => this.petSummary(pet)),
			errors: result.errors,
		};
	}

	private findPet(query?: string | null): CodexPetSummary | null {
		const response = this.petsResponse();
		if (response.pets.length === 0) return null;
		const normalized = query?.trim().toLowerCase();
		if (!normalized) {
			const active = this.activePetId
				? response.pets.find((pet) => pet.id === this.activePetId)
				: null;
			return active ?? response.pets[0] ?? null;
		}
		return response.pets.find((pet) =>
			pet.id.toLowerCase() === normalized ||
			pet.displayName.toLowerCase() === normalized
		) ?? null;
	}

	private spawnPet(pet: CodexPetSummary): CodexPetSpawnResponse {
		this.activePetId = pet.id;
		this.broadcast({ kind: "ui:open-pet", pet });
		return { pet, state: this.currentPetState() };
	}

	private setPetState(state: CodexPetAnimationState, reason?: string): void {
		this.activePetStateOverride = { state, expiresAt: Date.now() + 9_000 };
		this.broadcast({ kind: "ui:pet-state", state, ...(reason ? { reason } : {}) });
	}

	private currentPetState(): CodexPetAnimationState {
		const override = this.activePetStateOverride;
		if (!override) return "idle";
		if (override.expiresAt > Date.now()) return override.state;
		this.activePetStateOverride = null;
		return "idle";
	}

	private petActivity(): CodexPetActivity {
		const now = Date.now();
		const runtime = this.activity.runtimeSnapshot();
		const runningAgents = readWorkspaceAgents()
			.filter((agent) => agent.status === "running")
			.slice(0, 3);
		const recentLogs = this.activity.logs.list({ limit: 6 });
		const activeLog = recentLogs.find((entry) => now - entry.time < 45_000);
		const errorLog = recentLogs.find((entry) => entry.levelName.toLowerCase() === "error" && now - entry.time < 90_000);
		const override = this.currentPetState();
		const state: CodexPetAnimationState = override !== "idle"
			? override
			: errorLog
				? "failed"
				: runningAgents.length > 0
					? "review"
					: !runtime.available
						? "waiting"
						: activeLog
							? "running"
							: "idle";
		const summary = errorLog
			? "needs attention"
			: runningAgents.length > 0
				? `${runningAgents.length} coding agent${runningAgents.length === 1 ? "" : "s"} running`
				: !runtime.available
					? "runtime starting"
					: activeLog
						? `active${activeLog.source ? `: ${activeLog.source}` : ""}`
						: "idle";
		const detail = errorLog?.msg ?? runningAgents[0]?.task ?? activeLog?.msg;
		return {
			state,
			summary,
			...(detail ? { detail } : {}),
			runningAgents,
			recentLogs,
			runtime: {
				available: runtime.available,
				...(runtime.agentName ? { agentName: runtime.agentName } : {}),
				counts: runtime.counts,
			},
			updatedAt: Date.now(),
		};
	}

	/**
	 * Debounce runtime reloads triggered by channel credential changes.
	 * Without this, pasting Discord token + Telegram token + iMessage flag
	 * back-to-back fires three rebuilds; each restarts the Telegraf poll
	 * before the previous one's long-poll has timed out, triggering
	 * Telegram's "409 Conflict: terminated by other getUpdates request"
	 * cascade. Coalesce changes within 1.5s into a single rebuild.
	 */
	private scheduleChannelReload(): void {
		if (this.channelReloadTimer) clearTimeout(this.channelReloadTimer);
		this.channelReloadTimer = setTimeout(() => {
			this.channelReloadTimer = null;
			void this.runtime.rebuild().catch((err) => {
				console.warn("[channels] debounced auto-reload failed:", err);
			});
		}, 1500);
	}

	private installBrowserControlGlobal(): void {
		(globalThis as Record<symbol, BrowserControlGlobal>)[
			BROWSER_CONTROL_GLOBAL
		] = {
			enqueue: (command) => this.enqueueBrowserCommand(command),
			enqueueAndWait: (command, timeoutMs) =>
				this.enqueueBrowserCommandAndWait(command, timeoutMs),
		};
	}

	private removeBrowserControlGlobal(): void {
		const g = globalThis as Record<symbol, BrowserControlGlobal | undefined>;
		if (g[BROWSER_CONTROL_GLOBAL]?.enqueue) {
			delete g[BROWSER_CONTROL_GLOBAL];
		}
	}

	private enqueueBrowserCommand(input: BrowserCommandInput): BrowserCommand {
		const command = {
			...input,
			id: crypto.randomUUID(),
			time: Date.now(),
		} as BrowserCommand;
		this.browserCommands.push(command);
		if (this.browserCommands.length > MAX_BROWSER_COMMANDS) {
			this.browserCommands.splice(
				0,
				this.browserCommands.length - MAX_BROWSER_COMMANDS,
			);
		}
		this.broadcast({ kind: "ui:open-browser" });
		this.broadcast({ kind: "browser:command", command });
		return command;
	}

	private enqueueBrowserCommandAndWait(
		input: BrowserCommandInput,
		timeoutMs = 30_000,
	): Promise<BrowserCommandResult> {
		const command = this.enqueueBrowserCommand(input);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.browserWaiters.delete(command.id);
				resolve({
					ok: false,
					error: `Browser command timed out after ${timeoutMs}ms`,
					time: Date.now(),
				});
			}, timeoutMs);
			this.browserWaiters.set(command.id, { resolve, timer });
		});
	}

	private finishBrowserCommand(
		commandId: string,
		result: Omit<BrowserCommandResult, "time"> & { time?: number },
	): BrowserCommandResult {
		const complete: BrowserCommandResult = {
			...result,
			time: typeof result.time === "number" ? result.time : Date.now(),
		};
		this.browserResults.set(commandId, complete);
		if (this.browserResults.size > MAX_BROWSER_COMMANDS) {
			const first = this.browserResults.keys().next().value;
			if (typeof first === "string") this.browserResults.delete(first);
		}
		const waiter = this.browserWaiters.get(commandId);
		if (waiter) {
			clearTimeout(waiter.timer);
			this.browserWaiters.delete(commandId);
			waiter.resolve(complete);
		}
		return complete;
	}

	private parseBrowserCommand(body: unknown): BrowserCommandInput | null {
		return parseBrowserCommandInput(body);
	}

	setWindowController(fn: WindowController | null): void {
		this.windowController = fn;
	}

	constructor(
		private readonly runtime: RuntimeService,
		private readonly vault: VaultService,
		private readonly auth: AuthService,
		private readonly backendOps: BackendOps,
		private readonly config: ConfigService,
		private readonly pensieve: PensieveService,
		private readonly activity: ActivityService,
		private readonly channels: ChannelsService,
		private readonly gateway: ChannelGatewayService,
		private readonly inbox: InboxService,
		private readonly llama: LlamaServerService,
		private readonly cron: CronService,
		private readonly ownerBind: OwnerBindService,
	) {}

	private async updateChroniclerConfig(
		ctx: ApiRequestContext,
	): Promise<Response> {
		const parsed = parseChroniclerConfig(await ctx.req.json());
		if (!parsed.ok) return ctx.error(parsed.error, 400);
		const current = this.pensieve.chronicler.getConfig();
		const next = await this.pensieve.chronicler.configure({
			enabled: parsed.body.enabled ?? current.enabled,
			intervalMs: parsed.body.intervalMs ?? current.intervalMs,
			includeWindowTitles:
				parsed.body.includeWindowTitles ?? current.includeWindowTitles,
			maxWindowsPerScreen:
				parsed.body.maxWindowsPerScreen ?? current.maxWindowsPerScreen,
		});
		pensieveAudit({
			action: "chronicler.configure",
			success: true,
			target: next.enabled ? "enabled" : "disabled",
			caller: "ui-pensieve",
			ts: Date.now(),
		});
		return ctx.json(next);
	}

	private async updateMemory(
		ctx: ApiRequestContext,
		rawId: string,
	): Promise<Response> {
		const id = decodeURIComponent(rawId) as never;
		const body = (await ctx.req.json()) as {
			contentText?: string;
			tags?: string[];
			path?: string;
		};
		let success = false;
		let errMsg: string | undefined;
		try {
			success = await this.pensieve.memories.update(id, body);
		} catch (err) {
			errMsg = err instanceof Error ? err.message : String(err);
		}
		pensieveAudit({
			action: "memory.update",
			target: rawId,
			success,
			...(errMsg ? { error: errMsg } : {}),
			caller: "ui-pensieve",
			ts: Date.now(),
		});
		return success ? ctx.ok() : ctx.error(errMsg ?? "update failed", 400);
	}

	private async deleteMemory(
		ctx: ApiRequestContext,
		rawId: string,
	): Promise<Response> {
		const id = decodeURIComponent(rawId) as never;
		let success = false;
		let errMsg: string | undefined;
		try {
			success = await this.pensieve.memories.remove(id);
		} catch (err) {
			errMsg = err instanceof Error ? err.message : String(err);
		}
		pensieveAudit({
			action: "memory.delete",
			target: rawId,
			success,
			...(errMsg ? { error: errMsg } : {}),
			caller: "ui-pensieve",
			ts: Date.now(),
		});
		return success ? ctx.ok() : ctx.error(errMsg ?? "delete failed", 400);
	}

	private async createRelationship(ctx: ApiRequestContext): Promise<Response> {
		const body = (await ctx.req.json()) as Parameters<
			typeof this.pensieve.relationships.create
		>[0];
		let success = false;
		let errMsg: string | undefined;
		try {
			success = await this.pensieve.relationships.create(body);
		} catch (err) {
			errMsg = err instanceof Error ? err.message : String(err);
		}
		pensieveAudit({
			action: "relationship.create",
			target: `${String(body.sourceEntityId)}↔${String(body.targetEntityId)}`,
			success,
			...(errMsg ? { error: errMsg } : {}),
			caller: "ui-pensieve",
			ts: Date.now(),
		});
		return success ? ctx.ok() : ctx.error(errMsg ?? "create failed", 400);
	}

	private async updateRelationship(
		ctx: ApiRequestContext,
		rawSource: string,
		rawTarget: string,
	): Promise<Response> {
		const source = decodeURIComponent(rawSource) as never;
		const target = decodeURIComponent(rawTarget) as never;
		const body = (await ctx.req.json()) as {
			tags?: string[];
			metadata?: Record<string, unknown>;
		};
		let success = false;
		let errMsg: string | undefined;
		try {
			success = await this.pensieve.relationships.update(source, target, body);
		} catch (err) {
			errMsg = err instanceof Error ? err.message : String(err);
		}
		pensieveAudit({
			action: "relationship.update",
			target: `${rawSource}↔${rawTarget}`,
			success,
			...(errMsg ? { error: errMsg } : {}),
			caller: "ui-pensieve",
			ts: Date.now(),
		});
		return success ? ctx.ok() : ctx.error(errMsg ?? "update failed", 400);
	}

	private async deleteRelationship(
		ctx: ApiRequestContext,
		rawSource: string,
		rawTarget: string,
	): Promise<Response> {
		const source = decodeURIComponent(rawSource) as never;
		const target = decodeURIComponent(rawTarget) as never;
		let success = false;
		let errMsg: string | undefined;
		try {
			success = await this.pensieve.relationships.remove(source, target);
		} catch (err) {
			errMsg = err instanceof Error ? err.message : String(err);
		}
		pensieveAudit({
			action: "relationship.delete",
			target: `${rawSource}↔${rawTarget}`,
			success,
			...(errMsg ? { error: errMsg } : {}),
			caller: "ui-pensieve",
			ts: Date.now(),
		});
		return success ? ctx.ok() : ctx.error(errMsg ?? "delete failed", 400);
	}

	private async updateTemplate(
		ctx: ApiRequestContext,
		rawId: string,
	): Promise<Response> {
		const id = decodeURIComponent(rawId);
		const body = (await ctx.req.json()) as {
			body?: string;
			tags?: string[];
			path?: string;
		};
		let success = false;
		let errMsg: string | undefined;
		try {
			success = await this.pensieve.templates.updateTemplate(id, body);
		} catch (err) {
			errMsg = err instanceof Error ? err.message : String(err);
		}
		pensieveAudit({
			action: "template.update",
			target: id,
			success,
			...(errMsg ? { error: errMsg } : {}),
			caller: "ui-pensieve",
			ts: Date.now(),
		});
		return success ? ctx.ok() : ctx.error(errMsg ?? "update failed", 400);
	}

	private async deleteTemplate(
		ctx: ApiRequestContext,
		rawId: string,
	): Promise<Response> {
		const id = decodeURIComponent(rawId);
		let success = false;
		let errMsg: string | undefined;
		try {
			success = await this.pensieve.templates.deleteTemplate(id);
		} catch (err) {
			errMsg = err instanceof Error ? err.message : String(err);
		}
		pensieveAudit({
			action: "template.delete",
			target: id,
			success,
			...(errMsg ? { error: errMsg } : {}),
			caller: "ui-pensieve",
			ts: Date.now(),
		});
		return success ? ctx.ok() : ctx.error(errMsg ?? "delete failed", 400);
	}

	private async debugEmbedding(ctx: ApiRequestContext): Promise<Response> {
		const body = (await ctx.req.json().catch(() => ({}))) as DebugEmbeddingBody;
		const text = body.text ?? "hello world";
		const live = this.runtime.peek();
		if (!live) return ctx.error("runtime not built", 503);
		const runtime = live as DebugEmbeddingRuntime;
		const model = await runDebugEmbeddingModel(runtime, text);
		const embSvc = runtime.getService?.("embedding-generation") as
			| {
					isDisabled?: boolean;
					batchQueue?: { size?: number; isStarted?: boolean } | null;
			  }
			| null
			| undefined;
		const writeResult = await writeDebugEmbedding(
			runtime,
			body,
			text,
			model.vector,
		);
		return ctx.json({
			hasModel: runtime.getModel?.("TEXT_EMBEDDING") !== undefined,
			adapterEmbeddingDimension: runtime.adapter?.embeddingDimension ?? null,
			embeddingServiceRegistered: embSvc !== null && embSvc !== undefined,
			embeddingServiceDisabled: embSvc?.isDisabled ?? null,
			queueStarted: embSvc?.batchQueue?.isStarted ?? null,
			queueSize: embSvc?.batchQueue?.size ?? null,
			durationMs: model.durationMs,
			dim: model.vector.length,
			nonZero: model.vector.filter((n) => Math.abs(n) > 1e-9).length,
			first5: model.vector.slice(0, 5),
			modelErr: model.modelErr,
			writeResult,
		});
	}

	private async debugImage(ctx: ApiRequestContext): Promise<Response> {
		const body = (await ctx.req.json().catch(() => ({}))) as DebugImageBody;
		const prompt =
			typeof body.prompt === "string" && body.prompt.trim().length > 0
				? body.prompt.trim()
				: "A small proof image of a neon command console with the words Detour image pipeline works, crisp bitmap, square.";
		const live = this.runtime.peek();
		if (!live) return ctx.error("runtime not built", 503);
		const runtime = live as DebugImageRuntime;
		if (!runtime.useModel) return ctx.error("runtime.useModel is not a function", 503);
		const result = await runtime.useModel(ModelType.IMAGE, {
			prompt,
			...(typeof body.size === "string" && body.size.trim().length > 0
				? { size: body.size.trim() }
				: {}),
		});
		const image = generatedImage(result);
		if (!image) return ctx.error("image generation returned no image", 502);
		return imageResponseFromUrl(image.url);
	}

	private async deleteActivityTask(
		ctx: ApiRequestContext,
		rawId: string,
	): Promise<Response> {
		const id = decodeURIComponent(rawId);
		let success = false;
		let errMsg: string | undefined;
		try {
			success = await this.activity.tasks.remove(id);
		} catch (err) {
			errMsg = err instanceof Error ? err.message : String(err);
		}
		pensieveAudit({
			action: "task.delete",
			target: id,
			success,
			...(errMsg ? { error: errMsg } : {}),
			caller: "ui-activity",
			ts: Date.now(),
		});
		return success ? ctx.ok() : ctx.error(errMsg ?? "delete failed", 400);
	}

	async start(preferredPort = 2138): Promise<{ port: number }> {
		this.installBrowserControlGlobal();
		// Try preferred port first; fall back to ephemeral if taken
		try {
			return await this.tryStart(preferredPort);
		} catch (err) {
			if ((err as { code?: string }).code === "EADDRINUSE") {
				console.warn(
					`[core] port ${preferredPort} in use, falling back to ephemeral`,
				);
				return this.tryStart(0);
			}
			throw err;
		}
	}

	private async tryStart(port: number): Promise<{ port: number }> {
		const json = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), {
				status,
				headers: corsHeaders("application/json"),
			});
		const ok = () => json({ ok: true });
		const error = (message: string, status = 400) =>
			json({ ok: false, error: message }, status);

		this.server = Bun.serve<WsData, never>({
			port,
			hostname: "127.0.0.1",
			fetch: async (req, server) => {
				return this.handleHttpRequest(req, server, { json, ok, error });
			},
			websocket: {
				open: (ws) => {
					if (ws.data.kind === "agent-log") {
						this.openAgentLogStream(ws);
						return;
					}
					this.subscribers.set(ws.data.id, ws);
				},
				close: (ws) => {
					if (ws.data.kind === "agent-log") {
						this.closeAgentLogStream(ws.data.id);
						return;
					}
					this.subscribers.delete(ws.data.id);
				},
				message: async (ws, raw) => {
					if (ws.data.kind === "agent-log") return;
					let msg: WsClientMessage;
					try {
						msg = JSON.parse(raw.toString()) as WsClientMessage;
					} catch {
						return;
					}
					if (msg.kind === "ping") {
						this.send(ws, { kind: "pong" });
						return;
					}
						if (msg.kind === "log:webview") {
							this.activity.logs.captureWebviewLog({
								level: msg.level,
								msg: msg.msg,
							...(msg.source ? { source: msg.source } : {}),
							...(msg.traceId ? { traceId: msg.traceId } : {}),
							...(msg.extras ? { extras: msg.extras } : {}),
							});
							return;
						}
						if (msg.kind === "chat:cancel") {
							this.activeChatTurns.get(msg.convId)?.cancel();
							return;
						}
						if (msg.kind === "ui:close-command-palette") {
							this.broadcast({ kind: "ui:close-command-palette" });
							return;
						}
						if (msg.kind === "ui:pet-window-drag") {
							if (
								Number.isFinite(msg.dx) &&
							Number.isFinite(msg.dy) &&
							Math.abs(msg.dx) <= 240 &&
							Math.abs(msg.dy) <= 240
						) {
							this.broadcast({ kind: "ui:pet-window-drag", dx: msg.dx, dy: msg.dy });
							}
							return;
						}
						if (msg.kind === "ui:run-chat-command") {
							this.broadcast({ kind: "ui:run-chat-command", command: msg.command });
							return;
						}
						if (msg.kind === "chat:send") {
							const { convId, text } = msg;
						// One trace id per chat send. Stamps every log line emitted
						// during the eliza pipeline (via AsyncLocalStorage) and
						// every chat:* WS message back to the webview, so the
						// React side can correlate its own console output with
						// server-side logs for the same turn.
						const traceId = newTraceId();
						let completeFired = false;
						let idleTimer: ReturnType<typeof setTimeout> | null = null;
						let cancelled = false;
						const clearActive = () => {
							const active = this.activeChatTurns.get(convId);
							if (active?.traceId === traceId) this.activeChatTurns.delete(convId);
						};
						const fireComplete = () => {
							if (cancelled || completeFired) return;
							completeFired = true;
							if (idleTimer) clearTimeout(idleTimer);
							clearActive();
							this.broadcast({ kind: "chat:complete", convId, traceId });
						};
						const cancel = () => {
							if (cancelled || completeFired) return;
							cancelled = true;
							completeFired = true;
							if (idleTimer) clearTimeout(idleTimer);
							clearActive();
							this.broadcast({ kind: "chat:complete", convId, traceId });
						};
						const armIdle = () => {
							if (idleTimer) clearTimeout(idleTimer);
							idleTimer = setTimeout(fireComplete, 1500);
						};
						this.activeChatTurns.get(convId)?.cancel();
						this.activeChatTurns.set(convId, { traceId, cancel });
						await traceScope(traceId, async () => {
							try {
								await this.runtime.sendMessage(text, (delta) => {
									if (cancelled) return;
									this.broadcast({
										kind: "chat:delta",
										convId,
										delta,
										traceId,
									});
									armIdle();
								});
								fireComplete();
							} catch (err) {
								if (cancelled) return;
								if (idleTimer) clearTimeout(idleTimer);
								clearActive();
								const message =
									err instanceof Error ? err.message : String(err);
								this.broadcast({
									kind: "chat:error",
									convId,
									message,
									traceId,
								});
							}
						});
					}
				},
			},
		});

		this.port = this.server.port ?? port;
		this.writeLockfile();
		return { port: this.port };
	}

	private readonly routeHandlers: ApiRouteHandler[] = [
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/health") {
				return json({ ok: true, version: VERSION });
			}
			if (req.method === "GET" && path === "/api/chat/commands") {
				return json({ commands: chatCommands() });
			}
			if (req.method === "GET" && path === "/api/pets") {
				return json(this.petsResponse());
			}
			if (req.method === "GET" && path === "/api/pets/active") {
				const pet = this.findPet();
				return pet ? json({ pet, state: this.currentPetState() }) : error("no Codex pets installed", 404);
			}
			if (req.method === "GET" && path === "/api/pets/activity") {
				return json(this.petActivity());
			}
			if (req.method === "PUT" && path === "/api/pets/state") {
				const body = (await req.json().catch(() => ({}))) as { state?: unknown; reason?: unknown };
				if (typeof body.state !== "string" || !PET_STATES.has(body.state as CodexPetAnimationState)) {
					return error("invalid pet animation state", 400);
				}
				this.setPetState(
					body.state as CodexPetAnimationState,
					typeof body.reason === "string" ? body.reason : undefined,
				);
				return json({ state: this.currentPetState() });
			}
			if (req.method === "POST" && path === "/api/pets/spawn") {
				const body = (await req.json().catch(() => ({}))) as { pet?: unknown };
				const pet = this.findPet(typeof body.pet === "string" ? body.pet : null);
				if (!pet) return error("Codex pet not found", 404);
				return json(this.spawnPet(pet));
			}
			const petSprite = path.match(/^\/api\/pets\/([^/]+)\/spritesheet$/);
			if ((req.method === "GET" || req.method === "HEAD") && petSprite) {
				const pet = this.findPet(decodeURIComponent(petSprite[1] ?? ""));
				if (!pet) return error("Codex pet not found", 404);
				if (!existsSync(pet.spritesheetPath)) return error("pet spritesheet missing", 404);
				return new Response(req.method === "HEAD" ? null : Bun.file(pet.spritesheetPath), {
					headers: {
						"content-type": "image/webp",
						"cache-control": "no-store",
					},
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/providers") {
				const list = await this.vault.listProviders();
				await this.runtime.getOrBuild().catch(() => {});
				const runtimeProvider = this.runtime.getCurrentProvider();
				const enriched = list.map((p) => ({
					...p,
					active: runtimeProvider === p.id,
				}));
				return json(enriched);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/providers/openrouter/models") {
				const manager = await this.vault.manager();
				const apiKey = (await manager.has("OPENROUTER_API_KEY"))
					? await manager.get("OPENROUTER_API_KEY")
					: undefined;
				return json(await fetchOpenRouterModels({ apiKey }));
			}
			return null;
		},
		async (ctx) => {
			const { req, path, ok } = ctx;
			const setKey = path.match(/^\/api\/providers\/([^/]+)\/key$/);
			if (req.method === "PUT" && setKey) {
				const id = setKey[1] as ProviderId;
				const body = (await req.json()) as SetProviderKeyBody;
				await this.vault.setProviderKey(id, body.key);
				const current = this.runtime.getCurrentProvider();
				if (!current || current === id) await this.runtime.rebuild();
				this.broadcast({
					kind: "provider:changed",
					activeProvider: await this.vault.getActiveProvider(),
				});
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, path, ok } = ctx;
			const setKey = path.match(/^\/api\/providers\/([^/]+)\/key$/);
			if (req.method === "DELETE" && setKey) {
				const id = setKey[1] as ProviderId;
				await this.vault.removeProviderKey(id);
				if (this.runtime.getCurrentProvider() === id) {
					await this.runtime.rebuild();
				}
				this.broadcast({
					kind: "provider:changed",
					activeProvider: await this.vault.getActiveProvider(),
				});
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, path, ok } = ctx;
			if (req.method === "PUT" && path === "/api/providers/active") {
				const body = (await req.json()) as SetActiveProviderBody;
				await this.vault.setActiveProvider(body.id);
				await this.runtime.rebuild();
				this.broadcast({
					kind: "provider:changed",
					activeProvider: body.id,
				});
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, path, json } = ctx;
			if (req.method === "GET" && path === "/api/backends") {
				const manager = await this.vault.manager();
				return json(await manager.detectBackends());
			}
			return null;
		},
		async (ctx) => {
			const { req, path, json } = ctx;
			if (req.method === "GET" && path === "/api/backends/enabled") {
				const manager = await this.vault.manager();
				const prefs = await manager.getPreferences();
				return json({ enabled: prefs.enabled });
			}
			return null;
		},
		async (ctx) => {
			const { req, path, ok, error } = ctx;
			if (req.method === "PUT" && path === "/api/backends/enabled") {
				const body = (await req.json()) as SetEnabledBackendsBody;
				const enabled = parseBackendIds(body.enabled);
				if (!enabled) return error("invalid backend id", 400);
				const manager = await this.vault.manager();
				const prefs = await manager.getPreferences();
				await manager.setPreferences({
					...prefs,
					enabled,
				});
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- backend ops: diagnose / signin / signout ---
			if (req.method === "GET" && path === "/api/backends/1password/diagnose") {
				return json(await this.backendOps.diagnoseOnePassword());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const signInMatch = path.match(/^\/api\/backends\/([^/]+)\/signin$/);
			if (req.method === "POST" && signInMatch) {
				const id = decodeURIComponent(
					signInMatch[1] ?? "",
				) as InstallableBackendId;
				const body = (await req.json()) as Omit<
					Parameters<typeof this.backendOps.signIn>[0],
					"backendId"
				>;
				const result = await this.backendOps.signIn({ backendId: id, ...body });
				this.broadcast({ kind: "backend:changed", backendId: id });
				return json(result);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const signOutMatch = path.match(/^\/api\/backends\/([^/]+)\/signout$/);
			if (req.method === "POST" && signOutMatch) {
				const id = decodeURIComponent(
					signOutMatch[1] ?? "",
				) as InstallableBackendId;
				await this.backendOps.signOut(id);
				this.broadcast({ kind: "backend:changed", backendId: id });
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- system browser (OAuth flows can't use window.open from inside a webview) ---
			if (req.method === "POST" && path === "/api/external/open") {
				const body = (await req.json()) as { url: string };
				if (typeof body.url !== "string" || !/^https?:\/\//i.test(body.url)) {
					return error("invalid url", 400);
				}
				const cmd =
					process.platform === "darwin"
						? "open"
						: process.platform === "win32"
							? "start"
							: "xdg-open";
				const { spawn: sp } = await import("node:child_process");
				sp(cmd, [body.url], {
					stdio: "ignore",
					detached: true,
					shell: false,
				}).unref();
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/browser/commands") {
				const after = url.searchParams.get("after") ?? "";
				const since = url.searchParams.get("since")
					? Number(url.searchParams.get("since"))
					: 0;
				const afterIndex = after
					? this.browserCommands.findIndex((command) => command.id === after)
					: -1;
				const commands =
					afterIndex >= 0
						? this.browserCommands.slice(afterIndex + 1)
						: this.browserCommands.filter(
								(command) => !since || command.time >= since,
							);
				return json({
					commands: commands.filter(
						(command) => !this.browserResults.has(command.id),
					),
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/browser/commands") {
				const input = this.parseBrowserCommand(await req.json());
				if (!input) return error("invalid browser command", 400);
				return json({ command: this.enqueueBrowserCommand(input) });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const browserResultMatch = path.match(
				/^\/api\/browser\/commands\/([^/]+)\/result$/,
			);
			if (req.method === "POST" && browserResultMatch) {
				const id = decodeURIComponent(browserResultMatch[1] ?? "");
				const body = (await req.json()) as Record<string, unknown>;
				const okResult = body.ok === true;
				const result = this.finishBrowserCommand(id, {
					ok: okResult,
					...(body.result !== undefined ? { result: body.result } : {}),
					...(typeof body.error === "string" ? { error: body.error } : {}),
					...(typeof body.text === "string" ? { text: body.text } : {}),
				});
				return json({ result });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- window control (chat popup) ---
			if (req.method === "POST" && path === "/api/window/hide") {
				this.windowController?.({ kind: "hide" });
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/window/pin") {
				const body = (await req.json()) as { on: boolean };
				this.windowController?.({ kind: "pin", on: !!body.on });
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/window/resize") {
				const body = (await req.json()) as { width: number; height: number };
				this.windowController?.({
					kind: "resize",
					width: Math.max(320, Math.min(2000, Number(body.width) || 0)),
					height: Math.max(320, Math.min(2000, Number(body.height) || 0)),
				});
				return ok();
			}
			if (req.method === "POST" && path === "/api/window/open") {
				const body = (await req.json()) as { target?: unknown };
				const target = parseWindowOpenTarget(body.target);
				if (!target) return error("invalid window target", 400);
				this.broadcast(windowMessageForTarget(target));
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- OS permissions (macOS TCC) ---
			if (req.method === "GET" && path === "/api/os/permissions") {
				return json(await listPermissions());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const osPermOpen = path.match(/^\/api\/os\/permissions\/([^/]+)\/open$/);
			if (req.method === "POST" && osPermOpen) {
				const id = decodeURIComponent(osPermOpen[1] ?? "") as PermissionId;
				try {
					await openPermissionPane(id);
					return ok();
				} catch (err) {
					return error(err instanceof Error ? err.message : String(err), 400);
				}
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- App configuration (agent permissions, models, window) ---
			if (req.method === "GET" && path === "/api/config/agent") {
				return json(await this.config.getAgent());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "PUT" && path === "/api/config/agent") {
				const body = (await req.json()) as Parameters<
					ConfigService["setAgent"]
				>[0];
				await this.config.setAgent(body);
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/config/character") {
				return json(await this.config.getCharacter());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "PUT" && path === "/api/config/character") {
				const body = (await req.json()) as Parameters<
					ConfigService["setCharacter"]
				>[0];
				await this.config.setCharacter(body);
				await this.runtime.rebuild().catch(() => {});
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/config/models") {
				return json(await this.config.getModels());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "PUT" && path === "/api/config/models") {
				const body = (await req.json()) as Parameters<
					ConfigService["setModels"]
				>[0];
				await this.config.setModels(body);
				// Rebuild runtime so new model names take effect immediately
				await this.runtime.rebuild().catch(() => {});
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/config/window") {
				return json(await this.config.getWindow());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "PUT" && path === "/api/config/window") {
				const body = (await req.json()) as Parameters<
					ConfigService["setWindow"]
				>[0];
				await this.config.setWindow(body);
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- UI preferences (theme + accent), persisted to vault ---
			if (req.method === "GET" && path === "/api/ui/preferences") {
				const v = await this.vault.vault();
				const theme = (await v.has("ui.theme"))
					? await v.get("ui.theme")
					: "system";
				const accent = (await v.has("ui.accent"))
					? await v.get("ui.accent")
					: "#0a84ff";
				return json({ theme, accent });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "PUT" && path === "/api/ui/preferences") {
				const body = (await req.json()) as { theme?: string; accent?: string };
				const v = await this.vault.vault();
				if (typeof body.theme === "string") await v.set("ui.theme", body.theme);
				if (typeof body.accent === "string")
					await v.set("ui.accent", body.accent);
				// Broadcast so other open windows (Pensieve, Activity, Channels)
				// can re-apply the new theme/accent live without a reload.
				const theme = (
					(await v.has("ui.theme")) ? await v.get("ui.theme") : "system"
				) as "system" | "light" | "dark";
				const accent = (await v.has("ui.accent"))
					? await v.get("ui.accent")
					: "#0a84ff";
				this.broadcast({
					kind: "ui:preferences-changed",
					preferences: { theme, accent },
				});
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/backends/install") {
				const platform = currentPlatform();
				const pms = await detectPackageManagers();
				const specs = await Promise.all(
					Object.values(BACKEND_INSTALL_SPECS).map(async (spec: any) => {
						const runnable = await resolveRunnableMethods(spec.id, platform);
						const commands = runnable.map((m: any) => buildInstallCommand(m));
						return { id: spec.id, methods: runnable, commands };
					}),
				);
				return json({ platform, packageManagers: pms, specs });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- generic vault inventory + per-key CRUD ---
			if (req.method === "GET" && path === "/api/vault/inventory") {
				const manager = await this.vault.manager();
				const items = await listVaultInventory(manager.vault);
				const enriched = await Promise.all(
					items.map(async (item: any) => ({
						...item,
						category: categorizeKey(item.key),
						provider: inferProviderId(item.key) ?? null,
						meta: await readEntryMeta(manager.vault, item.key).catch(
							() => null,
						),
					})),
				);
				return json(enriched);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/vault/stats") {
				const v = await this.vault.vault();
				return json(await v.stats());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/vault/keys") {
				const manager = await this.vault.manager();
				const prefix = url.searchParams.get("prefix") ?? undefined;
				return json([...(await manager.list(prefix))]);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const vaultKey = path.match(/^\/api\/vault\/keys\/(.+?)(\/meta)?$/);
			if (vaultKey) {
				const key = decodeURIComponent(vaultKey[1] ?? "");
				const isMeta = vaultKey[2] === "/meta";
				const v = await this.vault.vault();
				const manager = await this.vault.manager();

				if (isMeta) {
					if (req.method === "GET") {
						return json(await readEntryMeta(v, key));
					}
					if (req.method === "PUT") {
						const meta = (await req.json()) as any;
						await setEntryMeta(v, key, meta);
						return ok();
					}
					if (req.method === "DELETE") {
						await removeEntryMeta(v, key);
						return ok();
					}
				} else {
					if (req.method === "GET") {
						const reveal = url.searchParams.get("reveal") === "1";
						const exists = await manager.has(key);
						if (!exists) return error("not found", 404);
						const desc = await v.describe(key);
						if (!reveal) return json({ key, descriptor: desc });
						const value = await v.reveal(key, "tray-app:vault-ui");
						return json({ key, descriptor: desc, value });
					}
					if (req.method === "PUT") {
						const body = (await req.json()) as {
							value: string;
							sensitive?: boolean;
						};
						await manager.set(key, body.value, {
							sensitive: body.sensitive ?? true,
						});
						return ok();
					}
					if (req.method === "DELETE") {
						await manager.remove(key);
						return ok();
					}
				}
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- saved logins (in-house + 1Password + Bitwarden) ---
			if (req.method === "GET" && path === "/api/saved-logins") {
				const manager = await this.vault.manager();
				return json(await manager.listAllSavedLogins());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/saved-logins") {
				// in-house only
				const body = (await req.json()) as Omit<SavedLogin, "lastModified">;
				const v = await this.vault.vault();
				await setSavedLogin(v, body);
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const reveal = path.match(/^\/api\/saved-logins\/([^/]+)\/(.+)$/);
			if (reveal) {
				const source = decodeURIComponent(reveal[1] ?? "") as
					| "in-house"
					| "1password"
					| "bitwarden";
				const identifier = decodeURIComponent(reveal[2] ?? "");
				if (req.method === "GET") {
					const manager = await this.vault.manager();
					try {
						return json(await manager.revealSavedLogin(source, identifier));
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						// 1Password items without a `password` field (passkeys, SSO/social
						// logins, identity items mis-categorized as Login) trip the
						// hard error in eliza. Fall back to op item get and surface the
						// metadata we can read instead of failing the whole request.
						if (source === "1password" && /no password field/i.test(msg)) {
							const fallback = await readOnePasswordItemMetadata(identifier);
							return json({
								source: "1password",
								identifier,
								username: fallback.username ?? "",
								password: "",
								domain: fallback.domain ?? null,
								...(fallback.totp ? { totp: fallback.totp } : {}),
								note: fallback.note,
							});
						}
						throw err;
					}
				}
				if (req.method === "DELETE" && source === "in-house") {
					// in-house identifier is "<domain>:<username>"
					const sep = identifier.lastIndexOf(":");
					if (sep < 0) return error("invalid in-house identifier", 400);
					const domain = identifier.slice(0, sep);
					const username = identifier.slice(sep + 1);
					const v = await this.vault.vault();
					await deleteSavedLogin(v, domain, username);
					return ok();
				}
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- routing profiles ---
			if (req.method === "GET" && path === "/api/routing") {
				const v = await this.vault.vault();
				return json(await readRoutingConfig(v));
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "PUT" && path === "/api/routing") {
				const body = (await req.json()) as RoutingConfig;
				const v = await this.vault.vault();
				await writeRoutingConfig(v, body);
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Activity (operational: runtime, logs, trajectories, tasks) ---
			if (req.method === "GET" && path === "/api/activity/runtime") {
				return json(this.activity.runtimeSnapshot());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "OPTIONS" && path.startsWith("/api/activity/workspace-")) {
				return publicOptions();
			}
			if (req.method === "GET" && path === "/api/activity/workspace-agents") {
				return publicJson({
					agents: readWorkspaceAgents(url.origin),
					stateDir: WORKSPACE_AGENT_STATE_DIR,
					updatedAt: Date.now(),
				});
			}
				if (req.method === "GET" && path === "/api/activity/workspace-projects") {
					return publicJson({
						projects: readWorkspaceProjects(url.origin),
						workspaceRoot: WORKSPACE_PROJECT_ROOT,
						updatedAt: Date.now(),
					});
				}
				const projectDelete = path.match(
					/^\/api\/activity\/workspace-projects\/([^/]+)$/,
				);
				if (req.method === "DELETE" && projectDelete) {
					const result = deleteWorkspaceProject(
						decodeURIComponent(projectDelete[1] ?? ""),
						url.origin,
					);
					if (!result.ok) return publicError(result.error, result.status);
					return publicJson(result);
				}
				const projectFiles = path.match(
					/^\/api\/activity\/workspace-projects\/([^/]+)\/files$/,
				);
			if (req.method === "GET" && projectFiles) {
				const project = resolveWorkspaceProject(
					decodeURIComponent(projectFiles[1] ?? ""),
					url.origin,
				);
				if (!project) return publicError("workspace project not found", 404);
				const result = readWorkspaceProjectFiles(
					project,
					projectSubpath(url.searchParams.get("path")),
				);
				if ("error" in result) return publicError(result.error, result.status);
				return publicJson(result);
			}
			const projectFile = path.match(
				/^\/api\/activity\/workspace-projects\/([^/]+)\/file$/,
			);
			if (req.method === "GET" && projectFile) {
				const project = resolveWorkspaceProject(
					decodeURIComponent(projectFile[1] ?? ""),
					url.origin,
				);
				if (!project) return publicError("workspace project not found", 404);
				const result = readWorkspaceProjectFile(
					project,
					projectSubpath(url.searchParams.get("path")),
				);
				if ("error" in result) return publicError(result.error, result.status);
				return publicJson(result);
			}
			const projectPreview = path.match(
				/^\/api\/activity\/workspace-projects\/([^/]+)\/preview\/(.+)$/,
			);
			if (req.method === "GET" && projectPreview) {
				const project = resolveWorkspaceProject(
					decodeURIComponent(projectPreview[1] ?? ""),
					url.origin,
				);
				if (!project) return publicError("workspace project not found", 404);
				const result = workspaceProjectPreviewResponse(
					project,
					projectSubpath(decodeURIComponent(projectPreview[2] ?? "")),
				);
				if ("error" in result) return publicError(result.error, result.status);
				return result;
			}
			const logMatch = path.match(
				/^\/api\/activity\/workspace-agents\/([^/]+)\/log$/,
			);
			if (req.method === "GET" && logMatch) {
				const id = decodeURIComponent(logMatch[1] ?? "");
				const agent = readWorkspaceAgents().find((item) => item.id === id);
				if (!agent) return publicError("workspace agent not found", 404);
				const logPath = safeWorkspaceAgentLogPath(agent);
				if (!logPath || !existsSync(logPath)) {
					return publicJson({
						id,
						offset: 0,
						nextOffset: 0,
						text: "",
						truncated: false,
					});
				}
				const rawOffset = Number(url.searchParams.get("offset") ?? 0);
				const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
				const data = readFileSync(logPath);
				const start = Math.min(offset, data.byteLength);
				const available = data.byteLength - start;
				const take = Math.min(available, MAX_WORKSPACE_AGENT_LOG_CHARS);
				const text = data.subarray(start, start + take).toString("utf8");
				return publicJson({
					id,
					offset: start,
					nextOffset: start + take,
					text,
					truncated: available > take,
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/activity/logs") {
				const level = url.searchParams.get("level") ?? undefined;
				const source = url.searchParams.get("source") ?? undefined;
				const q = url.searchParams.get("q") ?? undefined;
				const limit = url.searchParams.get("limit")
					? Number(url.searchParams.get("limit"))
					: undefined;
				const since = url.searchParams.get("since")
					? Number(url.searchParams.get("since"))
					: undefined;
				return json(
					this.activity.logs.list({
						...(level ? { level } : {}),
						...(source ? { source } : {}),
						...(q ? { q } : {}),
						...(limit ? { limit } : {}),
						...(since ? { since } : {}),
					}),
				);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/activity/trajectories") {
				const limit = Number(url.searchParams.get("limit") ?? 50);
				const offset = Number(url.searchParams.get("offset") ?? 0);
				const status = url.searchParams.get("status") ?? undefined;
				const source = url.searchParams.get("source") ?? undefined;
				const q = url.searchParams.get("q") ?? undefined;
				return json(
					await this.activity.trajectories.list({
						limit,
						offset,
						...(status ? { status } : {}),
						...(source ? { source } : {}),
						...(q ? { q } : {}),
					}),
				);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const trajGet = path.match(/^\/api\/activity\/trajectories\/([^/]+)$/);
			if (req.method === "GET" && trajGet) {
				return json(
					await this.activity.trajectories.get(
						decodeURIComponent(trajGet[1] ?? ""),
					),
				);
			}
			if (
				req.method === "POST" &&
				path === "/api/activity/trajectories/export.zip"
			) {
				const body = (await req.json().catch(() => ({}))) as {
					ids?: string[];
					includePrompts?: boolean;
				};
				const exported = await this.activity.trajectories.exportZip({
					...(Array.isArray(body.ids) && body.ids.length > 0
						? { ids: body.ids }
						: {}),
					...(typeof body.includePrompts === "boolean"
						? { includePrompts: body.includePrompts }
						: {}),
				});
				const responseBody = new ArrayBuffer(exported.data.byteLength);
				new Uint8Array(responseBody).set(exported.data);
				return new Response(responseBody, {
					headers: {
						"content-type": exported.mimeType,
						"content-disposition": `attachment; filename="${exported.filename}"`,
						"x-trajectory-count": String(exported.count),
					},
				});
			}
			if (
				req.method === "POST" &&
				path === "/api/activity/trajectories/export"
			) {
				const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
				const ids =
					Array.isArray(body.ids) && body.ids.length > 0
						? body.ids
						: (
								await this.activity.trajectories.list({ limit: 500 })
							).trajectories.map((t) => t.id);
				const details = await this.activity.trajectories.getMany(ids);
				return json({
					exportedAt: Date.now(),
					count: details.length,
					trajectories: details,
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Pensieve (knowledge: memories + relationships + graph + templates) ---
			if (req.method === "GET" && path === "/api/pensieve/memories/tree") {
				const table = parseMemoryTable(url.searchParams.get("tableName"));
				if (!table.ok) return error(table.error, 400);
				return json(
					await this.pensieve.memories.tree({
						...(table.tableName ? { tableName: table.tableName } : {}),
					}),
				);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/pensieve/memories") {
				const table = parseMemoryTable(url.searchParams.get("tableName"));
				if (!table.ok) return error(table.error, 400);
				const opts: Record<string, unknown> = {
					limit: Number(url.searchParams.get("limit") ?? 100),
					...(table.tableName ? { tableName: table.tableName } : {}),
				};
				for (const key of [
					"roomId",
					"entityId",
					"type",
					"tag",
					"q",
					"pathPrefix",
				]) {
					const v = url.searchParams.get(key);
					if (v) opts[key] = v;
				}
				return json(
					await this.pensieve.memories.list(
						opts as Parameters<typeof this.pensieve.memories.list>[0],
					),
				);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/pensieve/knowledge/status") {
				return json({ available: this.pensieve.knowledge.available() });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/pensieve/embedding-map") {
				return json(await this.pensieve.embeddingMap.snapshot());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/pensieve/chronicler/status") {
				return json(this.pensieve.chronicler.status());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/pensieve/chronicler/config") {
				return json(this.pensieve.chronicler.getConfig());
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			if (req.method === "PUT" && path === "/api/pensieve/chronicler/config") {
				return this.updateChroniclerConfig(ctx);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/pensieve/chronicler/sample") {
				try {
					const observation = await this.pensieve.chronicler.sampleNow();
					pensieveAudit({
						action: "chronicler.sample",
						target: observation.id,
						success: true,
						caller: "ui-pensieve",
						ts: Date.now(),
					});
					return json(observation);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					pensieveAudit({
						action: "chronicler.sample",
						success: false,
						error: msg,
						caller: "ui-pensieve",
						ts: Date.now(),
					});
					return error(msg, 400);
				}
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/pensieve/chronicler/recent") {
				const limit = Number(url.searchParams.get("limit") ?? 20);
				return json(this.pensieve.chronicler.recent(limit));
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/pensieve/knowledge/ingest") {
				const body = (await req.json()) as {
					filename: string;
					contentType?: string;
					content: string;
					metadata?: Record<string, unknown>;
				};
				let success = false;
				let result: unknown = null;
				let errMsg: string | undefined;
				try {
					result = await this.pensieve.knowledge.ingest({
						filename: body.filename,
						contentType: body.contentType ?? "text/plain",
						content: body.content,
						...(body.metadata ? { metadata: body.metadata } : {}),
					});
					success = !!result;
				} catch (err) {
					errMsg = err instanceof Error ? err.message : String(err);
				}
				pensieveAudit({
					action: "knowledge.ingest",
					target: body.filename,
					success,
					...(errMsg ? { error: errMsg } : {}),
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				return success
					? json({ ok: true, ...(result as Record<string, unknown>) })
					: error(errMsg ?? "knowledge service not available", 400);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/pensieve/memories") {
				const body = (await req.json()) as {
					text: string;
					path?: string;
					type?: string;
					tags?: string[];
					extraMetadata?: Record<string, unknown>;
				};
				let success = false;
				let errMsg: string | undefined;
				let createdId: string | undefined;
				try {
					const created = await this.pensieve.memories.create(body);
					success = !!created;
					createdId = created?.id;
				} catch (err) {
					errMsg = err instanceof Error ? err.message : String(err);
				}
				pensieveAudit({
					action: "memory.create",
					target: createdId,
					success,
					...(errMsg ? { error: errMsg } : {}),
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				return success
					? json({ ok: true, id: createdId })
					: error(errMsg ?? "create failed", 400);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/pensieve/memories/search") {
				const body = (await req.json()) as { text: string; limit?: number };
				return json(
					await this.pensieve.memories.search(body.text, body.limit ?? 30),
				);
			}
			return null;
		},
		async (ctx) => {
			const { req, path, json, error } = ctx;
			const memGet = path.match(/^\/api\/pensieve\/memories\/([^/]+)$/);
			if (req.method === "GET" && memGet) {
				const id = decodeURIComponent(memGet[1] ?? "") as never;
				const detail = await this.pensieve.memories.get(id);
				if (!detail) return error("not found", 404);
				const backlinks = await this.pensieve.graph.backlinksForMemory(
					memGet[1] ?? "",
				);
				return json({ ...detail, backlinks });
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			const memGet = path.match(/^\/api\/pensieve\/memories\/([^/]+)$/);
			if (req.method === "PATCH" && memGet) {
				return this.updateMemory(ctx, memGet[1] ?? "");
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			const memGet = path.match(/^\/api\/pensieve\/memories\/([^/]+)$/);
			if (req.method === "DELETE" && memGet) {
				return this.deleteMemory(ctx, memGet[1] ?? "");
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json } = ctx;
			if (
				req.method === "GET" &&
				path === "/api/pensieve/relationships/persons"
			) {
				const limit = Number(url.searchParams.get("limit") ?? 100);
				return json(await this.pensieve.relationships.listPersons(limit));
			}
			return null;
		},
		async (ctx) => {
			const { req, path, json, error } = ctx;
			const personGet = path.match(/^\/api\/pensieve\/relationships\/([^/]+)$/);
			if (req.method === "GET" && personGet) {
				const id = decodeURIComponent(personGet[1] ?? "") as never;
				const detail = await this.pensieve.relationships.getPerson(id);
				if (!detail) return error("not found", 404);
				return json(detail);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json } = ctx;
			if (req.method === "GET" && path === "/api/pensieve/relationships") {
				const ids = (url.searchParams.get("entityIds") ?? "")
					.split(",")
					.filter(Boolean) as never[];
				const tags = (url.searchParams.get("tags") ?? "")
					.split(",")
					.filter(Boolean);
				const limit = Number(url.searchParams.get("limit") ?? 200);
				return json(
					await this.pensieve.relationships.listRelationships(ids, tags, limit),
				);
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			if (req.method === "POST" && path === "/api/pensieve/relationships") {
				return this.createRelationship(ctx);
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			const relPair = path.match(
				/^\/api\/pensieve\/relationships\/([^/]+)\/([^/]+)$/,
			);
			if (req.method === "PATCH" && relPair) {
				return this.updateRelationship(ctx, relPair[1] ?? "", relPair[2] ?? "");
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			const relPair = path.match(
				/^\/api\/pensieve\/relationships\/([^/]+)\/([^/]+)$/,
			);
			if (req.method === "DELETE" && relPair) {
				return this.deleteRelationship(ctx, relPair[1] ?? "", relPair[2] ?? "");
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Pensieve templates + prompt variables ---
			if (req.method === "GET" && path === "/api/pensieve/templates") {
				return json(await this.pensieve.templates.listTemplates());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/pensieve/templates") {
				const body = (await req.json()) as {
					name: string;
					body: string;
					tags?: string[];
				};
				let success = false;
				let id: string | undefined;
				let errMsg: string | undefined;
				try {
					const created = await this.pensieve.templates.createTemplate(body);
					success = !!created;
					id = created?.id;
				} catch (err) {
					errMsg = err instanceof Error ? err.message : String(err);
				}
				pensieveAudit({
					action: "template.create",
					target: id,
					success,
					...(errMsg ? { error: errMsg } : {}),
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				return success
					? json({ ok: true, id })
					: error(errMsg ?? "create failed", 400);
			}
			return null;
		},
		async (ctx) => {
			const { req, path, json, error } = ctx;
			const tplDetail = path.match(/^\/api\/pensieve\/templates\/([^/]+)$/);
			if (req.method === "GET" && tplDetail) {
				const id = decodeURIComponent(tplDetail[1] ?? "");
				const detail = await this.pensieve.templates.getTemplate(id);
				return detail ? json(detail) : error("not found", 404);
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			const tplDetail = path.match(/^\/api\/pensieve\/templates\/([^/]+)$/);
			if (req.method === "PATCH" && tplDetail) {
				return this.updateTemplate(ctx, tplDetail[1] ?? "");
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			const tplDetail = path.match(/^\/api\/pensieve\/templates\/([^/]+)$/);
			if (req.method === "DELETE" && tplDetail) {
				return this.deleteTemplate(ctx, tplDetail[1] ?? "");
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const tplRender = path.match(
				/^\/api\/pensieve\/templates\/([^/]+)\/render$/,
			);
			if (req.method === "POST" && tplRender) {
				const id = decodeURIComponent(tplRender[1] ?? "");
				const body = (await req.json().catch(() => ({}))) as {
					vars?: Record<string, string>;
				};
				const result = await this.pensieve.templates.renderTemplate(
					id,
					body.vars ?? {},
				);
				pensieveAudit({
					action: "template.render",
					target: id,
					success: !!result,
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				return result ? json(result) : error("not found", 404);
			}
			if (req.method === "GET" && path === "/api/pensieve/template-vars") {
				return json(await this.pensieve.templates.listVariables());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const varRoute = path.match(/^\/api\/pensieve\/template-vars\/([^/]+)$/);
			if (req.method === "PUT" && varRoute) {
				const name = decodeURIComponent(varRoute[1] ?? "");
				const body = (await req.json()) as { value: string };
				let success = false;
				let errMsg: string | undefined;
				try {
					const v = await this.pensieve.templates.setVariable(name, body.value);
					success = !!v;
				} catch (err) {
					errMsg = err instanceof Error ? err.message : String(err);
				}
				pensieveAudit({
					action: "promptvar.set",
					target: name,
					success,
					...(errMsg ? { error: errMsg } : {}),
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				return success ? ok() : error(errMsg ?? "set failed", 400);
			}
			if (req.method === "DELETE" && varRoute) {
				const name = decodeURIComponent(varRoute[1] ?? "");
				let success = false;
				try {
					success = await this.pensieve.templates.deleteVariable(name);
				} catch (err) {
					const m = err instanceof Error ? err.message : String(err);
					pensieveAudit({
						action: "promptvar.delete",
						target: name,
						success: false,
						error: m,
						caller: "ui-pensieve",
						ts: Date.now(),
					});
					return error(m, 400);
				}
				pensieveAudit({
					action: "promptvar.delete",
					target: name,
					success,
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				return success ? ok() : error("not found", 404);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Channels (Discord/Telegram/iMessage) ---
			if (req.method === "GET" && path === "/api/channels") {
				const snap = this.activity.pluginsSnapshot();
				const loadedNames = snap.plugins.map((p) => p.name);
				const liveRuntime = this.runtime.peek();
				return json(await this.channels.snapshot(loadedNames, liveRuntime));
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/channels/credentials") {
				const body = (await req.json()) as {
					key: string;
					value: string;
					skipValidate?: boolean;
				};
				// Pre-flight validation against the channel's authoritative
				// API. We'd rather reject a dead token loudly than save it
				// and have the user wonder why the bot is silently broken
				// (the historical Discord pain point). Pass skipValidate=true
				// to bypass — useful if the API is briefly down.
				if (!body.skipValidate) {
					const validation = await validateChannelCredential(
						body.key,
						body.value,
					);
					if (!validation.ok) {
						return error(validation.error, 400);
					}
				}
				await this.channels.setCredential(body.key, body.value);
				this.scheduleChannelReload();
				return json({
					ok: true,
					reloadScheduled: true,
					validated: !body.skipValidate,
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const credDelete = path.match(/^\/api\/channels\/credentials\/([^/]+)$/);
			if (req.method === "DELETE" && credDelete) {
				await this.channels.clearCredential(
					decodeURIComponent(credDelete[1] ?? ""),
				);
				this.scheduleChannelReload();
				return json({ ok: true, reloadScheduled: true });
			}
			if (req.method === "POST" && path === "/api/channels/reload") {
				// Fire-and-forget — telegram's 5-attempt retry-with-backoff
				// can stall the rebuild promise for up to ~3 minutes on a
				// bad/conflicted token. Schedule via the same debouncer so
				// double-clicks coalesce, and let the UI poll status.
				this.scheduleChannelReload();
				return json({ ok: true, reloadScheduled: true });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Discord channel discovery + history backfill ---
			// List the bot's reachable guilds + text channels.
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/channels/discord/guilds") {
				const live = this.runtime.peek();
				const svc = live
					? ((
							live as unknown as { getService?: (t: string) => unknown }
						).getService?.("discord") as {
							client?: {
								guilds?: {
									cache?: Map<
										string,
										{
											id: string;
											name: string;
											channels?: {
												cache?: Map<
													string,
													{ id: string; name: string; type?: number }
												>;
											};
										}
									>;
								};
							};
						} | null)
					: null;
				const cache = svc?.client?.guilds?.cache;
				if (!cache) return json({ guilds: [] });
				const out: Array<{
					id: string;
					name: string;
					channels: Array<{ id: string; name: string; type: number }>;
				}> = [];
				for (const [, g] of cache) {
					const channels: Array<{ id: string; name: string; type: number }> =
						[];
					const ch = g.channels?.cache;
					if (ch)
						for (const [, c] of ch) {
							channels.push({ id: c.id, name: c.name, type: c.type ?? -1 });
						}
					out.push({ id: g.id, name: g.name, channels });
				}
				return json({ guilds: out });
			}
			// Backfill a Discord channel's history into memories.
			// Fire-and-forget — backfill can take minutes on large channels.
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/channels/discord/backfill") {
				const body = (await req.json()) as {
					channelId: string;
					limit?: number;
					force?: boolean;
				};
				const live = this.runtime.peek();
				const svc = live
					? ((
							live as unknown as { getService?: (t: string) => unknown }
						).getService?.("discord") as {
							fetchChannelHistory?: (
								channelId: string,
								opts: { limit?: number; force?: boolean },
							) => Promise<{
								stats: {
									fetched: number;
									stored: number;
									pages: number;
									fullyBackfilled: boolean;
								};
							}>;
						})
					: null;
				if (!svc?.fetchChannelHistory)
					return error("Discord service not loaded", 400);
				// Run in background; client polls trajectories/memories to see progress.
				void svc
					.fetchChannelHistory(body.channelId, {
						limit: body.limit ?? 200,
						force: !!body.force,
					})
					.then((r) =>
						console.log(
							`[discord] backfill complete for ${body.channelId}:`,
							r.stats,
						),
					)
					.catch((err) =>
						console.warn(
							`[discord] backfill failed for ${body.channelId}:`,
							err instanceof Error ? err.message : err,
						),
					);
				return json({ ok: true, scheduled: true, channelId: body.channelId });
			}
			return null;
		},
		async (ctx) => {
			const { req, path, json, error } = ctx;
			if (req.method === "POST" && path === "/api/channels/discord/catch-up") {
				const body = recordValue(await req.json().catch(() => ({}))) ?? {};
				const live = this.runtime.peek();
				if (!live) return error("runtime not built", 503);
				const channelId = optionalString(body, "channelId");
				const limit = optionalNumber(body, "limit") ?? 100;
				const maxAgeHours = optionalNumber(body, "maxAgeHours") ?? 24;
				const options = {
					...(channelId ? { channelId } : {}),
					limit,
					maxAgeMs: maxAgeHours > 0 ? maxAgeHours * 60 * 60_000 : 0,
				};
				const wait = optionalBoolean(body, "wait") ?? Boolean(channelId);
				if (wait) {
					try {
						const result = await runDiscordCatchUp(live, options);
						return json({
							ok: true,
							scheduled: false,
							result,
							...(channelId ? { channelId } : {}),
						});
					} catch (err) {
						return error(err instanceof Error ? err.message : String(err), 400);
					}
				}
				void runDiscordCatchUp(live, options).catch((err) => {
					const runtime = this.runtime.peek();
					runtime?.logger.warn(
						{
							src: "api:discord-catchup",
							channelId,
							error: err instanceof Error ? err.message : String(err),
						},
						"Discord catch-up failed",
					);
				});
				return json({
					ok: true,
					scheduled: true,
					...(channelId ? { channelId } : {}),
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json } = ctx;
			// --- Channel gateway (unified inbound/outbound feed) ---
			if (req.method === "GET" && path === "/api/gateway/feed") {
				return json(this.gateway.list(gatewayListOptions(url)));
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/gateway/identities") {
				const all = url.searchParams.get("all") === "1";
				return json({
					identities: all
						? this.gateway.allIdentities()
						: this.gateway.identityCandidates(),
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Inbox (notifications + actionable channel signals) ---
			if (req.method === "GET" && path === "/api/inbox") {
				const status = url.searchParams.get("status") as InboxStatus | null;
				const kind = url.searchParams.get("kind") as InboxKind | null;
				const source = url.searchParams.get("source") ?? undefined;
				const channel = url.searchParams.get("channel") ?? undefined;
				const since = url.searchParams.get("since")
					? Number(url.searchParams.get("since"))
					: undefined;
				const limit = url.searchParams.get("limit")
					? Number(url.searchParams.get("limit"))
					: undefined;
				return json(
					this.inbox.list({
						...(status ? { status } : {}),
						...(kind ? { kind } : {}),
						...(source ? { source } : {}),
						...(channel ? { channel } : {}),
						...(since ? { since } : {}),
						...(limit ? { limit } : {}),
					}),
				);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/inbox/stats") {
				return json(this.inbox.stats());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Local llama server status ---
			if (req.method === "GET" && path === "/api/llama/status") {
				return json(this.llama.status());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Debug: probe text-model pipeline end-to-end ---
			if (req.method === "POST" && path === "/api/debug/text-model") {
				const body = (await req.json().catch(() => ({}))) as {
					type?: string;
					prompt?: string;
				};
				const modelType = body.type ?? "TEXT_LARGE";
				const prompt = body.prompt ?? "Reply with the single word: pong";
				const live = this.runtime.peek();
				if (!live) return error("runtime not built", 503);
				const r = live as unknown as {
					useModel?: (type: string, params: unknown) => Promise<unknown>;
					getModel?: (type: string) => unknown;
					models?: Map<string, unknown[]>;
				};
				const handlers = r.models?.get?.(modelType);
				const handlerCount = Array.isArray(handlers)
					? handlers.length
					: handlers
						? 1
						: 0;
				const hasModel =
					typeof r.getModel === "function" &&
					r.getModel(modelType) !== undefined;
				let result: unknown = null;
				let err: string | null = null;
				const t0 = Date.now();
				try {
					if (typeof r.useModel === "function") {
						result = await r.useModel(modelType, {
							prompt,
							maxTokens: 50,
							temperature: 0,
						});
					} else {
						err = "runtime.useModel is not a function";
					}
				} catch (e) {
					err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
				}
				const latency = Date.now() - t0;
				return json({
					modelType,
					handlerCount,
					hasModel,
					latencyMs: latency,
					error: err,
					result: typeof result === "string" ? result.slice(0, 500) : result,
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			// --- Debug: probe embedding pipeline end-to-end ---
			if (req.method === "POST" && path === "/api/debug/embedding") {
				return this.debugEmbedding(ctx);
			}
			if (req.method === "POST" && path === "/api/debug/image") {
				return this.debugImage(ctx);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/inbox") {
				const body = (await req.json()) as {
					kind?: InboxKind;
					title?: string;
					body?: string;
					source?: string;
					channel?: string;
					fromHandle?: string;
					meta?: Record<string, unknown>;
					prompt?: boolean;
				};
				if (!body.title) return error("title required", 400);
				const item = await this.inbox.post({
					kind: body.kind ?? "notification",
					title: body.title,
					body: body.body ?? "",
					...(body.source ? { source: body.source } : {}),
					...(body.channel ? { channel: body.channel } : {}),
					...(body.fromHandle ? { fromHandle: body.fromHandle } : {}),
					...(body.meta ? { meta: body.meta } : {}),
					...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
				});
				return json({ ok: true, item });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const inboxStatusUpdate = path.match(/^\/api\/inbox\/([^/]+)\/status$/);
			if (req.method === "PATCH" && inboxStatusUpdate) {
				const id = decodeURIComponent(inboxStatusUpdate[1] ?? "");
				const body = (await req.json()) as { status?: InboxStatus };
				const status = parseInboxStatus(body.status);
				if (!status) return error("valid status required", 400);
				const updated = this.inbox.updateStatus(id, status);
				if (!updated) return error("inbox item not found", 404);
				return json({ ok: true, item: updated });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const inboxAct = path.match(/^\/api\/inbox\/([^/]+)\/act$/);
			if (req.method === "POST" && inboxAct) {
				const id = decodeURIComponent(inboxAct[1] ?? "");
				const updated = await this.inbox.act(id);
				if (!updated) return error("inbox item not found", 404);
				return json({ ok: true, item: updated });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Cron / scheduled prompts ---
			if (req.method === "GET" && path === "/api/cron") {
				return json({ jobs: this.cron.listJobs() });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/cron") {
				const body = (await req.json()) as {
					schedule?: string;
					prompt?: string;
					name?: string;
					enabled?: boolean;
				};
				if (!body.schedule) return error("schedule required", 400);
				if (!body.prompt) return error("prompt required", 400);
				try {
					const job = await this.cron.createJob({
						schedule: body.schedule,
						prompt: body.prompt,
						...(body.name ? { name: body.name } : {}),
						...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
						createdBy: "ui",
					});
					return json({ ok: true, job });
				} catch (err) {
					return error(err instanceof Error ? err.message : String(err), 400);
				}
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Owner-bind (eliza /eliza_pair flow) ---
			if (req.method === "POST" && path === "/api/owner-bind/code") {
				const body = (await req.json()) as { connector?: string };
				const connector = body.connector;
				if (
					connector !== "telegram" &&
					connector !== "discord" &&
					connector !== "wechat" &&
					connector !== "matrix"
				) {
					return error(
						"connector must be telegram | discord | wechat | matrix",
						400,
					);
				}
				const issued = this.ownerBind.generateCode(connector);
				return json({ ok: true, ...issued, connector });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const ownerStatus = path.match(
				/^\/api\/owner-bind\/(telegram|discord|wechat|matrix)$/,
			);
			if (ownerStatus) {
				const connector = (ownerStatus[1] ?? "") as OwnerConnector;
				if (req.method === "GET") {
					const owner = await this.ownerBind.getOwner(connector);
					return json({ connector, bound: !!owner, owner });
				}
				if (req.method === "DELETE") {
					await this.ownerBind.unbind(connector);
					return json({ ok: true });
				}
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const cronById = path.match(/^\/api\/cron\/([^/]+)$/);
			if (cronById) {
				const id = decodeURIComponent(cronById[1] ?? "");
				if (req.method === "GET") {
					const job = this.cron.getJob(id);
					if (!job) return error("not found", 404);
					return json({ job });
				}
				if (req.method === "PATCH") {
					const body = (await req.json()) as {
						schedule?: string;
						prompt?: string;
						name?: string;
						enabled?: boolean;
					};
					try {
						const job = await this.cron.updateJob(id, body);
						if (!job) return error("not found", 404);
						return json({ ok: true, job });
					} catch (err) {
						return error(err instanceof Error ? err.message : String(err), 400);
					}
				}
				if (req.method === "DELETE") {
					const removed = await this.cron.deleteJob(id);
					if (!removed) return error("not found", 404);
					return json({ ok: true });
				}
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Activity DB inspector (read-only) ---
			if (req.method === "GET" && path === "/api/activity/db/tables") {
				return json({
					available: this.activity.db.available(),
					tables: await this.activity.db.listTables(),
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const dbDescribe = path.match(
				/^\/api\/activity\/db\/tables\/([^/]+)\/([^/]+)$/,
			);
			if (req.method === "GET" && dbDescribe) {
				const schema = decodeURIComponent(dbDescribe[1] ?? "");
				const name = decodeURIComponent(dbDescribe[2] ?? "");
				const detail = await this.activity.db.describeTable(schema, name);
				return detail ? json(detail) : error("not found", 404);
			}
			if (req.method === "POST" && path === "/api/activity/db/query") {
				const body = (await req.json()) as { sql: string };
				try {
					const result = await this.activity.db.query(body.sql);
					return json(result);
				} catch (err) {
					const m = err instanceof Error ? err.message : String(err);
					return error(m, 400);
				}
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Activity plugins ---
			if (req.method === "GET" && path === "/api/activity/plugins") {
				return json(this.activity.pluginsSnapshot());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/activity/skills") {
				const runtime = this.runtime.peek();
				const service = runtime?.getService<RuntimeSkillsService>(
					"AGENT_SKILLS_SERVICE",
				);
				if (!service) {
					return json({
						available: false,
						count: 0,
						skills: [],
						stats: null,
					});
				}
				const skills = service.getLoadedSkills().map((skill) => ({
					slug: skill.slug,
					name: skill.name,
					description: skill.description,
					source: skill.source ?? null,
					sourceDir: skill.sourceDir ?? null,
					path: skill.path ?? null,
					enabled: skill.enabled ?? null,
				}));
				return json({
					available: true,
					count: skills.length,
					stats: service.getCatalogStats?.() ?? null,
					skills,
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/activity/plugins/rebuild") {
				const result = await this.runtime.rebuild();
				return json({ ok: !!result, provider: result?.provider ?? null });
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Activity autonomy ---
			if (req.method === "GET" && path === "/api/activity/autonomy") {
				return json(await this.activity.autonomy.snapshot());
			}
			if (req.method === "POST" && path === "/api/activity/autonomy/x") {
				const parsed = parseXAutonomyUpdate(await req.json());
				if (!parsed.ok) return error(parsed.error, 400);
				const v = await this.vault.vault();
				for (const [key, value] of xAutonomyRuntimeSettings(parsed.update)) {
					await v.set(key, value);
				}
				const applied = await this.activity.autonomy.applyXSettings(
					parsed.update,
				);
				pensieveAudit({
					action: "autonomy.x.configure",
					success: applied,
					caller: "ui-activity",
					ts: Date.now(),
				});
				return json(await this.activity.autonomy.snapshot());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/activity/autonomy/enable") {
				const success = await this.activity.autonomy.setEnabled(true);
				pensieveAudit({
					action: "autonomy.enable",
					success,
					caller: "ui-activity",
					ts: Date.now(),
				});
				return success ? ok() : error("autonomy service not available", 400);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/activity/autonomy/disable") {
				const success = await this.activity.autonomy.setEnabled(false);
				pensieveAudit({
					action: "autonomy.disable",
					success,
					caller: "ui-activity",
					ts: Date.now(),
				});
				return success ? ok() : error("autonomy service not available", 400);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "POST" && path === "/api/activity/autonomy/interval") {
				const body = (await req.json()) as { intervalMs: number };
				const success = await this.activity.autonomy.setIntervalMs(
					body.intervalMs,
				);
				pensieveAudit({
					action: "autonomy.interval",
					target: String(body.intervalMs),
					success,
					caller: "ui-activity",
					ts: Date.now(),
				});
				return success ? ok() : error("could not set interval", 400);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- Activity tasks (heartbeat / cron / autonomous) ---
			if (req.method === "GET" && path === "/api/activity/tasks") {
				return json(await this.activity.tasks.snapshot());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const taskAction = path.match(
				/^\/api\/activity\/tasks\/([^/]+)\/(run|pause|resume)$/,
			);
			if (req.method === "POST" && taskAction) {
				const id = decodeURIComponent(taskAction[1] ?? "");
				const action = taskAction[2] ?? "";
				let success = false;
				let errMsg: string | undefined;
				try {
					if (action === "run") success = await this.activity.tasks.runNow(id);
					else if (action === "pause")
						success = await this.activity.tasks.pause(id, true);
					else if (action === "resume")
						success = await this.activity.tasks.pause(id, false);
				} catch (err) {
					errMsg = err instanceof Error ? err.message : String(err);
				}
				pensieveAudit({
					action: `task.${action}` as "task.run" | "task.pause" | "task.resume",
					target: id,
					success,
					...(errMsg ? { error: errMsg } : {}),
					caller: "ui-activity",
					ts: Date.now(),
				});
				return success ? ok() : error(errMsg ?? `${action} failed`, 400);
			}
			return null;
		},
		async (ctx) => {
			const { req, path } = ctx;
			const taskDelete = path.match(/^\/api\/activity\/tasks\/([^/]+)$/);
			if (req.method === "DELETE" && taskDelete) {
				return this.deleteActivityTask(ctx, taskDelete[1] ?? "");
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json } = ctx;
			if (req.method === "GET" && path === "/api/pensieve/graph") {
				return json(
					await this.pensieve.graph.snapshot(pensieveGraphFilter(url)),
				);
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			// --- auth: account providers + OAuth flows ---
			if (req.method === "GET" && path === "/api/auth/providers") {
				return json({
					subscription: ["anthropic-subscription", "openai-codex"],
					direct: Object.keys(PROVIDER_ENV),
					all: ALL_PROVIDER_IDS,
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			if (req.method === "GET" && path === "/api/auth/accounts") {
				return json(this.auth.listAllAccounts());
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const accountList = path.match(/^\/api\/auth\/accounts\/([^/]+)$/);
			if (req.method === "GET" && accountList) {
				const provider = decodeURIComponent(
					accountList[1] ?? "",
				) as AccountCredentialProvider;
				return json(this.auth.listAccounts(provider));
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const accountDelete = path.match(
				/^\/api\/auth\/accounts\/([^/]+)\/(.+)$/,
			);
			if (req.method === "DELETE" && accountDelete) {
				const provider = decodeURIComponent(
					accountDelete[1] ?? "",
				) as AccountCredentialProvider;
				const accountId = decodeURIComponent(accountDelete[2] ?? "");
				this.auth.deleteAccount(provider, accountId);
				await this.runtime.rebuild().catch(() => {});
				this.broadcast({
					kind: "provider:changed",
					activeProvider: this.runtime.getCurrentProvider(),
				});
				return ok();
			}
			if (req.method === "POST" && path === "/api/auth/flows") {
				const body = (await req.json()) as {
					provider: "anthropic-subscription" | "openai-codex";
					label: string;
					accountId?: string;
				};
				const handle = await this.auth.startFlow(body.provider, {
					label: body.label,
					accountId: body.accountId,
				});
				// Subscribe and broadcast WS updates. On success, rebuild the
				// runtime so the chat picks up the freshly-stored OAuth account.
				this.auth.subscribeFlow(handle.sessionId, (state) => {
					this.broadcast({
						kind: "auth:flow-update",
						sessionId: handle.sessionId,
						state,
					});
					if (state.status === "success") {
						this.runtime
							.rebuild()
							.then(() => {
								this.broadcast({
									kind: "provider:changed",
									activeProvider: this.runtime.getCurrentProvider(),
								});
							})
							.catch((err) =>
								console.error(
									"[runtime] rebuild after OAuth success failed:",
									err,
								),
							);
					}
				});
				// Don't await completion — return immediately so the UI can display authUrl
				handle.completion.catch(() => {
					// errors are surfaced via subscribeFlow
				});
				return json({
					sessionId: handle.sessionId,
					authUrl: handle.authUrl,
					needsCodeSubmission: handle.needsCodeSubmission,
				});
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const flowState = path.match(/^\/api\/auth\/flows\/([^/]+)$/);
			if (req.method === "GET" && flowState) {
				const sessionId = decodeURIComponent(flowState[1] ?? "");
				const state = this.auth.getFlowState(sessionId);
				if (!state) return error("flow not found", 404);
				return json(state);
			}
			if (req.method === "DELETE" && flowState) {
				const sessionId = decodeURIComponent(flowState[1] ?? "");
				this.auth.cancelFlow(sessionId, "user-cancelled");
				return ok();
			}
			return null;
		},
		async (ctx) => {
			const { req, url, path, json, ok, error } = ctx;
			const flowSubmit = path.match(/^\/api\/auth\/flows\/([^/]+)\/code$/);
			if (req.method === "POST" && flowSubmit) {
				const sessionId = decodeURIComponent(flowSubmit[1] ?? "");
				const body = (await req.json()) as { code: string };
				const ok2 = this.auth.submitFlowCode(sessionId, body.code);
				return json({ ok: ok2 });
			}
			return null;
		},
	];

	private async handleHttpRequest(
		req: Request,
		server: Server<WsData>,
		responses: ApiResponseHelpers,
	): Promise<Response | undefined> {
		const url = new URL(req.url);
		const path = url.pathname;

		if (req.method === "OPTIONS") return publicOptions();

		if (path === "/ws") {
			const id = crypto.randomUUID();
			if (server.upgrade(req, { data: { id, kind: "app" } })) return;
			return responses.error("upgrade failed", 426);
		}
		const agentStream = path.match(
			/^\/api\/activity\/workspace-agents\/([^/]+)\/stream$/,
		);
		if (agentStream) {
			const agentId = decodeURIComponent(agentStream[1] ?? "");
			if (!readWorkspaceAgents().some((agent) => agent.id === agentId)) {
				return responses.error("workspace agent not found", 404);
			}
			const rawOffset = Number(url.searchParams.get("offset") ?? 0);
			const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
			const id = crypto.randomUUID();
			if (server.upgrade(req, {
				data: { id, kind: "agent-log", agentId, offset },
			})) return;
			return responses.error("upgrade failed", 426);
		}

		const ctx: ApiRequestContext = { req, url, path, ...responses };
		try {
			for (const handler of this.routeHandlers) {
				const response = await handler(ctx);
				if (response) return response;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return responses.error(msg, 500);
		}

		return responses.error("not found", 404);
	}

	stop(): void {
		this.removeBrowserControlGlobal();
		this.removeLockfile();
		this.server?.stop(true);
		this.server = null;
		for (const timer of this.agentStreamTimers.values()) clearInterval(timer);
		this.agentStreamTimers.clear();
		for (const ws of this.subscribers.values()) ws.close();
		this.subscribers.clear();
		for (const [id, waiter] of this.browserWaiters.entries()) {
			clearTimeout(waiter.timer);
			waiter.resolve({
				ok: false,
				error: `Browser command ${id} canceled because API server stopped.`,
				time: Date.now(),
			});
		}
		this.browserWaiters.clear();
	}

	listen(handler: Listener): () => void {
		// Local listener for in-process use (e.g. tray window).
		const wrapper = (msg: WsServerMessage) => handler(msg);
		this.localListeners.add(wrapper);
		return () => this.localListeners.delete(wrapper);
	}

	private localListeners = new Set<Listener>();

	private send(ws: ServerWebSocket<WsData>, msg: WsServerMessage) {
		ws.send(JSON.stringify(msg));
	}

	private openAgentLogStream(ws: ServerWebSocket<WsData>): void {
		if (ws.data.kind !== "agent-log") return;
		const agentId = ws.data.agentId;
		let offset = ws.data.offset;
		const sendNext = () => {
			const agent = readWorkspaceAgents().find((item) => item.id === agentId);
			if (!agent) {
				ws.close();
				return;
			}
			const logPath = safeWorkspaceAgentLogPath(agent);
			if (!logPath || !existsSync(logPath)) return;
			const data = readFileSync(logPath);
			const start = Math.min(offset, data.byteLength);
			const available = data.byteLength - start;
			if (available <= 0) return;
			const take = Math.min(available, MAX_WORKSPACE_AGENT_LOG_CHARS);
			ws.send(data.subarray(start, start + take).toString("utf8"));
			offset = start + take;
		};
		sendNext();
		this.agentStreamTimers.set(ws.data.id, setInterval(sendNext, 1000));
	}

	private closeAgentLogStream(id: string): void {
		const timer = this.agentStreamTimers.get(id);
		if (timer) clearInterval(timer);
		this.agentStreamTimers.delete(id);
	}

	/** Public broadcast — used by features outside the API server (e.g. tray to push `ui:open-settings`). */
	publish(msg: WsServerMessage): void {
		this.broadcast(msg);
	}

	private broadcast(msg: WsServerMessage) {
		const payload = JSON.stringify(msg);
		for (const ws of this.subscribers.values()) ws.send(payload);
		for (const fn of this.localListeners) fn(msg);
	}

	private writeLockfile() {
		try {
			mkdirSync(join(homedir(), ".detour"), { recursive: true });
			writeFileSync(
				this.lockFile,
				JSON.stringify({
					port: this.port,
					pid: process.pid,
					startedAt: new Date().toISOString(),
				}),
			);
		} catch (err) {
			console.error("Failed to write runtime lockfile:", err);
		}
	}

	private removeLockfile() {
		try {
			if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
		} catch {
			// best effort
		}
	}
}

/**
 * Pre-flight check that a channel credential is actually valid before we
 * commit it to vault. Each channel hits its authoritative `/me`-style
 * endpoint with the supplied token; a non-2xx response means we reject
 * the save and tell the user exactly what's wrong, instead of silently
 * storing a dead token and letting the plugin fail at next runtime build.
 *
 * Returns `{ok: true}` on successful validation OR if we don't know how
 * to validate the key (not a token we recognize). Returns `{ok: false,
 * error: "..."}` only when validation actively failed (auth rejection,
 * network reachable but bad token).
 */
type CredentialValidationResult =
	| { ok: true; info?: string }
	| { ok: false; error: string };
type CredentialValidator = (
	key: string,
	trimmed: string,
) => Promise<CredentialValidationResult>;

const CREDENTIAL_VALIDATION_TIMEOUT_MS = 5000;
const CREDENTIAL_VALIDATORS: Record<string, CredentialValidator> = {
	DISCORD_API_TOKEN: (_key, trimmed) => validateDiscordCredential(trimmed),
	DISCORD_BOT_TOKEN: (_key, trimmed) => validateDiscordCredential(trimmed),
	TELEGRAM_BOT_TOKEN: (_key, trimmed) => validateTelegramCredential(trimmed),
	GITHUB_TOKEN: (_key, trimmed) => validateGitHubCredential(trimmed),
	GITHUB_USER_PAT: (_key, trimmed) => validateGitHubCredential(trimmed),
	GITHUB_AGENT_PAT: (_key, trimmed) => validateGitHubCredential(trimmed),
	OPENAI_EMBEDDING_API_KEY: (_key, trimmed) =>
		validateOpenAICredential(trimmed),
	OPENAI_API_KEY: (_key, trimmed) => validateOpenAICredential(trimmed),
	X_AUTH_TOKEN: validateXCredential,
	X_CT0: validateXCredential,
};

async function fetchCredentialValidation(
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), CREDENTIAL_VALIDATION_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: ctl.signal });
	} finally {
		clearTimeout(t);
	}
}

async function validateChannelCredential(
	key: string,
	value: string,
): Promise<CredentialValidationResult> {
	const trimmed = value.trim();
	if (trimmed.length === 0) return { ok: false, error: `${key} is empty` };
	const validate = CREDENTIAL_VALIDATORS[key];
	return validate ? validate(key, trimmed) : { ok: true };
}

async function validateDiscordCredential(
	trimmed: string,
): Promise<CredentialValidationResult> {
	try {
		const res = await fetchCredentialValidation(
			"https://discord.com/api/v10/users/@me",
			{
				headers: { Authorization: `Bot ${trimmed}` },
			},
		);
		if (res.status === 401)
			return {
				ok: false,
				error:
					"Discord rejected the token (401 Unauthorized) — regenerate it in Developer Portal → Bot → Reset Token.",
			};
		if (res.status === 403)
			return {
				ok: false,
				error:
					"Discord rejected the token (403 Forbidden) — bot lacks required permissions.",
			};
		if (!res.ok)
			return {
				ok: false,
				error: `Discord token check failed: HTTP ${res.status}`,
			};
		const body = (await res.json()) as { username?: string; id?: string };
		if (!body.id || !body.username)
			return {
				ok: false,
				error: "Discord responded but token didn't return a bot user",
			};
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Could not reach Discord to validate token: ${msg}`,
		};
	}
}

async function validateTelegramCredential(
	trimmed: string,
): Promise<CredentialValidationResult> {
	try {
		const res = await fetchCredentialValidation(
			`https://api.telegram.org/bot${encodeURIComponent(trimmed)}/getMe`,
		);
		const body = (await res.json()) as {
			ok?: boolean;
			description?: string;
			result?: { username?: string };
		};
		if (!body.ok)
			return {
				ok: false,
				error: `Telegram rejected the token: ${body.description ?? "unknown error"}`,
			};
		if (!body.result?.username)
			return {
				ok: false,
				error: "Telegram responded but didn't return bot info",
			};
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Could not reach Telegram to validate token: ${msg}`,
		};
	}
}

async function validateGitHubCredential(
	trimmed: string,
): Promise<CredentialValidationResult> {
	try {
		const res = await fetchCredentialValidation("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${trimmed}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (res.status === 401)
			return {
				ok: false,
				error: "GitHub rejected the token (401 Unauthorized).",
			};
		if (res.status === 403)
			return {
				ok: false,
				error: "GitHub rejected the token (403 Forbidden or rate limited).",
			};
		if (!res.ok)
			return {
				ok: false,
				error: `GitHub token check failed: HTTP ${res.status}`,
			};
		const body = (await res.json()) as { login?: string };
		return {
			ok: true,
			...(body.login ? { info: `signed in as @${body.login}` } : {}),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Could not reach GitHub to validate token: ${msg}`,
		};
	}
}

async function validateOpenAICredential(
	trimmed: string,
): Promise<CredentialValidationResult> {
	try {
		const res = await fetchCredentialValidation(
			"https://api.openai.com/v1/models",
			{
				headers: { Authorization: `Bearer ${trimmed}` },
			},
		);
		if (res.status === 401)
			return {
				ok: false,
				error: "OpenAI rejected the API key (401 Unauthorized).",
			};
		if (!res.ok)
			return {
				ok: false,
				error: `OpenAI key check failed: HTTP ${res.status}`,
			};
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Could not reach OpenAI to validate key: ${msg}`,
		};
	}
}

async function validateXCredential(
	key: string,
	trimmed: string,
): Promise<CredentialValidationResult> {
	const otherKey = key === "X_AUTH_TOKEN" ? "X_CT0" : "X_AUTH_TOKEN";
	const otherValue = process.env[otherKey];
	if (!otherValue) return { ok: true };
	const authToken = key === "X_AUTH_TOKEN" ? trimmed : otherValue;
	const ct0 = key === "X_CT0" ? trimmed : otherValue;
	try {
		const { XClient } = await import("@detour/plugin-x-tweets");
		const client = new XClient({ cookies: { authToken, ct0 } });
		const viewer = await client.viewer();
		return { ok: true, info: `signed in as @${viewer.screenName}` };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
			return {
				ok: false,
				error:
					"X rejected the cookies (auth_token + ct0). Re-export both from x.com via Cookie-Editor and try again.",
			};
		}
		return {
			ok: false,
			error: `Could not reach X to validate cookies: ${msg}`,
		};
	}
}

/**
 * Read a 1Password item via `op item get` and pull metadata that matters
 * even when the password field is missing (passkeys, SSO, identity items).
 * Used as the fallback when eliza's `revealSavedLogin` throws "no password field".
 */
async function readOnePasswordItemMetadata(externalId: string): Promise<{
	username: string | null;
	domain: string | null;
	totp: string | null;
	note: string;
}> {
	const out = await new Promise<{
		stdout: string;
		stderr: string;
		code: number;
	}>((resolve) => {
		const child = spawn("op", ["item", "get", externalId, "--format=json"], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
	});
	if (out.code !== 0) {
		return {
			username: null,
			domain: null,
			totp: null,
			note: `op item get failed: ${out.stderr.trim() || "unknown error"}`,
		};
	}
	try {
		const item = JSON.parse(out.stdout) as {
			category?: string;
			urls?: Array<{ href?: string; primary?: boolean }>;
			fields?: Array<{
				id?: string;
				label?: string;
				purpose?: string;
				value?: string;
				type?: string;
			}>;
		};
		const username =
			item.fields?.find(
				(f) => f.purpose === "USERNAME" && typeof f.value === "string",
			)?.value ??
			item.fields?.find((f) => f.label?.toLowerCase() === "username")?.value ??
			null;
		const totp =
			item.fields?.find((f) => f.type?.toUpperCase() === "OTP")?.value ??
			item.fields?.find((f) => f.label?.toLowerCase().includes("one-time"))
				?.value ??
			null;
		const url =
			item.urls?.find((u) => u.primary)?.href ?? item.urls?.[0]?.href ?? null;
		const domain = url
			? (() => {
					try {
						return new URL(url.includes("://") ? url : `https://${url}`)
							.hostname;
					} catch {
						return null;
					}
				})()
			: null;
		const noteParts: string[] = [];
		noteParts.push(`Item type: ${item.category ?? "unknown"}.`);
		const hasPasskey = item.fields?.some(
			(f) => f.type?.toUpperCase() === "PASSKEY",
		);
		if (hasPasskey)
			noteParts.push(
				"This is a passkey — passwordless. Use the 1Password app to sign in.",
			);
		else
			noteParts.push(
				"This item has no password field (likely SSO / social-login).",
			);
		return { username, domain, totp, note: noteParts.join(" ") };
	} catch (err) {
		return {
			username: null,
			domain: null,
			totp: null,
			note: `Could not parse op item: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
