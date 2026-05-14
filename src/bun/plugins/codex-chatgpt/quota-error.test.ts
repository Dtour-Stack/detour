import { describe, expect, test } from "bun:test";
import { parseQuotaError, QuotaExceededError } from "./quota-error";

describe("parseQuotaError", () => {
	test("parses canonical Codex Pro usage_limit_reached body", () => {
		const body = JSON.stringify({
			error: {
				type: "usage_limit_reached",
				message: "The usage limit has been reached",
				plan_type: "pro",
				resets_at: 1779177098,
				resets_in_seconds: 498696,
				eligible_promo: null,
			},
		});
		const err = parseQuotaError(body);
		expect(err).toBeInstanceOf(QuotaExceededError);
		expect(err?.planType).toBe("pro");
		expect(err?.resetsAtMs).toBe(1779177098 * 1000);
		expect(err?.upstreamMessage).toBe("The usage limit has been reached");
	});

	test("falls back to resets_in_seconds when resets_at is missing", () => {
		const body = JSON.stringify({
			error: {
				type: "usage_limit_reached",
				message: "cap",
				plan_type: "pro",
				resets_in_seconds: 600,
			},
		});
		const before = Date.now();
		const err = parseQuotaError(body);
		const after = Date.now();
		expect(err).toBeInstanceOf(QuotaExceededError);
		// resets_in_seconds 600 → ~10 min from now, allowing for wall-clock drift.
		expect(err!.resetsAtMs).toBeGreaterThanOrEqual(before + 600 * 1000);
		expect(err!.resetsAtMs).toBeLessThanOrEqual(after + 600 * 1000);
	});

	test("returns null for non-quota error bodies", () => {
		expect(parseQuotaError(JSON.stringify({ error: { type: "rate_limit" } }))).toBeNull();
		expect(parseQuotaError(JSON.stringify({ error: { message: "boom" } }))).toBeNull();
		expect(parseQuotaError("not json at all")).toBeNull();
		expect(parseQuotaError("")).toBeNull();
	});

	test("defaults plan_type to 'unknown' when missing", () => {
		const body = JSON.stringify({
			error: {
				type: "usage_limit_reached",
				resets_at: 1779177098,
			},
		});
		const err = parseQuotaError(body);
		expect(err).toBeInstanceOf(QuotaExceededError);
		expect(err?.planType).toBe("unknown");
	});
});
