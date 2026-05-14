/**
 * Typed error for paid-plan quota exhaustion (ChatGPT Pro weekly cap, etc).
 *
 * Codex Responses API returns this shape on 429:
 *   {
 *     "error": {
 *       "type": "usage_limit_reached",
 *       "message": "The usage limit has been reached",
 *       "plan_type": "pro",
 *       "resets_at": 1779177098,         // unix seconds
 *       "resets_in_seconds": 498696,
 *       "eligible_promo": null
 *     }
 *   }
 *
 * We surface this separately from generic 429s because the remediation is
 * different — for a generic 429 you wait a few seconds and retry; for a
 * plan-quota cap you wait days or switch credential/provider. The runtime
 * uses the typed error to (a) update ProviderQuotaService so the UI can
 * show a banner with the reset time, and (b) fail subsequent calls fast
 * instead of hammering the upstream until the window resets.
 */

export interface QuotaExceededDetails {
	readonly planType: string;
	readonly resetsAtMs: number;
	readonly upstreamMessage: string;
}

export class QuotaExceededError extends Error {
	readonly planType: string;
	readonly resetsAtMs: number;
	readonly upstreamMessage: string;

	constructor(details: QuotaExceededDetails) {
		super(
			`Codex Pro usage limit reached (plan=${details.planType}, resets at ${new Date(
				details.resetsAtMs,
			).toISOString()}): ${details.upstreamMessage}`,
		);
		this.name = "QuotaExceededError";
		this.planType = details.planType;
		this.resetsAtMs = details.resetsAtMs;
		this.upstreamMessage = details.upstreamMessage;
	}
}

/**
 * Parse a 429 body from the Codex Responses API. Returns the typed
 * `QuotaExceededError` when the body matches the `usage_limit_reached`
 * shape, or `null` otherwise (caller falls back to generic 429 handling).
 *
 * Defensive: accepts both `resets_at` (unix seconds) and `resets_in_seconds`
 * shapes; either one is enough to compute when the cap lifts.
 */
export function parseQuotaError(body: string): QuotaExceededError | null {
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const root = raw as Record<string, unknown>;
	const err = root.error;
	if (!err || typeof err !== "object" || Array.isArray(err)) return null;
	const errObj = err as Record<string, unknown>;
	if (errObj.type !== "usage_limit_reached") return null;
	const planType = typeof errObj.plan_type === "string" ? errObj.plan_type : "unknown";
	const upstreamMessage = typeof errObj.message === "string" ? errObj.message : "The usage limit has been reached";
	const resetsAtSeconds = typeof errObj.resets_at === "number" && Number.isFinite(errObj.resets_at)
		? errObj.resets_at
		: null;
	const resetsInSeconds = typeof errObj.resets_in_seconds === "number" && Number.isFinite(errObj.resets_in_seconds)
		? errObj.resets_in_seconds
		: null;
	const resetsAtMs = resetsAtSeconds !== null
		? resetsAtSeconds * 1000
		: resetsInSeconds !== null
			? Date.now() + resetsInSeconds * 1000
			: Date.now() + 60 * 60 * 1000;
	return new QuotaExceededError({ planType, resetsAtMs, upstreamMessage });
}
