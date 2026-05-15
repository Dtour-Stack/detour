import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { evalApiEnabled, evalRoutes, type EvalRouteDeps, type EvalRouteHelpers } from "./eval-routes";
import type { ActivityService } from "../activity";
import { CompanionService } from "../llama/companion-service";
import type { RuntimeService } from "../runtime";

const TOKEN = "test-token-abcdef";
let prevToken: string | undefined;

function jsonHelper(): EvalRouteHelpers {
	return {
		json: (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
		error: (message: string, status = 400) =>
			new Response(JSON.stringify({ ok: false, error: message }), {
				status,
				headers: { "content-type": "application/json" },
			}),
	};
}

function makeDeps(opts: {
	sendMessage?: (text: string, onDelta: (d: string) => void) => Promise<void>;
	trajectoryList?: () => Promise<{ trajectories: Array<{ id: string }>; total: number; limit: number; offset: number }>;
	trajectoryGet?: (id: string) => Promise<unknown>;
	peek?: () => unknown;
} = {}): EvalRouteDeps {
	return {
		runtime: {
			sendMessage:
				opts.sendMessage ??
				(async (_text, onDelta) => {
					onDelta("hello");
					onDelta(" world");
				}),
			peek: opts.peek ?? (() => ({ character: { name: "TestSquirrel" } })),
			getCurrentProvider: () => "openai",
		} as unknown as RuntimeService,
		activity: {
			trajectories: {
				list:
					opts.trajectoryList ??
					(async () => ({
						trajectories: [{ id: "tj-1" }],
						total: 1,
						limit: 1,
						offset: 0,
					})),
				get:
					opts.trajectoryGet ??
					(async (id: string) => ({
						trajectory: { id, source: "chat", status: "completed", durationMs: 100 },
						identity: { id },
						totals: {
							stepCount: 1,
							llmCallCount: 1,
							providerAccessCount: 0,
							actionCount: 1,
							totalPromptTokens: 0,
							totalCompletionTokens: 0,
							totalLatencyMs: 0,
						},
						llmCalls: [],
						providerAccesses: [],
						actions: [{ attemptId: "a1", stepNumber: 1, timestamp: 0, actionName: "REPLY", success: true, result: { text: "hello world" } }],
						steps: [],
						metadata: {},
						rewardComponents: null,
						metrics: {},
						raw: { rootMessage: { text: "say hi" } },
					})),
			},
		} as unknown as ActivityService,
	};
}

async function call(
	route: ReturnType<typeof evalRoutes>,
	method: string,
	path: string,
	body?: unknown,
	token?: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = {};
	if (token !== null && token !== undefined) headers["x-detour-eval-token"] = token;
	if (body) headers["content-type"] = "application/json";
	const req = new Request(`http://test${path}`, {
		method,
		headers,
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const url = new URL(req.url);
	// Match the server dispatcher: pathname excludes the query string.
	const res = await route(req, url, url.pathname);
	if (!res) throw new Error(`route returned null for ${method} ${path}`);
	const parsed = await res.json().catch(() => ({}));
	return { status: res.status, body: parsed as Record<string, unknown> };
}

beforeEach(() => {
	prevToken = process.env.DETOUR_EVAL_TOKEN;
	process.env.DETOUR_EVAL_TOKEN = TOKEN;
});

afterEach(() => {
	if (prevToken === undefined) delete process.env.DETOUR_EVAL_TOKEN;
	else process.env.DETOUR_EVAL_TOKEN = prevToken;
});

describe("eval routes auth", () => {
	test("evalApiEnabled is true with a long-enough token", () => {
		expect(evalApiEnabled()).toBe(true);
	});

	test("evalApiEnabled is false when token unset", () => {
		delete process.env.DETOUR_EVAL_TOKEN;
		expect(evalApiEnabled()).toBe(false);
	});

	test("returns 404 when token env var is unset (entire surface invisible)", async () => {
		delete process.env.DETOUR_EVAL_TOKEN;
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/health", undefined, null);
		expect(out.status).toBe(404);
	});

	test("returns 401 when token missing from header", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/health", undefined, null);
		expect(out.status).toBe(401);
	});

	test("returns 401 when token mismatched", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/health", undefined, "wrong-token-xyz");
		expect(out.status).toBe(401);
	});

	test("returns null when path is not /api/eval/* so the dispatcher can fall through", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const req = new Request("http://test/api/health");
		const result = await route(req, new URL(req.url), "/api/health");
		expect(result).toBeNull();
	});
});

describe("eval routes — health", () => {
	test("GET /api/eval/health reports runtime + provider state", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/health", undefined, TOKEN);
		expect(out.status).toBe(200);
		expect(out.body.ok).toBe(true);
		expect(out.body.runtimeBuilt).toBe(true);
		expect(out.body.activeProvider).toBe("openai");
		expect(out.body.agentName).toBe("TestSquirrel");
	});
});

describe("eval routes — send", () => {
	test("POST /api/eval/send wait=true returns reply + trajectory id", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "POST", "/api/eval/send", { text: "hi" }, TOKEN);
		expect(out.status).toBe(200);
		expect(out.body.ok).toBe(true);
		expect(out.body.reply).toBe("hello world");
		expect(out.body.trajectoryId).toBe("tj-1");
		expect(typeof out.body.durationMs).toBe("number");
	});

	test("POST /api/eval/send wait=false returns immediately", async () => {
		let sendInvoked = false;
		const deps = makeDeps({
			sendMessage: async (_text, onDelta) => {
				sendInvoked = true;
				await new Promise((r) => setTimeout(r, 30));
				onDelta("delayed");
			},
		});
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(route, "POST", "/api/eval/send", { text: "hi", wait: false }, TOKEN);
		expect(out.status).toBe(200);
		expect(out.body.async).toBe(true);
		expect(out.body.reply).toBeNull();
		// async send was kicked off (fire-and-forget)
		await new Promise((r) => setTimeout(r, 50));
		expect(sendInvoked).toBe(true);
	});

	test("POST /api/eval/send returns 400 on missing text", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "POST", "/api/eval/send", {}, TOKEN);
		expect(out.status).toBe(400);
	});

	test("POST /api/eval/send surfaces runtime errors", async () => {
		const deps = makeDeps({
			sendMessage: async () => {
				throw new Error("no provider wired");
			},
		});
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(route, "POST", "/api/eval/send", { text: "hi" }, TOKEN);
		expect(out.status).toBe(500);
		expect(out.body.error).toContain("no provider wired");
	});
});

describe("eval routes — trajectory", () => {
	test("GET /api/eval/trajectory/:id returns full detail", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/trajectory/tj-1", undefined, TOKEN);
		expect(out.status).toBe(200);
		expect(out.body.ok).toBe(true);
		const detail = out.body.detail as Record<string, unknown>;
		expect(detail).toBeDefined();
		expect((detail.trajectory as Record<string, unknown>).id).toBe("tj-1");
	});

	test("GET /api/eval/trajectory/:id/simple returns SimpleView", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/trajectory/tj-1/simple", undefined, TOKEN);
		expect(out.status).toBe(200);
		expect(out.body.ok).toBe(true);
		expect(out.body.request).toBe("say hi");
		expect(out.body.reply).toBe("hello world");
	});

	test("GET /api/eval/trajectory/missing returns 404", async () => {
		const deps = makeDeps({
			trajectoryGet: async () => ({
				trajectory: null,
				identity: null,
				totals: { stepCount: 0, llmCallCount: 0, providerAccessCount: 0, actionCount: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalLatencyMs: 0 },
				llmCalls: [],
				providerAccesses: [],
				actions: [],
				steps: [],
				metadata: {},
				rewardComponents: null,
				metrics: {},
				raw: null,
			}),
		});
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(route, "GET", "/api/eval/trajectory/ghost", undefined, TOKEN);
		expect(out.status).toBe(404);
	});

	test("GET /api/eval/trajectories returns the list", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/trajectories?limit=5", undefined, TOKEN);
		expect(out.status).toBe(200);
		const trajs = out.body.trajectories as Array<Record<string, unknown>>;
		expect(Array.isArray(trajs)).toBe(true);
		expect(trajs[0]?.id).toBe("tj-1");
	});
});

// Self-improvement loop endpoints: dreams, HF sync, continuous-improvement.
// Each one is gated behind the corresponding optional dep — when the service
// isn't wired into the deps object, the route returns 503 (not implemented)
// instead of crashing. The harness uses these to confirm Dreams are running,
// HF buckets sync, and reflections are landing — all without touching RPC.
describe("eval routes — self-improvement", () => {
	test("GET /api/eval/dreams returns 503 when dream service is not wired", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/dreams", undefined, TOKEN);
		expect(out.status).toBe(503);
	});

	test("GET /api/eval/dreams returns snapshot when service is wired", async () => {
		const deps: EvalRouteDeps = {
			...makeDeps(),
			dream: {
				snapshot: async () => ({
					dreams: [
						{
							id: "dr-1",
							createdAt: 12345,
							summary: "add=2 merge=1 replace=0 delete=0",
							counts: { additions: 2, merges: 1, replacements: 0, deletions: 0 },
							pendingCount: 3,
						},
					],
				}),
				runNow: async () => ({
					planId: "dr-2",
					plan: {
						additions: [{ op: "addition", text: "x" }],
						merges: [],
						replacements: [],
						deletions: [],
					},
				}),
				apply: async () => ({ applied: 1, skipped: 0, failed: 0, errors: [] }),
				reject: async () => ({ removed: 3 }),
			} as unknown as import("../dream-service").DreamService,
		};
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(route, "GET", "/api/eval/dreams", undefined, TOKEN);
		expect(out.status).toBe(200);
		const dreams = out.body.dreams as Array<{ id: string }>;
		expect(dreams[0]?.id).toBe("dr-1");
	});

	test("POST /api/eval/dreams/run triggers an ad-hoc dream", async () => {
		const deps: EvalRouteDeps = {
			...makeDeps(),
			dream: {
				snapshot: async () => ({ dreams: [] }),
				runNow: async (opts?: { instructions?: string }) => ({
					planId: "dr-3",
					plan: {
						additions: [
							{ op: "addition", text: opts?.instructions ?? "default" },
						],
						merges: [],
						replacements: [],
						deletions: [],
					},
				}),
				apply: async () => ({ applied: 0, skipped: 0, failed: 0, errors: [] }),
				reject: async () => ({ removed: 0 }),
			} as unknown as import("../dream-service").DreamService,
		};
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(
			route,
			"POST",
			"/api/eval/dreams/run",
			{ instructions: "focus on coding quirks" },
			TOKEN,
		);
		expect(out.status).toBe(200);
		expect(out.body.planId).toBe("dr-3");
		const plan = out.body.plan as { additions: { text: string }[] };
		expect(plan.additions[0]?.text).toBe("focus on coding quirks");
	});

	test("GET /api/eval/hf-sync returns 503 when not wired, status when wired", async () => {
		const route1 = evalRoutes(makeDeps(), jsonHelper());
		const noService = await call(route1, "GET", "/api/eval/hf-sync", undefined, TOKEN);
		expect(noService.status).toBe(503);

		const deps: EvalRouteDeps = {
			...makeDeps(),
			agentHfSync: {
				status: async () => ({
					defaultDestination: "hf://detour/dumps",
					hfAvailable: true,
					activeJob: null,
					policy: {
						enabled: true,
						destination: "hf://detour/dumps",
						daily: true,
						dailyTimeUtc: "03:00",
						everyNewTrajectories: 50,
						syncOnStartup: true,
						minIntervalMinutes: 60,
						failureCooldownMinutes: 30,
						limit: 500,
					},
					state: {
						lastAttemptAt: null,
						lastSuccessAt: null,
						lastFailureAt: null,
						lastError: null,
						lastReason: null,
						lastSyncedTrajectoryTotal: null,
						lastObservedTrajectoryTotal: null,
						lastDailySyncDateUtc: null,
						lastCounts: null,
					},
				}),
				startSync: async () => ({
					id: "job-1",
					destination: "hf://detour/dumps",
					command: "hf datasets sync ...",
					reason: "manual",
					status: "running",
					startedAt: new Date().toISOString(),
					finishedAt: null,
					counts: null,
					stdout: null,
					stderr: null,
					error: null,
				}),
				checkNow: async () => null,
			} as unknown as import("../agent-hf-sync-service").AgentHfSyncService,
		};
		const route2 = evalRoutes(deps, jsonHelper());
		const ok = await call(route2, "GET", "/api/eval/hf-sync", undefined, TOKEN);
		expect(ok.status).toBe(200);
		expect((ok.body.policy as { enabled: boolean }).enabled).toBe(true);
	});

	test("POST /api/eval/hf-sync/run kicks off a manual sync job", async () => {
		const calls: { reason?: string; destination?: string; limit?: number }[] = [];
		const deps: EvalRouteDeps = {
			...makeDeps(),
			agentHfSync: {
				status: async () => ({}) as never,
				startSync: async (
					reason: string,
					opts?: { destination?: string; limit?: number },
				) => {
					calls.push({
						reason,
						...(opts?.destination !== undefined
							? { destination: opts.destination }
							: {}),
						...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
					});
					return {
						id: "job-2",
						destination: opts?.destination ?? "hf://detour/dumps",
						command: "hf ...",
						reason,
						status: "running",
						startedAt: new Date().toISOString(),
						finishedAt: null,
						counts: null,
						stdout: null,
						stderr: null,
						error: null,
					};
				},
				checkNow: async () => null,
			} as unknown as import("../agent-hf-sync-service").AgentHfSyncService,
		};
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(
			route,
			"POST",
			"/api/eval/hf-sync/run",
			{ reason: "manual", limit: 100 },
			TOKEN,
		);
		expect(out.status).toBe(200);
		const job = out.body.job as { id: string };
		expect(job.id).toBe("job-2");
		expect(calls[0]?.reason).toBe("manual");
		expect(calls[0]?.limit).toBe(100);
	});
});

describe("eval routes — companion", () => {
	test("GET /api/eval/companion exposes preset, assignments, backends", async () => {
		const companion = new CompanionService();
		const deps: EvalRouteDeps = { ...makeDeps(), companion };
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(route, "GET", "/api/eval/companion", undefined, TOKEN);
		expect(out.status).toBe(200);
		expect(out.body.ok).toBe(true);
		expect(typeof out.body.preset).toBe("string");
		const presets = out.body.presets as Array<{ id: string }>;
		expect(presets.length).toBeGreaterThan(0);
		const assignments = out.body.assignments as Record<string, string>;
		expect(assignments.triage).toBe("classical");
		expect(assignments.personaPrePass).toBe("llm");
		const backends = out.body.backends as Record<
			string,
			{ available: boolean }
		>;
		expect(backends.classical.available).toBe(true);
	});

	test("POST /api/eval/companion/assignments updates a single job", async () => {
		const companion = new CompanionService();
		const deps: EvalRouteDeps = { ...makeDeps(), companion };
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(
			route,
			"POST",
			"/api/eval/companion/assignments",
			{ assignments: { triage: "llm" } },
			TOKEN,
		);
		expect(out.status).toBe(200);
		const assignments = out.body.assignments as Record<string, string>;
		expect(assignments.triage).toBe("llm");
		// other rows untouched
		expect(assignments.shouldRespond).toBe("classical");
	});

	test("POST /api/eval/companion/assignments with reset:true restores defaults", async () => {
		const companion = new CompanionService();
		companion.setJobBackend("triage", "off");
		companion.setJobBackend("shouldRespond", "llm");
		const deps: EvalRouteDeps = { ...makeDeps(), companion };
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(
			route,
			"POST",
			"/api/eval/companion/assignments",
			{ reset: true },
			TOKEN,
		);
		expect(out.status).toBe(200);
		const assignments = out.body.assignments as Record<string, string>;
		expect(assignments.triage).toBe("classical");
		expect(assignments.shouldRespond).toBe("classical");
	});

	test("POST /api/eval/companion/assignments rejects unknown job/choice silently", async () => {
		const companion = new CompanionService();
		const deps: EvalRouteDeps = { ...makeDeps(), companion };
		const route = evalRoutes(deps, jsonHelper());
		const out = await call(
			route,
			"POST",
			"/api/eval/companion/assignments",
			{
				assignments: {
					triage: "bogus",
					nonExistentJob: "llm",
				},
			},
			TOKEN,
		);
		expect(out.status).toBe(200);
		const assignments = out.body.assignments as Record<string, string>;
		// triage stayed at default because "bogus" was rejected
		expect(assignments.triage).toBe("classical");
	});

	test("GET /api/eval/companion returns 503 when companion not wired", async () => {
		const route = evalRoutes(makeDeps(), jsonHelper());
		const out = await call(route, "GET", "/api/eval/companion", undefined, TOKEN);
		expect(out.status).toBe(503);
	});
});
