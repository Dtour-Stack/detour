import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	BackendStatus,
	ProviderId,
	ProviderInfo,
	WsClientMessage,
	WsServerMessage,
} from "@detour/shared";

const LOCK = join(homedir(), ".detour", "runtime.json");

export type RuntimeLock = { port: number; pid: number; startedAt: string };

export class NoServerError extends Error {
	constructor() {
		super(
			"No detour agent running. Launch the tray app first (or `bun run dev` from the repo root).",
		);
	}
}

export function discoverServer(): RuntimeLock {
	if (!existsSync(LOCK)) throw new NoServerError();
	const lock = JSON.parse(readFileSync(LOCK, "utf8")) as RuntimeLock;
	// Best-effort: confirm pid is alive
	try {
		process.kill(lock.pid, 0);
	} catch {
		throw new NoServerError();
	}
	return lock;
}

type Listener = (msg: WsServerMessage) => void;

export class CliClient {
	private base: string;
	private ws: WebSocket | null = null;
	private listeners = new Set<Listener>();

	constructor(port: number) {
		this.base = `http://127.0.0.1:${port}`;
	}

	async connect(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/ws`);
			ws.onopen = () => {
				this.ws = ws;
				resolve();
			};
			ws.onerror = reject;
			ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(ev.data.toString()) as WsServerMessage;
					for (const fn of this.listeners) fn(msg);
				} catch {
					// ignore
				}
			};
			ws.onclose = () => {
				this.ws = null;
			};
		});
	}

	close(): void {
		this.ws?.close();
		this.ws = null;
	}

	on(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	send(msg: WsClientMessage): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("Not connected to agent server");
		}
		this.ws.send(JSON.stringify(msg));
	}

	async listProviders(): Promise<ProviderInfo[]> {
		return this.json<ProviderInfo[]>("GET", "/api/providers");
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

	async detectBackends(): Promise<BackendStatus[]> {
		return this.json<BackendStatus[]>("GET", "/api/backends");
	}

	async health(): Promise<{ ok: true; version: string }> {
		return this.json("GET", "/api/health");
	}

	listVaultInventory(): Promise<any[]> {
		return this.json("GET", "/api/vault/inventory");
	}
	vaultStats(): Promise<any> {
		return this.json("GET", "/api/vault/stats");
	}
	getVaultKey(key: string, reveal = false): Promise<any> {
		return this.json("GET", `/api/vault/keys/${encodeURIComponent(key)}${reveal ? "?reveal=1" : ""}`);
	}
	async setVaultKey(key: string, value: string, sensitive = true): Promise<void> {
		await this.json("PUT", `/api/vault/keys/${encodeURIComponent(key)}`, { value, sensitive });
	}
	async removeVaultKey(key: string): Promise<void> {
		await this.json("DELETE", `/api/vault/keys/${encodeURIComponent(key)}`);
	}
	listSavedLogins(): Promise<{ logins: any[]; failures: any[] }> {
		return this.json("GET", "/api/saved-logins");
	}
	revealSavedLogin(source: string, identifier: string): Promise<any> {
		return this.json(
			"GET",
			`/api/saved-logins/${encodeURIComponent(source)}/${encodeURIComponent(identifier)}`,
		);
	}
	getBackends(): Promise<any[]> {
		return this.json("GET", "/api/backends");
	}

	listAllAccounts(): Promise<Record<string, any[]>> {
		return this.json("GET", "/api/auth/accounts");
	}
	getAuthProviders(): Promise<{ subscription: string[]; direct: string[]; all: string[] }> {
		return this.json("GET", "/api/auth/providers");
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
	async deleteAccount(provider: string, accountId: string): Promise<void> {
		await this.json(
			"DELETE",
			`/api/auth/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountId)}`,
		);
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
