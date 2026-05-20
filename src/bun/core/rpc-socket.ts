/**
 * rpc-socket — typed RPC over a Unix domain socket between the Swift
 * launcher and the bun agent runtime. Newline-delimited JSON-RPC 2.0
 * framing. Per-call latency ~80µs vs ~1ms for HTTP loopback.
 *
 * Frame format (one JSON object per line):
 *
 *   // Request:
 *   {"jsonrpc":"2.0","id":42,"method":"eval.send","params":{...}}
 *
 *   // Response (success):
 *   {"jsonrpc":"2.0","id":42,"result":{...}}
 *
 *   // Response (error):
 *   {"jsonrpc":"2.0","id":42,"error":{"code":-32603,"message":"..."}}
 *
 *   // Server → client notification (no id, no response expected):
 *   {"jsonrpc":"2.0","method":"event.agentNarrate","params":{...}}
 *
 * The transport coexists with the HTTP server on 127.0.0.1:2138 during
 * migration. New Swift code uses the socket; legacy HTTP callers
 * (external curl, eval drivers) keep working unchanged.
 *
 * Socket path: ~/.detour/rpc.sock
 */

import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { broadcaster, registerWindow } from "./rpc/registry";

const SOCKET_PATH = join(homedir(), ".detour", "rpc.sock");

/// JSON-RPC 2.0 method handler. Args are the raw `params` object,
/// returns whatever JSON-serializable result. Throws → error response.
export type RpcMethod = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export interface RpcSocketServer {
	stop(): void;
	path: string;
}

/// Open a Bun.listen() Unix socket and dispatch incoming JSON-RPC
/// messages to the supplied method table. Also fans `broadcaster`
/// events out to every connected client as JSON-RPC notifications
/// (replaces the SSE channel).
export function startRpcSocket(methods: Record<string, RpcMethod>): RpcSocketServer {
	if (existsSync(SOCKET_PATH)) {
		try { unlinkSync(SOCKET_PATH); } catch {
			// Another instance may be running; ignore — Bun.listen will
			// error and we'll surface it then.
		}
	}

	interface Conn {
		buffer: string;
		write(line: string): void;
	}
	const connections = new Set<Conn>();

	// Wire the broadcaster so chatDelta / chatComplete / agentNarrate
	// etc. fan out to every connected RPC client as notifications.
	// Same path the SSE endpoint uses — virtual subscriber.
	const sendToAllClients = (method: string, params: unknown): void => {
		const frame = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
		for (const c of connections) {
			try { c.write(frame); } catch { /* dead client; will be cleaned on next loop */ }
		}
	};
	// Register one virtual "window" that the broadcaster will fan-out
	// to. Receives EVERY broadcast — clients filter on their end.
	const unsubscribe = registerWindow((name, payload) => {
		sendToAllClients(`event.${name}`, payload);
	});

	const handleMessage = async (conn: Conn, raw: string): Promise<void> => {
		raw = raw.trim();
		if (raw.length === 0) return;
		let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
		try {
			msg = JSON.parse(raw);
		} catch (err) {
			conn.write(JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "parse error" },
			}) + "\n");
			return;
		}
		if (msg.jsonrpc !== "2.0") {
			conn.write(JSON.stringify({
				jsonrpc: "2.0",
				id: msg.id ?? null,
				error: { code: -32600, message: "invalid request" },
			}) + "\n");
			return;
		}
		const id = msg.id;
		const methodName = msg.method ?? "";
		const handler = methods[methodName];
		if (!handler) {
			if (id != null) {
				conn.write(JSON.stringify({
					jsonrpc: "2.0",
					id,
					error: { code: -32601, message: `method not found: ${methodName}` },
				}) + "\n");
			}
			return;
		}
		try {
			const result = await handler(msg.params ?? {});
			if (id != null) {
				conn.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
			}
		} catch (err) {
			if (id != null) {
				conn.write(JSON.stringify({
					jsonrpc: "2.0",
					id,
					error: {
						code: -32603,
						message: err instanceof Error ? err.message : String(err),
					},
				}) + "\n");
			}
		}
	};

	const server = Bun.listen({
		unix: SOCKET_PATH,
		socket: {
			open(socket) {
				const conn: Conn = {
					buffer: "",
					write: (line) => socket.write(line),
				};
				connections.add(conn);
				(socket as unknown as { _detourConn: Conn })._detourConn = conn;
			},
			data(socket, data) {
				const conn = (socket as unknown as { _detourConn?: Conn })._detourConn;
				if (!conn) return;
				conn.buffer += data.toString();
				let nl: number;
				while ((nl = conn.buffer.indexOf("\n")) !== -1) {
					const line = conn.buffer.slice(0, nl);
					conn.buffer = conn.buffer.slice(nl + 1);
					void handleMessage(conn, line);
				}
			},
			close(socket) {
				const conn = (socket as unknown as { _detourConn?: Conn })._detourConn;
				if (conn) connections.delete(conn);
			},
			error(_, err) {
				console.warn("[rpc-socket] socket error:", err.message);
			},
		},
	});
	console.log(`[rpc-socket] listening on ${SOCKET_PATH} (${methods ? Object.keys(methods).length : 0} methods)`);

	return {
		path: SOCKET_PATH,
		stop() {
			unsubscribe();
			(server as unknown as { stop: () => void }).stop?.();
			for (const conn of connections) {
				try { conn.write(""); } catch { /* ignore */ }
			}
			connections.clear();
			if (existsSync(SOCKET_PATH)) {
				try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
			}
		},
	};
}

/// Build a method table from the existing eval/dispatch surface.
/// Each method delegates to the same handlers the HTTP routes call,
/// so behavior is identical — only the transport changes.
///
/// This is intentionally a thin wrapper. Migrating individual handlers
/// to truly typed methods (defined in src/shared/rpc/) is incremental;
/// for now we use generic params/result and let the Swift side type
/// the calls.
export function buildAgentMethods(deps: {
	runtime: import("./runtime").RuntimeService;
	activity: import("./activity").ActivityService;
	pensieve?: import("./pensieve").PensieveService;
	config?: import("./config-service").ConfigService;
	vault?: import("./vault").VaultService;
	inbox?: import("./inbox").InboxService;
	trayStateBuilder?: () => Promise<unknown>;
}): Record<string, RpcMethod> {
	const methods: Record<string, RpcMethod> = {};

	methods["health"] = async () => ({ ok: true, version: "0.0.1" });

	methods["eval.send"] = async (params) => {
		const text = String(params.text ?? "");
		const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 60000;
		if (!text) throw new Error("text is required");
		const chunks: string[] = [];
		const onDelta = (delta: string): void => {
			chunks.push(delta);
			broadcaster.broadcast("chatDelta", { delta, traceId: "rpc-send" });
		};
		const started = Date.now();
		try {
			const promise = deps.runtime.sendMessage(text, onDelta);
			const timeout = new Promise<never>((_, rej) =>
				setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs),
			);
			await Promise.race([promise, timeout]);
			const reply = chunks.join("");
			const list = await deps.activity.trajectories.list({ limit: 1, source: "tray-app" });
			const trajectoryId = list.trajectories[0]?.id ?? null;
			broadcaster.broadcast("chatComplete", {
				text: reply, summary: reply.slice(0, 200),
				trajectoryId, durationMs: Date.now() - started,
			});
			return { reply, trajectoryId, durationMs: Date.now() - started };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Surface to the pet feed + any UI banner that subscribes.
			// Fire-and-forget — the caller still gets the throw for its
			// own error reporting.
			broadcaster.broadcast("chatError", {
				convId: "rpc-send",
				message,
				traceId: "rpc-send",
			});
			throw err;
		}
	};

	methods["eval.actions.list"] = async () => {
		const live = deps.runtime.peek();
		if (!live) throw new Error("runtime not live");
		const actions = (live as unknown as {
			actions?: Array<{ name: string; description?: string }>;
		}).actions ?? [];
		return {
			actions: actions
				.map((a) => ({ name: a.name, description: a.description ?? null }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		};
	};

	methods["eval.action.run"] = async (params) => {
		const name = String(params.name ?? "");
		const options = (params.options as Record<string, unknown>) ?? {};
		if (!name) throw new Error("name required");
		await deps.runtime.getOrBuild();
		const live = deps.runtime.peek();
		if (!live) throw new Error("runtime not live");
		const actions = (live as unknown as {
			actions?: Array<{ name: string; handler: (...a: unknown[]) => unknown }>;
		}).actions ?? [];
		const action = actions.find((a) => a.name === name);
		if (!action) throw new Error(`action ${name} not registered`);
		const emits: Array<{ text: string; action: string }> = [];
		const callback = async (p: { text?: string; action?: string }) => {
			emits.push({ text: p.text ?? "", action: p.action ?? "" });
			return [];
		};
		const fakeMemory = {
			id: "00000000-0000-0000-0000-000000000000",
			entityId: "00000000-0000-0000-0000-000000000001",
			roomId: "00000000-0000-0000-0000-000000000002",
			content: { text: "" },
		};
		const fakeState = { values: {}, data: {}, text: "" };
		const result = await action.handler(live, fakeMemory, fakeState, options, callback);
		return { action: name, emits, result };
	};

	methods["pensieve.memories.list"] = async (params) => {
		if (!deps.pensieve) throw new Error("pensieve not wired");
		const limit = typeof params.limit === "number" ? params.limit : 50;
		const memories = await deps.pensieve.memories.list({ limit });
		return { memories };
	};

	methods["pensieve.memories.search"] = async (params) => {
		if (!deps.pensieve) throw new Error("pensieve not wired");
		const text = String(params.text ?? "");
		const limit = typeof params.limit === "number" ? params.limit : 20;
		if (!text.trim()) return { memories: [] };
		const memories = await deps.pensieve.memories.search(text, limit);
		return { memories };
	};

	methods["activity.logs.list"] = async (params) => {
		const limit = typeof params.limit === "number" ? params.limit : 200;
		const entries = deps.activity.logs.list({ limit });
		return { entries };
	};

	methods["activity.trajectories.list"] = async (params) => {
		const limit = typeof params.limit === "number" ? params.limit : 20;
		const result = await deps.activity.trajectories.list({ limit });
		return result;
	};

	methods["models.get"] = async () => {
		if (!deps.config) throw new Error("config not wired");
		return { models: await deps.config.getModels() };
	};

	methods["models.set"] = async (params) => {
		if (!deps.config) throw new Error("config not wired");
		await deps.config.setModels(params as never);
		return { models: await deps.config.getModels() };
	};

	methods["tray.snapshot"] = async () => {
		// Caller side fetches this every 4s today via HTTP. RPC moves
		// it to ~80µs per refresh.
		if (!deps.trayStateBuilder) throw new Error("tray snapshot builder not wired");
		return await deps.trayStateBuilder();
	};

	/// Inbox feed — used by the chat sidebar to render Discord /
	/// Telegram / iMessage / X message lists when a channel is selected.
	/// Filters by `channel:` field (matches what plugin-* services set).
	methods["inbox.list"] = async (params) => {
		if (!deps.inbox) throw new Error("inbox not wired");
		const channel = typeof params.channel === "string" ? params.channel : undefined;
		const kind = typeof params.kind === "string" ? params.kind : undefined;
		const limit = typeof params.limit === "number" ? params.limit : 50;
		const result = await deps.inbox.list({
			...(kind ? { kind: kind as never } : {}),
			limit,
		});
		const items = channel
			? result.items.filter((it) => it.channel === channel)
			: result.items;
		return {
			items: items.map((it) => ({
				id: it.id,
				time: it.time,
				kind: it.kind,
				status: it.status,
				title: it.title,
				body: it.body,
				source: it.source,
				channel: it.channel ?? null,
				fromHandle: it.fromHandle ?? null,
				replyText: it.replyText ?? null,
			})),
			total: items.length,
		};
	};

	/// Vault credential lookup. Returns a map of key → bool indicating
	/// presence (not the secret itself). Used by the Mac app's Connect
	/// panels to show "Connected" / "Disconnected" state for channels.
	methods["vault.has"] = async (params) => {
		if (!deps.vault) throw new Error("vault not wired");
		const keys = Array.isArray(params.keys) ? (params.keys as string[]) : [];
		const manager = await deps.vault.manager();
		const has: Record<string, boolean> = {};
		for (const k of keys) {
			if (typeof k !== "string" || k.length === 0) continue;
			has[k] = await manager.has(k);
		}
		return { has };
	};

	/// Bulk-write vault entries (used by Channel Connect flows). Each
	/// entry is stored as a sensitive secret in the macOS keychain via
	/// elizaos/vault's SecretsManager.
	methods["vault.set"] = async (params) => {
		if (!deps.vault) throw new Error("vault not wired");
		const entries = Array.isArray(params.entries) ? params.entries : [];
		const manager = await deps.vault.manager();
		let n = 0;
		for (const e of entries) {
			if (typeof e !== "object" || e === null) continue;
			const rec = e as Record<string, unknown>;
			const key = typeof rec.key === "string" ? rec.key : "";
			const value = typeof rec.value === "string" ? rec.value : "";
			if (!key || !value) continue;
			await manager.set(key, value, { sensitive: true });
			// Mirror to process.env so plugins reading via runtime.getSetting()
			// see the new value without restart.
			process.env[key] = value;
			n++;
		}
		return { ok: true, written: n };
	};

	methods["vault.remove"] = async (params) => {
		if (!deps.vault) throw new Error("vault not wired");
		const keys = Array.isArray(params.keys) ? (params.keys as string[]) : [];
		const manager = await deps.vault.manager();
		let n = 0;
		for (const k of keys) {
			if (typeof k !== "string" || k.length === 0) continue;
			await manager.remove(k);
			delete process.env[k];
			n++;
		}
		return { ok: true, removed: n };
	};

	/// Write a runtime setting from the local Swift Settings UI.
	/// Local-only (Unix socket), so no token gate — but allowlisted so
	/// callers can't mutate arbitrary process.env.
	methods["settings.set"] = async (params) => {
		const key = String(params.key ?? "");
		const value = String(params.value ?? "");
		if (!key) throw new Error("key required");
		const ALLOWED = new Set([
			"LOCAL_MLX_IMAGE_ENABLED",
			"LOCAL_MLX_IMAGE_PRESET",
			"LOCAL_MLX_IMAGE_NEGATIVE_PROMPT",
			"LOCAL_MLX_STT_ENABLED",
			"LOCAL_MLX_STT_PRESET",
			"LOCAL_MLX_STT_LANGUAGE",
			"LOCAL_MLX_TTS_ENABLED",
			"LOCAL_MLX_TTS_PRESET",
			"LOCAL_MLX_TTS_VOICE",
			"LOCAL_MLX_VISION_ENABLED",
			"LOCAL_MLX_VISION_PRESET",
			"DETOUR_MODEL_IMAGE_PROVIDER",
			"DETOUR_MODEL_IMAGE_DESCRIPTION_PROVIDER",
			"DETOUR_MODEL_TRANSCRIPTION_PROVIDER",
			"DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER",
			"DETOUR_MODEL_VIDEO_GENERATION_PROVIDER",
		]);
		if (!ALLOWED.has(key)) throw new Error(`setting ${key} not allowed`);
		process.env[key] = value;
		return { ok: true, key, value };
	};

	return methods;
}

/**
 * Start a bun-side broadcaster that polls the tray snapshot every 4s,
 * diffs against the last sent version, and emits a `tray.state` RPC
 * notification ONLY when the snapshot changed. Eliminates the
 * client-side 4s HTTP poll entirely.
 *
 * Returns a stop handle. Idle cost on bun: one snapshot build every
 * 4s (cheap, mostly in-memory reads). Idle cost on the wire: zero
 * unless something changed.
 */
export function startTrayBroadcaster(
	trayStateBuilder: () => Promise<unknown>,
): () => void {
	let lastSerialized: string | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	const tick = async (): Promise<void> => {
		try {
			const snap = await trayStateBuilder();
			const serialized = JSON.stringify(snap);
			if (serialized !== lastSerialized) {
				lastSerialized = serialized;
				broadcaster.broadcast("tray.state", snap as never);
			}
		} catch (err) {
			// Surface but don't tear down the loop — transient failures
			// (eg vault temporarily unreachable) shouldn't kill the
			// broadcaster. Next tick re-runs.
			console.warn("[tray-broadcaster] tick failed:", err instanceof Error ? err.message : err);
		}
	};
	// Fire once immediately so subscribers get state before the first 4s.
	void tick();
	timer = setInterval(tick, 4000);
	return () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	};
}
