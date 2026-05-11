import { useEffect, useState } from "react";
import type { ProviderId, ProviderInfo } from "../../shared/index";
import { rpc } from "../rpc";
import { onAuthFlowUpdate } from "../rpc-listeners/auth";
import { onProviderChanged } from "../rpc-listeners/providers";

type AccountSummary = {
	id: string;
	providerId: string;
	label: string;
	source: "oauth" | "api-key";
	expires?: number;
	expired?: boolean;
	tokenPreview?: string;
};

type ActiveFlow = {
	sessionId: string;
	provider: string;
	authUrl: string;
	needsCodeSubmission: boolean;
	status: string;
	error?: string;
};

type VendorSpec = {
	id: ProviderId;
	label: string;
	// `openrouter-pkce` and `elizacloud-cli` are synthetic provider ids
	// used only for the OAuth UI dispatch — they don't have OAuth account
	// records (the flows return raw API keys stored under their respective
	// envKey in the vault). The button routes them through bespoke RPC
	// methods rather than the standard `authStartFlow`.
	oauthProvider?: "anthropic-subscription" | "openai-codex" | "openrouter-pkce" | "elizacloud-cli";
	oauthLabel?: string;
};

const VENDORS: VendorSpec[] = [
	{
		id: "anthropic",
		label: "Anthropic (Claude)",
		oauthProvider: "anthropic-subscription",
		oauthLabel: "Connect via Claude Pro / Max OAuth",
	},
	{
		id: "openai",
		label: "OpenAI",
		oauthProvider: "openai-codex",
		oauthLabel: "Connect via ChatGPT (Codex) OAuth",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		oauthProvider: "openrouter-pkce",
		oauthLabel: "Connect via OpenRouter (one-click PKCE)",
	},
	{
		id: "elizacloud",
		label: "ElizaOS Cloud",
		oauthProvider: "elizacloud-cli",
		oauthLabel: "Connect via ElizaOS Cloud",
	},
];

/**
 * The Anthropic OAuth callback page surfaces a literal `<code>#<state>`
 * blob (no `sk-` prefix; both halves are URL-safe base64). Detect it so
 * `saveKey` can short-circuit the API-key path and run the token
 * exchange directly.
 */
function isAnthropicOAuthCodeBlob(input: string): boolean {
	if (input.startsWith("sk-")) return false;
	const splits = input.split("#");
	if (splits.length !== 2) return false;
	const [code, state] = splits;
	if (!code || !state) return false;
	return /^[A-Za-z0-9_-]+$/.test(code) && /^[A-Za-z0-9_-]+$/.test(state);
}

function fmtExpires(expires?: number) {
	if (!expires) return "";
	const ms = expires - Date.now();
	if (ms < 0) return "expired";
	const days = Math.floor(ms / 86_400_000);
	if (days >= 1) return `expires in ${days}d`;
	const hours = Math.floor(ms / 3_600_000);
	if (hours >= 1) return `expires in ${hours}h`;
	const mins = Math.floor(ms / 60_000);
	return `expires in ${mins}m`;
}

export function ProvidersTab() {
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [accounts, setAccounts] = useState<Record<string, AccountSummary[]>>({});
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [activeFlow, setActiveFlow] = useState<ActiveFlow | null>(null);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function refresh() {
		const [ps, as] = await Promise.all([
			rpc.request.providersList({}),
			rpc.request.authListAccounts({}) as Promise<Record<string, AccountSummary[]>>,
		]);
		setProviders(ps);
		setAccounts(as);
	}

	useEffect(() => {
		void refresh();
		// One mount-time subscription for OAuth flow transitions; filter by
		// sessionId via functional setState. The bun-side `subscribeFlow`
		// is registered before authStartFlow returns, so the first push
		// can't fire before this listener is in place.
		const offFlow = onAuthFlowUpdate((m) => {
			setActiveFlow((f) =>
				f && f.sessionId === m.sessionId
					? { ...f, status: m.state.status, error: m.state.error }
					: f,
			);
			if (
				m.state.status === "success" ||
				m.state.status === "cancelled" ||
				m.state.status === "error" ||
				m.state.status === "timeout"
			) {
				void refresh();
				if (m.state.status === "success") setActiveFlow(null);
			}
		});
		const offProvider = onProviderChanged(() => {
			void refresh();
		});
		return () => {
			offFlow();
			offProvider();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function saveKey(id: ProviderId) {
		const k = (drafts[id] ?? "").trim();
		if (!k) return;
		try {
			setError(null);
			// Anthropic's OAuth redirect surfaces a `<code>#<state>` blob
			// on the callback page. Users routinely paste it into the API
			// key box by mistake — auto-detect and route through the OAuth
			// token-exchange instead. Anthropic's flow encodes the PKCE
			// verifier in the state half, so we can do the exchange with
			// just the pasted blob (no originating-session state required).
			if (id === "anthropic" && isAnthropicOAuthCodeBlob(k)) {
				await rpc.request.authImportAnthropicCode({ code: k });
			} else {
				await rpc.request.providersSetKey({ id, key: k });
			}
			setDrafts((d) => ({ ...d, [id]: "" }));
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function removeKey(id: ProviderId) {
		if (!confirm(`Remove ${id} API key?`)) return;
		try {
			setError(null);
			await rpc.request.providersRemoveKey({ id });
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function activate(id: ProviderId) {
		try {
			setError(null);
			await rpc.request.providersSetActive({ id });
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function startOAuth(provider: "anthropic-subscription" | "openai-codex", label: string) {
		try {
			setError(null);
			const handle = await rpc.request.authStartFlow({ provider, label });
			setActiveFlow({
				sessionId: handle.sessionId,
				provider,
				authUrl: handle.authUrl,
				needsCodeSubmission: handle.needsCodeSubmission,
				status: "pending",
			});
			setCode("");
			try { await rpc.request.externalOpen({ url: handle.authUrl }); }
			catch (err) { setError(`Couldn't open browser: ${err instanceof Error ? err.message : String(err)}. Authorize at: ${handle.authUrl}`); }
		} catch (err) {
			setError(`OAuth start failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function startOpenRouterOAuth(label: string) {
		try {
			setError(null);
			const handle = await rpc.request.authStartOpenRouterFlow({ label });
			setActiveFlow({
				sessionId: handle.sessionId,
				provider: "openrouter",
				authUrl: handle.authUrl,
				needsCodeSubmission: false,
				status: "pending",
			});
			setCode("");
			try { await rpc.request.externalOpen({ url: handle.authUrl }); }
			catch (err) { setError(`Couldn't open browser: ${err instanceof Error ? err.message : String(err)}. Authorize at: ${handle.authUrl}`); }
		} catch (err) {
			setError(`OpenRouter OAuth start failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function startElizaCloudFlow(label: string) {
		try {
			setError(null);
			const handle = await rpc.request.authStartElizaCloudFlow({ label });
			setActiveFlow({
				sessionId: handle.sessionId,
				provider: "elizacloud",
				authUrl: handle.authUrl,
				needsCodeSubmission: false,
				status: "pending",
			});
			setCode("");
			try { await rpc.request.externalOpen({ url: handle.authUrl }); }
			catch (err) { setError(`Couldn't open browser: ${err instanceof Error ? err.message : String(err)}. Authorize at: ${handle.authUrl}`); }
		} catch (err) {
			setError(`ElizaOS Cloud sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function submitCode() {
		if (!activeFlow) return;
		try {
			setError(null);
			await rpc.request.authSubmitFlowCode({ sessionId: activeFlow.sessionId, code: code.trim() });
		} catch (err) {
			setError(`Submit code failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function cancelFlow() {
		if (!activeFlow) return;
		try {
			await rpc.request.authCancelFlow({ sessionId: activeFlow.sessionId });
			setActiveFlow(null);
		} catch (err) {
			setError(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function removeAccount(provider: string, accountId: string) {
		if (!confirm(`Remove ${provider} account?`)) return;
		try {
			await rpc.request.authDeleteAccount({ provider, accountId });
			await refresh();
		} catch (err) {
			setError(`Remove failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Providers</h3>
			<p className="hint">
				Connect once via OAuth or paste an API key. The active provider is tried first for chat.
			</p>
			{error && <div className="banner error">{error}</div>}

			{activeFlow && (
				<div className="card" style={{ borderColor: "var(--accent)", marginBottom: 16 }}>
					<div className="provider-header">
						<span className="name">Connecting to {activeFlow.provider}…</span>
						<span className={`badge ${activeFlow.status === "error" ? "err" : "info"}`}>
							{activeFlow.status}
						</span>
					</div>
					{activeFlow.status === "pending" && (
						<>
							<div className="hint" style={{ marginBottom: 8 }}>
								Browser opened — complete the sign-in there.{" "}
								<button
									type="button"
									className="btn ghost small"
									onClick={() => rpc.request.externalOpen({ url: activeFlow.authUrl })}
								>
									Re-open
								</button>
							</div>
							{activeFlow.needsCodeSubmission && (
								<>
									<div className="hint" style={{ marginBottom: 6 }}>
										Paste the <code>code#state</code> from the redirect page:
									</div>
									<div className="row" style={{ marginBottom: 6 }}>
										<input
											type="text"
											value={code}
											onChange={(e) => setCode(e.target.value)}
											placeholder="code#state"
										/>
										<button type="button" className="btn small" onClick={submitCode}>
											Submit
										</button>
									</div>
								</>
							)}
							<button type="button" className="btn ghost small" onClick={cancelFlow}>
								Cancel
							</button>
						</>
					)}
					{activeFlow.status === "error" && (
						<div className="banner error">{activeFlow.error ?? "Flow failed"}</div>
					)}
				</div>
			)}

			{VENDORS.map((vendor) => {
				const provider = providers.find((p) => p.id === vendor.id);
				// `openrouter-pkce` is a UI-only marker — the flow stores the
				// resulting key under OPENROUTER_API_KEY (so `provider.hasKey`
				// reflects it). There's no per-account record like the OAuth
				// providers, so `oauthAccounts` is always empty for it.
				const isOpenRouterPkce = vendor.oauthProvider === "openrouter-pkce";
				const isElizaCloudCli = vendor.oauthProvider === "elizacloud-cli";
				const isSyntheticFlow = isOpenRouterPkce || isElizaCloudCli;
				const oauthAccounts =
					vendor.oauthProvider && !isSyntheticFlow
						? accounts[vendor.oauthProvider] ?? []
						: [];
				const usableOAuth = oauthAccounts.find((a) => !a.expired);
				const startVendorOAuth = isOpenRouterPkce
					? () => startOpenRouterOAuth("Default")
					: isElizaCloudCli
						? () => startElizaCloudFlow("Default")
						: () => startOAuth(vendor.oauthProvider as "anthropic-subscription" | "openai-codex", "Default");
				return (
					<div className="card" key={vendor.id}>
						<div className="provider-header">
							<span className="name">{vendor.label}</span>
							{provider?.active ? (
								<span className="badge ok">Active for chat</span>
							) : provider?.hasKey || usableOAuth ? (
								<span className="badge muted">Configured</span>
							) : (
								<span className="badge muted">Not configured</span>
							)}
						</div>

						{/* OAuth section */}
						{vendor.oauthProvider && (
							<div style={{ marginBottom: 12 }}>
								<div style={{ fontSize: 11, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
									{isOpenRouterPkce
									? "OAuth (one-click)"
									: isElizaCloudCli
										? "Cloud sign-in"
										: "Subscription (OAuth)"}
								</div>
								{oauthAccounts.length === 0 ? (
									<button
										type="button"
										className="btn secondary small"
										onClick={startVendorOAuth}
									>
										{vendor.oauthLabel}
									</button>
								) : (
									<>
										{oauthAccounts.map((acc) => (
											<div className="row" key={acc.id} style={{ marginBottom: 4, gap: 8 }}>
												<div style={{ flex: 1, fontSize: 12 }}>
													<span style={{ fontWeight: 500 }}>{acc.label}</span>{" "}
													<span style={{ color: "var(--fg-muted)" }}>
														{acc.tokenPreview ?? "—"} · {fmtExpires(acc.expires)}
													</span>
												</div>
												{acc.expired && <span className="badge warn">Expired</span>}
												<button
													type="button"
													className="btn ghost small"
													onClick={() => removeAccount(vendor.oauthProvider!, acc.id)}
												>
													Remove
												</button>
											</div>
										))}
										<button
											type="button"
											className="btn secondary small"
											onClick={startVendorOAuth}
											style={{ marginTop: 4 }}
										>
											{usableOAuth ? "Add another" : "Reconnect"}
										</button>
									</>
								)}
							</div>
						)}

						{/* Direct API key section */}
						<div>
							<div style={{ fontSize: 11, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
								{vendor.id === "anthropic" ? "API key or OAuth code" : "API key"}
							</div>
							<div className="row">
								<input
									type="password"
									placeholder={
										drafts[vendor.id]
											? ""
											: provider?.hasKey
												? "•••••••• stored (type to overwrite)"
												: vendor.id === "anthropic"
													? "Paste API key (sk-ant-…) or OAuth code#state"
													: "Paste API key"
									}
									value={drafts[vendor.id] ?? ""}
									onChange={(e) => setDrafts((d) => ({ ...d, [vendor.id]: e.target.value }))}
								/>
								{drafts[vendor.id] ? (
									<button type="button" className="btn small" onClick={() => saveKey(vendor.id)}>
										Save
									</button>
								) : provider?.hasKey || (provider?.oauthAccountCount ?? 0) > 0 ? (
									<button
										type="button"
										className="btn ghost small"
										onClick={() => removeKey(vendor.id)}
										title="Removes both the API key and any OAuth-account credentials for this provider."
									>
										Remove
									</button>
								) : (
									<button type="button" className="btn small" onClick={() => saveKey(vendor.id)}>
										Save
									</button>
								)}
								{(provider?.hasKey || usableOAuth) && !provider?.active && (
									<button type="button" className="btn secondary small" onClick={() => activate(vendor.id)}>
										Use this
									</button>
								)}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}
