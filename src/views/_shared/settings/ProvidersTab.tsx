import { useEffect, useState } from "react";
import type { ProviderId, ProviderInfo } from "../../../shared/index";
import type { WebClient } from "../api/client";

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
	oauthProvider?: "anthropic-subscription" | "openai-codex";
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
	},
];

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

export function ProvidersTab({ client }: { client: WebClient }) {
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [accounts, setAccounts] = useState<Record<string, AccountSummary[]>>({});
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [activeFlow, setActiveFlow] = useState<ActiveFlow | null>(null);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function refresh() {
		const [ps, as] = await Promise.all([
			client.listProviders(),
			client.listAllAccounts() as Promise<Record<string, AccountSummary[]>>,
		]);
		setProviders(ps);
		setAccounts(as);
	}

	useEffect(() => {
		void refresh();
		const off = client.on((m) => {
			if (m.kind === "auth:flow-update") {
				setActiveFlow((f) =>
					f && f.sessionId === m.sessionId ? { ...f, status: m.state.status, error: m.state.error } : f,
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
			} else if (m.kind === "provider:changed") {
				void refresh();
			}
		});
		return off;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function saveKey(id: ProviderId) {
		const k = (drafts[id] ?? "").trim();
		if (!k) return;
		try {
			setError(null);
			await client.setProviderKey(id, k);
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
			await client.removeProviderKey(id);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function activate(id: ProviderId) {
		try {
			setError(null);
			await client.setActiveProvider(id);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function startOAuth(provider: "anthropic-subscription" | "openai-codex", label: string) {
		const handle = await client.startAuthFlow(provider, label);
		setActiveFlow({
			sessionId: handle.sessionId,
			provider,
			authUrl: handle.authUrl,
			needsCodeSubmission: handle.needsCodeSubmission,
			status: "pending",
		});
		setCode("");
		await client.openExternal(handle.authUrl);
	}

	async function submitCode() {
		if (!activeFlow) return;
		await client.submitFlowCode(activeFlow.sessionId, code.trim());
	}

	async function cancelFlow() {
		if (!activeFlow) return;
		await client.cancelFlow(activeFlow.sessionId);
		setActiveFlow(null);
	}

	async function removeAccount(provider: string, accountId: string) {
		if (!confirm(`Remove ${provider} account?`)) return;
		await client.deleteAccount(provider, accountId);
		await refresh();
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
									onClick={() => client.openExternal(activeFlow.authUrl)}
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
				const oauthAccounts = vendor.oauthProvider ? accounts[vendor.oauthProvider] ?? [] : [];
				const usableOAuth = oauthAccounts.find((a) => !a.expired);
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
									Subscription (OAuth)
								</div>
								{oauthAccounts.length === 0 ? (
									<button
										type="button"
										className="btn secondary small"
										onClick={() => startOAuth(vendor.oauthProvider!, "Default")}
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
											onClick={() => startOAuth(vendor.oauthProvider!, "Default")}
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
								API key
							</div>
							<div className="row">
								<input
									type="password"
									placeholder={provider?.hasKey ? "•••••••• stored" : "Paste API key"}
									value={drafts[vendor.id] ?? ""}
									onChange={(e) => setDrafts((d) => ({ ...d, [vendor.id]: e.target.value }))}
								/>
								{provider?.hasKey ? (
									<button type="button" className="btn ghost small" onClick={() => removeKey(vendor.id)}>
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
