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
import type { PensieveService } from "../pensieve";
import type { ConfigService } from "../config-service";
import { extractSimpleView } from "../../../main/activity/trajectory-extractors";
import { narrate } from "../agent-narrator";

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
	pensieve?: PensieveService;
	config?: ConfigService;
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
	const { broadcaster } = await import("../rpc/registry");
	// Real narration via the local companion model. Falls back to a
	// canned summary when the companion isn't running so the bubble is
	// never silent.
	const echo = text.length > 60 ? text.slice(0, 60) + "…" : text;
	narrate(deps.companion, {
		kind: "turn-start",
		fact: `User just asked: "${echo}"`,
		fallback: `Thinking about: ${echo}`,
		traceId: "eval-send",
	});
	const chunks: string[] = [];
	const onDelta = (delta: string): void => {
		chunks.push(delta);
		broadcaster.broadcast("chatDelta", {
			convId: "default",
			delta,
			traceId: "eval-send",
		});
	};
	const started = Date.now();
	const sendPromise = deps.runtime.sendMessage(text, onDelta);
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(
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
		convId: "default",
		text: reply,
		summary: reply.slice(0, 200),
		trajectoryId,
		durationMs,
		traceId: "eval-send",
	});
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

		// ── Pensieve memories / entities + Activity logs ──────────────────
		// Native SwiftUI surfaces (Pensieve.Memories, Pensieve.Relationships,
		// Activity.Logs) consume these. Read-only summaries — full RPC
		// surface for create/update/delete stays in the typed-RPC bag.

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

		// Skills catalog — surfaces elizaOS skills (SKILL.md) so the
		// SwiftUI Settings → Skills tab can list them with toggle state.
		if (req.method === "GET" && path === "/api/eval/skills") {
			let skills: Array<{ id: string; label: string; description: string | null; enabled: boolean; actionCount: number | null }>= [];
			try {
				const mod = await import("@elizaos/skills");
				const result = mod.loadSkills();
				const list = (result.skills as Array<{ name: string; description?: string; enabled?: boolean; metadata?: { actions?: unknown[] } }>);
				skills = list.map((s) => ({
					id: s.name,
					label: s.name,
					description: typeof s.description === "string" && s.description.length > 0 ? s.description : null,
					enabled: s.enabled !== false,  // default true
					actionCount: Array.isArray(s.metadata?.actions) ? s.metadata!.actions!.length : null,
				}));
			} catch (err) {
				console.warn("[eval/skills] loadSkills failed:", err instanceof Error ? err.message : err);
			}
			skills.sort((a, b) => a.id.localeCompare(b.id));
			return json({ ok: true, skills });
		}

		// Toggle a skill on/off. The skills package persists enable state
		// via its own storage adapter; we just write a marker file the
		// loader checks on next load. Best-effort — failure is non-fatal.
		if (req.method === "POST" && path.startsWith("/api/eval/skills/")) {
			const id = path.slice("/api/eval/skills/".length);
			if (!id) return error("skill id required", 400);
			let body: { enabled?: boolean } = {};
			try { body = (await req.json()) as typeof body; } catch { return error("invalid body", 400); }
			if (typeof body.enabled !== "boolean") return error("enabled must be a boolean", 400);
			// Persist via a JSON state file the loader can consult.
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

		// ── Action audit (list + invoke) ──────────────────────────────────
		// Token-gated mirror of /api/debug/action that works outside dev
		// bundles. Used by the action validator to enumerate every action
		// registered on the live runtime and call them with safe defaults.
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
		if (req.method === "POST" && path === "/api/eval/action/run") {
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

		// ── Settings write (process.env mutation) ─────────────────────────
		// Lightweight setter for runtime flags the local-mlx-image /
		// local-mlx-video plugins (and any other process.env-gated
		// plugin) check on every call. Used by the Settings UI's enable
		// toggles + preset pickers.
		if (req.method === "POST" && path === "/api/eval/settings") {
			let body: { key?: string; value?: string } = {};
			try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON", 400); }
			const key = typeof body.key === "string" ? body.key.trim() : "";
			const value = typeof body.value === "string" ? body.value : "";
			if (!key) return error("missing 'key'", 400);
			// Allowlist — only let the UI touch known-safe runtime flags.
			// Anything not on this list gets a 403 so the eval endpoint
			// can't be repurposed to mutate arbitrary env.
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
				// Unified model-routing keys — picked by the user in
				// the Settings → Model Routing surface.
				"DETOUR_MODEL_IMAGE_PROVIDER",
				"DETOUR_MODEL_IMAGE_DESCRIPTION_PROVIDER",
				"DETOUR_MODEL_TRANSCRIPTION_PROVIDER",
				"DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER",
				"DETOUR_MODEL_VIDEO_GENERATION_PROVIDER",  // still allowed (cloud-only routing)
			]);
			if (!ALLOWED.has(key)) return error(`setting '${key}' not allowed via eval API`, 403);
			process.env[key] = value;
			return json({ ok: true, key, value });
		}

		// ── Active pet bundle ─────────────────────────────────────────────
		// A pet is a bundle: spritesheet + companion model preset +
		// curated skill focus + narrator persona. Setting the active
		// pet wires its preset into the companion and its persona/
		// skill focus into runtime settings the narrator reads when
		// asked to summarize agent activity.
		if (req.method === "POST" && path === "/api/eval/active-pet") {
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
			if (typeof body.persona === "string") {
				process.env.DETOUR_PET_PERSONA = body.persona;
			}
			if (Array.isArray(body.skills)) {
				process.env.DETOUR_PET_SKILLS = body.skills.join(",");
			}
			// Optionally boot the companion at the pet's preset. Routes
			// through the same code path as the tray Start Companion item.
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

		// ── Planner tier pin ──────────────────────────────────────────────
		// Lets the SwiftUI routing card override which model tier the
		// planner ASKS for first. dpe-fallback-plugin reads
		// DETOUR_PLANNER_TIER via runtime.getSetting; we also write
		// process.env so the value applies before the next runtime build.
		if (req.method === "GET" && path === "/api/eval/planner-tier") {
			const tier = process.env.DETOUR_PLANNER_TIER ?? "";
			return json({ ok: true, tier });
		}
		if (req.method === "POST" && path === "/api/eval/planner-tier") {
			let body: { tier?: string } = {};
			try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON", 400); }
			const raw = (body.tier ?? "").trim().toUpperCase();
			const valid = ["", "TEXT_SMALL", "TEXT_MEDIUM", "TEXT_LARGE"];
			if (!valid.includes(raw)) return error("tier must be TEXT_SMALL/MEDIUM/LARGE or empty", 400);
			if (raw === "") {
				delete process.env.DETOUR_PLANNER_TIER;
			} else {
				process.env.DETOUR_PLANNER_TIER = raw;
			}
			return json({ ok: true, tier: process.env.DETOUR_PLANNER_TIER ?? "" });
		}

		// ── Models / routing ──────────────────────────────────────────────
		// Per-tier model picks (TEXT_LARGE / TEXT_SMALL / EMBEDDING / …)
		// driven from the native Settings UI. Writes via ConfigService
		// so the values land in env vars the eliza model plugins read.
		if (req.method === "GET" && path === "/api/eval/models") {
			if (!deps.config) return error("config service not wired", 503);
			const models = await deps.config.getModels();
			return json({ ok: true, models });
		}
		if (req.method === "POST" && path === "/api/eval/models") {
			if (!deps.config) return error("config service not wired", 503);
			let body: unknown;
			try { body = await req.json(); } catch { return error("invalid JSON", 400); }
			await deps.config.setModels(body as never);
			const models = await deps.config.getModels();
			return json({ ok: true, models });
		}

		// ── Character editor ──────────────────────────────────────────────
		// Native Settings → Character tab reads via GET, persists edits
		// via POST, and asks for AI-generated additions via /generate.
		// All three go through ConfigService.{get,set}Character so the
		// runtime picks up changes on the next character rebuild.
		if (req.method === "GET" && path === "/api/eval/character") {
			if (!deps.config) return error("config service not wired", 503);
			const character = await deps.config.getCharacter();
			return json({ ok: true, character });
		}
		if (req.method === "POST" && path === "/api/eval/character") {
			if (!deps.config) return error("config service not wired", 503);
			let body: unknown;
			try { body = await req.json(); } catch { return error("invalid JSON", 400); }
			const character = await deps.config.setCharacter(body as never);
			return json({ ok: true, character });
		}
		if (req.method === "POST" && path === "/api/eval/character/generate") {
			let body: { section?: string; existing?: unknown; count?: number; hint?: string } = {};
			try { body = (await req.json()) as typeof body; } catch { return error("invalid JSON", 400); }
			const section = typeof body.section === "string" ? body.section : "";
			if (!section) return error("section is required", 400);
			const count = typeof body.count === "number" && body.count > 0 && body.count <= 10 ? body.count : 3;
			const hint = typeof body.hint === "string" ? body.hint : "";
			const existing = Array.isArray(body.existing)
				? body.existing.filter((v): v is string => typeof v === "string").slice(0, 50)
				: [];

			const character = deps.config ? await deps.config.getCharacter() : null;
			const lines = [
				`You are helping author the character file for the agent "${character?.name ?? "this agent"}".`,
				`Current persona: ${character?.system ?? "(none)"}.`,
				`Generate exactly ${count} new entries for the '${section}' section.`,
				`Output one entry per line, no numbering, no quotes, no commentary, no blank lines.`,
				existing.length > 0
					? `Existing entries (don't duplicate):\n${existing.map((e) => `- ${e}`).join("\n")}`
					: "",
				hint ? `Additional guidance from the user: ${hint}` : "",
				`Respond with ONLY the ${count} new entries — nothing else.`,
			].filter(Boolean);
			const prompt = lines.join("\n\n");

			const chunks: string[] = [];
			try {
				await deps.runtime.sendMessage(prompt, (d) => chunks.push(d));
			} catch (err) {
				return error(err instanceof Error ? err.message : "generate failed", 500);
			}
			const reply = chunks.join("").trim();
			const suggestions = reply
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter((l) => l.length > 0)
				.map((l) => l.replace(/^[\s\-\*\d\.\)]+/, "").replace(/^"|"$/g, "").trim())
				.filter((l) => l.length > 0)
				.slice(0, count);
			return json({ ok: true, section, suggestions });
		}

		if (req.method === "GET" && path === "/api/eval/logs") {
			const limit = asNumber(url.searchParams.get("limit"), 200);
			const minLevel = url.searchParams.get("minLevel") ?? undefined;
			const entries = deps.activity.logs.list({
				limit,
				...(minLevel ? { minLevel: parseInt(minLevel, 10) } : {}),
			});
			return json({ ok: true, entries });
		}

		// SSE stream — Server-Sent Events emitting the same broadcasts the
		// React shell gets (chatComplete, workerStatusUpdate, etc.) plus
		// activity events the LogService emits. The native Detour binary
		// subscribes to this and renders UNUserNotifications for events
		// the user should know about while the agent runs in the background.
		//
		// Filter via ?names=chatComplete,workerStatusUpdate,…
		if (req.method === "GET" && path === "/api/eval/events") {
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
							// Stream was closed mid-send; clean up so we
							// don't keep enqueueing into a dead controller.
							closed = true;
							unsubscribe();
						}
					};
					const unsubscribe = registerWindow(send);
					// Heartbeat every 15s so reverse proxies don't drop us
					// during long agent idles.
					const heartbeat = setInterval(() => {
						if (closed) return;
						try {
							controller.enqueue(enc.encode(`: heartbeat\n\n`));
						} catch {
							closed = true;
						}
					}, 15000);
					// `cancel` runs when the client disconnects.
					(controller as unknown as { cancelHook?: () => void }).cancelHook = () => {
						closed = true;
						clearInterval(heartbeat);
						unsubscribe();
					};
					// Emit a hello so the subscriber knows the stream is
					// live before any agent activity happens.
					controller.enqueue(enc.encode(`event: hello\ndata: {"ok":true}\n\n`));
				},
				cancel() {
					// Bun calls this when the response is torn down. The
					// start() closure stored the unsubscribe under cancelHook
					// — invoke if present.
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
