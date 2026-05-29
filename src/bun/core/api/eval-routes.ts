/**
 * Eval-API routes for external coding-agent drivers.
 *
 *   GET  /api/eval/health        → { ok, runtimeBuilt, activeProvider, capActive }
 *   POST /api/eval/send          → drive a turn; returns { ok, traceId, reply, durationMs }
 *                                  body: { text, wait?, timeoutMs?,
 *                                          source?, callerId?, conversationId?,
 *                                          callbackUrl?, callbackEmail? }
 *   GET  /api/eval/trajectory/:id           → full ActivityTrajectoryDetail JSON
 *   GET  /api/eval/trajectory/:id/simple    → SimpleView extract (request/reply/thinking/actions)
 *   GET  /api/eval/trajectories             → list of recent trajectory summaries
 *                                              (?limit&status — same options as the RPC handler)
 *
 * Agent-to-agent features:
 *   - source / callerId: tag prompts with the caller's identity (logged in trajectory)
 *   - conversationId: multi-turn threading — calls with the same id share eliza room context
 *   - callbackUrl: webhook — POST { traceId, reply, durationMs, conversationId } when done
 *   - callbackEmail: send the reply as an AgentMail email to this address
 *
 * Authentication: every route requires the `X-Detour-Eval-Token` header
 * to match the `DETOUR_EVAL_TOKEN` env var. If the env var is unset the
 * entire eval API returns 404 — the surface only exists when the user
 * explicitly opts in by setting a token. This prevents any local process
 * from prompting the agent without the user's consent.
 *
 * Surface is intentionally small and stable so external agents can
 * scriptedly drive Detour through paces (build an app, post a tweet,
 * grade the trajectory) without touching RPC or the UI.
 */

import type { ActivityService } from "../activity";
import type { RuntimeService } from "../runtime";
import type { DreamService } from "../dream-service";
import type { ContinuousImprovementService } from "../continuous-improvement-service";
import type { AgentHfSyncService } from "../agent-hf-sync-service";
import type { TrajectoryLearningService } from "../trajectory-learning-service";
import type { LocalChatService } from "../llama/chat-service";
import type { CompanionService } from "../llama/companion-service";
import type { PensieveService } from "../pensieve";
import type { ConfigService } from "../config-service";
import { logger } from "@elizaos/core";
import { extractSimpleView } from "../../../main/activity/trajectory-extractors";
import { narrate } from "../agent-narrator";
import { EVAL_WRITABLE_SETTING_KEYS } from "../../../shared/settings-registry";
import { ConversationCondenserService } from "../pensieve/conversation-condenser";

type Json = (data: unknown, status?: number) => Response;
type ErrorJson = (message: string, status?: number) => Response;
type EvalRouteHandler = (ctx: EvalRequestContext) => Promise<Response | null>;

export interface EvalRouteDeps {
	runtime: RuntimeService;
	activity: ActivityService;
	dream?: DreamService;
	improvement?: ContinuousImprovementService;
	agentHfSync?: AgentHfSyncService;
	trajectoryLearning?: TrajectoryLearningService;
	localChat?: LocalChatService;
	companion?: CompanionService;
	pensieve?: PensieveService;
	config?: ConfigService;
}

export interface EvalRouteHelpers {
	json: Json;
	error: ErrorJson;
}

interface EvalRequestContext {
	deps: EvalRouteDeps;
	req: Request;
	url: URL;
	path: string;
	json: Json;
	error: ErrorJson;
}

export function evalApiEnabled(): boolean {
	const token = process.env.DETOUR_EVAL_TOKEN;
	return typeof token === "string" && token.length >= 8;
}

function authorized(req: Request): boolean {
	const expected = process.env.DETOUR_EVAL_TOKEN;
	if (!expected || expected.length < 8) return false;
	const provided = req.headers.get("x-detour-eval-token") ?? "";
	return provided === expected;
}

interface SendBody {
	text?: unknown;
	wait?: unknown;
	timeoutMs?: unknown;
	/** Source identifier — e.g. "codex", "claude", "cron:daily-review". */
	source?: unknown;
	/** Opaque caller identifier for distinguishing prompt origins. */
	callerId?: unknown;
	/** Conversation thread id — consecutive calls with the same id share eliza room context. */
	conversationId?: unknown;
	/** Webhook URL — when the turn completes, POST { traceId, reply, durationMs, conversationId } here. */
	callbackUrl?: unknown;
	/** AgentMail address — send the reply as an email to this address. */
	callbackEmail?: unknown;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asBool(value: unknown, dflt: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value === "true" || value === "1";
	return dflt;
}

function asNumber(value: unknown, dflt: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	return dflt;
}

/**
 * Drive one turn through `runtime.sendMessage`. Resolves with the full
 * reply text and elapsed time when `wait=true` (default). When `wait=false`
 * returns immediately with `traceId: null, reply: null` — caller polls
 * `/api/eval/trajectories?limit=1` to discover the trajectory id and then
 * pulls `/api/eval/trajectory/:id`.
 *
 * The traceId returned here is best-effort: we observe the first delta
 * and read the `traceId` baggage off the most recent trajectory, since
 * sendMessage itself doesn't return one.
 */
async function driveTurn(
	deps: EvalRouteDeps,
	text: string,
	timeoutMs: number,
	opts?: {
		source?: string;
		callerId?: string;
		conversationId?: string;
	},
): Promise<{ reply: string; durationMs: number; trajectoryId: string | null; conversationId?: string }> {
	const { broadcaster } = await import("../rpc/registry");
	// Real narration via the local companion model. Falls back to a
	// canned summary when the companion isn't running so the bubble is
	// never silent.
	const echo = text.length > 60 ? text.slice(0, 60) + "…" : text;
	const sourceLabel = opts?.source ? ` [${opts.source}]` : "";
	narrate(deps.companion, {
		kind: "turn-start",
		fact: `User${sourceLabel} just asked: "${echo}"`,
		fallback: `Thinking about: ${echo}`,
		traceId: "eval-send",
	});
	const chunks: string[] = [];
	const onDelta = (delta: string): void => {
		chunks.push(delta);
		broadcaster.broadcast("chatDelta", {
			convId: opts?.conversationId ?? "default",
			delta,
			traceId: "eval-send",
			source: opts?.source,
		});
	};
	const started = Date.now();
	// Inject source/caller metadata into the prompt so it's captured
	// in trajectory logs. The runtime.sendMessage API takes a plain
	// string, so we prepend a structured header that the agent can see.
	const metaHeader =
		opts?.source || opts?.callerId
			? `[source=${opts.source ?? "unknown"} caller=${opts.callerId ?? "anonymous"} conversation=${opts.conversationId ?? "none"}]\n`
			: "";
	const sendPromise = deps.runtime.sendMessage(metaHeader + text, onDelta, {
		source: opts?.source ?? "eval",
		conversationId: opts?.conversationId,
	});
	let sendTimer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		sendTimer = setTimeout(
			() => reject(new Error(`eval send timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		await Promise.race([sendPromise, timeoutPromise]);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		narrate(deps.companion, {
			kind: "turn-error",
			fact: `Turn failed: ${msg}`,
			fallback: `Turn failed: ${msg.slice(0, 80)}`,
			traceId: "eval-send",
		});
		throw err;
	} finally {
		clearTimeout(sendTimer);
	}
	const durationMs = Date.now() - started;
	const reply = chunks.join("");
	const list = await deps.activity.trajectories.list({
		limit: 1,
		source: "tray-app",
	});
	const trajectoryId = list.trajectories[0]?.id ?? null;
	// Final broadcast — chat surfaces finalize their bubbles, the
	// notification manager fires a banner, the pet bubble flips from
	// "thinking" to the actual reply.
	broadcaster.broadcast("chatComplete", {
		convId: opts?.conversationId ?? "default",
		text: reply,
		summary: reply.slice(0, 200),
		trajectoryId,
		durationMs,
		traceId: "eval-send",
		source: opts?.source,
	});
	return { reply, durationMs, trajectoryId, conversationId: opts?.conversationId };
}

export function evalRoutes(deps: EvalRouteDeps, helpers: EvalRouteHelpers) {
	const { error } = helpers;

	return async (req: Request, url: URL, path: string): Promise<Response | null> => {
		if (!path.startsWith("/api/eval/")) return null;
		if (!evalApiEnabled()) return error("eval API disabled — set DETOUR_EVAL_TOKEN", 404);
		if (!authorized(req)) return error("missing or invalid X-Detour-Eval-Token", 401);

		const ctx: EvalRequestContext = {
			deps,
			req,
			url,
			path,
			json: helpers.json,
			error,
		};

		for (const handler of evalRouteHandlers) {
			const response = await handler(ctx);
			if (response) return response;
		}

		return error("not found", 404);
	};
}

const evalRouteHandlers: EvalRouteHandler[] = [
	handleCoreEvalRoutes,
	handlePensieveEvalRoutes,
	handleSkillsEvalRoutes,
	handleActionEvalRoutes,
	handleRuntimeSettingsRoutes,
	handleCharacterEvalRoutes,
	handleLogsAndEventsRoutes,
	handleDreamEvalRoutes,
	handleHfSyncEvalRoutes,
	handleLocalChatEvalRoutes,
	handleCompanionEvalRoutes,
	handleContactEvalRoutes,
];

async function firstRoute(ctx: EvalRequestContext, handlers: readonly EvalRouteHandler[]): Promise<Response | null> {
	for (const handler of handlers) {
		const response = await handler(ctx);
		if (response) return response;
	}
	return null;
}

async function handleCoreEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	return firstRoute(ctx, [
		handleHealthRoute,
		handleSendRoute,
		handleTrajectoryRoute,
		handleTrajectoriesRoute,
	]);
}

async function handleHealthRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json } = ctx;

	if (req.method === "GET" && path === "/api/eval/health") {
		const peek = deps.runtime.peek();
		return json({
			ok: true,
			runtimeBuilt: peek !== null,
			activeProvider: deps.runtime.getCurrentProvider(),
			agentName: typeof peek?.character?.name === "string" ? peek.character.name : null,
		});
	}

	return null;
}

async function handleSendRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/send") {
		let body: SendBody = {};
		try {
			body = (await req.json()) as SendBody;
		} catch {
			return error("invalid JSON body", 400);
		}
		const text = asString(body.text);
		if (!text) return error("missing 'text' field", 400);
		const wait = asBool(body.wait, true);
		const timeoutMs = asNumber(body.timeoutMs, 90_000);
		const source = asString(body.source) ?? undefined;
		const callerId = asString(body.callerId) ?? undefined;
		const conversationId = asString(body.conversationId) ?? undefined;
		const callbackUrl = asString(body.callbackUrl) ?? undefined;
		const callbackEmail = asString(body.callbackEmail) ?? undefined;

		if (source || callerId) {
			logger.info(
				{ src: "eval", source, callerId, conversationId },
				"eval/send with source metadata",
			);
		}

		if (!wait) {
			// Fire-and-forget, then deliver callback when done
			void (async () => {
				try {
					const result = await driveTurn(deps, text, timeoutMs, { source, callerId, conversationId });
					if (callbackUrl) {
						void fireCallback(callbackUrl, result).catch((err) =>
							logger.warn({ src: "eval", err: err instanceof Error ? err.message : err }, "callback delivery failed"),
						);
					}
				} catch (err) {
					logger.warn(
						{ src: "eval", err: err instanceof Error ? err.message : err, source },
						"async send failed",
					);
				}
			})();
			return json({ ok: true, async: true, reply: null, trajectoryId: null, source, conversationId });
		}

		try {
			const result = await driveTurn(deps, text, timeoutMs, { source, callerId, conversationId });
			// Fire webhook callback in the background if provided
			if (callbackUrl) {
				void fireCallback(callbackUrl, result).catch((err) =>
					logger.warn({ src: "eval", err: err instanceof Error ? err.message : err }, "callback delivery failed"),
				);
			}
			return json({ ok: true, ...result, source, callerId });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return error(msg, 500);
		}
	}

	return null;
}

/**
 * Fire a webhook callback to the caller's URL after a turn completes.
 * Best-effort — logs failures but does not retry.
 */
async function fireCallback(
	callbackUrl: string,
	result: { reply: string; durationMs: number; trajectoryId: string | null; conversationId?: string },
): Promise<void> {
	const CALLBACK_TIMEOUT_MS = 10_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
	try {
		const res = await fetch(callbackUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				traceId: result.trajectoryId,
				reply: result.reply,
				durationMs: result.durationMs,
				conversationId: result.conversationId,
				completedAt: new Date().toISOString(),
			}),
			signal: controller.signal,
		});
		logger.info(
			{ src: "eval", callbackUrl, status: res.status },
			"callback delivered",
		);
	} finally {
		clearTimeout(timer);
	}
}

async function handleTrajectoryRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "GET" && path.startsWith("/api/eval/trajectory/")) {
		const tail = path.slice("/api/eval/trajectory/".length);
		const [id, sub] = tail.split("/");
		if (!id) return error("trajectory id required", 400);
		const detail = await deps.activity.trajectories.get(id);
		if (!detail.trajectory) return error("trajectory not found", 404);
		if (sub === "simple") return json({ ok: true, ...extractSimpleView(detail) });
		if (!sub) return json({ ok: true, detail });
		return error("unknown trajectory subresource", 404);
	}

	return null;
}

async function handleTrajectoriesRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, url, path, json } = ctx;

	if (req.method === "GET" && path === "/api/eval/trajectories") {
		const limit = asNumber(url.searchParams.get("limit"), 20);
		const status = url.searchParams.get("status") ?? undefined;
		const result = await deps.activity.trajectories.list({
			limit,
			...(status ? { status } : {}),
		});
		return json({ ok: true, ...result });
	}

	return null;
}

async function handlePensieveEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, url, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/memories") {
		if (!deps.pensieve) return error("pensieve service not wired", 503);
		const limit = asNumber(url.searchParams.get("limit"), 50);
		const tableName = url.searchParams.get("tableName") ?? undefined;
		const memories = await deps.pensieve.memories.list({
			limit,
			...(tableName ? { tableName } : {}),
		});
		return json({ ok: true, memories });
	}

	if (req.method === "GET" && path === "/api/eval/entities") {
		if (!deps.pensieve) return error("pensieve service not wired", 503);
		const limit = asNumber(url.searchParams.get("limit"), 100);
		const entities = await deps.pensieve.relationships.listPersons(limit);
		return json({ ok: true, entities });
	}

	return null;
}

async function handleSkillsEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	const { req, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/skills") {
		let skills: Array<{ id: string; label: string; description: string | null; enabled: boolean; actionCount: number | null }> = [];
		try {
			const mod = await import("@elizaos/skills");
			const result = mod.loadSkills();
			const list = (result.skills as Array<{ name: string; description?: string; enabled?: boolean; metadata?: { actions?: unknown[] } }>);
			skills = list.map((s) => ({
				id: s.name,
				label: s.name,
				description: typeof s.description === "string" && s.description.length > 0 ? s.description : null,
				enabled: s.enabled !== false,
				actionCount: Array.isArray(s.metadata?.actions) ? s.metadata!.actions!.length : null,
			}));
		} catch (err) {
			logger.warn(
				{ src: "eval:skills", err: err instanceof Error ? err.message : err },
				"[EvalRoutes] loadSkills failed",
			);
		}
		skills.sort((a, b) => a.id.localeCompare(b.id));
		return json({ ok: true, skills });
	}

	if (req.method === "POST" && path.startsWith("/api/eval/skills/")) {
		const id = path.slice("/api/eval/skills/".length);
		if (!id) return error("skill id required", 400);
		let body: { enabled?: boolean } = {};
		try { body = (await req.json()) as typeof body; } catch { return error("invalid body", 400); }
		if (typeof body.enabled !== "boolean") return error("enabled must be a boolean", 400);
		const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { join: joinPath } = await import("node:path");
		const { homedir } = await import("node:os");
		const stateDir = joinPath(homedir(), ".detour");
		const statePath = joinPath(stateDir, "skill-enablement.json");
		let state: Record<string, boolean> = {};
		if (existsSync(statePath)) {
			try { state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, boolean>; }
			catch { state = {}; }
		}
		state[id] = body.enabled;
		try {
			if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
			writeFileSync(statePath, JSON.stringify(state, null, 2));
		} catch (err) {
			return error(err instanceof Error ? err.message : "write failed", 500);
		}
		return json({ ok: true, id, enabled: body.enabled });
	}

	return null;
}

async function handleActionEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/actions") {
		const live = deps.runtime.peek();
		if (!live) return error("runtime not live", 503);
		const liveActions = (live as unknown as {
			actions?: Array<{ name: string; description?: string; similes?: string[] }>;
		}).actions ?? [];
		const summary = liveActions.map((a) => ({
			name: a.name,
			description: a.description ?? null,
			similes: a.similes ?? [],
		})).sort((a, b) => a.name.localeCompare(b.name));
		return json({ ok: true, count: summary.length, actions: summary });
	}

	if (req.method !== "POST" || path !== "/api/eval/action/run") return null;

	let body: { name?: string; options?: Record<string, unknown> } = {};
	try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON", 400); }
	if (!body.name) return error("missing 'name'", 400);
	const state = await deps.runtime.getOrBuild();
	if (!state) return error("runtime not built", 503);
	const live = deps.runtime.peek();
	if (!live) return error("runtime not live", 503);
	const liveActions = (live as unknown as {
		actions?: Array<{ name: string; handler: (...a: unknown[]) => unknown }>;
	}).actions ?? [];
	const action = liveActions.find((a) => a.name === body.name);
	if (!action) return error(`action '${body.name}' not registered`, 404);
	const emits: { text: string; action: string }[] = [];
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
	const t0 = Date.now();
	try {
		const result = await action.handler(live, fakeMemory, fakeState, body.options ?? {}, callback);
		return json({ ok: true, action: body.name, durationMs: Date.now() - t0, emits, result });
	} catch (err) {
		return json({
			ok: false,
			action: body.name,
			durationMs: Date.now() - t0,
			emits,
			error: err instanceof Error ? err.message : String(err),
		}, 200);
	}
}

async function handleRuntimeSettingsRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	return firstRoute(ctx, [
		handleSettingsWriteRoute,
		handleActivePetRoute,
		handlePlannerTierGetRoute,
		handlePlannerTierPostRoute,
		handleModelsGetRoute,
		handleModelsPostRoute,
	]);
}

async function handleSettingsWriteRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { req, path } = ctx;

	if (req.method === "POST" && path === "/api/eval/settings") {
		return handleSettingsWrite(ctx);
	}

	return null;
}

async function handleActivePetRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { req, path } = ctx;

	if (req.method === "POST" && path === "/api/eval/active-pet") {
		return handleActivePet(ctx);
	}

	return null;
}

async function handlePlannerTierGetRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { req, path, json } = ctx;

	if (req.method === "GET" && path === "/api/eval/planner-tier") {
		return json({ ok: true, tier: process.env.DETOUR_PLANNER_TIER ?? "" });
	}

	return null;
}

async function handlePlannerTierPostRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/planner-tier") {
		let body: { tier?: string } = {};
		try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON", 400); }
		const raw = (body.tier ?? "").trim().toUpperCase();
		const valid = ["", "TEXT_SMALL", "TEXT_MEDIUM", "TEXT_LARGE"];
		if (!valid.includes(raw)) return error("tier must be TEXT_SMALL/MEDIUM/LARGE or empty", 400);
		if (raw === "") delete process.env.DETOUR_PLANNER_TIER;
		else process.env.DETOUR_PLANNER_TIER = raw;
		return json({ ok: true, tier: process.env.DETOUR_PLANNER_TIER ?? "" });
	}

	return null;
}

async function handleModelsGetRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/models") {
		if (!deps.config) return error("config service not wired", 503);
		const models = await deps.config.getModels();
		return json({ ok: true, models });
	}

	return null;
}

async function handleModelsPostRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/models") {
		if (!deps.config) return error("config service not wired", 503);
		let body: unknown;
		try { body = await req.json(); } catch { return error("invalid JSON", 400); }
		await deps.config.setModels(body as never);
		const models = await deps.config.getModels();
		return json({ ok: true, models });
	}

	return null;
}

async function handleSettingsWrite(ctx: EvalRequestContext): Promise<Response> {
	const { req, json, error } = ctx;
	let body: { key?: string; value?: string } = {};
	try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON", 400); }
	const key = typeof body.key === "string" ? body.key.trim() : "";
	const value = typeof body.value === "string" ? body.value : "";
	if (!key) return error("missing 'key'", 400);
	const allowed: ReadonlySet<string> = new Set(EVAL_WRITABLE_SETTING_KEYS);
	if (!allowed.has(key)) return error(`setting '${key}' not allowed via eval API`, 403);
	process.env[key] = value;
	return json({ ok: true, key, value });
}

async function handleActivePet(ctx: EvalRequestContext): Promise<Response> {
	const { deps, req, json, error } = ctx;
	let body: {
		petId?: string;
		persona?: string;
		skills?: string[];
		companionPreset?: string;
		startCompanion?: boolean;
	} = {};
	try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON", 400); }
	const petId = typeof body.petId === "string" ? body.petId : "";
	if (petId) process.env.DETOUR_ACTIVE_PET = petId;
	if (typeof body.persona === "string") process.env.DETOUR_PET_PERSONA = body.persona;
	if (Array.isArray(body.skills)) process.env.DETOUR_PET_SKILLS = body.skills.join(",");
	if (body.startCompanion && deps.companion && typeof body.companionPreset === "string") {
		const result = await deps.companion.start({ preset: body.companionPreset });
		return json({
			ok: true,
			petId: process.env.DETOUR_ACTIVE_PET,
			persona: process.env.DETOUR_PET_PERSONA,
			skills: process.env.DETOUR_PET_SKILLS,
			companionStarted: result !== null,
			companionUrl: result?.url ?? null,
		});
	}
	return json({
		ok: true,
		petId: process.env.DETOUR_ACTIVE_PET,
		persona: process.env.DETOUR_PET_PERSONA,
		skills: process.env.DETOUR_PET_SKILLS,
	});
}

async function handleCharacterEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	return firstRoute(ctx, [
		handleCharacterGetRoute,
		handleCharacterPostRoute,
		handleCharacterGenerateRoute,
	]);
}

async function handleCharacterGetRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/character") {
		if (!deps.config) return error("config service not wired", 503);
		const character = await deps.config.getCharacter();
		return json({ ok: true, character });
	}

	return null;
}

async function handleCharacterPostRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/character") {
		if (!deps.config) return error("config service not wired", 503);
		let body: unknown;
		try { body = await req.json(); } catch { return error("invalid JSON", 400); }
		const character = await deps.config.setCharacter(body as never);
		return json({ ok: true, character });
	}

	return null;
}

interface CharacterGenerateInput {
	section: string;
	count: number;
	hint: string;
	existing: string[];
}

async function readCharacterGenerateInput(ctx: EvalRequestContext): Promise<CharacterGenerateInput | Response> {
	let body: { section?: unknown; existing?: unknown; count?: unknown; hint?: unknown } = {};
	try {
		body = await ctx.req.json();
	} catch {
		return ctx.error("invalid JSON", 400);
	}

	const section = typeof body.section === "string" ? body.section : "";
	if (!section) return ctx.error("section is required", 400);

	return {
		section,
		count: typeof body.count === "number" && body.count > 0 && body.count <= 10 ? body.count : 3,
		hint: typeof body.hint === "string" ? body.hint : "",
		existing: Array.isArray(body.existing)
			? body.existing.filter((value): value is string => typeof value === "string").slice(0, 50)
			: [],
	};
}

function characterGeneratePrompt(input: CharacterGenerateInput, character: Awaited<ReturnType<ConfigService["getCharacter"]>> | null): string {
	const lines = [
		`You are helping author the character file for the agent "${character?.name ?? "this agent"}".`,
		`Current persona: ${character?.system ?? "(none)"}.`,
		`Generate exactly ${input.count} new entries for the '${input.section}' section.`,
		`Output one entry per line, no numbering, no quotes, no commentary, no blank lines.`,
		input.existing.length > 0
			? `Existing entries (don't duplicate):\n${input.existing.map((entry) => `- ${entry}`).join("\n")}`
			: "",
		input.hint ? `Additional guidance from the user: ${input.hint}` : "",
		`Respond with ONLY the ${input.count} new entries — nothing else.`,
	].filter(Boolean);
	return lines.join("\n\n");
}

function characterSuggestions(text: string, count: number): string[] {
	return text.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.replace(/^[\s\-\*\d\.\)]+/, "").replace(/^"|"$/g, "").trim())
		.filter((line) => line.length > 0)
		.slice(0, count);
}

async function handleCharacterGenerateRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method !== "POST" || path !== "/api/eval/character/generate") return null;

	const input = await readCharacterGenerateInput(ctx);
	if (input instanceof Response) return input;

	const character = deps.config ? await deps.config.getCharacter() : null;
	const chunks: string[] = [];
	try {
		await deps.runtime.sendMessage(characterGeneratePrompt(input, character), (d) => chunks.push(d), { source: "eval:character-gen" });
	} catch (err) {
		return error(err instanceof Error ? err.message : "generate failed", 500);
	}
	return json({ ok: true, section: input.section, suggestions: characterSuggestions(chunks.join(""), input.count) });
}

async function handleLogsAndEventsRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, url, path, json } = ctx;

	if (req.method === "GET" && path === "/api/eval/logs") {
		const limit = asNumber(url.searchParams.get("limit"), 200);
		const minLevel = url.searchParams.get("minLevel") ?? undefined;
		const entries = deps.activity.logs.list({
			limit,
			...(minLevel ? { minLevel: parseInt(minLevel, 10) } : {}),
		});
		return json({ ok: true, entries });
	}

	if (req.method !== "GET" || path !== "/api/eval/events") return null;

	const namesParam = url.searchParams.get("names");
	const names = namesParam
		? new Set(namesParam.split(",").map((s) => s.trim()).filter(Boolean))
		: null;
	const { registerWindow } = await import("../rpc/registry");
	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			let closed = false;
			const send = (name: string, payload: unknown): void => {
				if (closed) return;
				if (names && !names.has(name)) return;
				try {
					const line = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
					controller.enqueue(enc.encode(line));
				} catch {
					closed = true;
					unsubscribe();
				}
			};
			const unsubscribe = registerWindow(send);
			const heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(enc.encode(`: heartbeat\n\n`));
				} catch {
					closed = true;
				}
			}, 15000);
			(controller as unknown as { cancelHook?: () => void }).cancelHook = () => {
				closed = true;
				clearInterval(heartbeat);
				unsubscribe();
			};
			controller.enqueue(enc.encode(`event: hello\ndata: {"ok":true}\n\n`));
		},
		cancel() {
			const hook = (this as unknown as { cancelHook?: () => void }).cancelHook;
			hook?.();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

async function handleDreamEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	return firstRoute(ctx, [
		handleDreamsGetRoute,
		handleDreamRunRoute,
		handleDreamApplyRoute,
		handleDreamRejectRoute,
	]);
}

async function handleDreamsGetRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/dreams") {
		if (!deps.dream) return error("dream service not wired", 503);
		const snapshot = await deps.dream.snapshot();
		return json({ ok: true, ...snapshot });
	}

	return null;
}

async function handleDreamRunRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/dreams/run") {
		if (!deps.dream) return error("dream service not wired", 503);
		let body: { instructions?: unknown } = {};
		try { body = (await req.json()) as { instructions?: unknown }; } catch { /* optional body */ }
		const instructions = asString(body.instructions);
		const result = await deps.dream.runNow(instructions ? { instructions } : {});
		return json({
			ok: true,
			planId: result.planId ?? null,
			plan: result.plan,
			skipReason: result.skipReason ?? null,
		});
	}

	return null;
}

async function handleDreamApplyRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path.startsWith("/api/eval/dreams/apply/")) {
		if (!deps.dream) return error("dream service not wired", 503);
		const id = path.slice("/api/eval/dreams/apply/".length);
		if (!id) return error("dream id required", 400);
		const result = await deps.dream.apply(id);
		return json({ ok: true, ...result });
	}

	return null;
}

async function handleDreamRejectRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path.startsWith("/api/eval/dreams/reject/")) {
		if (!deps.dream) return error("dream service not wired", 503);
		const id = path.slice("/api/eval/dreams/reject/".length);
		if (!id) return error("dream id required", 400);
		const result = await deps.dream.reject(id);
		return json({ ok: true, ...result });
	}

	return null;
}

async function handleHfSyncEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	return firstRoute(ctx, [
		handleHfSyncGetRoute,
		handleHfSyncRunRoute,
		handleHfSyncCheckRoute,
		handleTrajectoryLearningRunRoute,
	]);
}

async function handleTrajectoryLearningRunRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;
	if (req.method === "POST" && path === "/api/eval/trajectory-learning/run") {
		if (!deps.trajectoryLearning) return error("trajectory-learning service not wired", 503);
		try {
			const result = await deps.trajectoryLearning.tick();
			return json({ ok: true, result });
		} catch (err) {
			return error(err instanceof Error ? err.message : String(err), 500);
		}
	}
	return null;
}

async function handleHfSyncGetRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/hf-sync") {
		if (!deps.agentHfSync) return error("hf-sync service not wired", 503);
		const status = await deps.agentHfSync.status();
		return json({ ok: true, ...status });
	}

	return null;
}

async function handleHfSyncRunRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/hf-sync/run") {
		if (!deps.agentHfSync) return error("hf-sync service not wired", 503);
		let body: { reason?: unknown; destination?: unknown; limit?: unknown } = {};
		try {
			body = (await req.json()) as typeof body;
		} catch { /* optional body */ }
		const reason = asString(body.reason) ?? "manual";
		try {
			const job = await deps.agentHfSync.startSync(
				reason as "manual" | "startup" | "daily" | "trajectory-threshold",
				{
					...(asString(body.destination)
						? { destination: asString(body.destination) as string }
						: {}),
					...(typeof body.limit === "number" && body.limit > 0 ? { limit: body.limit } : {}),
				},
			);
			return json({ ok: true, job });
		} catch (err) {
			return error(err instanceof Error ? err.message : String(err), 500);
		}
	}

	return null;
}

async function handleHfSyncCheckRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/hf-sync/check") {
		if (!deps.agentHfSync) return error("hf-sync service not wired", 503);
		try {
			const job = await deps.agentHfSync.checkNow();
			return json({ ok: true, job });
		} catch (err) {
			return error(err instanceof Error ? err.message : String(err), 500);
		}
	}

	return null;
}

async function handleLocalChatEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	return firstRoute(ctx, [
		handleLocalChatGetRoute,
		handleLocalChatStartRoute,
		handleLocalChatStopRoute,
	]);
}

async function handleLocalChatGetRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/local-chat") {
		if (!deps.localChat) return error("local-chat service not wired", 503);
		return json({ ok: true, ...deps.localChat.status() });
	}

	return null;
}

async function handleLocalChatStartRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/local-chat/start") {
		if (!deps.localChat) return error("local-chat service not wired", 503);
		let body: { preset?: unknown; customModelRef?: unknown; contextSize?: unknown } = {};
		try { body = (await req.json()) as typeof body; } catch { /* optional body */ }
		const config: { preset?: string; customModelRef?: string; contextSize?: number } = {};
		const preset = asString(body.preset);
		if (preset) config.preset = preset;
		const customRef = asString(body.customModelRef);
		if (customRef) config.customModelRef = customRef;
		if (typeof body.contextSize === "number" && body.contextSize > 0) {
			config.contextSize = body.contextSize;
		}
		try {
			process.env.DETOUR_LOCAL_CHAT_ENABLED = "true";
			const result = await deps.localChat.start(config);
			if (!result) {
				return error(deps.localChat.status().lastError ?? "local-chat failed to start", 500);
			}
			return json({ ok: true, ...result, ...deps.localChat.status() });
		} catch (err) {
			return error(err instanceof Error ? err.message : String(err), 500);
		}
	}

	return null;
}

async function handleLocalChatStopRoute(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "POST" && path === "/api/eval/local-chat/stop") {
		if (!deps.localChat) return error("local-chat service not wired", 503);
		deps.localChat.stop();
		delete process.env.DETOUR_LOCAL_CHAT_ENABLED;
		return json({ ok: true, ...deps.localChat.status() });
	}

	return null;
}

async function handleCompanionEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	if (req.method === "GET" && path === "/api/eval/companion") {
		if (!deps.companion) return error("companion not wired", 503);
		return json({ ok: true, ...deps.companion.status() });
	}

	if (req.method === "POST" && path === "/api/eval/companion/start") {
		return handleCompanionStart(ctx);
	}

	if (req.method === "POST" && path === "/api/eval/companion/stop") {
		if (!deps.companion) return error("companion not wired", 503);
		deps.companion.stop();
		delete process.env.DETOUR_COMPANION_ENABLED;
		return json({ ok: true, ...deps.companion.status() });
	}

	if (req.method === "POST" && path === "/api/eval/companion/assignments") {
		return handleCompanionAssignments(ctx);
	}

	if (req.method === "POST" && path === "/api/eval/companion/job") {
		return handleCompanionJob(ctx);
	}

	return null;
}

async function handleCompanionStart(ctx: EvalRequestContext): Promise<Response> {
	const { deps, req, json, error } = ctx;
	if (!deps.companion) return error("companion not wired", 503);
	let body: { modelRef?: unknown; contextSize?: unknown; preset?: unknown } = {};
	try { body = (await req.json()) as typeof body; } catch { /* optional body */ }
	const config: { modelRef?: string; contextSize?: number; preset?: string } = {};
	const ref = asString(body.modelRef);
	if (ref) config.modelRef = ref;
	const presetId = asString(body.preset);
	if (presetId) config.preset = presetId;
	if (typeof body.contextSize === "number" && body.contextSize > 0) {
		config.contextSize = body.contextSize;
	}
	process.env.DETOUR_COMPANION_ENABLED = "true";
	try {
		const result = await deps.companion.start(config);
		if (!result) {
			return error(deps.companion.status().lastError ?? "companion failed to start", 500);
		}
		return json({ ok: true, ...result, ...deps.companion.status() });
	} catch (err) {
		return error(err instanceof Error ? err.message : String(err), 500);
	}
}

async function handleCompanionAssignments(ctx: EvalRequestContext): Promise<Response> {
	const { deps, req, json, error } = ctx;
	if (!deps.companion) return error("companion not wired", 503);
	let body: { assignments?: unknown; reset?: unknown } = {};
	try { body = (await req.json()) as typeof body; } catch { /* optional body */ }
	if (body.reset === true) {
		deps.companion.resetAssignments();
		return json({ ok: true, ...deps.companion.status() });
	}
	const raw =
		body.assignments && typeof body.assignments === "object"
			? (body.assignments as Record<string, unknown>)
			: {};
	const validJobs = [
		"triage",
		"shouldRespond",
		"memoryQuery",
		"compress",
		"personaPrePass",
	] as const;
	const validChoices = new Set(["classical", "llm", "off"]);
	for (const job of validJobs) {
		const choice = raw[job];
		if (typeof choice !== "string") continue;
		if (!validChoices.has(choice)) continue;
		deps.companion.setJobBackend(job, choice as "classical" | "llm" | "off");
	}
	return json({ ok: true, ...deps.companion.status() });
}

async function handleCompanionJob(ctx: EvalRequestContext): Promise<Response> {
	const { deps, req, json, error } = ctx;
	if (!deps.companion) return error("companion not wired", 503);
	let body: {
		job?: unknown;
		userText?: unknown;
		history?: unknown;
		agentName?: unknown;
		channel?: unknown;
		recentMessages?: unknown;
	} = {};
	try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON body", 400); }
	const job = asString(body.job);
	if (!job) return error("missing 'job' field", 400);
	try {
		switch (job) {
			case "triage": {
				const text = asString(body.userText) ?? "";
				return json({ ok: true, result: await deps.companion.triage(text) });
			}
			case "shouldRespond":
				return handleShouldRespondJob(ctx, body);
			case "memoryQuery": {
				const text = asString(body.userText) ?? "";
				return json({ ok: true, result: await deps.companion.memoryQuery(text) });
			}
			case "compress": {
				const history = asString(body.history) ?? "";
				return json({ ok: true, result: await deps.companion.compress(history) });
			}
			case "personaPrePass": {
				const agentName = asString(body.agentName) ?? "agent";
				const text = asString(body.userText) ?? "";
				return json({ ok: true, result: await deps.companion.personaPrePass(agentName, text) });
			}
			default:
				return error(`unknown job: ${job}`, 400);
		}
	} catch (err) {
		return error(err instanceof Error ? err.message : String(err), 500);
	}
}

async function handleShouldRespondJob(
	ctx: EvalRequestContext,
	body: { agentName?: unknown; channel?: unknown; recentMessages?: unknown },
): Promise<Response> {
	const { deps, json } = ctx;
	if (!deps.companion) return ctx.error("companion not wired", 503);
	const agentName = asString(body.agentName) ?? "agent";
	const channel = asString(body.channel) ?? "channel";
	const recent = Array.isArray(body.recentMessages)
		? (body.recentMessages as { author?: unknown; text?: unknown }[])
				.map((m) => ({
					author: asString(m.author) ?? "user",
					text: asString(m.text) ?? "",
				}))
				.filter((m) => m.text.length > 0)
		: [];
	return json({
		ok: true,
		result: await deps.companion.shouldRespond(agentName, channel, recent),
	});
}

// ── Contact management routes ─────────────────────────────────────────────

async function handleContactEvalRoutes(ctx: EvalRequestContext): Promise<Response | null> {
	const { deps, req, path, json, error } = ctx;

	// GET /api/eval/contacts — list all contacts with dossier summaries
	if (req.method === "GET" && path === "/api/eval/contacts") {
		if (!deps.pensieve) return error("pensieve not wired", 503);
		try {
			const limit = asNumber(
				new URL(req.url).searchParams.get("limit") ?? undefined,
				100,
			);
			const persons = await deps.pensieve.relationships.listPersons(limit);
			return json({ ok: true, count: persons.length, contacts: persons });
		} catch (err) {
			return error(
				`contacts list failed: ${err instanceof Error ? err.message : String(err)}`,
				500,
			);
		}
	}

	// GET /api/eval/contacts/:entityId — full dossier for a contact
	const contactDetailMatch = path.match(/^\/api\/eval\/contacts\/([a-f0-9-]+)$/);
	if (req.method === "GET" && contactDetailMatch) {
		if (!deps.pensieve) return error("pensieve not wired", 503);
		const entityId = contactDetailMatch[1];
		try {
			const detail = await deps.pensieve.relationships.getPerson(entityId as any);
			if (!detail) return error(`contact ${entityId} not found`, 404);
			return json({ ok: true, contact: detail });
		} catch (err) {
			return error(
				`contact detail failed: ${err instanceof Error ? err.message : String(err)}`,
				500,
			);
		}
	}

	// POST /api/eval/contacts/consolidate — trigger cross-channel identity consolidation
	if (req.method === "POST" && path === "/api/eval/contacts/consolidate") {
		if (!deps.pensieve) return error("pensieve not wired", 503);
		try {
			const result = await deps.pensieve.relationships.consolidateCrossChannelIdentities();
			return json({ ok: true, ...result });
		} catch (err) {
			return error(
				`consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
				500,
			);
		}
	}

	// POST /api/eval/contacts/condense — trigger conversation condensation
	if (req.method === "POST" && path === "/api/eval/contacts/condense") {
		if (!deps.pensieve) return error("pensieve not wired", 503);
		const runtime = deps.runtime.peek();
		if (!runtime) return error("runtime not ready", 503);
		try {
			const condenser = new ConversationCondenserService(() => runtime);
			const result = await condenser.run();
			return json({ ok: true, ...result });
		} catch (err) {
			return error(
				`condensation failed: ${err instanceof Error ? err.message : String(err)}`,
				500,
			);
		}
	}

	// POST /api/eval/contacts/prune — trigger stale contact pruning
	if (req.method === "POST" && path === "/api/eval/contacts/prune") {
		if (!deps.pensieve) return error("pensieve not wired", 503);
		try {
			let body: Record<string, unknown> = {};
			try { body = await req.json() as Record<string, unknown>; } catch { /* empty body ok */ }
			const dryRun = body.dryRun === true;
			const result = await deps.pensieve.relationships.pruneStaleContacts({ dryRun });
			return json({ ok: true, dryRun, ...result });
		} catch (err) {
			return error(
				`pruning failed: ${err instanceof Error ? err.message : String(err)}`,
				500,
			);
		}
	}

	// POST /api/eval/contacts/:primaryId/merge — merge secondary into primary
	const mergeMatch = path.match(/^\/api\/eval\/contacts\/([a-f0-9-]+)\/merge$/);
	if (req.method === "POST" && mergeMatch) {
		if (!deps.pensieve) return error("pensieve not wired", 503);
		const primaryId = mergeMatch[1];
		try {
			const body = await req.json() as { secondaryIds?: string[] };
			const secondaryIds = body.secondaryIds;
			if (!Array.isArray(secondaryIds) || secondaryIds.length === 0) {
				return error("missing secondaryIds array", 400);
			}
			const result = await deps.pensieve.relationships.mergeEntities(
				primaryId as any,
				secondaryIds as any[],
			);
			if (!result) return error("merge failed — relationships service may not support merge", 500);
			return json({ ok: true, contact: result });
		} catch (err) {
			return error(
				`merge failed: ${err instanceof Error ? err.message : String(err)}`,
				500,
			);
		}
	}

	return null;
}
