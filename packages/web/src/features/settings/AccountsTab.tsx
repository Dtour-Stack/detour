import { useEffect, useState } from "react";
import type { AuthFlowState } from "@detour/shared";
import type { WebClient } from "../../api/client";

type AccountSummary = {
	id: string;
	providerId: string;
	label: string;
	source: "oauth" | "api-key";
	expires?: number;
	expired?: boolean;
	tokenPreview?: string;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	email?: string;
};

const SUBSCRIPTION_LABEL: Record<string, string> = {
	"anthropic-subscription": "Claude (Pro/Max via OAuth)",
	"openai-codex": "ChatGPT / Codex (OAuth)",
};

const DIRECT_LABEL: Record<string, string> = {
	"anthropic-api": "Anthropic API",
	"openai-api": "OpenAI API",
	"deepseek-api": "DeepSeek API",
	"zai-api": "Z.ai API",
	"moonshot-api": "Moonshot API",
};

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

export function AccountsTab({ client }: { client: WebClient }) {
	const [accounts, setAccounts] = useState<Record<string, AccountSummary[]>>({});
	const [providers, setProviders] = useState<{ subscription: string[]; direct: string[] } | null>(null);
	const [activeFlow, setActiveFlow] = useState<{
		sessionId: string;
		provider: string;
		authUrl: string;
		needsCodeSubmission: boolean;
		state?: AuthFlowState;
	} | null>(null);
	const [code, setCode] = useState("");

	async function refresh() {
		const [a, p] = await Promise.all([
			client.listAllAccounts(),
			client.getAuthProviders(),
		]);
		setAccounts(a as Record<string, AccountSummary[]>);
		setProviders(p);
	}

	useEffect(() => {
		void refresh();
		const off = client.on((msg) => {
			if (msg.kind === "auth:flow-update") {
				setActiveFlow((f) =>
					f && f.sessionId === msg.sessionId ? { ...f, state: msg.state } : f,
				);
				if (
					msg.state.status === "success" ||
					msg.state.status === "cancelled" ||
					msg.state.status === "error" ||
					msg.state.status === "timeout"
				) {
					void refresh();
				}
			}
		});
		return off;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function startFlow(provider: string, label: string) {
		const handle = await client.startAuthFlow(provider, label);
		setActiveFlow({
			sessionId: handle.sessionId,
			provider,
			authUrl: handle.authUrl,
			needsCodeSubmission: handle.needsCodeSubmission,
		});
		setCode("");
		// Open browser
		window.open(handle.authUrl, "_blank", "noopener");
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

	async function removeAccount(provider: string, id: string) {
		if (!confirm(`Remove ${provider} account "${id}"?`)) return;
		await client.deleteAccount(provider, id);
		await refresh();
	}

	if (!providers) return <div className="hint">Loading…</div>;

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Accounts</h3>
			<p className="hint">
				Subscription auth (OAuth) and direct API keys, organized per provider.
				Multiple accounts per provider are supported (e.g., personal + work).
			</p>

			{activeFlow && (
				<div className="provider" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
					<div className="provider-header">
						<span className="name">
							Connecting to{" "}
							{SUBSCRIPTION_LABEL[activeFlow.provider] ?? activeFlow.provider}
						</span>
						<span className="badge">
							{activeFlow.state?.status ?? "pending"}
						</span>
					</div>
					{activeFlow.state?.status === "pending" && (
						<>
							<div className="hint" style={{ marginBottom: 8 }}>
								Browser opened to{" "}
								<a href={activeFlow.authUrl} target="_blank" rel="noopener noreferrer">
									authorize
								</a>
								. Complete the sign-in there.
							</div>
							{activeFlow.needsCodeSubmission && (
								<>
									<div className="hint" style={{ marginBottom: 8 }}>
										After authorizing, paste the <code>code#state</code> string from
										the redirect page below:
									</div>
									<div className="row">
										<input
											type="text"
											value={code}
											onChange={(e) => setCode(e.target.value)}
											placeholder="code#state"
										/>
										<button type="button" className="btn" onClick={submitCode}>
											Submit
										</button>
									</div>
								</>
							)}
							<button
								type="button"
								className="btn secondary"
								style={{ marginTop: 8 }}
								onClick={cancelFlow}
							>
								Cancel
							</button>
						</>
					)}
					{activeFlow.state?.status === "success" && (
						<div className="hint">Connected. The account is now usable for chat.</div>
					)}
					{activeFlow.state?.status === "error" && (
						<div className="bubble error">{activeFlow.state.error ?? "Flow failed"}</div>
					)}
				</div>
			)}

			<section>
				<h3 style={{ marginBottom: 8 }}>Subscription auth (OAuth)</h3>
				{providers.subscription.map((provider) => {
					const list = accounts[provider] ?? [];
					return (
						<div className="provider" key={provider}>
							<div className="provider-header">
								<span className="name">{SUBSCRIPTION_LABEL[provider] ?? provider}</span>
								<button
									type="button"
									className="btn"
									onClick={() => startFlow(provider, "Default")}
								>
									{list.length > 0 ? "Add another" : "Connect"}
								</button>
							</div>
							{list.length === 0 && <div className="hint">No accounts connected.</div>}
							{list.map((acc) => (
								<div className="row" key={acc.id} style={{ marginBottom: 6 }}>
									<div style={{ flex: 1 }}>
										<div style={{ fontWeight: 500 }}>{acc.label}</div>
										<div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
											{acc.tokenPreview ?? "—"} · {fmtExpires(acc.expires)}
											{acc.email && ` · ${acc.email}`}
										</div>
									</div>
									{acc.expired && <span className="badge warn">Expired</span>}
									<button
										type="button"
										className="btn secondary"
										onClick={() => removeAccount(provider, acc.id)}
									>
										Remove
									</button>
								</div>
							))}
						</div>
					);
				})}
			</section>

			<section>
				<h3 style={{ marginBottom: 8 }}>Direct API keys</h3>
				<p className="hint">
					Configured via <strong>Providers</strong> tab (or the <strong>Vault</strong> tab
					for additional providers like deepseek, z.ai, moonshot).
				</p>
				{providers.direct.map((provider) => {
					const list = accounts[provider] ?? [];
					return (
						<div className="provider" key={provider}>
							<div className="provider-header">
								<span className="name">{DIRECT_LABEL[provider] ?? provider}</span>
								<span className="badge muted">{list.length} account(s)</span>
							</div>
							{list.map((acc) => (
								<div className="row" key={acc.id} style={{ marginBottom: 6 }}>
									<div style={{ flex: 1 }}>
										<div style={{ fontWeight: 500 }}>{acc.label}</div>
										<div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
											{acc.tokenPreview ?? "—"}
										</div>
									</div>
									<button
										type="button"
										className="btn secondary"
										onClick={() => removeAccount(provider, acc.id)}
									>
										Remove
									</button>
								</div>
							))}
						</div>
					);
				})}
			</section>
		</div>
	);
}
