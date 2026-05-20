import { logger, type Memory, type UUID } from "@elizaos/core";
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve as pathResolve, sep } from "node:path";
import type { RuntimeService } from "../runtime";
import type { ActivityService } from "../activity";
import { broadcaster } from "../rpc/registry";
import { evalRoutes } from "./eval-routes";
import { getUrlSchemeDispatcher } from "../../features/url-scheme/index";
import type {
	BrowserCommand,
	BrowserCommandInput,
	BrowserCommandResult,
	TraySnapshotWire,
} from "../../../shared/index";

const VERSION = "0.0.1";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Resolve the bundled `Resources/app/views/main/` directory on disk —
 *  same logic `view-url.ts` uses for the WKWebView's local file URL. We
 *  serve from that exact tree so the HTTP-served UI is byte-identical to
 *  what the WebView would load via the `views://` scheme. */
let cachedViewRoot: string | null | undefined;
function resolveViewRoot(): string | null {
	if (cachedViewRoot !== undefined) return cachedViewRoot;
	const candidates = [
		process.execPath ? join(dirname(process.execPath), "..", "Resources", "app", "views", "main") : null,
		process.execPath ? join(dirname(process.execPath), "views", "main") : null,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			cachedViewRoot = candidate;
			return candidate;
		}
	}
	cachedViewRoot = null;
	return null;
}

const STATIC_MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
};

async function serveStaticAsset(requestPath: string): Promise<Response | null> {
	const root = resolveViewRoot();
	if (!root) return null;
	const rel = requestPath === "/" ? "/index.html" : requestPath;
	const relNoSlash = rel.startsWith("/") ? rel.slice(1) : rel;
	const normalized = normalize(relNoSlash).replace(/^(\.\.[/\\])+/, "");
	const candidate = pathResolve(root, normalized);
	// Path-traversal guard — refuse anything that escapes the view root.
	if (!candidate.startsWith(root + sep) && candidate !== root) return null;
	if (!existsSync(candidate)) return null;
	let target = candidate;
	try {
		if (statSync(candidate).isDirectory()) {
			target = join(candidate, "index.html");
			if (!existsSync(target)) return null;
		}
	} catch {
		return null;
	}
	const file = Bun.file(target);
	const mime = STATIC_MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
	return new Response(file, { headers: { "content-type": mime, "cache-control": "no-cache" } });
}

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

const BROWSER_CONTROL_GLOBAL = Symbol.for("detour.browser.control");
const MAX_BROWSER_COMMANDS = 100;

type BrowserControlGlobal = {
	enqueue(command: BrowserCommandInput): BrowserCommand;
	enqueueAndWait(command: BrowserCommandInput, timeoutMs?: number): Promise<BrowserCommandResult>;
	// Used by RPC handlers in src/bun/core/rpc/handlers/browser.ts so HTTP and
	// RPC paths share one queue. The legacy HTTP routes are gone, but the
	// global is still the integration point for vault-tools agent enqueue
	// (which can't hold an ApiServer reference).
	list(opts: { after?: string; since?: number }): BrowserCommand[];
	report(commandId: string, result: Omit<BrowserCommandResult, "time">): BrowserCommandResult;
};

type DebugEmbeddingBody = { text?: string; storeAs?: string };
type LocalAiTier = "chat" | "companion";
type LocalAiAction = "start" | "stop";
type LocalAiBody = { preset?: string };
type DebugActionBody = { name?: string; options?: Record<string, unknown> };
type RuntimeDebugAction = { name: string; handler: (...a: unknown[]) => unknown };
type DebugEmbeddingRuntime = {
	useModel?: (type: string, params: { text: string }) => Promise<unknown>;
	getModel?: (type: string) => unknown;
	getService?: (type: string) => unknown;
	adapter?: { embeddingDimension?: string };
	createMemory?: (memory: Memory, table: string) => Promise<string>;
	updateMemory?: (memory: { id: string; embedding: number[] }) => Promise<boolean>;
	agentId?: UUID;
};
type DebugEmbeddingWriteResult = { ok: boolean; memoryId?: string; error?: string };
type DebugEmbeddingModelResult = { vector: number[]; modelErr: string | null; durationMs: number };

function isLocalAiTier(tier: string | undefined): tier is LocalAiTier {
	return tier === "chat" || tier === "companion";
}

function isLocalAiAction(action: string | undefined): action is LocalAiAction {
	return action === "start" || action === "stop";
}

async function readLocalAiBody(req: Request): Promise<LocalAiBody | null> {
	try {
		const raw = await req.text();
		return raw.length > 0 ? JSON.parse(raw) as LocalAiBody : {};
	} catch {
		return null;
	}
}

function localAiStartConfig(body: LocalAiBody): { preset?: string } {
	return typeof body.preset === "string" && body.preset.length > 0
		? { preset: body.preset }
		: {};
}

async function readDebugActionBody(req: Request): Promise<DebugActionBody | null> {
	try {
		return await req.json() as DebugActionBody;
	} catch {
		return null;
	}
}

function findRuntimeAction(live: unknown, name: string): RuntimeDebugAction | undefined {
	const liveActions = (live as { actions?: RuntimeDebugAction[] }).actions ?? [];
	return liveActions.find((action) => action.name === name);
}

function debugMemory(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000000" as UUID,
		entityId: "00000000-0000-0000-0000-000000000001" as UUID,
		roomId: "00000000-0000-0000-0000-000000000002" as UUID,
		content: { text: "" },
	};
}

function debugState(): { values: Record<string, unknown>; data: Record<string, unknown>; text: string } {
	return { values: {}, data: {}, text: "" };
}

function embeddingVector(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

async function runDebugEmbeddingModel(runtime: DebugEmbeddingRuntime, text: string): Promise<DebugEmbeddingModelResult> {
	let raw: unknown = null;
	let modelErr: string | null = null;
	const t0 = Date.now();
	try {
		if (runtime.useModel) raw = await runtime.useModel("TEXT_EMBEDDING", { text });
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
	if (!body.storeAs || !runtime.createMemory || !runtime.updateMemory) return null;
	if (!runtime.agentId) return null;
	try {
		const memId = await runtime.createMemory({
			entityId: runtime.agentId,
			roomId: runtime.agentId,
			agentId: runtime.agentId,
			content: { text, source: "debug" },
			createdAt: Date.now(),
		}, body.storeAs);
		await runtime.updateMemory({ id: memId, embedding });
		return { ok: true, memoryId: String(memId) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export type WindowCommand =
	| { kind: "hide" }
	| { kind: "pin"; on: boolean }
	| { kind: "resize"; width: number; height: number };

export type WindowController = (cmd: WindowCommand) => void;

/**
 * ApiServer — the slim HTTP surface that survives Phase 4 of the
 * HTTP/WS→RPC migration (see docs/rpc-migration.md). All feature traffic
 * (chat streaming, log forwarding, every former HTTP route) now flows
 * through electrobun's typed RPC bridge. What's left here is:
 *
 *   - GET /api/health — basic liveness ping
 *   - POST /api/debug/action — dev-only, gated to Detour-dev.app builds
 *   - POST /api/debug/embedding — embedding-pipeline diagnostic; called via
 *     raw fetch from the LocalAI debug tab
 *   - The browser-command queue (BROWSER_CONTROL_GLOBAL) — backs the RPC
 *     handlers in src/bun/core/rpc/handlers/browser.ts and the agent-side
 *     enqueue in src/bun/plugins/vault-tools/index.ts. Pushes go through
 *     the typed RPC `broadcaster` (`uiOpenBrowser` / `browserCommand`).
 *
 * Window control (pin/hide/resize) lives in the RPC-only window-controller
 * registry in src/bun/core/rpc/window-controller-registry.ts.
 */
export class ApiServer {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private port = 0;
	private lockFile = join(homedir(), ".detour", "runtime.json");
	private browserCommands: BrowserCommand[] = [];
	private browserResults = new Map<string, BrowserCommandResult>();
	private browserWaiters = new Map<string, {
		resolve: (result: BrowserCommandResult) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	constructor(
		private readonly runtime: RuntimeService,
		private readonly activity: ActivityService,
		private readonly selfImprovement?: {
			dream?: import("../dream-service").DreamService;
			improvement?: import("../continuous-improvement-service").ContinuousImprovementService;
			agentHfSync?: import("../agent-hf-sync-service").AgentHfSyncService;
			localChat?: import("../llama/chat-service").LocalChatService;
			companion?: import("../llama/companion-service").CompanionService;
			pensieve?: import("../pensieve").PensieveService;
			config?: import("../config-service").ConfigService;
		},
		/**
		 * Build the tray snapshot consumed by the Swift tray companion.
		 * core/index.ts wires this in with access to all the services
		 * the snapshot needs (runtime, llama, localChat, companion,
		 * memoryArbiter, activity, config). Optional — if missing,
		 * GET /api/tray-state returns 503 and the Swift tray falls back
		 * to a minimal "just running" menu.
		 */
		private readonly trayStateBuilder?: () => Promise<TraySnapshotWire>,
	) {}

	private installBrowserControlGlobal(): void {
		(globalThis as Record<symbol, BrowserControlGlobal>)[BROWSER_CONTROL_GLOBAL] = {
			enqueue: (command) => this.enqueueBrowserCommand(command),
			enqueueAndWait: (command, timeoutMs) => this.enqueueBrowserCommandAndWait(command, timeoutMs),
			list: (opts) => this.listBrowserCommands(opts),
			report: (commandId, result) => this.finishBrowserCommand(commandId, result),
		};
	}

	private removeBrowserControlGlobal(): void {
		const g = globalThis as Record<symbol, BrowserControlGlobal | undefined>;
		if (g[BROWSER_CONTROL_GLOBAL]?.enqueue) {
			delete g[BROWSER_CONTROL_GLOBAL];
		}
	}

	private listBrowserCommands(opts: { after?: string; since?: number }): BrowserCommand[] {
		const after = opts.after ?? "";
		const since = opts.since ?? 0;
		const afterIndex = after
			? this.browserCommands.findIndex((command) => command.id === after)
			: -1;
		const commands = afterIndex >= 0
			? this.browserCommands.slice(afterIndex + 1)
			: this.browserCommands.filter((command) => !since || command.time >= since);
		return commands.filter((command) => !this.browserResults.has(command.id));
	}

	private enqueueBrowserCommand(input: BrowserCommandInput): BrowserCommand {
		const command = {
			...input,
			id: crypto.randomUUID(),
			time: Date.now(),
		} as BrowserCommand;
		this.browserCommands.push(command);
		if (this.browserCommands.length > MAX_BROWSER_COMMANDS) {
			this.browserCommands.splice(0, this.browserCommands.length - MAX_BROWSER_COMMANDS);
		}
		// Push to all open webviews via typed RPC AND fire the in-process
		// kernel listener (which opens the Browser window). See
		// src/bun/kernel/app.ts for the registerWindow faux-send that
		// translates `uiOpenBrowser` into the `ui:open-browser` event.
		broadcaster.broadcast("uiOpenBrowser", {});
		broadcaster.broadcast("browserCommand", { command });
		return command;
	}

	private enqueueBrowserCommandAndWait(input: BrowserCommandInput, timeoutMs = 30_000): Promise<BrowserCommandResult> {
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

	private finishBrowserCommand(commandId: string, result: Omit<BrowserCommandResult, "time"> & { time?: number }): BrowserCommandResult {
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

	private async handleLocalAiControl(ctx: ApiRequestContext): Promise<Response | null> {
		const { req, path, json, error } = ctx;
		if (req.method !== "POST") return null;
		if (!path.startsWith("/api/local-ai/")) return null;
		const [tier, action] = path.slice("/api/local-ai/".length).split("/");
		if (!isLocalAiTier(tier) || !isLocalAiAction(action)) return error("unknown local-ai route", 404);
		const svc = tier === "chat"
			? this.selfImprovement?.localChat
			: this.selfImprovement?.companion;
		if (!svc) return error(`${tier} service not wired`, 503);
		const body = await readLocalAiBody(req);
		if (!body) return error("invalid JSON body", 400);
		try {
			if (action === "stop") {
				svc.stop();
				return json({ ok: true, action: "stop", tier });
			}
			const result = await svc.start(localAiStartConfig(body));
			if (!result) {
				const reason = svc.getLastArbiterRefusal();
				return json(
					{ ok: false, action: "start", tier, reason: reason ?? "start returned null (see logs)" },
					409,
				);
			}
			return json({
				ok: true,
				action: "start",
				tier,
				url: result.url,
				modelPath: result.modelPath,
			});
		} catch (err) {
			return error(
				err instanceof Error ? err.message : `${tier} ${action} failed`,
				500,
			);
		}
	}

	private async handleDebugAction(ctx: ApiRequestContext): Promise<Response | null> {
		const { req, path, json, error } = ctx;
		if (req.method !== "POST" || path !== "/api/debug/action") return null;
		const isDevBundle = typeof process.execPath === "string" && process.execPath.includes("Detour-dev.app/");
		const allowOverride = process.env.DETOUR_ALLOW_DEBUG_API === "1";
		if (!isDevBundle && !allowOverride) return error("debug API disabled in this build", 404);
		const body = await readDebugActionBody(req);
		if (!body) return error("invalid JSON body", 400);
		if (!body.name) return error("missing 'name'", 400);
		const state = await this.runtime.getOrBuild();
		if (!state) return error("runtime not built — no LLM provider configured", 503);
		const live = this.runtime.peek();
		if (!live) return error("runtime not live", 503);
		const action = findRuntimeAction(live, body.name);
		if (!action) return error(`action '${body.name}' not registered on runtime`, 404);
		const emits: { text: string; action: string }[] = [];
		const callback = async (p: { text: string; action: string }) => {
			emits.push({ text: p.text, action: p.action });
			return [];
		};
		const t0 = Date.now();
		try {
			const result = await action.handler(live, debugMemory(), debugState(), body.options ?? {}, callback);
			return json({ ok: true, action: body.name, durationMs: Date.now() - t0, emits, result });
		} catch (err) {
			return error(`action handler threw: ${err instanceof Error ? err.message : String(err)}`, 500);
		}
	}

	private async debugEmbedding(ctx: ApiRequestContext): Promise<Response> {
		const body = (await ctx.req.json().catch(() => ({}))) as DebugEmbeddingBody;
		const text = body.text ?? "hello world";
		const live = this.runtime.peek();
		if (!live) return ctx.error("runtime not built", 503);
		const runtime = live as DebugEmbeddingRuntime;
		const model = await runDebugEmbeddingModel(runtime, text);
		const embSvc = runtime.getService?.("embedding-generation") as {
			isDisabled?: boolean;
			batchQueue?: { size?: number; isStarted?: boolean } | null;
		} | null | undefined;
		const writeResult = await writeDebugEmbedding(runtime, body, text, model.vector);
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

	async start(preferredPort = 2138): Promise<{ port: number }> {
		this.installBrowserControlGlobal();
		// Try preferred port first; fall back to ephemeral if taken
		try {
			return await this.tryStart(preferredPort);
		} catch (err) {
			if ((err as { code?: string }).code === "EADDRINUSE") {
				logger.warn({ src: "api", preferredPort }, "[ApiServer] preferred port in use");
				return this.tryStart(0);
			}
			throw err;
		}
	}

	private async tryStart(port: number): Promise<{ port: number }> {
		// CORS: the few remaining debug routes are still cross-origin. The
		// server is bound to 127.0.0.1 only, so allow * is safe for
		// local-only access.
		const corsHeaders: Record<string, string> = {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
			"access-control-allow-headers": "content-type, authorization",
			"access-control-max-age": "86400",
		};
		const json = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { "content-type": "application/json", ...corsHeaders },
			});
		const ok = () => json({ ok: true });
		const error = (message: string, status = 400) =>
			json({ ok: false, error: message }, status);

		this.server = Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: async (req): Promise<Response> => {
				// CORS preflight — browsers send OPTIONS before any non-simple
				// cross-origin request.
				if (req.method === "OPTIONS") {
					return new Response(null, { status: 204, headers: corsHeaders });
				}
				const response = await this.handleHttpRequest(req, { json, ok, error });
				return response ?? error("not found", 404);
			},
		});

		this.port = this.server.port ?? port;
		this.writeLockfile();
		return { port: this.port };
	}

	private readonly routeHandlers: ApiRouteHandler[] = [
		async (ctx) => {
			const { req, path, json } = ctx;
			if (req.method === "GET" && path === "/api/health") {
				return json({ ok: true, version: VERSION });
			}
			return null;
		},
		// Tray-state snapshot polled by the Swift tray companion
		// (build-assets/tray-bridge/) every 4s. Contains everything the
		// rich NSMenu needs to render: provider, memory budget, the
		// three local-AI tiers, the user's quick-action slots, and
		// recent trajectories. Keep this small + fast — it's polled
		// often. Read-only; tray clicks go back through detour:// URLs.
		async (ctx) => {
			const { req, path, json, error } = ctx;
			if (req.method !== "GET" || path !== "/api/tray-state") return null;
			if (!this.trayStateBuilder) {
				return error("tray-state unavailable", 503);
			}
			try {
				const snap = await this.trayStateBuilder();
				return json(snap);
			} catch (err) {
				return error(
					err instanceof Error ? err.message : "tray-state failed",
					500,
				);
			}
		},
		// Local-AI control surface for the Swift tray (and any other
		// trusted client on 127.0.0.1). POST /api/local-ai/{chat|companion}
		// /{start|stop}. start() with a `preset` body kicks off a model
		// download if the GGUF isn't already on disk — the same code path
		// the React Local AI tab uses, just exposed over HTTP so the
		// native tray menu can fire it without going through RPC.
		//
		// 127.0.0.1 only — we never bind to 0.0.0.0 (see start() at the
		// bottom of this file). No auth on these because the tray runs
		// as the same user as Detour itself.
			(ctx) => this.handleLocalAiControl(ctx),
		// URL-scheme dispatch — in-process equivalent of the open-url event
		// listener. Swiftun's tray + AppleScript code POSTs `detour://…`
		// URLs here so they always land in THIS bun process, even while
		// LaunchServices still has a stale `ai.detour.app` (Electrobun)
		// registration competing for the scheme. External callers
		// (Shortcuts.app, raw `open detour://…`) keep going through the
		// OS-level URL handler. 127.0.0.1 only — same trust model as
		// /api/local-ai/* and /api/tray-state.
		async (ctx) => {
			const { req, path, json, error } = ctx;
			if (req.method !== "POST" || path !== "/api/url-scheme/dispatch") return null;
			let body: { url?: string } = {};
			try {
				body = (await req.json()) as typeof body;
			} catch {
				return error("invalid JSON body", 400);
			}
			const url = typeof body.url === "string" ? body.url.trim() : "";
			if (!url || !url.startsWith("detour:")) {
				return error("body.url must be a detour:// URL", 400);
			}
			const dispatch = getUrlSchemeDispatcher();
			if (!dispatch) return error("url-scheme feature not initialised", 503);
			const ok = dispatch(url);
			return json({ ok });
		},
		// Debug: invoke an eliza action by name directly through the built
		// runtime, bypassing the LLM action selector. Used to validate the
		// carrot bridge end-to-end (and any other plugin's actions) without
		// depending on chat path / model availability.
		//
		// DEV-ONLY. The endpoint exposes ANY registered action by name —
		// vault-tools, x-tweets, channel actions, etc. — to anything that
		// can reach 127.0.0.1:2138. We keep it gated to dev .app builds
		// (mirrors view-url.ts's dev-mode detection) so it never appears
		// in canary/stable artifacts. Override with DETOUR_ALLOW_DEBUG_API=1.
			(ctx) => this.handleDebugAction(ctx),
		// Debug: probe embedding pipeline end-to-end. Used by the LocalAI
		// settings tab which pings via raw fetch — keeping it on HTTP since
		// the diagnostic intentionally bypasses RPC plumbing to detect
		// runtime mounting issues.
		async (ctx) => {
			const { req, path } = ctx;
			if (req.method === "POST" && path === "/api/debug/embedding") {
				return this.debugEmbedding(ctx);
			}
			return null;
		},
		// Eval API for external coding-agent drivers. The entire /api/eval/*
		// surface is gated by DETOUR_EVAL_TOKEN — when unset, returns 404.
		async (ctx) => {
			const { req, url, path, json, error } = ctx;
			if (!path.startsWith("/api/eval/")) return null;
			const route = evalRoutes(
				{
					runtime: this.runtime,
					activity: this.activity,
					...(this.selfImprovement?.dream
						? { dream: this.selfImprovement.dream }
						: {}),
					...(this.selfImprovement?.improvement
						? { improvement: this.selfImprovement.improvement }
						: {}),
					...(this.selfImprovement?.agentHfSync
						? { agentHfSync: this.selfImprovement.agentHfSync }
						: {}),
					...(this.selfImprovement?.localChat
						? { localChat: this.selfImprovement.localChat }
						: {}),
					...(this.selfImprovement?.companion
						? { companion: this.selfImprovement.companion }
						: {}),
					...(this.selfImprovement?.pensieve
						? { pensieve: this.selfImprovement.pensieve }
						: {}),
					...(this.selfImprovement?.config
						? { config: this.selfImprovement.config }
						: {}),
				},
				{ json, error },
			);
			return route(req, url, path);
		},
		// Static-file fallback for the bundled view assets. Lets the
		// WKWebView (or an external browser, e.g. when the OAuth redirect
		// loads our redirect URL via a Cloudflare Tunnel) load
		// `views/main/index.html` + sibling assets over HTTP. Only kicks
		// in for GET requests that haven't matched any /api/* route.
		async (ctx) => {
			const { req, path } = ctx;
			if (req.method !== "GET" && req.method !== "HEAD") return null;
			if (path.startsWith("/api/")) return null;
			return serveStaticAsset(path);
		},
	];

	private async handleHttpRequest(
		req: Request,
		responses: ApiResponseHelpers,
	): Promise<Response | undefined> {
		const url = new URL(req.url);
		const path = url.pathname;

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
		for (const [id, waiter] of this.browserWaiters.entries()) {
			clearTimeout(waiter.timer);
			waiter.resolve({ ok: false, error: `Browser command ${id} canceled because API server stopped.`, time: Date.now() });
		}
		this.browserWaiters.clear();
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
			logger.error({ src: "api", lockFile: this.lockFile, err: errorMessage(err) }, "[ApiServer] failed to write runtime lockfile");
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
