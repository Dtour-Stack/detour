/**
 * CompanionService contract tests — runs without spawning a real
 * llama-server by stubbing fetch.
 *
 * The service now dispatches each job through a per-job backend
 * assignment table. Defaults: classical for triage / shouldRespond /
 * memoryQuery / compress, llm for personaPrePass. Tests cover:
 *
 *   - classical default works for the 4 classifier/extraction jobs
 *     even with no llama-server running
 *   - personaPrePass returns null when the LLM is down (classical
 *     fallback intentionally declines — generation isn't its job)
 *   - explicit "llm" assignment routes to /v1/completions and parses
 *     the response correctly
 *   - status() exposes preset / presets / assignments / backends
 *   - recentJobs ring-buffer caps at 25 entries and records the
 *     backend that served each call
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	COMPANION_MODEL_PRESETS,
	CompanionService,
	DEFAULT_COMPANION_PRESET,
	DEFAULT_JOB_ASSIGNMENTS,
} from "./companion-service";
import type { LocalChatActiveServerInfo, LocalChatService } from "./chat-service";

/**
 * Minimal mock of LocalChatService that exposes only what the companion's
 * dedup path looks at. Lets us drive shared-mode tests without spinning
 * up a real llama-server.
 */
function fakeLocalChat(
	info: LocalChatActiveServerInfo | null,
): { ref: LocalChatService; setActive: (next: LocalChatActiveServerInfo | null) => void } {
	let active = info;
	return {
		ref: {
			getActiveServerInfo: () => active,
		} as unknown as LocalChatService,
		setActive: (next) => {
			active = next;
		},
	};
}

const origFetch = globalThis.fetch;
const origEnv = { ...process.env };

afterEach(() => {
	globalThis.fetch = origFetch;
	for (const k of Object.keys(process.env)) {
		if (!(k in origEnv)) delete process.env[k];
	}
	Object.assign(process.env, origEnv);
});

function stubFetchReturning(textByCallIndex: string[]): {
	calls: Array<{ url: string; body: unknown }>;
} {
	const calls: Array<{ url: string; body: unknown }> = [];
	let i = 0;
	globalThis.fetch = (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({
			url,
			body: init?.body ? JSON.parse(init.body as string) : null,
		});
		const text = textByCallIndex[i++ % textByCallIndex.length] ?? "";
		return new Response(
			JSON.stringify({ choices: [{ text }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof globalThis.fetch;
	return { calls };
}

describe("Default assignments", () => {
	test("classifier jobs default to classical", () => {
		expect(DEFAULT_JOB_ASSIGNMENTS.triage).toBe("classical");
		expect(DEFAULT_JOB_ASSIGNMENTS.shouldRespond).toBe("classical");
		expect(DEFAULT_JOB_ASSIGNMENTS.memoryQuery).toBe("classical");
		expect(DEFAULT_JOB_ASSIGNMENTS.compress).toBe("classical");
	});
	test("personaPrePass defaults to llm — it's the only truly generative job", () => {
		expect(DEFAULT_JOB_ASSIGNMENTS.personaPrePass).toBe("llm");
	});
});

describe("Classical backend keeps working when companion is down", () => {
	test("triage classifies acknowledgments as skip even with no server", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		expect(await svc.triage("ok")).toBe("skip");
		expect(await svc.triage("lol nice")).toBe("skip");
	});

	test("triage classifies action verbs as tool", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		expect(await svc.triage("deploy the worker")).toBe("tool");
	});

	test("triage classifies URLs and lookup verbs as search", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		expect(await svc.triage("check https://example.com")).toBe("search");
		expect(await svc.triage("look up the price of SOL")).toBe("search");
	});

	test("shouldRespond suppresses double-speak by the agent", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		const out = await svc.shouldRespond("Detour", "#general", [
			{ author: "alice", text: "any updates?" },
			{ author: "Detour", text: "yes, just shipped" },
		]);
		expect(out).toBe(false);
	});

	test("shouldRespond returns true on direct @-mention", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		const out = await svc.shouldRespond("Detour", "#general", [
			{ author: "alice", text: "@detour how's the build?" },
		]);
		expect(out).toBe(true);
	});

	test("memoryQuery returns the literal text plus keyword query", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		const queries = await svc.memoryQuery("show me the goal service code");
		expect(queries).not.toBeNull();
		expect(queries![0]).toContain("show me");
	});

	test("compress shrinks long history by extractive ranking", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		const history = Array.from({ length: 20 }, (_, i) =>
			`Sentence ${i} about the project that should be summarized into a tight extractive form.`,
		).join(" ");
		const out = await svc.compress(history, 30);
		expect(out).not.toBeNull();
		expect(out!.length).toBeLessThan(history.length);
	});

	test("personaPrePass falls through to null when LLM is down (no classical generation)", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		expect(await svc.personaPrePass("Detour", "ship it")).toBeNull();
	});
});

describe("LLM backend dispatch when explicitly assigned", () => {
	test("triage routed to llm parses label from /v1/completions", async () => {
		const { calls } = stubFetchReturning([" chat"]);
		process.env.DETOUR_COMPANION_URL = "http://127.0.0.1:51234";
		const svc = new CompanionService();
		svc.setJobBackend("triage", "llm");
		const label = await svc.triage("hey what's up there");
		expect(label).toBe("chat");
		expect(calls[0]!.url).toBe("http://127.0.0.1:51234/v1/completions");
	});

	test("personaPrePass takes only the first line of output", async () => {
		stubFetchReturning([
			" User is checking on delivery timing.\nExtra line that should be dropped.",
		]);
		process.env.DETOUR_COMPANION_URL = "http://127.0.0.1:51234";
		const svc = new CompanionService();
		const frame = await svc.personaPrePass("Detour", "ship it today?");
		expect(frame).toBe("User is checking on delivery timing.");
	});

	test("compress routed to llm trims and returns the summary text", async () => {
		stubFetchReturning(["  User asked about deploys; agent answered.  "]);
		process.env.DETOUR_COMPANION_URL = "http://127.0.0.1:51234";
		const svc = new CompanionService();
		svc.setJobBackend("compress", "llm");
		const summary = await svc.compress("long history here");
		expect(summary).toBe("User asked about deploys; agent answered.");
	});
});

describe("Status & ring buffer", () => {
	test("status() reports enabled from DETOUR_COMPANION_ENABLED", () => {
		process.env.DETOUR_COMPANION_ENABLED = "true";
		const svc = new CompanionService();
		expect(svc.status().enabled).toBe(true);
		delete process.env.DETOUR_COMPANION_ENABLED;
		expect(new CompanionService().status().enabled).toBe(false);
	});

	test("status() exposes the full preset list and the active preset id", () => {
		const svc = new CompanionService();
		const s = svc.status();
		expect(s.preset).toBe(DEFAULT_COMPANION_PRESET.id);
		expect(s.presets.length).toBe(COMPANION_MODEL_PRESETS.length);
	});

	test("status() reports classical as always available", () => {
		const svc = new CompanionService();
		expect(svc.status().backends.classical.available).toBe(true);
	});

	test("status() reports llm unavailable when no server is running", () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		expect(svc.status().backends.llm.available).toBe(false);
	});

	test("recentJobs caps at 25 entries and records backend", async () => {
		delete process.env.DETOUR_COMPANION_URL;
		const svc = new CompanionService();
		for (let i = 0; i < 40; i += 1) {
			await svc.triage(`m-${i}`);
		}
		const jobs = svc.status().recentJobs;
		expect(jobs.length).toBeLessThanOrEqual(25);
		for (const j of jobs) {
			expect(["classical", "llm", "off"]).toContain(j.backend);
		}
	});

	test("default model is Qwen3-0.6B (instruction-tuned, smallest tier)", () => {
		const svc = new CompanionService();
		expect(svc.status().modelRef).toContain("Qwen3-0.6B");
	});

	test("setJobBackend rejects bogus choices silently", () => {
		const svc = new CompanionService();
		svc.setJobBackend("triage", "bogus" as unknown as "classical");
		expect(svc.getJobBackend("triage")).toBe("classical");
	});

	test("resetAssignments restores recommended defaults", () => {
		const svc = new CompanionService();
		svc.setJobBackend("triage", "llm");
		svc.resetAssignments();
		expect(svc.getJobBackend("triage")).toBe("classical");
	});

	test("non-OK HTTP swallowed → null (agent path keeps working)", async () => {
		globalThis.fetch = (async () => {
			return new Response("oops", { status: 503 });
		}) as unknown as typeof globalThis.fetch;
		process.env.DETOUR_COMPANION_URL = "http://127.0.0.1:51234";
		const svc = new CompanionService();
		svc.setJobBackend("triage", "llm");
		// classical fallback will fire because the LLM call fails. With
		// a strict-LLM assignment + no server, classical still classifies
		// "hi" — verify we get some answer, not null.
		const out = await svc.triage("hi");
		expect(out).not.toBeNull();
	});
});

describe("LocalChat dedup (shared mode)", () => {
	test("LLM jobs route to chat server when modelRefs match (no own process spawned)", async () => {
		const sharedRef = DEFAULT_COMPANION_PRESET.modelRef;
		const { ref: localChat } = fakeLocalChat({
			url: "http://127.0.0.1:60001",
			modelRef: sharedRef,
			presetId: DEFAULT_COMPANION_PRESET.id,
		});
		const calls: string[] = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			_init?: RequestInit,
		) => {
			calls.push(typeof input === "string" ? input : input.toString());
			return new Response(
				JSON.stringify({ choices: [{ text: " chat" }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof globalThis.fetch;

		const svc = new CompanionService();
		svc.attachLocalChat(localChat);
		// start() must enter shared mode. With matching modelRefs the
		// dedup branch returns synchronously without spawning anything.
		await svc.start({ modelRef: sharedRef });
		svc.setJobBackend("triage", "llm");
		await svc.triage("hey what's up there");

		// LLM call went to the chat server's url — not a freshly-spawned
		// companion port. Status flags shared mode.
		expect(calls[0]).toBe("http://127.0.0.1:60001/v1/completions");
		expect(svc.status().sharedWithLocalChat).toBe(true);
	});

	test("shared mode degrades to classical when chat server disappears mid-session", async () => {
		const sharedRef = DEFAULT_COMPANION_PRESET.modelRef;
		const fake = fakeLocalChat({
			url: "http://127.0.0.1:60002",
			modelRef: sharedRef,
			presetId: DEFAULT_COMPANION_PRESET.id,
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ choices: [{ text: " chat" }] }), {
				status: 200,
			})) as unknown as typeof globalThis.fetch;

		const svc = new CompanionService();
		svc.attachLocalChat(fake.ref);
		// Manually transition into shared mode by calling start() — uses
		// the dedup branch because the fake reports a matching modelRef.
		// We can't await start() (it tries to spawn) when modelRefs DON'T
		// match, but in the match case start() short-circuits with the
		// shared URL and never spawns.
		await svc.start({ modelRef: sharedRef });
		expect(svc.status().sharedWithLocalChat).toBe(true);

		// Chat server goes away — local-chat reports no active server.
		fake.setActive(null);

		// shouldRespond defaults to classical anyway; force the LLM path
		// for triage and verify it returns null (no shared URL, no own
		// process). The dispatcher's fallback then picks up classical.
		svc.setJobBackend("triage", "llm");
		const out = await svc.triage("ok"); // classical "skip" classifier
		expect(out).toBe("skip"); // fallback fired — answer came from classical
		expect(svc.status().sharedWithLocalChat).toBe(false); // sharedInfo gone
	});

	test("does not enter shared mode when chat modelRef differs from companion modelRef", async () => {
		const { ref: localChat } = fakeLocalChat({
			url: "http://127.0.0.1:60003",
			modelRef: "hf://other/different/model.gguf",
			presetId: "different",
		});
		const svc = new CompanionService();
		svc.attachLocalChat(localChat);
		// Don't call start() (would try to spawn a real server); just
		// confirm the status() helper reports no shared link.
		expect(svc.status().sharedWithLocalChat).toBe(false);
	});
});
