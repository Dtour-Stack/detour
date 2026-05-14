/**
 * Cloud > ElizaOS Cloud tab.
 *
 * One-stop view for the user's ElizaCloud account: connection status,
 * remaining credit balance, model bucket overrides, and a quick link
 * to the dashboard for everything else (agents, billing history, API
 * key management). Mirrors the OpenRouter picker pattern from
 * ModelsTab — fetch live catalog, fall back to text input when the
 * catalog can't load, group by upstream provider.
 */

import { useEffect, useMemo, useState } from "react";
import type {
	ElizaCloudModelInfo,
	ElizaCloudModelsResponse,
	ModelConfig,
} from "../../shared/index";
import type { CloudCreditsBalance } from "../../shared/rpc/providers";
import { rpc } from "../rpc";

const selectStyle = {
	width: "100%",
	padding: 7,
	marginTop: 4,
	borderRadius: "var(--radius-sm)",
	border: "1px solid var(--border)",
	background: "var(--bg)",
	color: "var(--fg)",
	font: "inherit",
	fontFamily: "ui-monospace, Menlo, monospace",
	fontSize: 12,
};

const BUCKET_FIELDS: Array<{
	key: keyof Pick<
		ModelConfig,
		"elizaCloudLarge" | "elizaCloudMedium" | "elizaCloudSmall" | "elizaCloudNano" | "elizaCloudMega" | "elizaCloudResponseHandler" | "elizaCloudImage" | "elizaCloudVideo"
	>;
	label: string;
	hint: string;
}> = [
	{ key: "elizaCloudLarge", label: "Large (TEXT_LARGE)", hint: "Heavyweight reasoning + planning" },
	{ key: "elizaCloudMedium", label: "Medium (TEXT_MEDIUM)", hint: "Default chat" },
	{ key: "elizaCloudSmall", label: "Small (TEXT_SMALL)", hint: "Cheap classify / extract" },
	{ key: "elizaCloudNano", label: "Nano (TEXT_NANO)", hint: "Smallest/fastest" },
	{ key: "elizaCloudMega", label: "Mega (TEXT_MEGA)", hint: "Frontier-tier (use sparingly)" },
	{ key: "elizaCloudResponseHandler", label: "Response handler", hint: "Reply / format / paraphrase" },
	{ key: "elizaCloudImage", label: "Image generation", hint: "Pictures" },
	{ key: "elizaCloudVideo", label: "Video generation", hint: "Videos" },
];

function fmtCredits(balance: number): string {
	if (Number.isFinite(balance)) {
		return balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	}
	return "—";
}

export function ElizaCloudTab() {
	const [cfg, setCfg] = useState<ModelConfig | null>(null);
	const [cfgError, setCfgError] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<ElizaCloudModelsResponse | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [loadingCatalog, setLoadingCatalog] = useState(false);
	const [balance, setBalance] = useState<CloudCreditsBalance | null>(null);
	const [loadingBalance, setLoadingBalance] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		rpc.request.configGetModels({})
			.then((c) => { setCfg(c); setCfgError(null); })
			.catch((err) => setCfgError(err instanceof Error ? err.message : String(err)));
		void refreshCatalog();
		void refreshBalance();
	}, []);

	async function refreshCatalog() {
		setLoadingCatalog(true);
		setCatalogError(null);
		try {
			const data = await rpc.request.providersElizaCloudModels({});
			setCatalog(data);
			if (data.error) setCatalogError(data.error);
		} catch (err) {
			setCatalogError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingCatalog(false);
		}
	}

	async function refreshBalance() {
		setLoadingBalance(true);
		try {
			setBalance(await rpc.request.cloudCreditsBalance({}));
		} catch (err) {
			setBalance({ balance: 0, signedIn: false, error: err instanceof Error ? err.message : String(err) });
		} finally {
			setLoadingBalance(false);
		}
	}

	async function save(next: ModelConfig) {
		setSaving(true);
		try {
			await rpc.request.configSetModels(next);
			setCfg(next);
			setSavedAt(Date.now());
			setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 2000 ? null : t)), 2200);
		} finally {
			setSaving(false);
		}
	}

	if (cfgError && !cfg) {
		return (
			<div>
				<h3 style={{ margin: "0 0 4px" }}>ElizaOS Cloud</h3>
				<div className="banner error" style={{ marginTop: 8 }}>
					Failed to load model config: {cfgError}
				</div>
			</div>
		);
	}
	if (!cfg) return <div className="hint">Loading…</div>;

	const signedIn = balance?.signedIn === true;

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>ElizaOS Cloud</h3>
			<p className="hint">
				Hosted inference + agents. One subscription covers Anthropic, OpenAI,
				Google, and the rest — credits drain per token used.
			</p>

			{/* ── Account ─────────────────────────────────────────────── */}
			<div className="card">
				<div className="provider-header">
					<span className="name">Account</span>
					{signedIn ? (
						<span className="badge ok">Signed in</span>
					) : balance?.error ? (
						<span className="badge err">Issue</span>
					) : (
						<span className="badge muted">Not signed in</span>
					)}
				</div>
				{!signedIn && (
					<div className="hint">
						Connect via Settings → Configuration → Providers → ElizaOS Cloud
						to start using hosted inference.
					</div>
				)}
				{balance?.error && (
					<div className="banner error" style={{ marginTop: 8 }}>
						{balance.error}
					</div>
				)}
				<div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
					<button
						type="button"
						className="btn ghost small"
						onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard" })}
					>
						Open dashboard
					</button>
					<button
						type="button"
						className="btn ghost small"
						onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/agents" })}
					>
						Hosted agents
					</button>
					<button
						type="button"
						className="btn ghost small"
						onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/api-keys" })}
					>
						API keys
					</button>
				</div>
			</div>

			{/* ── Credits ─────────────────────────────────────────────── */}
			<div className="card">
				<div className="provider-header">
					<span className="name">Credits</span>
					<button
						type="button"
						className="btn ghost small"
						onClick={() => void refreshBalance()}
						disabled={loadingBalance}
					>
						{loadingBalance ? "Refreshing…" : "Refresh"}
					</button>
				</div>
				{signedIn ? (
					<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
						<span style={{ fontSize: 28, fontWeight: 600, color: "var(--fg)" }}>
							{fmtCredits(balance?.balance ?? 0)}
						</span>
						<span className="hint">credits remaining</span>
					</div>
				) : (
					<div className="hint">Sign in to see your credit balance.</div>
				)}
				<div className="row" style={{ marginTop: 8, gap: 8 }}>
					<button
						type="button"
						className="btn small"
						onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/billing" })}
					>
						Top up
					</button>
					<button
						type="button"
						className="btn ghost small"
						onClick={() => rpc.request.externalOpen({ url: "https://www.elizacloud.ai/dashboard/billing/transactions" })}
					>
						Transactions
					</button>
				</div>
			</div>

			{/* ── Models ──────────────────────────────────────────────── */}
			<div className="card">
				<div className="row" style={{ marginBottom: 8 }}>
					<label style={{ flex: 1 }}>Model bucket overrides</label>
					<button
						type="button"
						className="btn ghost small"
						onClick={() => void refreshCatalog()}
						disabled={loadingCatalog}
					>
						{loadingCatalog ? "Refreshing…" : "Refresh catalog"}
					</button>
				</div>
				<div className="hint" style={{ marginBottom: 12 }}>
					{catalog && catalog.models.length > 0
						? `${catalog.models.length} models loaded · ${Object.keys(catalog.byProvider).length} upstream providers`
						: "Live catalog from elizacloud.ai. Empty bucket = use plugin's built-in default."}
				</div>
				{catalogError && (
					<div className="banner warn" style={{ marginBottom: 12 }}>
						Catalog: {catalogError}
					</div>
				)}
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
					{BUCKET_FIELDS.map((field) => (
						<ElizaCloudPicker
							key={field.key}
							label={field.label}
							hint={field.hint}
							value={cfg[field.key]}
							catalog={catalog}
							onChange={(value) => save({ ...cfg, [field.key]: value })}
						/>
					))}
				</div>
			</div>

			{saving && <div className="hint">Saving…</div>}
			{!saving && savedAt && <div className="hint" style={{ color: "var(--ok)" }}>Saved. Runtime rebuilt.</div>}
		</div>
	);
}

type ElizaCloudPickerProps = {
	label: string;
	hint?: string;
	value: string;
	catalog: ElizaCloudModelsResponse | null;
	onChange: (value: string) => void;
};

function ElizaCloudPicker({ label, hint, value, catalog, onChange }: ElizaCloudPickerProps) {
	const groups = useMemo(() => {
		if (!catalog || catalog.models.length === 0) return null;
		const byProvider = catalog.byProvider;
		// Stable provider order: known upstreams first, then the rest alphabetical.
		const knownOrder = ["openai", "anthropic", "google", "meta", "deepseek", "xai", "moonshot"];
		const all = Object.keys(byProvider);
		const known = knownOrder.filter((p) => p in byProvider);
		const rest = all.filter((p) => !known.includes(p)).sort();
		return [...known, ...rest].map((provider) => ({
			provider,
			models: ensureModel(byProvider[provider] ?? [], value, provider),
		}));
	}, [catalog, value]);

	return (
		<div>
			<label>
				{label}
				{hint && <span className="hint" style={{ marginLeft: 6, opacity: 0.7, fontWeight: 400 }}>· {hint}</span>}
			</label>
			{groups && groups.some((g) => g.models.length > 0) ? (
				<select
					value={value}
					onChange={(e) => onChange(e.target.value)}
					style={selectStyle}
				>
					<option value="">(plugin default)</option>
					{groups.map((g) => (
						<optgroup key={g.provider} label={g.provider}>
							{g.models.map((m) => (
								<option key={m.id} value={m.id}>{m.id}</option>
							))}
						</optgroup>
					))}
				</select>
			) : (
				<input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					style={selectStyle}
					placeholder="(plugin default)"
				/>
			)}
		</div>
	);
}

function ensureModel(models: ElizaCloudModelInfo[], id: string, provider: string): ElizaCloudModelInfo[] {
	if (!id) return models;
	if (models.some((m) => m.id === id)) return models;
	// If the user previously picked a model that's no longer in the
	// catalog (e.g. deprecated upstream), still surface it so the saved
	// config doesn't visually disappear.
	return [
		{ id, provider, ownedBy: provider, createdAt: 0 },
		...models,
	];
}
