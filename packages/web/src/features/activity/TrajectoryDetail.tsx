/**
 * Detail panel for a selected trajectory:
 *   - 5-stage pipeline graph (input → should_respond → plan → actions → evaluators)
 *   - Metadata block (source, status, totals, raw orchestrator metadata)
 *   - Provider accesses (per-provider query/data)
 *   - LLM call cards (model, latency, tokens, system/user prompts, response)
 *
 * Mirrors milady's TrajectoryDetailView shape but stripped down — no i18n,
 * no @elizaos/ui deps; everything inline so we can iterate fast.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	PensieveLlmCall,
	PensieveTrajectoryDetail,
} from "@detour/shared";
import type { WebClient } from "../../api/client";

type StageId = "input" | "should_respond" | "plan" | "actions" | "evaluators";

const STAGES: { id: StageId; label: string }[] = [
	{ id: "input", label: "Input" },
	{ id: "should_respond", label: "Should Respond" },
	{ id: "plan", label: "Plan" },
	{ id: "actions", label: "Actions" },
	{ id: "evaluators", label: "Evaluators" },
];

const STEP_TO_STAGE: Record<string, StageId> = {
	should_respond: "should_respond",
	compose_state: "plan",
	response: "plan",
	reasoning: "plan",
	orchestrator: "plan",
	coordination: "plan",
	action: "actions",
	evaluation: "evaluators",
	observation_extraction: "evaluators",
	turn_complete: "evaluators",
};

function stageForCall(call: PensieveLlmCall): StageId {
	return STEP_TO_STAGE[call.stepType ?? ""] ?? "plan";
}

function fmtMs(ms?: number): string {
	if (typeof ms !== "number") return "–";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}m`;
}

function fmtTokens(n?: number): string {
	if (typeof n !== "number" || n === 0) return "–";
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}k`;
}

function fmtJson(value: unknown): string {
	if (value == null) return "null";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function downloadJson(filename: string, data: unknown) {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export function TrajectoryDetail({
	client,
	trajectoryId,
	onClose,
}: {
	client: WebClient;
	trajectoryId: string;
	onClose: () => void;
}) {
	const [detail, setDetail] = useState<PensieveTrajectoryDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [activeStage, setActiveStage] = useState<StageId | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		client
			.pensieveTrajectory(trajectoryId)
			.then((res) => {
				if (cancelled) return;
				setDetail(res);
				setLoading(false);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [client, trajectoryId]);

	const stageCounts = useMemo(() => {
		const counts: Record<StageId, number> = {
			input: 1,
			should_respond: 0,
			plan: 0,
			actions: 0,
			evaluators: 0,
		};
		for (const c of detail?.llmCalls ?? []) counts[stageForCall(c)] += 1;
		return counts;
	}, [detail]);

	const filteredCalls = useMemo(() => {
		if (!detail) return [];
		if (!activeStage || activeStage === "input") return detail.llmCalls;
		return detail.llmCalls.filter((c) => stageForCall(c) === activeStage);
	}, [detail, activeStage]);

	const exportThis = useCallback(() => {
		if (!detail) return;
		const filename = `trajectory-${trajectoryId.slice(0, 8)}-${Date.now()}.json`;
		downloadJson(filename, detail);
	}, [detail, trajectoryId]);

	if (loading) return <div className="empty">Loading trajectory…</div>;
	if (error) return <div className="banner error">{error}</div>;
	if (!detail || !detail.trajectory) {
		return <div className="empty">Trajectory not found.</div>;
	}

	const t = detail.trajectory;

	return (
		<div className="trajectory-detail">
			<div className="trajectory-detail-header">
				<button type="button" className="link" onClick={onClose}>← back</button>
				<div className="trajectory-detail-title">
					<span className={`badge ${statusTone(t.status)}`}>{t.status ?? "?"}</span>
					{t.source && <span className="badge muted">{t.source}</span>}
					<span className="hint">{t.startTime ? new Date(t.startTime).toLocaleString() : ""}</span>
				</div>
				<div style={{ flex: 1 }} />
				<button type="button" className="btn small" onClick={exportThis}>
					Export JSON
				</button>
			</div>

			<div className="trajectory-summary-grid">
				<SummaryCard label="Duration" value={fmtMs(t.durationMs)} />
				<SummaryCard label="Steps" value={String(detail.totals.stepCount)} />
				<SummaryCard label="LLM calls" value={String(detail.totals.llmCallCount)} />
				<SummaryCard label="Provider accesses" value={String(detail.totals.providerAccessCount)} />
				<SummaryCard label="Actions" value={String(detail.totals.actionCount)} />
				<SummaryCard
					label="Tokens (in / out)"
					value={`${fmtTokens(detail.totals.totalPromptTokens)} / ${fmtTokens(detail.totals.totalCompletionTokens)}`}
				/>
			</div>

			<div className="trajectory-pipeline">
				{STAGES.map((stage, i) => {
					const count = stageCounts[stage.id];
					const isActive = activeStage === stage.id;
					const enabled = stage.id === "input" || count > 0;
					return (
						<div key={stage.id} className="trajectory-pipeline-stage-wrap">
							<button
								type="button"
								className={[
									"trajectory-pipeline-stage",
									enabled ? "" : "disabled",
									isActive ? "active" : "",
									t.status === "error" && enabled && stage.id !== "input" ? "errored" : "",
								].filter(Boolean).join(" ")}
								onClick={() => {
									if (!enabled || stage.id === "input") return setActiveStage(null);
									setActiveStage(isActive ? null : stage.id);
								}}
								disabled={!enabled}
							>
								<div className="trajectory-pipeline-stage-label">{stage.label}</div>
								<div className="trajectory-pipeline-stage-count">{count}</div>
							</button>
							{i < STAGES.length - 1 && <div className="trajectory-pipeline-arrow">→</div>}
						</div>
					);
				})}
				{activeStage && activeStage !== "input" && (
					<button type="button" className="link" style={{ marginLeft: 8 }} onClick={() => setActiveStage(null)}>
						clear filter
					</button>
				)}
			</div>

			{detail.metadata && Object.keys(detail.metadata).length > 0 && (
				<DisclosureSection label="Metadata" defaultOpen={false}>
					<pre className="trajectory-pre">{fmtJson(detail.metadata)}</pre>
				</DisclosureSection>
			)}

			{detail.providerAccesses.length > 0 && (
				<DisclosureSection label={`Provider accesses (${detail.providerAccesses.length})`} defaultOpen={false}>
					<div className="trajectory-provider-list">
						{detail.providerAccesses.map((acc, i) => (
							<div key={`${acc.providerId}-${i}`} className="trajectory-provider-card">
								<div className="trajectory-provider-header">
									<span className="trajectory-provider-name">{acc.providerName || "unknown"}</span>
									{acc.purpose && <span className="hint">· {acc.purpose}</span>}
									<span className="hint">step {acc.stepNumber}</span>
								</div>
								{acc.query !== undefined && (
									<details className="trajectory-provider-section">
										<summary>query</summary>
										<pre className="trajectory-pre">{fmtJson(acc.query)}</pre>
									</details>
								)}
								<details className="trajectory-provider-section" open>
									<summary>data</summary>
									<pre className="trajectory-pre">{fmtJson(acc.data)}</pre>
								</details>
							</div>
						))}
					</div>
				</DisclosureSection>
			)}

			{detail.actions.length > 0 && (
				<DisclosureSection label={`Actions (${detail.actions.length})`} defaultOpen={false}>
					<div className="trajectory-action-list">
						{detail.actions.map((a, i) => (
							<div key={`${a.attemptId}-${i}`} className="trajectory-action-card">
								<div className="trajectory-action-header">
									<span className={`badge ${a.success === false ? "err" : a.success === true ? "ok" : "muted"}`}>
										{a.success === false ? "failed" : a.success === true ? "ok" : "—"}
									</span>
									<span className="trajectory-action-name">{a.actionName ?? a.actionType ?? "action"}</span>
									<span className="hint">step {a.stepNumber}</span>
								</div>
								{a.reasoning && (
									<div className="trajectory-action-reasoning">{a.reasoning}</div>
								)}
								{a.error && <div className="banner error" style={{ margin: "6px 0" }}>{a.error}</div>}
								{a.parameters !== undefined && (
									<details className="trajectory-provider-section">
										<summary>parameters</summary>
										<pre className="trajectory-pre">{fmtJson(a.parameters)}</pre>
									</details>
								)}
								{a.result !== undefined && (
									<details className="trajectory-provider-section">
										<summary>result</summary>
										<pre className="trajectory-pre">{fmtJson(a.result)}</pre>
									</details>
								)}
							</div>
						))}
					</div>
				</DisclosureSection>
			)}

			<div className="trajectory-section-label">
				LLM calls {filteredCalls.length !== detail.llmCalls.length && (
					<span className="hint">({filteredCalls.length} of {detail.llmCalls.length})</span>
				)}
			</div>
			{filteredCalls.length === 0 ? (
				<div className="empty">No LLM calls recorded.</div>
			) : (
				<div className="trajectory-call-list">
					{filteredCalls.map((call, i) => (
						<TrajectoryLlmCallCard key={call.callId} index={i + 1} call={call} />
					))}
				</div>
			)}
		</div>
	);
}

function SummaryCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="trajectory-summary-card">
			<div className="trajectory-summary-label">{label}</div>
			<div className="trajectory-summary-value">{value}</div>
		</div>
	);
}

function DisclosureSection({
	label,
	defaultOpen,
	children,
}: {
	label: string;
	defaultOpen: boolean;
	children: React.ReactNode;
}) {
	return (
		<details className="trajectory-disclosure" open={defaultOpen}>
			<summary>{label}</summary>
			<div className="trajectory-disclosure-body">{children}</div>
		</details>
	);
}

function TrajectoryLlmCallCard({ index, call }: { index: number; call: PensieveLlmCall }) {
	const [openSystem, setOpenSystem] = useState(false);
	const [openInput, setOpenInput] = useState(true);
	const [openOutput, setOpenOutput] = useState(true);
	const totalTokens = (call.promptTokens ?? 0) + (call.completionTokens ?? 0);
	return (
		<div className="trajectory-call-card">
			<div className="trajectory-call-header">
				<span className="trajectory-call-index">#{index}</span>
				<span className="trajectory-call-purpose">
					{(call.stepType || call.purpose || call.actionType || "response").replace(/_/g, " ")}
				</span>
				<span className="hint">·</span>
				<span className="trajectory-call-model">{call.model}</span>
				<span style={{ flex: 1 }} />
				<span className="hint">{fmtMs(call.latencyMs)}</span>
				<span className="hint">·</span>
				<span className="hint">
					{fmtTokens(call.promptTokens)}↑ / {fmtTokens(call.completionTokens)}↓ ({fmtTokens(totalTokens)})
				</span>
			</div>
			{(call.tags?.length ?? 0) > 0 && (
				<div className="trajectory-call-tags">
					{call.tags?.filter((t) => t !== "llm").map((tag) => (
						<span key={tag} className="badge muted">{tag}</span>
					))}
				</div>
			)}
			{call.systemPrompt && (
				<details
					className="trajectory-call-section"
					open={openSystem}
					onToggle={(e) => setOpenSystem((e.target as HTMLDetailsElement).open)}
				>
					<summary>System ({call.systemPrompt.split("\n").length} lines)</summary>
					<pre className="trajectory-pre">{call.systemPrompt}</pre>
					<button type="button" className="link" onClick={() => navigator.clipboard?.writeText(call.systemPrompt ?? "")}>copy</button>
				</details>
			)}
			{call.userPrompt && (
				<details
					className="trajectory-call-section"
					open={openInput}
					onToggle={(e) => setOpenInput((e.target as HTMLDetailsElement).open)}
				>
					<summary>Input ({call.userPrompt.split("\n").length} lines)</summary>
					<pre className="trajectory-pre">{call.userPrompt}</pre>
					<button type="button" className="link" onClick={() => navigator.clipboard?.writeText(call.userPrompt ?? "")}>copy</button>
				</details>
			)}
			{call.response && (
				<details
					className="trajectory-call-section"
					open={openOutput}
					onToggle={(e) => setOpenOutput((e.target as HTMLDetailsElement).open)}
				>
					<summary>Output ({call.response.split("\n").length} lines)</summary>
					<pre className="trajectory-pre">{call.response}</pre>
					<button type="button" className="link" onClick={() => navigator.clipboard?.writeText(call.response ?? "")}>copy</button>
				</details>
			)}
			{call.reasoning && (
				<details className="trajectory-call-section">
					<summary>Reasoning</summary>
					<pre className="trajectory-pre">{call.reasoning}</pre>
				</details>
			)}
		</div>
	);
}

function statusTone(s?: string): string {
	if (s === "completed") return "ok";
	if (s === "error") return "err";
	if (s === "active") return "info";
	return "muted";
}
