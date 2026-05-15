/**
 * Regression test for "structured planner busted" canned responses.
 *
 * Symptom: agent on Discord/Telegram keeps replying with "My bad — the
 * structured planner is still the busted component..." That's the
 * dpe-fallback plain-text reply firing because the structured planner
 * returned null. Cause: the model emits OpenAI-style JSON shapes —
 * `providers: "USER_ACTIVITY_CONTEXT"` (string instead of array),
 * `actions: [{name, params}]` instead of `[{name}]`, top-level `text: ""`
 * with the actual reply hiding inside `actions[0].params.text` — and
 * eliza's schema validation rejects them all.
 *
 * Fix: `normalizeStructuredResponse` now coerces these common drift
 * shapes back to the planner's expected form before validation runs.
 */
import { describe, it, expect } from "bun:test";
import { AgentRuntime } from "../runtime";

// `normalizeStructuredResponse` is private; reach in for the test.
type Runtime = InstanceType<typeof AgentRuntime>;
type Normalizer = (
	this: Runtime,
	content: Record<string, unknown> | null,
	depth?: number,
) => Record<string, unknown> | null;

function callNormalizer(
	input: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const fn = (
		AgentRuntime.prototype as unknown as { normalizeStructuredResponse: Normalizer }
	).normalizeStructuredResponse;
	// The recursive .response-unwrap path calls `this.normalizeStructuredResponse`
	// — set up a minimal `this` that has the method bound. We don't need any
	// other AgentRuntime state for this pure-function logic.
	const ctx = {
		normalizeStructuredResponse: function (
			content: Record<string, unknown> | null,
			depth = 0,
		) {
			return fn.call(this as unknown as Runtime, content, depth);
		},
	};
	return ctx.normalizeStructuredResponse(input);
}

describe("normalizeStructuredResponse — model-drift coercion", () => {
	it("does NOT coerce providers — different schemas want different shapes (string vs array)", () => {
		// The message-handler planner declares providers: string, autonomous
		// mode declares array[string]. Touching it here either way breaks
		// one of the call sites. Leave it for the validator.
		const out = callNormalizer({
			thought: "x",
			providers: "USER_ACTIVITY_CONTEXT",
			actions: [],
			text: "hi",
			simple: true,
		});
		expect(out?.providers).toBe("USER_ACTIVITY_CONTEXT");
	});

	it("preserves array-shaped providers as-is", () => {
		const out = callNormalizer({
			providers: ["USER_ACTIVITY_CONTEXT", "KNOWLEDGE"],
			actions: [],
		});
		expect(out?.providers).toEqual(["USER_ACTIVITY_CONTEXT", "KNOWLEDGE"]);
	});

	it("leaves a clean array of action names intact", () => {
		const out = callNormalizer({
			providers: [],
			actions: ["REPLY", "NONE"],
		});
		expect(out?.actions).toEqual(["REPLY", "NONE"]);
	});

	it("flattens [{ name, params }] to ['NAME'] (planner schema is array[string])", () => {
		const out = callNormalizer({
			providers: [],
			actions: [
				{ name: "REPLY", params: { text: "yo" } },
				{ name: "GENERATE_IMAGE", params: { prompt: "a squirrel" } },
			],
			text: "yo",
		});
		expect(out?.actions).toEqual(["REPLY", "GENERATE_IMAGE"]);
	});

	it("lifts actions[0].params.text up to top-level text BEFORE flattening", () => {
		const out = callNormalizer({
			thought: "Reply briefly",
			providers: "USER_ACTIVITY_CONTEXT",
			actions: [
				{
					name: "REPLY",
					params: {
						text: "Depends on which fire you're talking about.",
					},
				},
			],
			text: "",
			simple: false,
		});
		// providers untouched (per the schema-variation rule above)
		expect(out?.providers).toBe("USER_ACTIVITY_CONTEXT");
		expect(out?.actions).toEqual(["REPLY"]);
		expect(out?.text).toBe("Depends on which fire you're talking about.");
	});

	it("splits a comma-separated actions string into a string array", () => {
		const out = callNormalizer({
			providers: [],
			actions: "REPLY, NONE",
		});
		expect(out?.actions).toEqual(["REPLY", "NONE"]);
	});

	it("accepts the OpenAI-shaped Telegram payload that was failing in prod", () => {
		// Verbatim shape that ran on a 5/14 telegram trajectory and tripped
		// the dpe-fallback "structured planner is busted" canned reply.
		const out = callNormalizer({
			thought: "Dexploarer is checking...",
			actions: [
				{
					name: "REPLY",
					params: {
						text: "Depends on which fire you're talking about.",
					},
				},
			],
			providers: "USER_ACTIVITY_CONTEXT",
			text: "",
			simple: false,
		});
		// providers stays string — message-handler schema wants string
		expect(out?.providers).toBe("USER_ACTIVITY_CONTEXT");
		expect(out?.actions).toEqual(["REPLY"]);
		expect(out?.text).toBe("Depends on which fire you're talking about.");
		expect(out?.simple).toBe(false);
	});

	it("does not overwrite a non-empty top-level text from params", () => {
		const out = callNormalizer({
			providers: [],
			actions: [
				{ name: "REPLY", params: { text: "inside-params" } },
			],
			text: "top-level",
		});
		expect(out?.text).toBe("top-level");
	});

	it("still unwraps nested .response objects (existing behavior)", () => {
		const out = callNormalizer({
			response: {
				thought: "ok",
				providers: "X",
				actions: ["REPLY"],
				text: "hi",
			},
		});
		expect(out?.thought).toBe("ok");
		// providers preserved as-is, actions flattened
		expect(out?.providers).toBe("X");
		expect(out?.actions).toEqual(["REPLY"]);
	});

	it("returns null for null input (no crash)", () => {
		expect(callNormalizer(null)).toBeNull();
	});
});
