import type { Memory, UUID } from "@elizaos/core";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeService } from "../runtime";
import type { ActivityService } from "../activity";
import { broadcaster } from "../rpc/registry";
import { evalRoutes } from "./eval-routes";
import type {
	BrowserCommand,
	BrowserCommandInput,
	BrowserCommandResult,
} from "../../../shared/index";

const VERSION = "0.0.1";

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
				console.warn(`[core] port ${preferredPort} in use, falling back to ephemeral`);
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
		async (ctx) => {
			const { req, path, json, error } = ctx;
			if (req.method !== "POST" || path !== "/api/debug/action") return null;
			const isDevBundle = typeof process.execPath === "string" && process.execPath.includes("Detour-dev.app/");
			const allowOverride = process.env.DETOUR_ALLOW_DEBUG_API === "1";
			if (!isDevBundle && !allowOverride) return error("debug API disabled in this build", 404);
			let body: { name?: string; options?: Record<string, unknown> } = {};
			try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON body", 400); }
			if (!body.name) return error("missing 'name'", 400);
			const state = await this.runtime.getOrBuild();
			if (!state) return error("runtime not built — no LLM provider configured", 503);
			const live = this.runtime.peek();
			if (!live) return error("runtime not live", 503);
			const liveActions = (live as unknown as { actions?: Array<{ name: string; handler: (...a: unknown[]) => unknown }> }).actions ?? [];
			const action = liveActions.find((a) => a.name === body.name);
			if (!action) return error(`action '${body.name}' not registered on runtime`, 404);
			const emits: { text: string; action: string }[] = [];
			const callback = async (p: { text: string; action: string }) => { emits.push({ text: p.text, action: p.action }); return []; };
			const fakeMemory = {
				id: "00000000-0000-0000-0000-000000000000",
				entityId: "00000000-0000-0000-0000-000000000001",
				roomId: "00000000-0000-0000-0000-000000000002",
				content: { text: "" },
			};
			const fakeState = { values: {}, data: {}, text: "" };
			const t0 = Date.now();
			try {
				const result = await action.handler(live, fakeMemory, fakeState, body.options ?? {}, callback);
				return json({ ok: true, action: body.name, durationMs: Date.now() - t0, emits, result });
			} catch (err) {
				return error(`action handler threw: ${err instanceof Error ? err.message : String(err)}`, 500);
			}
		},
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
				{ runtime: this.runtime, activity: this.activity },
				{ json, error },
			);
			return route(req, url, path);
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
