/**
 * CompanionCard — the largest card in the Local AI tab.
 *
 * Shows the 0.6B sidecar's lifecycle (running / stopped / shared),
 * preset picker, backend health strip, recent jobs log, APOLLO
 * fine-tune readiness, and an advanced disclosure for the per-job
 * routing matrix (classical / llm / off per job).
 *
 * Self-contained — receives state + callbacks via props. Parent
 * (LocalAITab) owns the RPC calls and busy state.
 */

import type { CompanionStatusWire } from "../../../shared/rpc/llama";
import { ArbiterRefusalBanner, DownloadProgress } from "./banners";
import {
	type BusyState,
	type CompanionBackendChoice,
	type CompanionJob,
	COMPANION_JOB_DESCRIPTIONS,
} from "./helpers";

export interface CompanionCardProps {
	busy: BusyState;
	status: CompanionStatusWire | null;
	err: string | null;
	selectedPreset: string;
	onPresetChange: (id: string) => void;
	onStart: () => void;
	onStop: () => void;
	onSetAssignment: (job: CompanionJob, choice: CompanionBackendChoice) => void;
	onResetAssignments: () => void;
}

export function CompanionCard(props: CompanionCardProps) {
	const status = props.status;
	const running = status?.running ?? false;
	const dl = status?.downloadProgress;
	const presets = status?.presets ?? [];
	const activePreset =
		presets.find((p) => p.id === props.selectedPreset) ??
		(status?.preset ? presets.find((p) => p.id === status.preset) : undefined);
	const backendsHealthy = status?.backends ?? {
		classical: { available: true, reason: null },
		llm: { available: false, reason: "companion not started" },
	};
	const assignments = status?.assignments;
	const allDefaults =
		assignments &&
		assignments.triage === "classical" &&
		assignments.shouldRespond === "classical" &&
		assignments.memoryQuery === "classical" &&
		assignments.compress === "classical" &&
		assignments.personaPrePass === "llm";
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
				<strong>Detour Companion (0.6B sidecar)</strong>
				<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
					{status?.sharedWithLocalChat && (
						<span
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 4,
								padding: "2px 8px",
								borderRadius: 999,
								fontSize: 11,
								background: "rgba(99,102,241,0.15)",
								color: "#a5b4fc",
							}}
							title="Companion is reusing the chat server's port — same model, zero extra RAM"
						>
							⇄ shared with chat
						</span>
					)}
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
								: status?.lastError
									? "rgba(255,69,58,0.15)"
									: "rgba(120,120,120,0.15)",
							color: running ? "#30d158" : status?.lastError ? "#ff453a" : "#888",
						}}
					>
						<span
							style={{
								width: 6,
								height: 6,
								borderRadius: 999,
								background: running ? "#30d158" : status?.lastError ? "#ff453a" : "#888",
							}}
						/>
						{running ? "running" : status?.lastError ? "error" : "stopped"}
					</span>
				</div>
			</div>
			{!running && status?.lastArbiterRefusal && (
				<ArbiterRefusalBanner reason={status.lastArbiterRefusal} />
			)}
			<div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12, lineHeight: 1.5 }}>
				A hybrid local helper that does <em>five</em> light jobs — <strong>triage</strong>,{" "}
				<strong>should-respond</strong>, <strong>memory query</strong>,{" "}
				<strong>compress</strong>, <strong>persona pre-pass</strong> — so the cloud planner
				skips the easy decisions. Two backends run side by side: a tiny LLM sidecar
				(generative) and a classical heuristic backend (instant, deterministic, no RAM
				cost). Defaults route the four classifiers to classical and the persona pass to
				the LLM — works out of the box, can be tuned in Advanced.
			</div>
			{presets.length > 0 && (
				<div style={{ marginBottom: 12 }}>
					<label
						htmlFor="companion-preset"
						style={{ fontSize: 11, opacity: 0.7, display: "block", marginBottom: 4 }}
					>
						LLM preset
					</label>
					<select
						id="companion-preset"
						value={props.selectedPreset}
						onChange={(e) => props.onPresetChange(e.target.value)}
						disabled={running}
						style={{ padding: "4px 8px", fontSize: 12, minWidth: 280 }}
					>
						{presets.map((p) => (
							<option key={p.id} value={p.id}>
								{p.label} · {p.approxLiveRamGB} GB
							</option>
						))}
					</select>
					{activePreset && (
						<div
							style={{
								fontSize: 11,
								opacity: 0.6,
								marginTop: 4,
								lineHeight: 1.4,
							}}
						>
							{activePreset.description}
						</div>
					)}
				</div>
			)}
			<div
				style={{
					display: "flex",
					gap: 12,
					fontSize: 11,
					marginBottom: 12,
					opacity: 0.85,
				}}
			>
				<BackendStrip
					label="Classical"
					available={backendsHealthy.classical.available}
					reason={backendsHealthy.classical.reason}
				/>
				<BackendStrip
					label="LLM"
					available={backendsHealthy.llm.available}
					reason={backendsHealthy.llm.reason}
				/>
			</div>
			{dl && dl.percent < 100 && <DownloadProgress dl={dl} />}
			{props.err && (
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
					{props.err}
				</div>
			)}
			{status?.lastError && (
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
					{status.lastError}
				</div>
			)}
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				{!running ? (
					<button
						type="button"
						onClick={props.onStart}
						disabled={props.busy === "companion-start"}
						style={{ padding: "6px 12px", fontSize: 12 }}
					>
						{props.busy === "companion-start" ? "Starting…" : "Start companion"}
					</button>
				) : (
					<button
						type="button"
						onClick={props.onStop}
						disabled={props.busy === "companion-stop"}
						style={{ padding: "6px 12px", fontSize: 12 }}
					>
						{props.busy === "companion-stop" ? "Stopping…" : "Stop companion"}
					</button>
				)}
			</div>
			{status?.modelPath && (
				<dl
					style={{
						display: "grid",
						gridTemplateColumns: "auto 1fr",
						gap: "4px 12px",
						margin: "0 0 12px",
						fontSize: 11,
						opacity: 0.7,
					}}
				>
					<dt>Model</dt>
					<dd style={{ margin: 0, fontFamily: "monospace" }}>
						{status.modelPath.split("/").pop()}
					</dd>
					<dt>Endpoint</dt>
					<dd style={{ margin: 0, fontFamily: "monospace" }}>
						{status.url ?? "—"}
					</dd>
					<dt>PID</dt>
					<dd style={{ margin: 0, fontFamily: "monospace" }}>
						{status.pid ?? "—"}
					</dd>
				</dl>
			)}
			{status?.fineTune && (
				<div
					style={{
						fontSize: 11,
						padding: 8,
						marginBottom: 10,
						borderRadius: 4,
						background: status.fineTune.readyToRetrain
							? "rgba(255,159,10,0.12)"
							: "rgba(120,120,120,0.08)",
						color: status.fineTune.readyToRetrain ? "#ff9f0a" : "inherit",
						lineHeight: 1.5,
					}}
				>
					{status.fineTune.readyToRetrain ? (
						<>
							🎯 <strong>APOLLO fine-tune ready</strong> —{" "}
							{status.fineTune.successfulTrajectoriesSinceLastCycle.toLocaleString()}{" "}
							successful trajectories accumulated (threshold:{" "}
							{status.fineTune.threshold.toLocaleString()}). Companion can be
							fine-tuned on YOUR voice/tools using the runbook at{" "}
							<code>{status.fineTune.runbookPath}</code> (~$1, ~3 hrs on a 4090 spot).
						</>
					) : (
						<>
							<strong>APOLLO fine-tune corpus</strong>:{" "}
							{status.fineTune.successfulTrajectoriesSinceLastCycle.toLocaleString()} /{" "}
							{status.fineTune.threshold.toLocaleString()} trajectories
							{". "}Threshold-gated to keep SFT noise low; runbook in{" "}
							<code>{status.fineTune.runbookPath}</code> when ready.
						</>
					)}
				</div>
			)}
			{status?.recentJobs && status.recentJobs.length > 0 && (
				<details style={{ fontSize: 12 }}>
					<summary
						style={{
							cursor: "pointer",
							opacity: 0.8,
							marginBottom: 6,
							userSelect: "none",
						}}
					>
						Recent jobs ({status.recentJobs.length})
					</summary>
					<div
						style={{
							maxHeight: 200,
							overflowY: "auto",
							padding: 6,
							background: "rgba(0,0,0,0.15)",
							borderRadius: 4,
							fontFamily: "monospace",
							fontSize: 11,
							lineHeight: 1.5,
						}}
					>
						{[...status.recentJobs].reverse().map((j, idx) => (
							<div
								key={`${j.startedAt}-${idx}`}
								style={{
									display: "grid",
									gridTemplateColumns: "60px 70px 90px 1fr",
									gap: 6,
									padding: "2px 0",
									opacity: j.ok ? 1 : 0.5,
								}}
							>
								<span style={{ color: "#888" }}>
									{j.durationMs >= 0 ? `${j.durationMs}ms` : "—"}
								</span>
								<span
									style={{
										color:
											j.backend === "classical"
												? "#5fa8ff"
												: j.backend === "llm"
													? "#b07cff"
													: "#888",
										fontStyle: "italic",
									}}
								>
									{j.backend}
								</span>
								<span style={{ color: "#9aa" }}>{j.job}</span>
								<span style={{ wordBreak: "break-word" }}>{j.summary}</span>
							</div>
						))}
					</div>
				</details>
			)}
			{assignments && (
				<details style={{ fontSize: 12, marginTop: 12 }}>
					<summary
						style={{
							cursor: "pointer",
							opacity: 0.8,
							marginBottom: 6,
							userSelect: "none",
							display: "flex",
							alignItems: "center",
							gap: 8,
						}}
					>
						Advanced — per-job backend routing
						{allDefaults ? (
							<span
								style={{
									fontSize: 10,
									padding: "1px 6px",
									borderRadius: 999,
									background: "rgba(48,209,88,0.15)",
									color: "#30d158",
								}}
							>
								recommended defaults
							</span>
						) : (
							<button
								type="button"
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									props.onResetAssignments();
								}}
								disabled={props.busy === "companion-assignments"}
								style={{
									fontSize: 10,
									padding: "2px 8px",
									cursor: "pointer",
								}}
							>
								Reset to defaults
							</button>
						)}
					</summary>
					<div
						style={{
							display: "grid",
							gap: 6,
							padding: 8,
							background: "rgba(0,0,0,0.1)",
							borderRadius: 4,
						}}
					>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "160px 1fr 200px",
								gap: 8,
								fontSize: 10,
								opacity: 0.6,
								paddingBottom: 4,
								borderBottom: "1px solid rgba(255,255,255,0.05)",
							}}
						>
							<span>Job</span>
							<span>What it does</span>
							<span>Backend</span>
						</div>
						{(
							[
								"triage",
								"shouldRespond",
								"memoryQuery",
								"compress",
								"personaPrePass",
							] as const
						).map((job) => (
							<JobAssignmentRow
								key={job}
								job={job}
								choice={assignments[job]}
								busy={props.busy === "companion-assignments"}
								llmAvailable={backendsHealthy.llm.available}
								onChange={(choice) => props.onSetAssignment(job, choice)}
							/>
						))}
					</div>
				</details>
			)}
		</section>
	);
}

function BackendStrip(props: {
	label: string;
	available: boolean;
	reason: string | null;
}) {
	return (
		<div
			title={props.reason ?? ""}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				padding: "2px 8px",
				borderRadius: 999,
				background: props.available
					? "rgba(48,209,88,0.12)"
					: "rgba(120,120,120,0.12)",
				color: props.available ? "#30d158" : "#888",
			}}
		>
			<span
				style={{
					width: 6,
					height: 6,
					borderRadius: 999,
					background: props.available ? "#30d158" : "#888",
				}}
			/>
			{props.label} backend{" "}
			{props.available ? "ready" : props.reason ?? "unavailable"}
		</div>
	);
}

function JobAssignmentRow(props: {
	job: CompanionJob;
	choice: CompanionBackendChoice;
	busy: boolean;
	llmAvailable: boolean;
	onChange: (choice: CompanionBackendChoice) => void;
}) {
	const meta = COMPANION_JOB_DESCRIPTIONS[props.job];
	// personaPrePass is the only truly generative job — the classical
	// backend returns null for it on purpose. Surfacing "Classical" as an
	// option there would be misleading (the dispatcher silently falls
	// back to LLM). Disable + relabel so the matrix tells the truth.
	const classicalDisabled = props.job === "personaPrePass";
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "160px 1fr 200px",
				gap: 8,
				alignItems: "center",
				padding: "4px 0",
			}}
		>
			<span style={{ fontSize: 12 }}>{meta.label}</span>
			<span style={{ fontSize: 11, opacity: 0.65, lineHeight: 1.4 }}>
				{meta.hint}
			</span>
			<select
				value={props.choice}
				onChange={(e) => props.onChange(e.target.value as CompanionBackendChoice)}
				disabled={props.busy}
				style={{ fontSize: 11, padding: "3px 6px" }}
			>
				<option value="classical" disabled={classicalDisabled}>
					{classicalDisabled
						? "Classical (N/A — generation only)"
						: "Classical (instant, deterministic)"}
				</option>
				<option value="llm" disabled={!props.llmAvailable}>
					LLM (generative{props.llmAvailable ? "" : " — start companion first"})
				</option>
				<option value="off">Off (skip this job)</option>
			</select>
		</div>
	);
}
