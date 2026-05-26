import { type ReactElement, useEffect, useMemo, useState } from "react";
import type { ProviderId, ProviderQuotaCap, ProviderInfo } from "../../shared/index";
import { UI_POLL_INTERVAL_MS } from "../../shared/timing";
import { rpc } from "../rpc";
import { onProviderQuotaChanged } from "../rpc-listeners/providers";

/**
 * Top-of-chat banner that surfaces "your active model provider is rate-capped"
 * to the user. Without this, a Codex Pro weekly-cap (or any future
 * `usage_limit_reached` upstream signal) is silent — the agent just stops
 * acting and the user has to guess why. The banner answers: which provider,
 * when it resets, and gives a one-click switch to another configured
 * provider when one is available.
 *
 * Refresh strategy: hydrate from `providersGetQuotaState` on mount, then
 * listen to `providerQuotaChanged` pushes. Tick a 1s timer to keep the
 * "resets in" countdown accurate without re-fetching.
 */

function describeAccountId(providerId: ProviderId): string {
	if (providerId === "openai") return "Codex Pro";
	if (providerId === "anthropic") return "Claude Pro";
	return providerId;
}

function formatCountdown(targetMs: number): string {
	const now = Date.now();
	const remainingMs = Math.max(0, targetMs - now);
	if (remainingMs <= 0) return "reset";
	const totalMinutes = Math.floor(remainingMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

export function QuotaBanner({
	onOpenSettings,
}: {
	onOpenSettings: () => void;
}): ReactElement | null {
	const [activeCap, setActiveCap] = useState<ProviderQuotaCap | null>(null);
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [, setNow] = useState(Date.now());
	const [switching, setSwitching] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void rpc.request.providersGetQuotaState({}).then((state) => {
			if (cancelled) return;
			const active = state.caps.find((c) => c.active) ?? null;
			setActiveCap(active);
		}).catch(() => { /* startup race */ });
		void rpc.request.providersList({}).then((list) => {
			if (!cancelled) setProviders(list);
		}).catch(() => { /* startup race */ });

		const offQuota = onProviderQuotaChanged((payload) => {
			const active = payload.caps.find((c) => c.active) ?? null;
			setActiveCap(active);
		});
		const tick = setInterval(() => setNow(Date.now()), UI_POLL_INTERVAL_MS.liveClock);
		return () => {
			cancelled = true;
			offQuota();
			clearInterval(tick);
		};
	}, []);

	const switchTarget = useMemo<ProviderInfo | null>(() => {
		if (!activeCap) return null;
		// Prefer an OAuth-backed provider that isn't the capped one. Anthropic
		// subscription and Codex are the typical "I'm already authenticated"
		// paths — flipping to one is the fastest unblock when the user has
		// no API key for openrouter / elizacloud sitting in the vault.
		const oauthCandidate = providers.find(
			(p) =>
				p.id !== activeCap.providerId
				&& (p.oauthAccountCount ?? 0) > 0,
		);
		if (oauthCandidate) return oauthCandidate;
		const keyCandidate = providers.find(
			(p) => p.id !== activeCap.providerId && p.hasKey,
		);
		return keyCandidate ?? null;
	}, [activeCap, providers]);

	if (!activeCap) return null;

	async function handleSwitch(): Promise<void> {
		if (!switchTarget) return;
		setSwitching(true);
		try {
			await rpc.request.providersSetActive({ id: switchTarget.id });
		} finally {
			setSwitching(false);
		}
	}

	const countdown = formatCountdown(activeCap.resetsAtMs);
	const resetClock = new Date(activeCap.resetsAtMs).toLocaleString();
	const headline = activeCap.accountLabel || describeAccountId(activeCap.providerId);

	return (
		<div className="banner warn quota-banner" role="status">
			<div className="quota-banner-text">
				<strong>{headline} cap reached.</strong>{" "}
				resets in {countdown} ({resetClock}). until then the agent can't plan or act.
			</div>
			<div className="quota-banner-actions">
				{switchTarget && (
					<button
						type="button"
						className="btn"
						onClick={handleSwitch}
						disabled={switching}
					>
						{switching ? "switching…" : `switch to ${switchTarget.label}`}
					</button>
				)}
				<button
					type="button"
					className="btn"
					onClick={onOpenSettings}
				>
					settings
				</button>
			</div>
		</div>
	);
}
