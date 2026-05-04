import { useEffect, useState } from "react";
import type { ProviderId, ProviderInfo } from "@detour/shared";
import type { WebClient } from "../../api/client";

export function ProvidersTab({ client }: { client: WebClient }) {
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [drafts, setDrafts] = useState<Record<string, string>>({});

	const refresh = () => client.listProviders().then(setProviders);

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function saveKey(id: ProviderId) {
		const k = (drafts[id] ?? "").trim();
		if (!k) return;
		await client.setProviderKey(id, k);
		setDrafts((d) => ({ ...d, [id]: "" }));
		await refresh();
	}

	async function removeKey(id: ProviderId) {
		if (!confirm(`Remove ${id} key?`)) return;
		await client.removeProviderKey(id);
		await refresh();
	}

	async function activate(id: ProviderId) {
		await client.setActiveProvider(id);
		await refresh();
	}

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>LLM providers</h3>
			<p className="hint">
				Paste an API key per provider. The active one handles new chat messages.
			</p>
			{providers.map((p) => (
				<div className="provider" key={p.id}>
					<div className="provider-header">
						<span className="name">{p.label}</span>
						{p.active ? (
							<span className="badge ok">Active</span>
						) : p.hasKey ? (
							<span className="badge muted">Configured</span>
						) : null}
					</div>
					<div className="row">
						<input
							type="password"
							placeholder={p.hasKey ? "•••••••• stored" : "API key"}
							value={drafts[p.id] ?? ""}
							onChange={(e) =>
								setDrafts((d) => ({ ...d, [p.id]: e.target.value }))
							}
						/>
						{p.hasKey ? (
							<button type="button" className="btn secondary" onClick={() => removeKey(p.id)}>
								Remove
							</button>
						) : (
							<button type="button" className="btn" onClick={() => saveKey(p.id)}>
								Save
							</button>
						)}
						{p.hasKey && !p.active && (
							<button type="button" className="btn secondary" onClick={() => activate(p.id)}>
								Use this
							</button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
