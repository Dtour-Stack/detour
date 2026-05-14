/**
 * Detour-side AccountPoolShim for @elizaos/plugin-anthropic.
 *
 * The plugin reads multi-account state through a globalThis slot
 * (`Symbol.for("eliza.account-pool.anthropic.v1")`) instead of importing
 * Detour. When the slot is filled, the plugin uses our shim to:
 *
 *   - pick the next non-capped account (with an exclude list when the
 *     fetch interceptor wants to rotate after a 429)
 *   - resolve / refresh access tokens through the existing accounts table
 *   - report rate-limit + invalid signals back to Detour
 *
 * The crucial bit for the quota banner: `markRateLimited(accountId, untilMs)`
 * already fires from the plugin's 429 handler with the
 * `anthropic-ratelimit-unified-5h-reset` header. We mirror that into
 * `ProviderQuotaService` so the same banner that surfaces Codex Pro caps
 * also surfaces Claude Pro caps — same UI, same DPE short-circuit, same
 * pre-flight in `sendMessage`.
 *
 * We do NOT throw `QuotaExceededError` from here: the plugin already
 * handles its own fetch-level rotation, and the runtime's deliverMessage
 * pre-flight + DPE short-circuit react off `ProviderQuotaService` state
 * which is exactly what we update.
 */

import { listAccounts, getAccessToken as getAuthAccessToken } from "@elizaos/agent/auth";
import { getProviderQuotaService } from "./provider-quota-service";

const ANTHROPIC_ACCOUNT_POOL_SYMBOL = Symbol.for("eliza.account-pool.anthropic.v1");

interface AccountPoolShim {
	selectAnthropicSubscription(opts?: {
		sessionKey?: string;
		exclude?: string[];
	}): Promise<{ id: string; expiresAt: number } | null>;
	getAccessToken(
		providerId: "anthropic-subscription",
		accountId: string,
	): Promise<string | null>;
	markInvalid(accountId: string, detail?: string): void;
	markRateLimited(accountId: string, untilMs: number, detail?: string): void;
}

type AccountRecord = ReturnType<typeof listAccounts>[number];

function getAccountLabel(record: AccountRecord | undefined): string {
	if (!record) return "Claude Pro";
	const raw = (record as { label?: string }).label;
	return typeof raw === "string" && raw.length > 0 ? raw : "Claude Pro";
}

function isAccountUsable(record: AccountRecord): boolean {
	const creds = (record as { credentials?: { access?: string; expires?: number } }).credentials;
	if (!creds || typeof creds.access !== "string" || creds.access.length === 0) return false;
	// `expires === 0` or missing → legacy / never-expires; treat as usable.
	const exp = creds.expires;
	if (typeof exp !== "number" || exp <= 0) return true;
	return exp > Date.now();
}

function isAccountCapped(accountId: string): boolean {
	return getProviderQuotaService().isCapped("anthropic", accountId);
}

const detourShim: AccountPoolShim = {
	async selectAnthropicSubscription(opts) {
		const exclude = new Set(opts?.exclude ?? []);
		let accounts: AccountRecord[];
		try {
			accounts = listAccounts("anthropic-subscription");
		} catch (err) {
			console.warn(
				"[anthropic-account-pool] listAccounts failed:",
				err instanceof Error ? err.message : err,
			);
			return null;
		}
		for (const account of accounts) {
			if (exclude.has(account.id)) continue;
			if (!isAccountUsable(account)) continue;
			if (isAccountCapped(account.id)) continue;
			const expiresRaw = (account as { credentials?: { expires?: number } }).credentials?.expires;
			const expiresAt = typeof expiresRaw === "number" && expiresRaw > 0
				? expiresRaw
				: Number.POSITIVE_INFINITY;
			return { id: account.id, expiresAt };
		}
		return null;
	},
	async getAccessToken(providerId, accountId) {
		try {
			return await getAuthAccessToken(providerId, accountId);
		} catch (err) {
			console.warn(
				`[anthropic-account-pool] getAccessToken failed for ${accountId}:`,
				err instanceof Error ? err.message : err,
			);
			return null;
		}
	},
	markInvalid(accountId, detail) {
		// 401 from Anthropic — the credential is dead, not capped. Clear any
		// pending cap state so the UI doesn't keep showing a stale "resets in N"
		// for a credential we've already rejected.
		getProviderQuotaService().clear("anthropic", accountId);
		console.warn(
			`[anthropic-account-pool] account marked invalid: ${accountId}${detail ? ` (${detail})` : ""}`,
		);
	},
	markRateLimited(accountId, untilMs, detail) {
		const accounts = (() => {
			try { return listAccounts("anthropic-subscription"); } catch { return []; }
		})();
		const record = accounts.find((a) => a.id === accountId);
		const accountLabel = getAccountLabel(record);
		// We don't know whether this is a 5-hour burst limit or the 7-day
		// weekly cap from the plugin's signal alone. Use the duration as a
		// heuristic: anything more than 24h out is the weekly cap (the only
		// thing the user-facing banner cares about); shorter is a burst
		// limit which the plugin's own fetch-level rotation will absorb.
		const remainingMs = Math.max(0, untilMs - Date.now());
		const ONE_DAY_MS = 24 * 60 * 60 * 1000;
		if (remainingMs < ONE_DAY_MS) {
			console.warn(
				`[anthropic-account-pool] short-window rate-limit (${Math.round(remainingMs / 60_000)}m); not surfacing as cap. detail=${detail ?? "n/a"}`,
			);
			return;
		}
		getProviderQuotaService().mark({
			providerId: "anthropic",
			accountId,
			accountLabel,
			kind: "plan_quota",
			planType: "pro",
			resetsAtMs: untilMs,
			upstreamMessage: detail ?? "Anthropic weekly cap reached",
		});
		console.warn(
			`[anthropic-account-pool] long-window cap recorded for ${accountId} until ${new Date(untilMs).toISOString()} (${detail ?? "no detail"})`,
		);
	},
};

let installed = false;

/**
 * Install the Detour shim into the global slot. Idempotent — repeated
 * calls (rebuild loops, hot-reload) replace the existing slot with the
 * same shim instance instead of stacking.
 */
export function installAnthropicAccountPool(): void {
	if (installed) return;
	(globalThis as Record<symbol, unknown>)[ANTHROPIC_ACCOUNT_POOL_SYMBOL] = detourShim;
	installed = true;
	console.log("[anthropic-account-pool] installed; quota signals will surface in Detour's banner");
}
