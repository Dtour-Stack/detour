import type {
	ActivityAutonomySnapshot,
	ActivityDbQueryResult,
	ActivityDbTable,
	ActivityDbTableDetail,
	ActivityLogEntry,
	ActivityPluginsSnapshot,
	ActivityRuntimeSnapshot,
	ActivityTasksSnapshot,
	ActivityTrajectoryDetail,
	ActivityTrajectoryExport,
	ActivityTrajectoryListResult,
	ActivityXAutonomyUpdate,
	AgentCharacterConfig,
	AgentConfig,
	BackendStatus,
	BrowserCommand,
	BrowserCommandInput,
	BrowserCommandResult,
	ChannelsSnapshot,
	ChroniclerConfig,
	ChroniclerObservation,
	ChroniclerStatus,
	ModelConfig,
	OpDiagnostic,
	OpenRouterModelsResponse,
	OsPermissionId,
	OsPermissionInfo,
	PensieveEmbeddingMap,
	PensieveEntitySummary,
	PensieveGraphSnapshot,
	PensieveMemoryDetail,
	PensieveMemorySummary,
	PensieveMemoryTree,
	PensievePersonDetail,
	PensievePromptVariable,
	PensieveRelationshipSummary,
	PensieveTemplateDetail,
	PensieveTemplateRenderResult,
	PensieveTemplateSummary,
	ProviderId,
	ProviderInfo,
	SigninResult,
	UiPreferences,
	WindowConfig,
	WorkspaceAgentLog,
	WorkspaceAgentsSnapshot,
	WorkspaceProjectFile,
	WorkspaceProjectFilesSnapshot,
	WorkspaceProjectsSnapshot,
	WsClientMessage,
	WsServerMessage,
} from "@detour/shared";

type Listener = (msg: WsServerMessage) => void;
type DetourFetchInit = RequestInit & { targetAddressSpace?: "local" };

export type DiscordCatchUpResult = {
	channelsScanned: number;
	messagesScanned: number;
	addressed: number;
	alreadyAnswered: number;
	replied: number;
	errors: number;
	errorDetails?: Array<{
		channelId: string;
		channelName?: string;
		error: string;
	}>;
};

function isLoopbackBase(base: string): boolean {
	if (!base) return false;
	try {
		const url = new URL(base, window.location.href);
		return (
			url.protocol === "http:" &&
			(url.hostname === "127.0.0.1" ||
				url.hostname === "localhost" ||
				url.hostname === "::1")
		);
	} catch {
		return false;
	}
}

export class WebClient {
	private ws: WebSocket | null = null;
	private listeners = new Set<Listener>();
	private outbox: WsClientMessage[] = [];

	constructor(private readonly base = "") {}

	private fetchInit(init: RequestInit): DetourFetchInit {
		return isLoopbackBase(this.base)
			? { ...init, targetAddressSpace: "local" }
			: init;
	}

	async connect(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = this.base
				? `${this.base.replace(/^http/, "ws")}/ws`
				: `${wsProto}//${location.host}/ws`;
			const ws = new WebSocket(wsUrl);
			ws.onopen = () => {
				this.ws = ws;
				for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
				installWebviewLogForwarder(this);
				resolve();
			};
			ws.onerror = reject;
			ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(ev.data) as WsServerMessage;
					for (const fn of this.listeners) fn(msg);
				} catch {
					// ignore
				}
			};
			ws.onclose = () => {
				this.ws = null;
				setTimeout(() => this.connect().catch(() => {}), 1000);
			};
		});
	}

	on(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	send(msg: WsClientMessage): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		} else {
			this.outbox.push(msg);
		}
	}

	listProviders(): Promise<ProviderInfo[]> {
		return this.json("GET", "/api/providers");
	}

	async setProviderKey(id: ProviderId, key: string): Promise<void> {
		await this.json("PUT", `/api/providers/${id}/key`, { key });
	}

	async removeProviderKey(id: ProviderId): Promise<void> {
		await this.json("DELETE", `/api/providers/${id}/key`);
	}

	async setActiveProvider(id: ProviderId): Promise<void> {
		await this.json("PUT", "/api/providers/active", { id });
	}

	listOpenRouterModels(): Promise<OpenRouterModelsResponse> {
		return this.json("GET", "/api/providers/openrouter/models");
	}

	detectBackends(): Promise<BackendStatus[]> {
		return this.json("GET", "/api/backends");
	}

	async getEnabledBackends(): Promise<string[]> {
		const res = await this.json<{ enabled: string[] }>(
			"GET",
			"/api/backends/enabled",
		);
		return res.enabled;
	}

	async setEnabledBackends(enabled: string[]): Promise<void> {
		await this.json("PUT", "/api/backends/enabled", { enabled });
	}

	// --- generic vault ---
	listVaultInventory(): Promise<any[]> {
		return this.json("GET", "/api/vault/inventory");
	}
	vaultStats(): Promise<{
		total: number;
		sensitive: number;
		nonSensitive: number;
		references: number;
	}> {
		return this.json("GET", "/api/vault/stats");
	}
	getVaultKey(
		key: string,
		reveal = false,
	): Promise<{ key: string; descriptor: any; value?: string }> {
		return this.json(
			"GET",
			`/api/vault/keys/${encodeURIComponent(key)}${reveal ? "?reveal=1" : ""}`,
		);
	}
	async setVaultKey(
		key: string,
		value: string,
		sensitive = true,
	): Promise<void> {
		await this.json("PUT", `/api/vault/keys/${encodeURIComponent(key)}`, {
			value,
			sensitive,
		});
	}
	async removeVaultKey(key: string): Promise<void> {
		await this.json("DELETE", `/api/vault/keys/${encodeURIComponent(key)}`);
	}

	// --- saved logins ---
	listSavedLogins(): Promise<{
		logins: any[];
		failures: { source: string; message: string }[];
	}> {
		return this.json("GET", "/api/saved-logins");
	}
	revealSavedLogin(source: string, identifier: string): Promise<any> {
		return this.json(
			"GET",
			`/api/saved-logins/${encodeURIComponent(source)}/${encodeURIComponent(identifier)}`,
		);
	}

	// --- install helpers ---
	getBackendInstall(): Promise<{
		platform: string;
		packageManagers: any;
		specs: any[];
	}> {
		return this.json("GET", "/api/backends/install");
	}

	// --- backend diagnose / signin / signout ---
	diagnoseOnePassword(): Promise<OpDiagnostic> {
		return this.json("GET", "/api/backends/1password/diagnose");
	}
	signInBackend(
		id: "1password" | "bitwarden",
		body: {
			email?: string;
			masterPassword: string;
			secretKey?: string;
			signInAddress?: string;
			bitwardenClientId?: string;
			bitwardenClientSecret?: string;
		},
	): Promise<SigninResult> {
		return this.json("POST", `/api/backends/${id}/signin`, body);
	}
	async signOutBackend(id: "1password" | "bitwarden"): Promise<void> {
		await this.json("POST", `/api/backends/${id}/signout`);
	}

	// --- ui preferences ---
	getUiPreferences(): Promise<UiPreferences> {
		return this.json("GET", "/api/ui/preferences");
	}
	async setUiPreferences(prefs: Partial<UiPreferences>): Promise<void> {
		await this.json("PUT", "/api/ui/preferences", prefs);
	}

	// --- app config (agent perms, models, window) ---
	getAgentConfig(): Promise<AgentConfig> {
		return this.json("GET", "/api/config/agent");
	}
	async setAgentConfig(cfg: AgentConfig): Promise<void> {
		await this.json("PUT", "/api/config/agent", cfg);
	}
	getAgentCharacter(): Promise<AgentCharacterConfig> {
		return this.json("GET", "/api/config/character");
	}
	async setAgentCharacter(cfg: AgentCharacterConfig): Promise<void> {
		await this.json("PUT", "/api/config/character", cfg);
	}
	getModelConfig(): Promise<ModelConfig> {
		return this.json("GET", "/api/config/models");
	}
	async setModelConfig(cfg: ModelConfig): Promise<void> {
		await this.json("PUT", "/api/config/models", cfg);
	}
	getWindowConfig(): Promise<WindowConfig> {
		return this.json("GET", "/api/config/window");
	}
	async setWindowConfig(cfg: WindowConfig): Promise<void> {
		await this.json("PUT", "/api/config/window", cfg);
	}

	// --- OS permissions (macOS TCC) ---
	listOsPermissions(): Promise<OsPermissionInfo[]> {
		return this.json("GET", "/api/os/permissions");
	}
	async openOsPermissionPane(id: OsPermissionId): Promise<void> {
		await this.json(
			"POST",
			`/api/os/permissions/${encodeURIComponent(id)}/open`,
		);
	}

	// --- Activity (operational: logs, runtime introspection, trajectories, tasks) ---
	activityLogs(
		params: {
			level?: string;
			source?: string;
			q?: string;
			limit?: number;
			since?: number;
		} = {},
	): Promise<ActivityLogEntry[]> {
		const qs = new URLSearchParams();
		if (params.level) qs.set("level", params.level);
		if (params.source) qs.set("source", params.source);
		if (params.q) qs.set("q", params.q);
		if (params.limit) qs.set("limit", String(params.limit));
		if (params.since) qs.set("since", String(params.since));
		const s = qs.toString();
		return this.json("GET", `/api/activity/logs${s ? `?${s}` : ""}`);
	}
	activityRuntime(): Promise<ActivityRuntimeSnapshot> {
		return this.json("GET", "/api/activity/runtime");
	}
	activityWorkspaceAgents(): Promise<WorkspaceAgentsSnapshot> {
		return this.json("GET", "/api/activity/workspace-agents");
	}
	activityWorkspaceProjects(): Promise<WorkspaceProjectsSnapshot> {
		return this.json("GET", "/api/activity/workspace-projects");
	}
	activityWorkspaceProjectFiles(
		projectId: string,
		path = "",
	): Promise<WorkspaceProjectFilesSnapshot> {
		const qs = new URLSearchParams();
		if (path) qs.set("path", path);
		const query = qs.toString();
		return this.json(
			"GET",
			`/api/activity/workspace-projects/${encodeURIComponent(projectId)}/files${query ? `?${query}` : ""}`,
		);
	}
	activityWorkspaceProjectFile(
		projectId: string,
		path: string,
	): Promise<WorkspaceProjectFile> {
		const qs = new URLSearchParams({ path });
		return this.json(
			"GET",
			`/api/activity/workspace-projects/${encodeURIComponent(projectId)}/file?${qs}`,
		);
	}
	activityWorkspaceAgentLog(id: string, offset = 0): Promise<WorkspaceAgentLog> {
		return this.json(
			"GET",
			`/api/activity/workspace-agents/${encodeURIComponent(id)}/log?offset=${offset}`,
		);
	}
	activityTrajectories(
		params: {
			limit?: number;
			offset?: number;
			status?: string;
			source?: string;
			q?: string;
		} = {},
	): Promise<ActivityTrajectoryListResult> {
		const qs = new URLSearchParams();
		if (params.limit) qs.set("limit", String(params.limit));
		if (params.offset) qs.set("offset", String(params.offset));
		if (params.status) qs.set("status", params.status);
		if (params.source) qs.set("source", params.source);
		if (params.q) qs.set("q", params.q);
		const s = qs.toString();
		return this.json("GET", `/api/activity/trajectories${s ? `?${s}` : ""}`);
	}
	activityTrajectory(id: string): Promise<ActivityTrajectoryDetail> {
		return this.json(
			"GET",
			`/api/activity/trajectories/${encodeURIComponent(id)}`,
		);
	}
	activityExportTrajectories(
		ids?: string[],
	): Promise<ActivityTrajectoryExport> {
		return this.json(
			"POST",
			"/api/activity/trajectories/export",
			ids?.length ? { ids } : {},
		);
	}
	async activityExportTrajectoriesZip(
		ids?: string[],
	): Promise<{ blob: Blob; filename: string }> {
		const path = "/api/activity/trajectories/export.zip";
		const res = await fetch(`${this.base}${path}`, this.fetchInit({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(ids?.length ? { ids } : {}),
		}));
		if (!res.ok) {
			const err = await res.text().catch(() => res.statusText);
			throw new Error(`API POST ${path}: ${err}`);
		}
		const disposition = res.headers.get("content-disposition") ?? "";
		const filename =
			disposition.match(/filename="([^"]+)"/)?.[1] ??
			`detour-trajectories-${Date.now()}.zip`;
		return { blob: await res.blob(), filename };
	}
	activityTasks(): Promise<ActivityTasksSnapshot> {
		return this.json("GET", "/api/activity/tasks");
	}
	activityAutonomy(): Promise<ActivityAutonomySnapshot> {
		return this.json("GET", "/api/activity/autonomy");
	}
	activitySetXAutonomy(
		update: ActivityXAutonomyUpdate,
	): Promise<ActivityAutonomySnapshot> {
		return this.json("POST", "/api/activity/autonomy/x", update);
	}
	activityPlugins(): Promise<ActivityPluginsSnapshot> {
		return this.json("GET", "/api/activity/plugins");
	}
	activityDbTables(): Promise<{
		available: boolean;
		tables: ActivityDbTable[];
	}> {
		return this.json("GET", "/api/activity/db/tables");
	}
	activityDbTable(
		schema: string,
		name: string,
	): Promise<ActivityDbTableDetail> {
		return this.json(
			"GET",
			`/api/activity/db/tables/${encodeURIComponent(schema)}/${encodeURIComponent(name)}`,
		);
	}
	async activityDbQuery(sqlText: string): Promise<ActivityDbQueryResult> {
		return this.json("POST", "/api/activity/db/query", { sql: sqlText });
	}
	async activityRebuildRuntime(): Promise<{
		ok: boolean;
		provider: string | null;
	}> {
		return this.json("POST", "/api/activity/plugins/rebuild");
	}

	// --- Channels ---
	channelsList(): Promise<ChannelsSnapshot> {
		return this.json("GET", "/api/channels");
	}
	async channelSetCredential(key: string, value: string): Promise<void> {
		await this.json("POST", "/api/channels/credentials", { key, value });
	}
	async channelClearCredential(key: string): Promise<void> {
		await this.json(
			"DELETE",
			`/api/channels/credentials/${encodeURIComponent(key)}`,
		);
	}
	async channelsReload(): Promise<{ ok: boolean; provider: string | null }> {
		return this.json("POST", "/api/channels/reload");
	}
	// --- owner-bind (eliza /eliza_pair flow) ---
	async ownerBindGenerateCode(connector: "telegram" | "discord"): Promise<{
		ok: boolean;
		code: string;
		expiresAt: number;
		connector: string;
	}> {
		return this.json("POST", "/api/owner-bind/code", { connector });
	}
	async ownerBindStatus(connector: "telegram" | "discord"): Promise<{
		connector: string;
		bound: boolean;
		owner: { externalId: string; displayHandle: string } | null;
	}> {
		return this.json("GET", `/api/owner-bind/${connector}`);
	}
	async ownerBindUnbind(connector: "telegram" | "discord"): Promise<void> {
		await this.json("DELETE", `/api/owner-bind/${connector}`);
	}
	async discordGuilds(): Promise<{
		guilds: Array<{
			id: string;
			name: string;
			channels: Array<{ id: string; name: string; type: number }>;
		}>;
	}> {
		return this.json("GET", "/api/channels/discord/guilds");
	}
	async discordBackfill(
		channelId: string,
		limit = 200,
		force = false,
	): Promise<{ ok: boolean; scheduled: boolean; channelId: string }> {
		return this.json("POST", "/api/channels/discord/backfill", {
			channelId,
			limit,
			force,
		});
	}
	async discordCatchUp(
		channelId: string,
		limit = 100,
		maxAgeHours = 24,
	): Promise<{
		ok: boolean;
		scheduled: boolean;
		channelId?: string;
		result?: DiscordCatchUpResult;
	}> {
		return this.json("POST", "/api/channels/discord/catch-up", {
			channelId,
			limit,
			maxAgeHours,
			wait: true,
		});
	}
	async activitySetAutonomy(enabled: boolean): Promise<void> {
		await this.json(
			"POST",
			`/api/activity/autonomy/${enabled ? "enable" : "disable"}`,
		);
	}
	async activitySetAutonomyInterval(intervalMs: number): Promise<void> {
		await this.json("POST", "/api/activity/autonomy/interval", { intervalMs });
	}
	async activityRunTask(id: string): Promise<void> {
		await this.json(
			"POST",
			`/api/activity/tasks/${encodeURIComponent(id)}/run`,
		);
	}
	async activityPauseTask(id: string): Promise<void> {
		await this.json(
			"POST",
			`/api/activity/tasks/${encodeURIComponent(id)}/pause`,
		);
	}
	async activityResumeTask(id: string): Promise<void> {
		await this.json(
			"POST",
			`/api/activity/tasks/${encodeURIComponent(id)}/resume`,
		);
	}
	async activityDeleteTask(id: string): Promise<void> {
		await this.json("DELETE", `/api/activity/tasks/${encodeURIComponent(id)}`);
	}

	// --- Pensieve (knowledge: memories, relationships, graph, templates) ---
	pensieveTemplates(): Promise<PensieveTemplateSummary[]> {
		return this.json("GET", "/api/pensieve/templates");
	}
	pensieveTemplate(id: string): Promise<PensieveTemplateDetail> {
		return this.json(
			"GET",
			`/api/pensieve/templates/${encodeURIComponent(id)}`,
		);
	}
	async pensieveCreateTemplate(input: {
		name: string;
		body: string;
		tags?: string[];
	}): Promise<{ id: string }> {
		return this.json("POST", "/api/pensieve/templates", input);
	}
	async pensieveUpdateTemplate(
		id: string,
		patch: { body?: string; tags?: string[]; path?: string },
	): Promise<void> {
		await this.json(
			"PATCH",
			`/api/pensieve/templates/${encodeURIComponent(id)}`,
			patch,
		);
	}
	async pensieveDeleteTemplate(id: string): Promise<void> {
		await this.json(
			"DELETE",
			`/api/pensieve/templates/${encodeURIComponent(id)}`,
		);
	}
	pensieveRenderTemplate(
		id: string,
		vars: Record<string, string> = {},
	): Promise<PensieveTemplateRenderResult> {
		return this.json(
			"POST",
			`/api/pensieve/templates/${encodeURIComponent(id)}/render`,
			{ vars },
		);
	}
	pensieveTemplateVars(): Promise<PensievePromptVariable[]> {
		return this.json("GET", "/api/pensieve/template-vars");
	}
	async pensieveSetTemplateVar(name: string, value: string): Promise<void> {
		await this.json(
			"PUT",
			`/api/pensieve/template-vars/${encodeURIComponent(name)}`,
			{ value },
		);
	}
	async pensieveDeleteTemplateVar(name: string): Promise<void> {
		await this.json(
			"DELETE",
			`/api/pensieve/template-vars/${encodeURIComponent(name)}`,
		);
	}
	pensieveMemoryTree(): Promise<PensieveMemoryTree> {
		return this.json("GET", "/api/pensieve/memories/tree");
	}
	pensieveKnowledgeStatus(): Promise<{ available: boolean }> {
		return this.json("GET", "/api/pensieve/knowledge/status");
	}
	pensieveEmbeddingMap(): Promise<PensieveEmbeddingMap> {
		return this.json("GET", "/api/pensieve/embedding-map");
	}
	pensieveChroniclerStatus(): Promise<ChroniclerStatus> {
		return this.json("GET", "/api/pensieve/chronicler/status");
	}
	pensieveChroniclerConfig(): Promise<ChroniclerConfig> {
		return this.json("GET", "/api/pensieve/chronicler/config");
	}
	pensieveSetChroniclerConfig(
		input: Partial<ChroniclerConfig>,
	): Promise<ChroniclerConfig> {
		return this.json("PUT", "/api/pensieve/chronicler/config", input);
	}
	pensieveChroniclerSample(): Promise<ChroniclerObservation> {
		return this.json("POST", "/api/pensieve/chronicler/sample");
	}
	pensieveChroniclerRecent(limit = 20): Promise<ChroniclerObservation[]> {
		return this.json("GET", `/api/pensieve/chronicler/recent?limit=${limit}`);
	}
	async pensieveIngestKnowledge(input: {
		filename: string;
		content: string;
		contentType?: string;
		metadata?: Record<string, unknown>;
	}): Promise<{
		clientDocumentId: string;
		storedDocumentMemoryId: string;
		fragmentCount: number;
	}> {
		return this.json("POST", "/api/pensieve/knowledge/ingest", input);
	}
	async pensieveCreateMemory(input: {
		text: string;
		path?: string;
		type?: string;
		tags?: string[];
		extraMetadata?: Record<string, unknown>;
	}): Promise<{ id: string }> {
		return this.json("POST", "/api/pensieve/memories", input);
	}
	pensieveMemories(
		params: {
			limit?: number;
			type?: string;
			roomId?: string;
			entityId?: string;
			tag?: string;
			q?: string;
			pathPrefix?: string;
		} = {},
	): Promise<PensieveMemorySummary[]> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) {
			if (v != null && v !== "") qs.set(k, String(v));
		}
		const s = qs.toString();
		return this.json("GET", `/api/pensieve/memories${s ? `?${s}` : ""}`);
	}
	pensieveSearchMemories(
		text: string,
		limit = 30,
	): Promise<PensieveMemorySummary[]> {
		return this.json("POST", "/api/pensieve/memories/search", { text, limit });
	}
	pensieveMemory(id: string): Promise<PensieveMemoryDetail> {
		return this.json("GET", `/api/pensieve/memories/${encodeURIComponent(id)}`);
	}
	async pensieveUpdateMemory(
		id: string,
		patch: { contentText?: string; tags?: string[]; path?: string },
	): Promise<void> {
		await this.json(
			"PATCH",
			`/api/pensieve/memories/${encodeURIComponent(id)}`,
			patch,
		);
	}
	async pensieveDeleteMemory(id: string): Promise<void> {
		await this.json(
			"DELETE",
			`/api/pensieve/memories/${encodeURIComponent(id)}`,
		);
	}
	pensievePersons(limit = 100): Promise<PensieveEntitySummary[]> {
		return this.json(
			"GET",
			`/api/pensieve/relationships/persons?limit=${limit}`,
		);
	}
	pensievePerson(id: string): Promise<PensievePersonDetail> {
		return this.json(
			"GET",
			`/api/pensieve/relationships/${encodeURIComponent(id)}`,
		);
	}
	pensieveRelationships(
		params: { entityIds?: string[]; tags?: string[]; limit?: number } = {},
	): Promise<PensieveRelationshipSummary[]> {
		const qs = new URLSearchParams();
		if (params.entityIds?.length)
			qs.set("entityIds", params.entityIds.join(","));
		if (params.tags?.length) qs.set("tags", params.tags.join(","));
		if (params.limit) qs.set("limit", String(params.limit));
		const s = qs.toString();
		return this.json("GET", `/api/pensieve/relationships${s ? `?${s}` : ""}`);
	}
	async pensieveCreateRelationship(rel: {
		sourceEntityId: string;
		targetEntityId: string;
		tags?: string[];
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		await this.json("POST", "/api/pensieve/relationships", rel);
	}
	async pensieveUpdateRelationship(
		source: string,
		target: string,
		patch: { tags?: string[]; metadata?: Record<string, unknown> },
	): Promise<void> {
		await this.json(
			"PATCH",
			`/api/pensieve/relationships/${encodeURIComponent(source)}/${encodeURIComponent(target)}`,
			patch,
		);
	}
	async pensieveDeleteRelationship(
		source: string,
		target: string,
	): Promise<void> {
		await this.json(
			"DELETE",
			`/api/pensieve/relationships/${encodeURIComponent(source)}/${encodeURIComponent(target)}`,
		);
	}
	pensieveGraph(
		filter: {
			dateFrom?: number;
			dateTo?: number;
			entityIds?: string[];
			types?: string[];
			tags?: string[];
		} = {},
	): Promise<PensieveGraphSnapshot> {
		const qs = new URLSearchParams();
		if (filter.dateFrom) qs.set("dateFrom", String(filter.dateFrom));
		if (filter.dateTo) qs.set("dateTo", String(filter.dateTo));
		if (filter.entityIds?.length)
			qs.set("entityIds", filter.entityIds.join(","));
		if (filter.types?.length) qs.set("types", filter.types.join(","));
		if (filter.tags?.length) qs.set("tags", filter.tags.join(","));
		const s = qs.toString();
		return this.json("GET", `/api/pensieve/graph${s ? `?${s}` : ""}`);
	}

	// --- external browser (OAuth flows can't use window.open in a webview) ---
	async openExternal(url: string): Promise<void> {
		await this.json("POST", "/api/external/open", { url });
	}
	browserCommands(
		params: { after?: string; since?: number } = {},
	): Promise<{ commands: BrowserCommand[] }> {
		const qs = new URLSearchParams();
		if (params.after) qs.set("after", params.after);
		if (params.since) qs.set("since", String(params.since));
		const s = qs.toString();
		return this.json("GET", `/api/browser/commands${s ? `?${s}` : ""}`);
	}
	queueBrowserCommand(
		command: BrowserCommandInput,
	): Promise<{ command: BrowserCommand }> {
		return this.json("POST", "/api/browser/commands", command);
	}
	reportBrowserCommandResult(
		commandId: string,
		result: Omit<BrowserCommandResult, "time">,
	): Promise<{ result: BrowserCommandResult }> {
		return this.json(
			"POST",
			`/api/browser/commands/${encodeURIComponent(commandId)}/result`,
			result,
		);
	}

	// --- window control (tray popup) ---
	async hideWindow(): Promise<void> {
		await this.json("POST", "/api/window/hide");
	}
	async pinWindow(on: boolean): Promise<void> {
		await this.json("POST", "/api/window/pin", { on });
	}
	async resizeWindow(width: number, height: number): Promise<void> {
		await this.json("POST", "/api/window/resize", { width, height });
	}

	// --- routing ---
	getRouting(): Promise<{ rules: any[] }> {
		return this.json("GET", "/api/routing");
	}

	// --- auth: account providers ---
	getAuthProviders(): Promise<{
		subscription: string[];
		direct: string[];
		all: string[];
	}> {
		return this.json("GET", "/api/auth/providers");
	}
	listAllAccounts(): Promise<Record<string, any[]>> {
		return this.json("GET", "/api/auth/accounts");
	}
	async deleteAccount(provider: string, accountId: string): Promise<void> {
		await this.json(
			"DELETE",
			`/api/auth/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountId)}`,
		);
	}
	startAuthFlow(
		provider: string,
		label: string,
	): Promise<{
		sessionId: string;
		authUrl: string;
		needsCodeSubmission: boolean;
	}> {
		return this.json("POST", "/api/auth/flows", { provider, label });
	}
	getAuthFlow(sessionId: string): Promise<any> {
		return this.json("GET", `/api/auth/flows/${encodeURIComponent(sessionId)}`);
	}
	async submitFlowCode(
		sessionId: string,
		code: string,
	): Promise<{ ok: boolean }> {
		return this.json(
			"POST",
			`/api/auth/flows/${encodeURIComponent(sessionId)}/code`,
			{ code },
		);
	}
	async cancelFlow(sessionId: string): Promise<void> {
		await this.json(
			"DELETE",
			`/api/auth/flows/${encodeURIComponent(sessionId)}`,
		);
	}

	// --- Inbox (notifications + actionable channel signals) ---
	listInbox(
		opts: { status?: string; kind?: string; limit?: number } = {},
	): Promise<{ items: InboxItem[]; total: number }> {
		const params = new URLSearchParams();
		if (opts.status) params.set("status", opts.status);
		if (opts.kind) params.set("kind", opts.kind);
		if (opts.limit) params.set("limit", String(opts.limit));
		const q = params.toString();
		return this.json("GET", `/api/inbox${q ? `?${q}` : ""}`);
	}
	postInboxNotification(body: {
		title: string;
		body: string;
		prompt?: boolean;
	}): Promise<{ ok: boolean; item: InboxItem }> {
		return this.json("POST", "/api/inbox", { kind: "notification", ...body });
	}
	updateInboxStatus(
		id: string,
		status: string,
	): Promise<{ ok: boolean; item: InboxItem }> {
		return this.json("PATCH", `/api/inbox/${encodeURIComponent(id)}/status`, {
			status,
		});
	}
	actInboxItem(id: string): Promise<{ ok: boolean; item: InboxItem }> {
		return this.json("POST", `/api/inbox/${encodeURIComponent(id)}/act`);
	}

	// --- Gateway (unified inbound/outbound feed across channels) ---
	listGatewayFeed(
		opts: {
			channel?: string;
			direction?: string;
			q?: string;
			limit?: number;
		} = {},
	): Promise<{ messages: GatewayMessage[]; total: number }> {
		const params = new URLSearchParams();
		if (opts.channel) params.set("channel", opts.channel);
		if (opts.direction) params.set("direction", opts.direction);
		if (opts.q) params.set("q", opts.q);
		if (opts.limit) params.set("limit", String(opts.limit));
		const q = params.toString();
		return this.json("GET", `/api/gateway/feed${q ? `?${q}` : ""}`);
	}
	listGatewayIdentities(): Promise<{ identities: GatewayIdentityCandidate[] }> {
		return this.json("GET", "/api/gateway/identities");
	}

	// --- Local llama-server status ---
	getLlamaStatus(): Promise<LlamaServerStatus> {
		return this.json("GET", "/api/llama/status");
	}

	private async json<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const res = await fetch(`${this.base}${path}`, this.fetchInit({
			method,
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		}));
		if (!res.ok) {
			const err = await res.text().catch(() => res.statusText);
			throw new Error(`API ${method} ${path}: ${err}`);
		}
		return res.json() as Promise<T>;
	}
}

export interface InboxItem {
	readonly id: string;
	readonly time: number;
	readonly kind: string;
	readonly status: string;
	readonly title: string;
	readonly body: string;
	readonly source: string;
	readonly channel?: string;
	readonly fromHandle?: string;
	readonly entityId?: string;
	readonly prompted?: boolean;
	readonly replyText?: string;
	readonly meta?: Record<string, unknown>;
}

export interface GatewayMessage {
	readonly id: string;
	readonly time: number;
	readonly direction: "in" | "out" | "deleted" | "interaction";
	readonly channel: string;
	readonly source: string;
	readonly roomId: string;
	readonly entityId: string;
	readonly externalHandle?: string;
	readonly text: string;
	readonly meta?: Record<string, unknown>;
}

export interface GatewayIdentityCandidate {
	readonly key: string;
	readonly channel: string;
	readonly externalHandle: string;
	readonly entityIds: string[];
	readonly firstSeen: number;
	readonly lastSeen: number;
	readonly messageCount: number;
}

export interface LlamaServerStatus {
	readonly running: boolean;
	readonly url: string | null;
	readonly modelPath: string | null;
	readonly pid: number | null;
	readonly startedAt: number | null;
	readonly lastError: string | null;
	readonly downloadProgress?: {
		downloadedBytes: number;
		totalBytes: number;
		percent: number;
	} | null;
}

/**
 * Forward webview console output (and unhandled errors) to the server's
 * ActivityLogService so they appear alongside main-process logs in
 * Activity > Logs and the persisted JSONL file. Without this, JS errors and
 * console warnings inside the chat / settings / pensieve windows are
 * invisible until the user manually opens DevTools.
 *
 * Idempotent: only patches console once even if connect() retries.
 */
let webviewLogForwarderInstalled = false;
/**
 * Latest trace id received from the server (via chat:* WS messages). Used
 * as the ambient trace id for webview console output that fires while a
 * chat turn is in flight, so React-side logs stitch under the same id as
 * the server-side eliza pipeline logs they were responding to.
 */
let lastServerTraceId: string | undefined;

function installWebviewLogForwarder(client: WebClient): void {
	if (webviewLogForwarderInstalled) return;
	webviewLogForwarderInstalled = true;

	const view =
		typeof location !== "undefined"
			? (location.hash || "").replace(/^#/, "") || "chat"
			: "webview";

	// Pick up the trace id from any inbound chat:* message so subsequent
	// console.log calls during the same turn carry it.
	client.on((m) => {
		if (
			(m.kind === "chat:delta" ||
				m.kind === "chat:complete" ||
				m.kind === "chat:error") &&
			typeof (m as { traceId?: string }).traceId === "string"
		) {
			lastServerTraceId = (m as { traceId?: string }).traceId;
		}
	});

	const send = (
		level: "trace" | "debug" | "info" | "warn" | "error",
		args: unknown[],
	) => {
		try {
			const msg = args
				.map((a) =>
					typeof a === "string"
						? a
						: a instanceof Error
							? `${a.name}: ${a.message}`
							: (() => {
									try {
										return JSON.stringify(a);
									} catch {
										return String(a);
									}
								})(),
				)
				.join(" ");
			client.send({
				kind: "log:webview",
				level,
				msg,
				source: `webview:${view}`,
				...(lastServerTraceId ? { traceId: lastServerTraceId } : {}),
			});
		} catch {
			/* ignore — never let logging break the page */
		}
	};

	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		const orig = console[level];
		console[level] = (...args: unknown[]) => {
			const lvl = level === "log" ? "info" : level;
			send(lvl, args);
			return orig.apply(console, args);
		};
	}

	if (typeof window !== "undefined") {
		window.addEventListener("error", (ev) => {
			send("error", [
				`${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`,
			]);
		});
		window.addEventListener("unhandledrejection", (ev) => {
			const r = ev.reason;
			send("error", [
				"unhandledrejection:",
				r instanceof Error ? `${r.name}: ${r.message}` : r,
			]);
		});
	}
}
