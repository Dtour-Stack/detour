/**
 * Settings > Local AI tab.
 *
 * Surfaces the local llama-server status (running PID, model, port, last
 * error, download progress) and the cloud-embedding fallback config.
 *
 * Also exposes a one-click "Test embedding" button that calls
 * /api/debug/embedding so the user can confirm semantic vectors are real
 * (not the zero-vector fallback).
 */

import { useCallback, useEffect, useState } from "react";
import type { LlamaServerStatus, WebClient } from "../api/client";
import { rpc } from "../rpc";

interface DebugProbe {
	dim: number;
	nonZero: number;
	durationMs: number;
	adapterEmbeddingDimension: string | null;
	embeddingServiceRegistered: boolean | null;
	embeddingServiceDisabled: boolean | null;
	queueSize: number | null;
}

type BusyState = "" | "save" | "test" | "clear";

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}

export function LocalAITab({ client: _client }: { client: WebClient }) {
	const [status, setStatus] = useState<LlamaServerStatus | null>(null);
	const [openaiKey, setOpenaiKey] = useState("");
	const [hasOpenaiKey, setHasOpenaiKey] = useState(false);
	const [busy, setBusy] = useState<BusyState>("");
	const [probe, setProbe] = useState<DebugProbe | null>(null);
	const [probeError, setProbeError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);

	const loadStatus = useCallback(async () => {
		try {
			const s = await rpc.request.llamaStatus({});
			setStatus(s as LlamaServerStatus);
		} catch {
			setStatus(null);
		}
	}, []);

	const checkOpenaiKey = useCallback(async () => {
		try {
			const inv = await rpc.request.vaultInventory({});
			setHasOpenaiKey(
				inv.some((e) => e.key === "OPENAI_EMBEDDING_API_KEY" || e.key === "OPENAI_API_KEY"),
			);
		} catch {
			/* noop */
		}
	}, []);

	useEffect(() => {
		void loadStatus();
		void checkOpenaiKey();
		const id = setInterval(() => void loadStatus(), 4_000);
		return () => clearInterval(id);
	}, [loadStatus, checkOpenaiKey]);

	const runProbe = useCallback(async () => {
		setBusy("test");
		setProbeError(null);
		try {
			const res = await fetch("/api/debug/embedding", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "the quick brown fox jumps over the lazy dog" }),
			});
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			const body = await res.json() as DebugProbe & { modelErr?: string | null };
			if (body.modelErr) throw new Error(body.modelErr);
			setProbe(body);
		} catch (err) {
			setProbeError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy("");
		}
	}, []);

	const saveOpenaiKey = useCallback(async () => {
		const v = openaiKey.trim();
		if (!v) return;
		setBusy("save");
		setSaveError(null);
		try {
			await fetch("/api/channels/credentials", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: "OPENAI_EMBEDDING_API_KEY", value: v }),
			}).then(async (res) => {
				if (!res.ok) {
					const t = await res.text();
					throw new Error(t.slice(0, 200));
				}
			});
			setOpenaiKey("");
			setHasOpenaiKey(true);
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy("");
		}
	}, [openaiKey]);

	const clearOpenaiKey = useCallback(async () => {
		setBusy("clear");
		try {
			await fetch("/api/channels/credentials/OPENAI_EMBEDDING_API_KEY", { method: "DELETE" });
			setHasOpenaiKey(false);
		} catch {
			/* noop */
		} finally {
			setBusy("");
		}
	}, []);

	const running = status?.running ?? false;

	return (
		<div className="settings-pane" style={{ padding: 16 }}>
			<LocalAIHeader />
			<ServerStatusCard status={status} running={running} />
			<PipelineCheckCard
				busy={busy}
				probe={probe}
				probeError={probeError}
				running={running}
				onProbe={runProbe}
			/>
			<CloudFallbackCard
				busy={busy}
				hasOpenaiKey={hasOpenaiKey}
				openaiKey={openaiKey}
				saveError={saveError}
				onClear={clearOpenaiKey}
				onKeyChange={setOpenaiKey}
				onSave={saveOpenaiKey}
			/>
		</div>
	);
}

function LocalAIHeader() {
	return (
		<header style={{ marginBottom: 16 }}>
			<h2 style={{ margin: 0 }}>Local AI</h2>
			<div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
				Detour ships a bundled llama.cpp server for free, on-device embeddings.
				No API key, no daemon, no network after first model download.
			</div>
		</header>
	);
}

function ServerStatusCard({ status, running }: { status: LlamaServerStatus | null; running: boolean }) {
	const dl = status?.downloadProgress;
	const upMs = status?.startedAt ? Date.now() - status.startedAt : null;
	return (
		<section style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
				<strong>Embedding server</strong>
				<span style={{
					display: "inline-flex", alignItems: "center", gap: 6,
					padding: "2px 8px", borderRadius: 999, fontSize: 11,
					background: running ? "rgba(48,209,88,0.15)" : "rgba(255,69,58,0.15)",
					color: running ? "#30d158" : "#ff453a",
				}}>
					<span style={{ width: 6, height: 6, borderRadius: 999, background: running ? "#30d158" : "#ff453a" }} />
					{running ? "running" : status?.lastError ? "error" : "starting"}
				</span>
			</div>
			{dl && dl.percent < 100 && <DownloadProgress dl={dl} />}
			{status?.lastError && (
				<div className="banner error" style={{ marginBottom: 10, padding: 8, fontSize: 12, borderRadius: 4, background: "rgba(255,69,58,0.1)", color: "#ff453a" }}>
					{status.lastError}
				</div>
			)}
			<dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0, fontSize: 12 }}>
				<dt style={{ opacity: 0.6 }}>Model</dt>
				<dd style={{ margin: 0, fontFamily: "monospace" }}>
					{status?.modelPath ? status.modelPath.split("/").pop() : "—"}
				</dd>
				<dt style={{ opacity: 0.6 }}>Endpoint</dt>
				<dd style={{ margin: 0, fontFamily: "monospace" }}>{status?.url ?? "—"}</dd>
				<dt style={{ opacity: 0.6 }}>Process</dt>
				<dd style={{ margin: 0, fontFamily: "monospace" }}>{status?.pid ? `pid ${status.pid}` : "—"}</dd>
				{upMs !== null && (
					<>
						<dt style={{ opacity: 0.6 }}>Uptime</dt>
						<dd style={{ margin: 0 }}>{fmtDuration(upMs)}</dd>
					</>
				)}
			</dl>
		</section>
	);
}

function DownloadProgress({ dl }: { dl: NonNullable<LlamaServerStatus["downloadProgress"]> }) {
	return (
		<div style={{ marginBottom: 10 }}>
			<div style={{ fontSize: 12, marginBottom: 4 }}>
				Downloading model — {dl.percent}% ({fmtBytes(dl.downloadedBytes)}/{fmtBytes(dl.totalBytes)})
			</div>
			<div style={{ height: 4, background: "rgba(128,128,128,0.2)", borderRadius: 2, overflow: "hidden" }}>
				<div style={{ width: `${dl.percent}%`, height: "100%", background: "var(--accent, #0a84ff)" }} />
			</div>
		</div>
	);
}

function PipelineCheckCard({
	busy,
	probe,
	probeError,
	running,
	onProbe,
}: {
	busy: BusyState;
	probe: DebugProbe | null;
	probeError: string | null;
	running: boolean;
	onProbe: () => Promise<void>;
}) {
	return (
		<section style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
				<strong>Pipeline check</strong>
				<button type="button" onClick={() => void onProbe()} disabled={!running || busy === "test"} className="btn">
					{busy === "test" ? "Running…" : "Test embedding"}
				</button>
			</div>
			<div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
				Sends a real semantic-embedding request through the agent's plugin chain to local
				llama-server. Confirms vectors are non-zero and stored in the right column.
			</div>
			{probeError && (
				<div className="banner error" style={{ marginBottom: 8, padding: 8, fontSize: 12, borderRadius: 4, background: "rgba(255,69,58,0.1)", color: "#ff453a" }}>
					{probeError}
				</div>
			)}
			{probe && <ProbeResult probe={probe} />}
		</section>
	);
}

function ProbeResult({ probe }: { probe: DebugProbe }) {
	return (
		<dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0, fontSize: 12 }}>
			<dt style={{ opacity: 0.6 }}>Result</dt>
			<dd style={{ margin: 0, color: probe.nonZero > 0 ? "#30d158" : "#ff9f0a" }}>
				{probe.nonZero > 0 ? "real vectors" : "zero vectors (fallback)"}
			</dd>
			<dt style={{ opacity: 0.6 }}>Dimension</dt>
			<dd style={{ margin: 0, fontFamily: "monospace" }}>
				{probe.dim} ({probe.nonZero}/{probe.dim} non-zero)
			</dd>
			<dt style={{ opacity: 0.6 }}>Latency</dt>
			<dd style={{ margin: 0 }}>{probe.durationMs} ms</dd>
			<dt style={{ opacity: 0.6 }}>DB column</dt>
			<dd style={{ margin: 0, fontFamily: "monospace" }}>
				{probe.adapterEmbeddingDimension ?? "—"}
			</dd>
			<dt style={{ opacity: 0.6 }}>Drain queue</dt>
			<dd style={{ margin: 0 }}>{probe.queueSize ?? "—"}</dd>
		</dl>
	);
}

function CloudFallbackCard({
	busy,
	hasOpenaiKey,
	openaiKey,
	saveError,
	onClear,
	onKeyChange,
	onSave,
}: {
	busy: BusyState;
	hasOpenaiKey: boolean;
	openaiKey: string;
	saveError: string | null;
	onClear: () => Promise<void>;
	onKeyChange: (value: string) => void;
	onSave: () => Promise<void>;
}) {
	return (
		<section style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 14 }}>
			<div style={{ marginBottom: 8 }}>
				<strong>Cloud fallback</strong>
			</div>
			<div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
				Optional. If you'd rather use OpenAI's embeddings (text-embedding-3-small) instead of
				(or as a fallback to) the local server, paste a regular OpenAI API key here.
				Keys are stored in your encrypted vault and validated on save.
			</div>
			{hasOpenaiKey ? (
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span style={{ color: "#30d158", fontSize: 12 }}>OpenAI embedding key stored</span>
					<button type="button" onClick={() => void onClear()} disabled={busy === "clear"} className="btn small ghost">
						{busy === "clear" ? "Clearing…" : "Clear"}
					</button>
				</div>
			) : (
				<OpenAiKeyForm
					busy={busy}
					openaiKey={openaiKey}
					saveError={saveError}
					onKeyChange={onKeyChange}
					onSave={onSave}
				/>
			)}
		</section>
	);
}

function OpenAiKeyForm({
	busy,
	openaiKey,
	saveError,
	onKeyChange,
	onSave,
}: {
	busy: BusyState;
	openaiKey: string;
	saveError: string | null;
	onKeyChange: (value: string) => void;
	onSave: () => Promise<void>;
}) {
	return (
		<>
			<div style={{ display: "flex", gap: 6 }}>
				<input
					type="password"
					placeholder="sk-... (validated against api.openai.com)"
					value={openaiKey}
					onChange={(e) => onKeyChange(e.target.value)}
					className="pensieve-input"
					style={{ flex: 1 }}
				/>
				<button type="button" onClick={() => void onSave()} disabled={busy === "save" || !openaiKey.trim()} className="btn">
					{busy === "save" ? "Saving…" : "Save"}
				</button>
			</div>
			{saveError && (
				<div className="banner error" style={{ marginTop: 8, padding: 8, fontSize: 12, borderRadius: 4, background: "rgba(255,69,58,0.1)", color: "#ff453a" }}>
					{saveError}
				</div>
			)}
		</>
	);
}
