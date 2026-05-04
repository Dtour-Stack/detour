import type {
	BackendStatus,
	OpDiagnostic,
	ProviderId,
	ProviderInfo,
	SigninResult,
	UiPreferences,
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
