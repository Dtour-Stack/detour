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
import type { LlamaServerStatus } from "../../shared/index";
import type {
	CompanionStatusWire,
	LlamaMemoryBudgetWire,
	LocalChatPresetWire,
	LocalChatStatusWire,
} from "../../shared/rpc/llama";
import { UI_POLL_INTERVAL_MS } from "../../shared/timing";
import { rpc } from "../rpc";
import { ArbiterRefusalBanner, DownloadProgress } from "./local-ai/banners";
import { CompanionCard } from "./local-ai/CompanionCard";
import {
	type BusyState,
	type CompanionBackendChoice,
	type CompanionJob,
	fmtBytes,
	fmtDuration,
	machineFitsLocal,
} from "./local-ai/helpers";

interface DebugProbe {
	dim: number;
	nonZero: number;
	durationMs: number;
	adapterEmbeddingDimension: string | null;
	embeddingServiceRegistered: boolean | null;
	embeddingServiceDisabled: boolean | null;
	queueSize: number | null;
}

export function LocalAITab() {
	const [status, setStatus] = useState<LlamaServerStatus | null>(null);
	const [chatStatus, setChatStatus] = useState<
		(LocalChatStatusWire & { presets: LocalChatPresetWire[] }) | null
	>(null);
	const [selectedPreset, setSelectedPreset] = useState<string>("");
	const [primaryLocal, setPrimaryLocal] = useState(false);
	const [chatError, setChatError] = useState<string | null>(null);
	const [companionStatus, setCompanionStatus] = useState<CompanionStatusWire | null>(null);
	const [companionError, setCompanionError] = useState<string | null>(null);
	const [selectedCompanionPreset, setSelectedCompanionPreset] = useState<string>("");
	const [memoryBudget, setMemoryBudget] = useState<LlamaMemoryBudgetWire | null>(null);
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
		try {
			const c = await rpc.request.localChatStatus({});
			setChatStatus(c);
			if (!selectedPreset && c.preset) {
				setSelectedPreset(c.preset);
			} else if (!selectedPreset && c.presets[0]) {
				setSelectedPreset(c.presets[0].id);
			}
		} catch {
			setChatStatus(null);
		}
		try {
			const c = await rpc.request.companionStatus({});
			setCompanionStatus(c);
			if (!selectedCompanionPreset && c.preset) {
				setSelectedCompanionPreset(c.preset);
			} else if (!selectedCompanionPreset && c.presets[0]) {
				setSelectedCompanionPreset(c.presets[0].id);
			}
		} catch {
			setCompanionStatus(null);
		}
		try {
			setMemoryBudget(await rpc.request.llamaMemoryBudget({}));
		} catch {
			setMemoryBudget(null);
		}
	}, [selectedPreset, selectedCompanionPreset]);

	const startCompanion = useCallback(async () => {
		setBusy("companion-start");
		setCompanionError(null);
		try {
			await rpc.request.companionStart(
				selectedCompanionPreset ? { preset: selectedCompanionPreset } : {},
			);
			await loadStatus();
		} catch (err) {
			setCompanionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy("");
		}
	}, [loadStatus, selectedCompanionPreset]);

	const stopCompanion = useCallback(async () => {
		setBusy("companion-stop");
		try {
			await rpc.request.companionStop({});
			await loadStatus();
		} catch (err) {
			setCompanionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy("");
		}
	}, [loadStatus]);

	const setCompanionAssignment = useCallback(
		async (job: CompanionJob, choice: CompanionBackendChoice) => {
			setBusy("companion-assignments");
			setCompanionError(null);
			try {
				const updated = await rpc.request.companionSetAssignments({
					assignments: { [job]: choice },
				});
				setCompanionStatus(updated);
			} catch (err) {
				setCompanionError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy("");
			}
		},
		[],
	);

	const resetCompanionAssignments = useCallback(async () => {
		setBusy("companion-assignments");
		setCompanionError(null);
		try {
			const updated = await rpc.request.companionResetAssignments({});
			setCompanionStatus(updated);
		} catch (err) {
			setCompanionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy("");
		}
	}, []);

	const startLocalChat = useCallback(async () => {
		setBusy("chat-start");
		setChatError(null);
		try {
			await rpc.request.localChatStart(
				selectedPreset ? { preset: selectedPreset } : {},
			);
			await loadStatus();
		} catch (err) {
			setChatError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy("");
		}
	}, [selectedPreset, loadStatus]);

	const stopLocalChat = useCallback(async () => {
		setBusy("chat-stop");
		try {
			await rpc.request.localChatStop({});
			await loadStatus();
		} catch (err) {
			setChatError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy("");
		}
	}, [loadStatus]);

	const toggleLocalPrimary = useCallback(
		async (next: boolean) => {
			setBusy("chat-primary");
			try {
				await rpc.request.localChatSetPrimary({ primary: next });
				setPrimaryLocal(next);
			} catch (err) {
				setChatError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy("");
			}
		},
		[],
	);

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
		const id = setInterval(() => void loadStatus(), UI_POLL_INTERVAL_MS.localAi);
		return () => clearInterval(id);
	}, [loadStatus, checkOpenaiKey]);

	const runProbe = useCallback(async () => {
		setBusy("test");
		setProbeError(null);
		try {
			const body = await rpc.request.debugEmbedding({
				text: "the quick brown fox jumps over the lazy dog",
			});
			if (body.modelErr) throw new Error(body.modelErr);
			setProbe(body as DebugProbe);
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
			await rpc.request.channelsSetCredential({ key: "OPENAI_EMBEDDING_API_KEY", value: v });
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
			await rpc.request.channelsClearCredential({ key: "OPENAI_EMBEDDING_API_KEY" });
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
			<MemoryBudgetCard budget={memoryBudget} />
			<PipelineCheckCard
				busy={busy}
				probe={probe}
				probeError={probeError}
				running={running}
				onProbe={runProbe}
			/>
			<LocalChatCard
				busy={busy}
				chatStatus={chatStatus}
				chatError={chatError}
				selectedPreset={selectedPreset}
				primaryLocal={primaryLocal}
				onPresetChange={setSelectedPreset}
				onStart={startLocalChat}
				onStop={stopLocalChat}
				onTogglePrimary={toggleLocalPrimary}
			/>
			<CompanionCard
				busy={busy}
				status={companionStatus}
				err={companionError}
				selectedPreset={selectedCompanionPreset}
				onPresetChange={setSelectedCompanionPreset}
				onStart={startCompanion}
				onStop={stopCompanion}
				onSetAssignment={setCompanionAssignment}
				onResetAssignments={resetCompanionAssignments}
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

function LocalChatCard(props: {
	busy: BusyState;
	chatStatus: (LocalChatStatusWire & { presets: LocalChatPresetWire[] }) | null;
	chatError: string | null;
	selectedPreset: string;
	primaryLocal: boolean;
	onPresetChange: (id: string) => void;
	onStart: () => void;
	onStop: () => void;
	onTogglePrimary: (next: boolean) => void;
}) {
	const { chatStatus } = props;
	const running = chatStatus?.running ?? false;
	const presets = chatStatus?.presets ?? [];
	const activePreset = presets.find((p) => p.id === props.selectedPreset);
	const ramFits = activePreset
		? machineFitsLocal(activePreset.approxLiveRamGB)
		: null;
	const dl = chatStatus?.downloadProgress;
	return (
		<section
			style={{
				border: "1px solid var(--border, #333)",
				borderRadius: 8,
				padding: 14,
				marginBottom: 14,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					marginBottom: 8,
				}}
			>
				<strong>Local chat model</strong>
				<span
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 6,
						padding: "2px 8px",
						borderRadius: 999,
						fontSize: 11,
						background: running
							? "rgba(48,209,88,0.15)"
							: chatStatus?.lastError
								? "rgba(255,69,58,0.15)"
								: "rgba(120,120,120,0.15)",
						color: running ? "#30d158" : chatStatus?.lastError ? "#ff453a" : "#888",
					}}
				>
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: 999,
							background: running ? "#30d158" : chatStatus?.lastError ? "#ff453a" : "#888",
						}}
					/>
					{running ? "running" : chatStatus?.lastError ? "error" : "stopped"}
				</span>
			</div>
			<div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
				Run a chat model on your machine instead of (or alongside) Codex /
				Anthropic. Detour spawns a second llama.cpp instance with the model
				you pick; no API key required.
			</div>
			{dl && dl.percent < 100 && <DownloadProgress dl={dl} />}
			{props.chatError && (
				<div
					className="banner error"
					style={{
						marginBottom: 10,
						padding: 8,
						fontSize: 12,
						borderRadius: 4,
						background: "rgba(255,69,58,0.1)",
						color: "#ff453a",
					}}
				>
					{props.chatError}
				</div>
			)}
			{chatStatus?.lastError && (
				<div
					className="banner error"
					style={{
						marginBottom: 10,
						padding: 8,
						fontSize: 12,
						borderRadius: 4,
						background: "rgba(255,69,58,0.1)",
						color: "#ff453a",
					}}
				>
					{chatStatus.lastError}
				</div>
			)}
			{!running && chatStatus?.lastArbiterRefusal && (
				<ArbiterRefusalBanner reason={chatStatus.lastArbiterRefusal} />
			)}
			<label
				style={{
					display: "block",
					fontSize: 12,
					opacity: 0.7,
					marginBottom: 4,
				}}
			>
				Model
			</label>
			<select
				value={props.selectedPreset}
				onChange={(e) => props.onPresetChange(e.target.value)}
				disabled={running}
				style={{
					width: "100%",
					padding: 8,
					fontSize: 12,
					marginBottom: 8,
					background: "var(--input-bg, #1a1a1a)",
					color: "inherit",
					border: "1px solid var(--border, #333)",
					borderRadius: 4,
				}}
			>
				{presets.map((p) => (
					<option key={p.id} value={p.id}>
						{p.label} — {p.approxDiskGB} GB disk, ~{p.approxLiveRamGB} GB RAM
					</option>
				))}
			</select>
			{activePreset && (
				<div
					style={{
						fontSize: 11,
						opacity: 0.7,
						marginBottom: 12,
						lineHeight: 1.4,
					}}
				>
					{activePreset.description}
					<br />
					<span style={{ opacity: 0.8 }}>
						License: <code>{activePreset.license}</code>. Context:{" "}
						{activePreset.contextSize.toLocaleString()} tokens.
					</span>
					{ramFits === false && (
						<div
							style={{
								marginTop: 6,
								padding: 6,
								background: "rgba(255,159,10,0.12)",
								color: "#ff9f0a",
								borderRadius: 4,
							}}
						>
							⚠️ Your machine may not have enough RAM for this preset. It
							may swap or fail to start.
						</div>
					)}
				</div>
			)}
			<div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
				{!running ? (
					<button
						type="button"
						onClick={props.onStart}
						disabled={props.busy === "chat-start" || !props.selectedPreset}
						style={{ padding: "6px 12px", fontSize: 12 }}
					>
						{props.busy === "chat-start" ? "Starting…" : "Start local chat"}
					</button>
				) : (
					<button
						type="button"
						onClick={props.onStop}
						disabled={props.busy === "chat-stop"}
						style={{ padding: "6px 12px", fontSize: 12 }}
					>
						{props.busy === "chat-stop" ? "Stopping…" : "Stop local chat"}
					</button>
				)}
			</div>
			<label
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					fontSize: 12,
					marginTop: 4,
					cursor: "pointer",
				}}
			>
				<input
					type="checkbox"
					checked={props.primaryLocal}
					onChange={(e) => props.onTogglePrimary(e.target.checked)}
					disabled={!running || props.busy === "chat-primary"}
				/>
				<span>
					Use local chat as the <strong>primary</strong> text provider
					<span style={{ opacity: 0.6 }}>
						{" "}
						— outranks Codex / Anthropic when enabled.
					</span>
				</span>
			</label>
			{chatStatus?.modelPath && (
				<dl
					style={{
						display: "grid",
						gridTemplateColumns: "auto 1fr",
						gap: "4px 12px",
						margin: "10px 0 0",
						fontSize: 11,
						opacity: 0.7,
					}}
				>
					<dt>Model file</dt>
					<dd style={{ margin: 0, fontFamily: "monospace" }}>
						{chatStatus.modelPath.split("/").pop()}
					</dd>
					{chatStatus.url && (
						<>
							<dt>Endpoint</dt>
							<dd style={{ margin: 0, fontFamily: "monospace" }}>
								{chatStatus.url}
							</dd>
						</>
					)}
					{chatStatus.pid && (
						<>
							<dt>Process</dt>
							<dd style={{ margin: 0, fontFamily: "monospace" }}>
								pid {chatStatus.pid}
							</dd>
						</>
					)}
				</dl>
			)}
		</section>
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

export function MemoryBudgetCard({
	budget,
}: {
	budget: LlamaMemoryBudgetWire | null;
}) {
	if (!budget) return null;
	const pct = budget.budgetGB > 0
		? Math.min(100, Math.round((budget.usedGB / budget.budgetGB) * 100))
		: 0;
	const tone = pct >= 90 ? "#ff453a" : pct >= 70 ? "#ff9f0a" : "#30d158";
	return (
		<section
			style={{
				border: "1px solid var(--border, #333)",
				borderRadius: 8,
				padding: 14,
				marginBottom: 14,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					marginBottom: 8,
				}}
			>
				<strong>Memory budget</strong>
				<span style={{ fontSize: 11, opacity: 0.7, fontFamily: "monospace" }}>
					{budget.usedGB.toFixed(1)} / {budget.budgetGB.toFixed(1)} GB
					<span style={{ opacity: 0.5 }}>
						{" "}· {budget.headroomGB.toFixed(1)} GB held back
					</span>
				</span>
			</div>
			<div
				style={{
					height: 6,
					background: "rgba(128,128,128,0.2)",
					borderRadius: 3,
					overflow: "hidden",
					marginBottom: 8,
				}}
			>
				<div style={{ width: `${pct}%`, height: "100%", background: tone }} />
			</div>
			<div style={{ display: "flex", gap: 8, fontSize: 11, opacity: 0.7 }}>
				{budget.reservations.length === 0 ? (
					<span>nothing reserved</span>
				) : (
					budget.reservations.map((r) => (
						<span
							key={r.tier}
							style={{
								padding: "2px 6px",
								borderRadius: 4,
								background: "rgba(120,120,120,0.15)",
							}}
						>
							{r.tier} · {r.ramGB.toFixed(1)} GB
						</span>
					))
				)}
			</div>
		</section>
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
