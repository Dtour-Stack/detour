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
import { extractSimpleView } from "../../../main/activity/trajectory-extractors";

type Json = (data: unknown, status?: number) => Response;
type ErrorJson = (message: string, status?: number) => Response;

export interface EvalRouteDeps {
	runtime: RuntimeService;
	activity: ActivityService;
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
	// The trajectory service lists newest-first; the most recent completed
	// one is almost always this turn. Best-effort linkage.
	const list = await deps.activity.trajectories.list({ limit: 1 });
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

		return error("not found", 404);
	};
}
