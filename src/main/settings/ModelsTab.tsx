import { useEffect, useMemo, useState } from "react";
import type { ModelConfig, OpenRouterModelCapability, OpenRouterModelInfo, OpenRouterModelsResponse } from "../../shared/index";
import { UI_DELAY_MS } from "../../shared/timing";
import { rpc } from "../rpc";

const CODEX_MODELS = [
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex",
	"gpt-5.2",
	"gpt-5.2-codex",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
	"codex-mini-latest",
];

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

type OpenRouterPickerProps = {
	label: string;
	value: string;
	capability: OpenRouterModelCapability;
	catalog: OpenRouterModelsResponse | null;
	onChange: (value: string) => void;
};

function OpenRouterPicker({ label, value, capability, catalog, onChange }: OpenRouterPickerProps) {
	const models = useMemo(() => {
		const bucket = catalog?.buckets[capability] ?? [];
		return ensureModel(bucket, value);
	}, [capability, catalog, value]);
	return (
		<div>
			<label>{label}</label>
			{models.length > 0 ? (
				<select
					value={value}
					onChange={(e) => onChange(e.target.value)}
					style={selectStyle}
				>
					{models.map((model) => (
						<option key={model.id} value={model.id}>
							{model.isFree ? "free · " : ""}{model.id}
						</option>
					))}
				</select>
			) : (
				<input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					style={selectStyle}
					placeholder="model/provider-id"
				/>
			)}
		</div>
	);
}

function ensureModel(models: OpenRouterModelInfo[], id: string): OpenRouterModelInfo[] {
	if (!id || models.some((model) => model.id === id)) return models;
	return [
		{
			id,
			name: id,
			inputModalities: [],
			outputModalities: [],
			supportedParameters: [],
			pricing: {},
			isFree: id.endsWith(":free") || id === "openrouter/free",
			capabilities: [],
		},
		...models,
	];
}

export function ModelsTab() {
	const [cfg, setCfg] = useState<ModelConfig | null>(null);
	const [cfgError, setCfgError] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<OpenRouterModelsResponse | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [loadingCatalog, setLoadingCatalog] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		rpc.request.configGetModels({})
			.then((c) => { setCfg(c); setCfgError(null); })
			.catch((err) => setCfgError(err instanceof Error ? err.message : String(err)));
		void refreshOpenRouterModels();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function refreshOpenRouterModels() {
		setLoadingCatalog(true);
		setCatalogError(null);
		try {
			setCatalog(await rpc.request.providersOpenRouterModels({}));
		} catch (err) {
			setCatalogError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingCatalog(false);
		}
	}

	async function save(next: ModelConfig) {
		setSaving(true);
		try {
			await rpc.request.configSetModels(next);
			setCfg(next);
			setSavedAt(Date.now());
			setTimeout(() => setSavedAt((t) => (t && Date.now() - t > UI_DELAY_MS.saveFlashVisible ? null : t)), UI_DELAY_MS.saveFlash);
		} finally {
			setSaving(false);
		}
	}

	if (cfgError) {
		return (
			<div>
				<h3 style={{ margin: "0 0 4px" }}>Models &amp; routing</h3>
				<div className="banner error" style={{ marginTop: 8 }}>
					Failed to load model config: {cfgError}
				</div>
				<button
					type="button"
					className="btn small"
					style={{ marginTop: 8 }}
					onClick={() => {
						setCfgError(null);
						rpc.request.configGetModels({})
							.then((c) => { setCfg(c); setCfgError(null); })
							.catch((err) => setCfgError(err instanceof Error ? err.message : String(err)));
					}}
				>Retry</button>
			</div>
		);
	}
	if (!cfg) return <div className="hint">Loading…</div>;

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Models &amp; routing</h3>
			<p className="hint">
				Per-bucket model overrides for the active provider. The provider itself is picked in
				Settings → Providers — it's used directly, no implicit fallback to another provider.
			</p>

			<div className="card">
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
					<div>
						<label>Codex large (TEXT_LARGE / TEXT_MEDIUM)</label>
						<select
							value={cfg.codexLarge}
							onChange={(e) => save({ ...cfg, codexLarge: e.target.value })}
							style={selectStyle}
						>
							{CODEX_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
						</select>
					</div>
					<div>
						<label>Codex small (TEXT_SMALL)</label>
						<select
							value={cfg.codexSmall}
							onChange={(e) => save({ ...cfg, codexSmall: e.target.value })}
							style={selectStyle}
						>
							{CODEX_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
						</select>
					</div>
				</div>
				<div style={{ marginTop: 12 }}>
					<label>Codex image (IMAGE)</label>
					<select
						value={cfg.codexImage}
						onChange={(e) => save({ ...cfg, codexImage: e.target.value })}
						style={selectStyle}
					>
						{CODEX_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
					</select>
				</div>
			</div>

			<div className="card">
				<div className="row" style={{ marginBottom: 8 }}>
					<label style={{ flex: 1 }}>OpenRouter models</label>
					<button
						type="button"
						className="btn ghost small"
						onClick={() => refreshOpenRouterModels()}
						disabled={loadingCatalog}
					>
						{loadingCatalog ? "Refreshing…" : "Refresh catalog"}
					</button>
				</div>
				<div className="hint" style={{ marginBottom: 12 }}>
					{catalog
						? `${catalog.models.length} models loaded · ${catalog.buckets.free.length} free · ${catalog.buckets.image.length} image · ${catalog.buckets.video.length} video · ${catalog.buckets.embedding.length} embedding`
						: "Live catalog loads from OpenRouter. If it fails, you can still paste model IDs."}
				</div>
				{catalogError && <div className="banner error" style={{ marginBottom: 12 }}>{catalogError}</div>}
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
					<OpenRouterPicker
						label="OpenRouter large (TEXT_LARGE / TEXT_MEDIUM)"
						value={cfg.openRouterTextLarge}
						capability="text"
						catalog={catalog}
						onChange={(value) => save({ ...cfg, openRouterTextLarge: value })}
					/>
					<OpenRouterPicker
						label="OpenRouter small (TEXT_SMALL)"
						value={cfg.openRouterTextSmall}
						capability="free"
						catalog={catalog}
						onChange={(value) => save({ ...cfg, openRouterTextSmall: value })}
					/>
					<OpenRouterPicker
						label="OpenRouter embedding (TEXT_EMBEDDING)"
						value={cfg.openRouterEmbedding}
						capability="embedding"
						catalog={catalog}
						onChange={(value) => save({ ...cfg, openRouterEmbedding: value })}
					/>
					<OpenRouterPicker
						label="OpenRouter vision (IMAGE_DESCRIPTION)"
						value={cfg.openRouterVision}
						capability="vision"
						catalog={catalog}
						onChange={(value) => save({ ...cfg, openRouterVision: value })}
					/>
				</div>
				<div style={{ marginTop: 12 }}>
					<OpenRouterPicker
						label="OpenRouter image (IMAGE / GENERATE_IMAGE)"
						value={cfg.openRouterImage}
						capability="image"
						catalog={catalog}
						onChange={(value) => save({ ...cfg, openRouterImage: value })}
					/>
				</div>
				<div style={{ marginTop: 12 }}>
					<OpenRouterPicker
						label="OpenRouter video (GENERATE_VIDEO)"
						value={cfg.openRouterVideo}
						capability="video"
						catalog={catalog}
						onChange={(value) => save({ ...cfg, openRouterVideo: value })}
					/>
				</div>
			</div>

			{saving && <div className="hint">Saving…</div>}
			{!saving && savedAt && <div className="hint" style={{ color: "var(--ok)" }}>Saved. Runtime rebuilt.</div>}
		</div>
	);
}
