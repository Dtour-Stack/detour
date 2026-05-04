import { useEffect, useState } from "react";
import type { ModelConfig } from "@detour/shared";
import type { WebClient } from "../../api/client";

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

const PROVIDER_LABELS: Record<string, string> = {
	"anthropic-subscription": "Claude Pro/Max (OAuth)",
	"openai-codex": "ChatGPT (Codex OAuth)",
	"anthropic-api": "Anthropic API key",
	"openai-api": "OpenAI API key",
};

export function ModelsTab({ client }: { client: WebClient }) {
	const [cfg, setCfg] = useState<ModelConfig | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		void client.getModelConfig().then(setCfg);
	}, [client]);

	async function save(next: ModelConfig) {
		setSaving(true);
		try {
			await client.setModelConfig(next);
			setCfg(next);
			setSavedAt(Date.now());
			setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 2000 ? null : t)), 2200);
		} finally {
			setSaving(false);
		}
	}

	function reorder(idx: number, dir: -1 | 1) {
		if (!cfg) return;
		const next = [...cfg.providerPriority];
		const swap = next[idx + dir];
		const cur = next[idx];
		if (swap === undefined || cur === undefined) return;
		next[idx + dir] = cur;
		next[idx] = swap;
		void save({ ...cfg, providerPriority: next });
	}

	if (!cfg) return <div className="hint">Loading…</div>;

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Models &amp; routing</h3>
			<p className="hint">
				Codex model overrides for each size bucket + provider priority for chat.
			</p>

			<div className="card">
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
					<div>
						<label>Codex large (TEXT_LARGE / TEXT_MEDIUM)</label>
						<select
							value={cfg.codexLarge}
							onChange={(e) => save({ ...cfg, codexLarge: e.target.value })}
							style={{ width: "100%", padding: 7, marginTop: 4, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", font: "inherit", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
						>
							{CODEX_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
						</select>
					</div>
					<div>
						<label>Codex small (TEXT_SMALL)</label>
						<select
							value={cfg.codexSmall}
							onChange={(e) => save({ ...cfg, codexSmall: e.target.value })}
							style={{ width: "100%", padding: 7, marginTop: 4, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", font: "inherit", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
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
						style={{ width: "100%", padding: 7, marginTop: 4, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", font: "inherit", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
					>
						{CODEX_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
					</select>
				</div>
			</div>

			<div className="card">
				<label>Provider priority</label>
				<div className="hint" style={{ marginTop: 4, marginBottom: 8 }}>
					Top of list wins for chat. Drag arrows to reorder. Currently active is highlighted.
				</div>
				{cfg.providerPriority.map((p, idx) => (
					<div className="row" key={p} style={{ marginBottom: 4, padding: 6, background: idx === 0 ? "var(--accent-soft)" : "transparent", borderRadius: "var(--radius-sm)" }}>
						<span style={{ flex: 1, fontSize: 12 }}>
							<strong>{idx + 1}.</strong> {PROVIDER_LABELS[p] ?? p}
						</span>
						<button
							type="button"
							className="btn ghost small"
							disabled={idx === 0 || saving}
							onClick={() => reorder(idx, -1)}
						>↑</button>
						<button
							type="button"
							className="btn ghost small"
							disabled={idx === cfg.providerPriority.length - 1 || saving}
							onClick={() => reorder(idx, 1)}
						>↓</button>
					</div>
				))}
			</div>

			{saving && <div className="hint">Saving…</div>}
			{!saving && savedAt && <div className="hint" style={{ color: "var(--ok)" }}>Saved. Runtime rebuilt.</div>}
		</div>
	);
}
