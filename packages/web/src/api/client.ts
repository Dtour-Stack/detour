import type {
	AgentConfig,
	BackendStatus,
	ModelConfig,
	OpDiagnostic,
	OsPermissionId,
	OsPermissionInfo,
	PensieveEntitySummary,
	PensieveGraphSnapshot,
	PensieveLogEntry,
	PensieveMemoryDetail,
	PensieveMemorySummary,
	PensievePersonDetail,
	PensieveRelationshipSummary,
	PensieveRuntimeSnapshot,
	PensieveTrajectoryListResult,
	ProviderId,
	ProviderInfo,
	SigninResult,
	UiPreferences,
	WindowConfig,
	WsClientMessage,
	WsServerMessage,
} from "@detour/shared";

type Listener = (msg: WsServerMessage) => void;

export class WebClient {
	private ws: WebSocket | null = null;
	private listeners = new Set<Listener>();
	private outbox: WsClientMessage[] = [];

	constructor(private readonly base = "") {}

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

	detectBackends(): Promise<BackendStatus[]> {
		return this.json("GET", "/api/backends");
	}

	async getEnabledBackends(): Promise<string[]> {
		const res = await this.json<{ enabled: string[] }>("GET", "/api/backends/enabled");
		return res.enabled;
	}

	async setEnabledBackends(enabled: string[]): Promise<void> {
		await this.json("PUT", "/api/backends/enabled", { enabled });
	}

	// --- generic vault ---
	listVaultInventory(): Promise<any[]> {
		return this.json("GET", "/api/vault/inventory");
	}
	vaultStats(): Promise<{ total: number; sensitive: number; nonSensitive: number; references: number }> {
		return this.json("GET", "/api/vault/stats");
	}
	getVaultKey(key: string, reveal = false): Promise<{ key: string; descriptor: any; value?: string }> {
		return this.json("GET", `/api/vault/keys/${encodeURIComponent(key)}${reveal ? "?reveal=1" : ""}`);
	}
	async setVaultKey(key: string, value: string, sensitive = true): Promise<void> {
		await this.json("PUT", `/api/vault/keys/${encodeURIComponent(key)}`, { value, sensitive });
	}
	async removeVaultKey(key: string): Promise<void> {
		await this.json("DELETE", `/api/vault/keys/${encodeURIComponent(key)}`);
	}

	// --- saved logins ---
	listSavedLogins(): Promise<{ logins: any[]; failures: { source: string; message: string }[] }> {
		return this.json("GET", "/api/saved-logins");
	}
	revealSavedLogin(source: string, identifier: string): Promise<any> {
		return this.json(
			"GET",
			`/api/saved-logins/${encodeURIComponent(source)}/${encodeURIComponent(identifier)}`,
		);
	}

	// --- install helpers ---
	getBackendInstall(): Promise<{ platform: string; packageManagers: any; specs: any[] }> {
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
		await this.json("POST", `/api/os/permissions/${encodeURIComponent(id)}/open`);
	}

	// --- Pensieve ---
	pensieveLogs(params: { level?: string; source?: string; q?: string; limit?: number; since?: number } = {}): Promise<PensieveLogEntry[]> {
		const qs = new URLSearchParams();
		if (params.level) qs.set("level", params.level);
		if (params.source) qs.set("source", params.source);
		if (params.q) qs.set("q", params.q);
		if (params.limit) qs.set("limit", String(params.limit));
		if (params.since) qs.set("since", String(params.since));
		const s = qs.toString();
		return this.json("GET", `/api/pensieve/logs${s ? `?${s}` : ""}`);
	}
	pensieveRuntime(): Promise<PensieveRuntimeSnapshot> {
		return this.json("GET", "/api/pensieve/runtime");
	}
	pensieveTrajectories(params: { limit?: number; offset?: number; status?: string; source?: string; q?: string } = {}): Promise<PensieveTrajectoryListResult> {
		const qs = new URLSearchParams();
		if (params.limit) qs.set("limit", String(params.limit));
		if (params.offset) qs.set("offset", String(params.offset));
		if (params.status) qs.set("status", params.status);
		if (params.source) qs.set("source", params.source);
		if (params.q) qs.set("q", params.q);
		const s = qs.toString();
		return this.json("GET", `/api/pensieve/trajectories${s ? `?${s}` : ""}`);
	}
	pensieveTrajectory(id: string): Promise<{ trajectory: Record<string, unknown> | null }> {
		return this.json("GET", `/api/pensieve/trajectories/${encodeURIComponent(id)}`);
	}
	pensieveMemories(params: { limit?: number; type?: string; roomId?: string; entityId?: string; tag?: string; q?: string } = {}): Promise<PensieveMemorySummary[]> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) {
			if (v != null && v !== "") qs.set(k, String(v));
		}
		const s = qs.toString();
		return this.json("GET", `/api/pensieve/memories${s ? `?${s}` : ""}`);
	}
	pensieveSearchMemories(text: string, limit = 30): Promise<PensieveMemorySummary[]> {
		return this.json("POST", "/api/pensieve/memories/search", { text, limit });
	}
	pensieveMemory(id: string): Promise<PensieveMemoryDetail> {
		return this.json("GET", `/api/pensieve/memories/${encodeURIComponent(id)}`);
	}
	async pensieveUpdateMemory(id: string, patch: { contentText?: string; tags?: string[] }): Promise<void> {
		await this.json("PATCH", `/api/pensieve/memories/${encodeURIComponent(id)}`, patch);
	}
	async pensieveDeleteMemory(id: string): Promise<void> {
		await this.json("DELETE", `/api/pensieve/memories/${encodeURIComponent(id)}`);
	}
	pensievePersons(limit = 100): Promise<PensieveEntitySummary[]> {
		return this.json("GET", `/api/pensieve/relationships/persons?limit=${limit}`);
	}
	pensievePerson(id: string): Promise<PensievePersonDetail> {
		return this.json("GET", `/api/pensieve/relationships/${encodeURIComponent(id)}`);
	}
	pensieveRelationships(params: { entityIds?: string[]; tags?: string[]; limit?: number } = {}): Promise<PensieveRelationshipSummary[]> {
		const qs = new URLSearchParams();
		if (params.entityIds?.length) qs.set("entityIds", params.entityIds.join(","));
		if (params.tags?.length) qs.set("tags", params.tags.join(","));
		if (params.limit) qs.set("limit", String(params.limit));
		const s = qs.toString();
		return this.json("GET", `/api/pensieve/relationships${s ? `?${s}` : ""}`);
	}
	async pensieveCreateRelationship(rel: { sourceEntityId: string; targetEntityId: string; tags?: string[]; metadata?: Record<string, unknown> }): Promise<void> {
		await this.json("POST", "/api/pensieve/relationships", rel);
	}
	async pensieveUpdateRelationship(source: string, target: string, patch: { tags?: string[]; metadata?: Record<string, unknown> }): Promise<void> {
		await this.json("PATCH", `/api/pensieve/relationships/${encodeURIComponent(source)}/${encodeURIComponent(target)}`, patch);
	}
	async pensieveDeleteRelationship(source: string, target: string): Promise<void> {
		await this.json("DELETE", `/api/pensieve/relationships/${encodeURIComponent(source)}/${encodeURIComponent(target)}`);
	}
	pensieveGraph(filter: { dateFrom?: number; dateTo?: number; entityIds?: string[]; types?: string[]; tags?: string[] } = {}): Promise<PensieveGraphSnapshot> {
		const qs = new URLSearchParams();
		if (filter.dateFrom) qs.set("dateFrom", String(filter.dateFrom));
		if (filter.dateTo) qs.set("dateTo", String(filter.dateTo));
		if (filter.entityIds?.length) qs.set("entityIds", filter.entityIds.join(","));
		if (filter.types?.length) qs.set("types", filter.types.join(","));
		if (filter.tags?.length) qs.set("tags", filter.tags.join(","));
		const s = qs.toString();
		return this.json("GET", `/api/pensieve/graph${s ? `?${s}` : ""}`);
	}

	// --- external browser (OAuth flows can't use window.open in a webview) ---
	async openExternal(url: string): Promise<void> {
		await this.json("POST", "/api/external/open", { url });
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
	getAuthProviders(): Promise<{ subscription: string[]; direct: string[]; all: string[] }> {
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
	startAuthFlow(provider: string, label: string): Promise<{ sessionId: string; authUrl: string; needsCodeSubmission: boolean }> {
		return this.json("POST", "/api/auth/flows", { provider, label });
	}
	getAuthFlow(sessionId: string): Promise<any> {
		return this.json("GET", `/api/auth/flows/${encodeURIComponent(sessionId)}`);
	}
	async submitFlowCode(sessionId: string, code: string): Promise<{ ok: boolean }> {
		return this.json("POST", `/api/auth/flows/${encodeURIComponent(sessionId)}/code`, { code });
	}
	async cancelFlow(sessionId: string): Promise<void> {
		await this.json("DELETE", `/api/auth/flows/${encodeURIComponent(sessionId)}`);
	}

	private async json<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const res = await fetch(`${this.base}${path}`, {
			method,
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const err = await res.text().catch(() => res.statusText);
			throw new Error(`API ${method} ${path}: ${err}`);
		}
		return res.json() as Promise<T>;
	}
}
