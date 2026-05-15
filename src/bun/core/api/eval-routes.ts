/**
 * Eval-API routes for external coding-agent drivers.
 *
 *   GET  /api/eval/health        → { ok, runtimeBuilt, activeProvider, capActive }
 *   POST /api/eval/send          → drive a turn; returns { ok, traceId, reply, durationMs }
 *                                  body: { text: string, wait?: boolean, timeoutMs?: number }
 *   GET  /api/eval/trajectory/:id           → full ActivityTrajectoryDetail JSON
 *   GET  /api/eval/trajectory/:id/simple    → SimpleView extract (request/reply/thinking/actions)
 *   GET  /api/eval/trajectories             → list of recent trajectory summaries
 *                                              (?limit&status — same options as the RPC handler)
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
import type { LocalChatService } from "../llama/chat-service";
import type { CompanionService } from "../llama/companion-service";
import { extractSimpleView } from "../../../main/activity/trajectory-extractors";

type Json = (data: unknown, status?: number) => Response;
type ErrorJson = (message: string, status?: number) => Response;

export interface EvalRouteDeps {
	runtime: RuntimeService;
	activity: ActivityService;
	dream?: DreamService;
	improvement?: ContinuousImprovementService;
	agentHfSync?: AgentHfSyncService;
	localChat?: LocalChatService;
	companion?: CompanionService;
}

export interface EvalRouteHelpers {
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
): Promise<{ reply: string; durationMs: number; trajectoryId: string | null }> {
	const chunks: string[] = [];
	const onDelta = (delta: string): void => {
		chunks.push(delta);
	};
	const started = Date.now();
	const sendPromise = deps.runtime.sendMessage(text, onDelta);
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new Error(`eval send timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	await Promise.race([sendPromise, timeoutPromise]);
	const durationMs = Date.now() - started;
	const reply = chunks.join("");
	// Filter to source="tray-app" so we don't race with x_autonomy ticks
	// that may have fired between the message send and this lookup. The
	// in-app chat connector tags its turns with source="tray-app" (set in
	// runtime.sendMessage when constructing the Memory).
	const list = await deps.activity.trajectories.list({
		limit: 1,
		source: "tray-app",
	});
	const trajectoryId = list.trajectories[0]?.id ?? null;
	return { reply, durationMs, trajectoryId };
}

export function evalRoutes(deps: EvalRouteDeps, helpers: EvalRouteHelpers) {
	const { json, error } = helpers;

	return async (req: Request, url: URL, path: string): Promise<Response | null> => {
		if (!path.startsWith("/api/eval/")) return null;
		// If the token isn't configured the entire surface is invisible.
		if (!evalApiEnabled()) return error("eval API disabled — set DETOUR_EVAL_TOKEN", 404);
		if (!authorized(req)) return error("missing or invalid X-Detour-Eval-Token", 401);

		if (req.method === "GET" && path === "/api/eval/health") {
			const peek = deps.runtime.peek();
			return json({
				ok: true,
				runtimeBuilt: peek !== null,
				activeProvider: deps.runtime.getCurrentProvider(),
				agentName:
					typeof peek?.character?.name === "string" ? peek.character.name : null,
			});
		}

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

			if (!wait) {
				// Fire and forget — return immediately so the caller can poll.
				void deps.runtime
					.sendMessage(text, () => undefined)
					.catch((err) => {
						console.warn(
							"[eval] async send failed:",
							err instanceof Error ? err.message : err,
						);
					});
				return json({ ok: true, async: true, reply: null, trajectoryId: null });
			}
			try {
				const result = await driveTurn(deps, text, timeoutMs);
				return json({ ok: true, ...result });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return error(msg, 500);
			}
		}

		if (req.method === "GET" && path.startsWith("/api/eval/trajectory/")) {
			const tail = path.slice("/api/eval/trajectory/".length);
			const [id, sub] = tail.split("/");
			if (!id) return error("trajectory id required", 400);
			const detail = await deps.activity.trajectories.get(id);
			if (!detail.trajectory) return error("trajectory not found", 404);
			if (sub === "simple") {
				return json({ ok: true, ...extractSimpleView(detail) });
			}
			if (!sub) {
				return json({ ok: true, detail });
			}
			return error("unknown trajectory subresource", 404);
		}

		if (req.method === "GET" && path === "/api/eval/trajectories") {
			const limit = asNumber(url.searchParams.get("limit"), 20);
			const status = url.searchParams.get("status") ?? undefined;
			const result = await deps.activity.trajectories.list({
				limit,
				...(status ? { status } : {}),
			});
			return json({ ok: true, ...result });
		}

		// ── Self-improvement loop status + triggers ─────────────────────────
		// One endpoint per service so a coding-agent driver (or this same
		// validator harness) can confirm dreams ran, HF buckets sync, and
		// continuous improvement is producing reflections. Triggers return
		// the same payload as a periodic tick so callers can assert against
		// either kind of run.
		if (req.method === "GET" && path === "/api/eval/dreams") {
			if (!deps.dream) return error("dream service not wired", 503);
			const snapshot = await deps.dream.snapshot();
			return json({ ok: true, ...snapshot });
		}

		if (req.method === "POST" && path === "/api/eval/dreams/run") {
			if (!deps.dream) return error("dream service not wired", 503);
			let body: { instructions?: unknown } = {};
			try {
				body = (await req.json()) as { instructions?: unknown };
			} catch {
				// allow empty body
			}
			const instructions = asString(body.instructions);
			const result = await deps.dream.runNow(
				instructions ? { instructions } : {},
			);
			return json({
				ok: true,
				planId: result.planId ?? null,
				plan: result.plan,
				skipReason: result.skipReason ?? null,
			});
		}

		if (req.method === "POST" && path.startsWith("/api/eval/dreams/apply/")) {
			if (!deps.dream) return error("dream service not wired", 503);
			const id = path.slice("/api/eval/dreams/apply/".length);
			if (!id) return error("dream id required", 400);
			const result = await deps.dream.apply(id);
			return json({ ok: true, ...result });
		}

		if (req.method === "POST" && path.startsWith("/api/eval/dreams/reject/")) {
			if (!deps.dream) return error("dream service not wired", 503);
			const id = path.slice("/api/eval/dreams/reject/".length);
			if (!id) return error("dream id required", 400);
			const result = await deps.dream.reject(id);
			return json({ ok: true, ...result });
		}

		if (req.method === "GET" && path === "/api/eval/hf-sync") {
			if (!deps.agentHfSync) return error("hf-sync service not wired", 503);
			const status = await deps.agentHfSync.status();
			return json({ ok: true, ...status });
		}

		if (req.method === "POST" && path === "/api/eval/hf-sync/run") {
			if (!deps.agentHfSync) return error("hf-sync service not wired", 503);
			let body: { reason?: unknown; destination?: unknown; limit?: unknown } = {};
			try {
				body = (await req.json()) as {
					reason?: unknown;
					destination?: unknown;
					limit?: unknown;
				};
			} catch {
				// allow empty body
			}
			const reason = asString(body.reason) ?? "manual";
			try {
				const job = await deps.agentHfSync.startSync(
					reason as "manual" | "startup" | "daily" | "trajectory-threshold",
					{
						...(asString(body.destination)
							? { destination: asString(body.destination) as string }
							: {}),
						...(typeof body.limit === "number" && body.limit > 0
							? { limit: body.limit }
							: {}),
					},
				);
				return json({ ok: true, job });
			} catch (err) {
				return error(err instanceof Error ? err.message : String(err), 500);
			}
		}

		if (req.method === "POST" && path === "/api/eval/hf-sync/check") {
			if (!deps.agentHfSync) return error("hf-sync service not wired", 503);
			try {
				const job = await deps.agentHfSync.checkNow();
				return json({ ok: true, job });
			} catch (err) {
				return error(err instanceof Error ? err.message : String(err), 500);
			}
		}

		// ── Local-chat lifecycle ────────────────────────────────────────────
		// GET  → current status (running, url, model, RAM fit)
		// POST /start { preset?, customModelRef?, contextSize? } → boot
		// POST /stop  → reap the subprocess
		if (req.method === "GET" && path === "/api/eval/local-chat") {
			if (!deps.localChat) return error("local-chat service not wired", 503);
			return json({ ok: true, ...deps.localChat.status() });
		}

		if (req.method === "POST" && path === "/api/eval/local-chat/start") {
			if (!deps.localChat) return error("local-chat service not wired", 503);
			let body: {
				preset?: unknown;
				customModelRef?: unknown;
				contextSize?: unknown;
			} = {};
			try {
				body = (await req.json()) as typeof body;
			} catch {
				// allow empty body
			}
			const config: {
				preset?: string;
				customModelRef?: string;
				contextSize?: number;
			} = {};
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
					return error(
						deps.localChat.status().lastError ?? "local-chat failed to start",
						500,
					);
				}
				return json({ ok: true, ...result, ...deps.localChat.status() });
			} catch (err) {
				return error(err instanceof Error ? err.message : String(err), 500);
			}
		}

		if (req.method === "POST" && path === "/api/eval/local-chat/stop") {
			if (!deps.localChat) return error("local-chat service not wired", 503);
			deps.localChat.stop();
			delete process.env.DETOUR_LOCAL_CHAT_ENABLED;
			return json({ ok: true, ...deps.localChat.status() });
		}

		// ── Companion (small sidecar model) ────────────────────────────────
		// Five-job 0.6B helper. Endpoints to start/stop/inspect AND test
		// each job individually — useful for verifying the model can
		// reliably triage / classify / compress without driving full
		// agent turns.
		if (req.method === "GET" && path === "/api/eval/companion") {
			if (!deps.companion) return error("companion not wired", 503);
			return json({ ok: true, ...deps.companion.status() });
		}

		if (req.method === "POST" && path === "/api/eval/companion/start") {
			if (!deps.companion) return error("companion not wired", 503);
			let body: {
				modelRef?: unknown;
				contextSize?: unknown;
				preset?: unknown;
			} = {};
			try {
				body = (await req.json()) as typeof body;
			} catch {
				// empty body OK
			}
			const config: {
				modelRef?: string;
				contextSize?: number;
				preset?: string;
			} = {};
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
					return error(
						deps.companion.status().lastError ?? "companion failed to start",
						500,
					);
				}
				return json({ ok: true, ...result, ...deps.companion.status() });
			} catch (err) {
				return error(err instanceof Error ? err.message : String(err), 500);
			}
		}

		if (req.method === "POST" && path === "/api/eval/companion/stop") {
			if (!deps.companion) return error("companion not wired", 503);
			deps.companion.stop();
			delete process.env.DETOUR_COMPANION_ENABLED;
			return json({ ok: true, ...deps.companion.status() });
		}

		if (req.method === "POST" && path === "/api/eval/companion/assignments") {
			if (!deps.companion) return error("companion not wired", 503);
			let body: { assignments?: unknown; reset?: unknown } = {};
			try {
				body = (await req.json()) as typeof body;
			} catch {
				// empty body OK
			}
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
				deps.companion.setJobBackend(
					job,
					choice as "classical" | "llm" | "off",
				);
			}
			return json({ ok: true, ...deps.companion.status() });
		}

		// Per-job test endpoints. POST a payload, get the parsed result.
		// Returns ok:true with result=null if the companion isn't running
		// (matches the "null = safe skip" contract).
		if (req.method === "POST" && path === "/api/eval/companion/job") {
			if (!deps.companion) return error("companion not wired", 503);
			let body: {
				job?: unknown;
				userText?: unknown;
				history?: unknown;
				agentName?: unknown;
				channel?: unknown;
				recentMessages?: unknown;
			} = {};
			try {
				body = (await req.json()) as typeof body;
			} catch {
				return error("invalid JSON body", 400);
			}
			const job = asString(body.job);
			if (!job) return error("missing 'job' field", 400);
			try {
				switch (job) {
					case "triage": {
						const text = asString(body.userText) ?? "";
						return json({ ok: true, result: await deps.companion.triage(text) });
					}
					case "shouldRespond": {
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
							result: await deps.companion.shouldRespond(
								agentName,
								channel,
								recent,
							),
						});
					}
					case "memoryQuery": {
						const text = asString(body.userText) ?? "";
						return json({
							ok: true,
							result: await deps.companion.memoryQuery(text),
						});
					}
					case "compress": {
						const history = asString(body.history) ?? "";
						return json({
							ok: true,
							result: await deps.companion.compress(history),
						});
					}
					case "personaPrePass": {
						const agentName = asString(body.agentName) ?? "agent";
						const text = asString(body.userText) ?? "";
						return json({
							ok: true,
							result: await deps.companion.personaPrePass(agentName, text),
						});
					}
					default:
						return error(`unknown job: ${job}`, 400);
				}
			} catch (err) {
				return error(err instanceof Error ? err.message : String(err), 500);
			}
		}

		return error("not found", 404);
	};
}
