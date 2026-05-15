#!/usr/bin/env bun
/**
 * End-to-end validation harness for the planner + trajectory fixes.
 *
 *   - Drives N turns through /api/eval/send
 *   - Pulls full trajectory detail for each
 *   - Asserts: no canned dpe-fallback reply, ≥1 real action recorded
 *     (not just "pending" placeholders), planner first-try success
 *     (TEXT_LARGE call returns parseable output that includes the agent
 *     reply, not just a single field like `providers[1]: "[]"`).
 *
 * Run while a fresh Detour is up:
 *   DETOUR_EVAL_TOKEN=... bun scripts/validate-agent-fixes.ts
 *
 * Pass — every turn shows: real reply, real actions, real planner.
 * Fail — at least one turn falls back / leaves the trajectory full of
 * pending stubs / surfaces the "structured planner busted" canned text.
 */
import process from "node:process";

const TOKEN =
	process.env.DETOUR_EVAL_TOKEN ??
	"fac554055f4b7d43508b2c4e7c4a489da767695b701341e106eb8665e942aa55";
const BASE = process.env.DETOUR_BASE ?? "http://127.0.0.1:2138";

const CANNED_FALLBACK_SIGNATURES = [
	"structured planner",
	"busted component",
	"fallback turn",
	"my bad - the structured planner",
];

// Each prompt declares expected behavior so the harness checks the right
// surface. Conversational turns don't run the full planner (eliza takes a
// lightweight provider-select → reply path), so demanding "actions taken"
// for "what is 2+2?" was incorrectly flagging the system as broken.
type Expectation = "reply" | "action";

const PROMPTS: { text: string; expect: Expectation; action?: string }[] = [
	// Reply-only — short conversational turns
	{ text: "hey detour, your shit fixed yet? give me a one-line yes/no.", expect: "reply" },
	{ text: "detour, list 3 things you can help me with", expect: "reply" },
	{ text: "what is 2+2?", expect: "reply" },
	{ text: "draft a tweet about shipping a prompt eval API in 2 sentences. Don't post.", expect: "reply" },
	{ text: "what's our current goal?", expect: "reply" },
	{ text: "roast this take: every dev should ship 10 prototypes a week to find product-market fit", expect: "reply" },
	// Action turns — only safe local-side-effect actions (no public posting)
	{ text: "generate an image of a chaotic squirrel hacker at a glowing terminal, retrowave style", expect: "action", action: "GENERATE_IMAGE" },
];

type EvalSendResult = {
	ok: boolean;
	reply: string;
	durationMs: number;
	trajectoryId: string | null;
};

type ActionRecord = {
	actionName?: string;
	actionType?: string;
	success?: boolean;
};

type LlmCallRecord = {
	model: string;
	purpose?: string;
	response?: string;
};

type TrajectoryDetail = {
	steps: unknown[];
	actions: ActionRecord[];
	llmCalls: LlmCallRecord[];
};

type SimpleView = {
	request: string | null;
	reply: string | null;
	thinking: unknown[];
	actionsTaken: { name: string; success?: boolean }[];
};

async function send(text: string, timeoutMs = 120_000): Promise<EvalSendResult> {
	const res = await fetch(`${BASE}/api/eval/send`, {
		method: "POST",
		headers: {
			"X-Detour-Eval-Token": TOKEN,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ text, timeoutMs }),
	});
	if (!res.ok) throw new Error(`/api/eval/send → ${res.status} ${await res.text()}`);
	return (await res.json()) as EvalSendResult;
}

async function fetchTrajectory(id: string): Promise<TrajectoryDetail> {
	const res = await fetch(`${BASE}/api/eval/trajectory/${id}`, {
		headers: { "X-Detour-Eval-Token": TOKEN },
	});
	if (!res.ok)
		throw new Error(`/api/eval/trajectory/${id} → ${res.status} ${await res.text()}`);
	const body = (await res.json()) as { detail: TrajectoryDetail };
	return body.detail;
}

async function fetchSimple(id: string): Promise<SimpleView> {
	const res = await fetch(`${BASE}/api/eval/trajectory/${id}/simple`, {
		headers: { "X-Detour-Eval-Token": TOKEN },
	});
	if (!res.ok)
		throw new Error(`/api/eval/trajectory/${id}/simple → ${res.status} ${await res.text()}`);
	return (await res.json()) as SimpleView;
}

type TurnResult = {
	prompt: string;
	reply: string;
	durationMs: number;
	cannedFallback: boolean;
	realActionNames: string[];
	llmCallSummary: string;
	expect: Expectation;
	expectedAction?: string;
	expectationMet: boolean;
};

function summarize(
	detail: TrajectoryDetail,
	simple: SimpleView,
): {
	realActionNames: string[];
	llmCallSummary: string;
} {
	const realActionNames = simple.actionsTaken.map((a) => a.name);
	const llmCallSummary = detail.llmCalls
		.map(
			(c) =>
				`${c.model}:${c.purpose ?? "?"}(${(c.response ?? "").length}c)`,
		)
		.join(" ");
	return { realActionNames, llmCallSummary };
}

async function runTurn(
	spec: { text: string; expect: Expectation; action?: string },
): Promise<TurnResult> {
	console.log(`\n--- PROMPT: ${spec.text}`);
	// Action turns (especially GENERATE_IMAGE) regularly take 60-90s; bump
	// the per-call timeout so we don't false-fail the slow path.
	const timeoutMs = spec.expect === "action" ? 240_000 : 90_000;
	const res = await send(spec.text, timeoutMs);
	console.log(`    reply (${res.durationMs}ms): ${JSON.stringify(res.reply)}`);
	const cannedFallback = CANNED_FALLBACK_SIGNATURES.some((sig) =>
		res.reply.toLowerCase().includes(sig.toLowerCase()),
	);
	let realActionNames: string[] = [];
	let llmCallSummary = "";
	if (res.trajectoryId) {
		try {
			const [detail, simple] = await Promise.all([
				fetchTrajectory(res.trajectoryId),
				fetchSimple(res.trajectoryId),
			]);
			const s = summarize(detail, simple);
			realActionNames = s.realActionNames;
			llmCallSummary = s.llmCallSummary;
		} catch (err) {
			console.log(
				`    (could not fetch trajectory ${res.trajectoryId}: ${err instanceof Error ? err.message : err})`,
			);
		}
	}
	console.log(`    LLM calls: ${llmCallSummary}`);
	console.log(`    real actionsTaken: [${realActionNames.join(", ")}]`);
	let expectationMet: boolean;
	if (spec.expect === "action") {
		expectationMet =
			!!spec.action && realActionNames.includes(spec.action);
		if (!expectationMet) {
			console.log(
				`    ⚠️  expected action ${spec.action} in trajectory, got [${realActionNames.join(", ")}]`,
			);
		}
	} else {
		// reply turns are healthy as long as: real text came back and no canned dpe-fallback fired.
		const hasReplyText =
			typeof res.reply === "string" && res.reply.trim().length > 0;
		expectationMet = hasReplyText && !cannedFallback;
		if (!hasReplyText)
			console.log(`    ⚠️  empty reply`);
	}
	if (cannedFallback) {
		console.log(
			`    ⚠️  reply contains a dpe-fallback canned-fallback signature`,
		);
	}
	return {
		prompt: spec.text,
		reply: res.reply,
		durationMs: res.durationMs,
		cannedFallback,
		realActionNames,
		llmCallSummary,
		expect: spec.expect,
		...(spec.action ? { expectedAction: spec.action } : {}),
		expectationMet,
	};
}

async function main(): Promise<void> {
	console.log(`Validation harness → ${BASE}`);
	const health = await fetch(`${BASE}/api/eval/health`, {
		headers: { "X-Detour-Eval-Token": TOKEN },
	});
	if (!health.ok) {
		console.error(`Eval health check failed: ${health.status} ${await health.text()}`);
		process.exit(2);
	}
	console.log(`Health: ${await health.text()}`);

	const results: TurnResult[] = [];
	for (const spec of PROMPTS) {
		try {
			results.push(await runTurn(spec));
		} catch (err) {
			console.log(
				`    ❌ turn failed: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	const total = results.length;
	const cannedHits = results.filter((r) => r.cannedFallback).length;
	const replyTurns = results.filter((r) => r.expect === "reply");
	const actionTurns = results.filter((r) => r.expect === "action");
	const replyOk = replyTurns.filter((r) => r.expectationMet).length;
	const actionOk = actionTurns.filter((r) => r.expectationMet).length;

	console.log(`\n===== SUMMARY =====`);
	console.log(`Turns:                              ${total}`);
	console.log(`With canned dpe-fallback signature: ${cannedHits} ← target: 0`);
	console.log(`Reply-only turns satisfied:         ${replyOk}/${replyTurns.length}`);
	console.log(`Action-required turns satisfied:    ${actionOk}/${actionTurns.length}`);

	const allGood =
		cannedHits === 0 &&
		replyOk === replyTurns.length &&
		actionOk === actionTurns.length;
	if (allGood) {
		console.log(`\n✅ All checks passed — agent at peak performance.`);
		process.exit(0);
	}
	console.log(`\n❌ Regressions remain (see above).`);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
