import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { evalApiEnabled, evalRoutes, type EvalRouteDeps, type EvalRouteHelpers } from "./eval-routes";
import type { ActivityService } from "../activity";
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
