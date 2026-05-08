import type {
	BackendStatus,
	ProviderId,
	ProviderInfo,
	WsClientMessage,
	WsServerMessage,
} from "../../shared/index";

type Listener = (msg: WsServerMessage) => void;

export class ApiClient {
	private ws: WebSocket | null = null;
	private listeners = new Set<Listener>();
	private outbox: WsClientMessage[] = [];

	constructor(private readonly baseUrl: string) {}

	async start(): Promise<void> {
		await this.openSocket();
	}

	stop(): void {
		this.ws?.close();
		this.ws = null;
		this.listeners.clear();
	}

	on(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	send(msg: WsClientMessage): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		} else {
			this.outbox.push(msg);
		}
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

	private async json<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const err = await res.text().catch(() => res.statusText);
			throw new Error(`API ${method} ${path} failed: ${err}`);
		}
		return res.json() as Promise<T>;
	}

	private async openSocket(): Promise<void> {
		const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws";
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			ws.onopen = () => {
				this.ws = ws;
				for (const msg of this.outbox.splice(0)) {
					ws.send(JSON.stringify(msg));
				}
				resolve();
			};
			ws.onerror = (err) => reject(err);
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
				// Auto-reconnect after 1s
				setTimeout(() => this.openSocket().catch(() => {}), 1000);
			};
		});
	}
}
