/**
 * mlx-rpc-client — bun-side JSON-RPC 2.0 client for the Swift-hosted
 * MLX compute socket at ~/.detour/mlx.sock. Symmetric pair of
 * rpc-socket.ts (which is bun-server, Swift-client). Two sockets, two
 * directions — isolation > elegance for compute paths.
 *
 * Used by src/bun/plugins/local-mlx-image/index.ts to register
 * `ModelType.IMAGE` with the eliza runtime. The plugin asks
 * MLXSocketServer.swift for image bytes; the bytes round-trip back as
 * base64, get persisted via saveGeneratedMediaBytes, and surface in
 * the gallery.
 *
 * Lazy-connect: the socket may not exist until Swift's
 * MLXSocketServer.shared.start() runs. We do not connect on import —
 * each call() ensures connection first, retrying with a short backoff
 * if the socket file isn't there yet (matches the cold-start race the
 * Swift→Bun RPCClient already handles in the other direction).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";

const SOCKET_PATH = join(homedir(), ".detour", "mlx.sock");

interface PendingRequest {
	resolve(value: unknown): void;
	reject(err: Error): void;
}

interface RpcFrame {
	jsonrpc: "2.0";
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface MlxImageGenerateResult {
	base64: string;
	contentType: string;
	width: number;
	height: number;
	durationMs: number;
	model: string;
}

export interface MlxImagePreset {
	id: string;
	label: string;
	modelID: string;
	ramGB: number;
	diskGB: number;
	defaultSteps: number;
	downloaded: boolean;
	available: boolean;
	fitsBudget: boolean;
	licenseNote?: string;
}

export interface MlxVideoPreset {
	id: string;
	label: string;
	modelID: string;
	ramGB: number;
	diskGB: number;
	defaultDurationSeconds: number;
	defaultFps: number;
	approxSecondsPerSecond: number;
	downloaded: boolean;
	available: boolean;
	fitsBudget: boolean;
	licenseNote?: string;
}

export interface MlxVideoGenerateResult {
	base64: string;
	contentType: string;
	width: number;
	height: number;
	durationSeconds: number;
	fps: number;
	durationMs: number;
	model: string;
}

export interface MlxHealth {
	ok: boolean;
	availability: "available" | "unsupportedHardware";
	memory: {
		physicalGB: number;
		reservedForSystemGB: number;
		availableGB: number;
		alreadyLoadedGB: number;
		headroomGB: number;
	};
}

export interface MlxMediaCatalogPreset {
	id: string;
	label: string;
	modelID: string;
	ramGB: number;
	diskGB: number;
	downloaded: boolean;
	available: boolean;
	fitsBudget: boolean;
	[k: string]: unknown;
}

export interface MlxTtsVoice {
	id: string;
	name: string;
	lang: string;
	quality: string;
}

export interface MlxTranscribeResult {
	text: string;
	language: string;
	durationMs: number;
	model: string;
	segments: Array<{ start: number; end: number; text: string }>;
}

export interface MlxSynthesizeResult {
	base64: string;
	contentType: string;
	durationSeconds: number;
	durationMs: number;
	voice: string;
	model: string;
}

export interface MlxVisionResult {
	title: string;
	description: string;
	detectedText: string;
	labels: Array<{ label: string; confidence: number }>;
	durationMs: number;
	model: string;
}

class MlxRpcClient {
	private socket: Socket | null = null;
	private buffer = "";
	private connected = false;
	private connecting: Promise<void> | null = null;
	private pending = new Map<string, PendingRequest>();
	private notificationHandlers = new Map<string, (params: unknown) => void>();
	private nextId = 1;

	async ensureConnected(timeoutMs = 30_000): Promise<void> {
		if (this.connected) return;
		if (this.connecting) return this.connecting;
		this.connecting = (async () => {
			const started = Date.now();
			// Fast-fail when the socket isn't present and the caller
			// gave a short timeout (the tray-state path uses 0). Avoids
			// queueing 90s waits forever on non-Apple-Silicon Macs where
			// Swift never opens the socket at all.
			if (timeoutMs <= 0) {
				if (!existsSync(SOCKET_PATH)) {
					this.connecting = null;
					throw new Error("MLX socket not available");
				}
			} else {
				while (!existsSync(SOCKET_PATH)) {
					if (Date.now() - started > timeoutMs) {
						this.connecting = null;
						throw new Error(`MLX socket not available after ${timeoutMs}ms`);
					}
					await new Promise((r) => setTimeout(r, 200));
				}
			}
			await new Promise<void>((resolve, reject) => {
				const sock = connect(SOCKET_PATH);
				sock.once("connect", () => {
					this.socket = sock;
					this.connected = true;
					sock.on("data", (chunk) => this.handleData(chunk));
					sock.on("close", (hadError) => {
						console.warn(`[mlx-rpc-client] socket close hadError=${hadError}`);
						this.handleClose();
					});
					sock.on("end", () => {
						console.warn(`[mlx-rpc-client] socket end (peer half-closed)`);
					});
					sock.on("error", (err) => {
						console.warn(`[mlx-rpc-client] socket error: ${err.message}`);
					});
					resolve();
				});
				sock.once("error", (err) => {
					this.connected = false;
					this.socket = null;
					reject(err);
				});
			});
		})();
		try {
			await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	private handleData(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: RpcFrame;
			try {
				frame = JSON.parse(line) as RpcFrame;
			} catch {
				continue;
			}
			this.dispatch(frame);
		}
	}

	private dispatch(frame: RpcFrame): void {
		if (frame.id != null) {
			const key = String(frame.id);
			const p = this.pending.get(key);
			if (!p) return;
			this.pending.delete(key);
			if (frame.error) {
				p.reject(new Error(frame.error.message));
			} else {
				p.resolve(frame.result);
			}
			return;
		}
		if (frame.method) {
			const handler = this.notificationHandlers.get(frame.method);
			if (handler) handler(frame.params);
		}
	}

	private handleClose(): void {
		this.connected = false;
		this.socket = null;
		// Fail outstanding requests so callers don't hang forever.
		for (const [, p] of this.pending) {
			p.reject(new Error("MLX socket closed"));
		}
		this.pending.clear();
	}

	async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000, connectTimeoutMs?: number): Promise<T> {
		await this.ensureConnected(connectTimeoutMs ?? 30_000);
		if (!this.socket) throw new Error("MLX socket not connected");
		const id = `bun-${this.nextId++}`;
		const frame: RpcFrame = { jsonrpc: "2.0", id, method, params };
		const line = JSON.stringify(frame) + "\n";
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MLX call ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => { clearTimeout(timer); resolve(v as T); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			this.socket!.write(line);
		});
	}

	onNotification(method: string, handler: (params: unknown) => void): void {
		this.notificationHandlers.set(method, handler);
	}

	async health(): Promise<MlxHealth> {
		return this.call<MlxHealth>("mlx.health");
	}

	async listImagePresets(): Promise<{ presets: MlxImagePreset[] }> {
		return this.call("mlx.image.presets");
	}

	async generateImage(params: {
		presetId: string;
		prompt: string;
		negativePrompt?: string;
		width?: number;
		height?: number;
		steps?: number;
		cfg?: number;
		seed?: number;
	}): Promise<MlxImageGenerateResult> {
		return this.call<MlxImageGenerateResult>("mlx.image.generate", params, 5 * 60 * 1000);
	}

	async unloadImageModels(): Promise<{ ok: boolean }> {
		return this.call("mlx.image.unload");
	}

	// Local video removed. Use the cloud-side GENERATE_VIDEO action
	// (media-generation plugin) for video; it routes to Veo / Veo3.

	// ── STT / TTS / Vision ────────────────────────────────────────────

	async listSttPresets(): Promise<{ presets: MlxMediaCatalogPreset[] }> {
		return this.call("mlx.stt.presets");
	}

	async transcribe(params: {
		presetId: string;
		audioBase64: string;
		mimeType?: string;
		languageCode?: string;
	}): Promise<MlxTranscribeResult> {
		return this.call<MlxTranscribeResult>("mlx.stt.transcribe", params, 5 * 60 * 1000);
	}

	async listTtsPresets(): Promise<{ presets: MlxMediaCatalogPreset[] }> {
		return this.call("mlx.tts.presets");
	}

	async listTtsVoices(): Promise<{ voices: MlxTtsVoice[] }> {
		return this.call("mlx.tts.voices");
	}

	async synthesize(params: {
		presetId: string;
		text: string;
		voice?: string;
		rate?: number;
		pitch?: number;
	}): Promise<MlxSynthesizeResult> {
		return this.call<MlxSynthesizeResult>("mlx.tts.synthesize", params, 5 * 60 * 1000);
	}

	async listVisionPresets(): Promise<{ presets: MlxMediaCatalogPreset[] }> {
		return this.call("mlx.vision.presets");
	}

	async describeImage(params: {
		presetId: string;
		imageBase64: string;
		mimeType?: string;
		prompt?: string;
	}): Promise<MlxVisionResult> {
		return this.call<MlxVisionResult>("mlx.vision.describe", params, 5 * 60 * 1000);
	}

	close(): void {
		this.socket?.end();
		this.socket = null;
		this.connected = false;
	}
}

export const mlxRpc = new MlxRpcClient();
