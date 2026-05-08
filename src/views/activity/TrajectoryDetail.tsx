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
	ActivityLlmCall,
	ActivityTrajectoryDetail,
	ActivityTrajectoryStepSummary,
} from "../../shared/index";
import type { WebClient } from "../_shared/api/client";

type StageId = "input" | "should_respond" | "plan" | "actions" | "evaluators";
type Trajectory = NonNullable<ActivityTrajectoryDetail["trajectory"]>;

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

function stageForCall(call: ActivityLlmCall): StageId {
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
	const [detail, setDetail] = useState<ActivityTrajectoryDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [activeStage, setActiveStage] = useState<StageId | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		client
			.activityTrajectory(trajectoryId)
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
			<TrajectoryHeader trajectory={t} onClose={onClose} onExport={exportThis} />
			<TrajectorySummary detail={detail} trajectory={t} />
			{detail.identity && <IdentityBlock identity={detail.identity} />}
			<TrajectoryPipeline
				status={t.status}
				stageCounts={stageCounts}
				activeStage={activeStage}
				onStageChange={setActiveStage}
			/>
			<TrajectoryMetricSections detail={detail} />
			<RagTraceSection providerAccesses={detail.providerAccesses} />
			<ProviderAccessSection providerAccesses={detail.providerAccesses} />
			<ActionSection actions={detail.actions} />
			<LlmCallsSection calls={filteredCalls} total={detail.llmCalls.length} />
		</div>
	);
}

function TrajectoryHeader({
	trajectory,
	onClose,
	onExport,
}: {
	trajectory: Trajectory;
	onClose: () => void;
	onExport: () => void;
}) {
	return (
		<div className="trajectory-detail-header">
			<button type="button" className="link" onClick={onClose}>← back</button>
			<div className="trajectory-detail-title">
				<span className={`badge ${statusTone(trajectory.status)}`}>{trajectory.status ?? "?"}</span>
				{trajectory.source && <span className="badge muted">{trajectory.source}</span>}
				<span className="hint">{trajectory.startTime ? new Date(trajectory.startTime).toLocaleString() : ""}</span>
			</div>
			<div style={{ flex: 1 }} />
			<button type="button" className="btn small" onClick={onExport}>
				Export JSON
			</button>
		</div>
	);
}

function TrajectorySummary({
	detail,
	trajectory,
}: {
	detail: ActivityTrajectoryDetail;
	trajectory: Trajectory;
}) {
	return (
		<div className="trajectory-summary-grid">
			<SummaryCard label="Duration" value={fmtMs(trajectory.durationMs)} />
			<SummaryCard label="LLM time" value={fmtMs(detail.totals.totalLatencyMs || undefined)} />
			<SummaryCard label="Steps" value={String(detail.totals.stepCount)} />
			<SummaryCard label="LLM calls" value={String(detail.totals.llmCallCount)} />
			<SummaryCard label="Provider accesses" value={String(detail.totals.providerAccessCount)} />
			<SummaryCard label="Actions" value={String(detail.totals.actionCount)} />
			<SummaryCard
				label="Tokens (in / out)"
				value={`${fmtTokens(detail.totals.totalPromptTokens)} / ${fmtTokens(detail.totals.totalCompletionTokens)}`}
			/>
			{detail.identity?.totalReward !== undefined && (
				<SummaryCard label="Total reward" value={detail.identity.totalReward.toFixed(3)} />
			)}
		</div>
	);
}

function TrajectoryPipeline({
	status,
	stageCounts,
	activeStage,
	onStageChange,
}: {
	status?: string;
	stageCounts: Record<StageId, number>;
	activeStage: StageId | null;
	onStageChange: (stage: StageId | null) => void;
}) {
	return (
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
								status === "error" && enabled && stage.id !== "input" ? "errored" : "",
							].filter(Boolean).join(" ")}
							onClick={() => {
								if (!enabled || stage.id === "input") return onStageChange(null);
								onStageChange(isActive ? null : stage.id);
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
				<button type="button" className="link" style={{ marginLeft: 8 }} onClick={() => onStageChange(null)}>
					clear filter
				</button>
			)}
		</div>
	);
}

function TrajectoryMetricSections({ detail }: { detail: ActivityTrajectoryDetail }) {
	return (
		<>
			{detail.metrics && Object.keys(detail.metrics).length > 0 && (
				<DisclosureSection label="Metrics" defaultOpen={true}>
					<KeyValueTable data={detail.metrics} />
				</DisclosureSection>
			)}
			{detail.rewardComponents && Object.keys(detail.rewardComponents).length > 0 && (
				<DisclosureSection label="Reward components" defaultOpen={false}>
					<KeyValueTable data={detail.rewardComponents} />
				</DisclosureSection>
			)}
			{detail.steps.length > 0 && (
				<DisclosureSection label={`Steps (${detail.steps.length})`} defaultOpen={false}>
					<div className="trajectory-step-list">
						{detail.steps.map((s) => (
							<StepCard key={s.stepNumber} step={s} />
						))}
					</div>
				</DisclosureSection>
			)}
			{detail.metadata && Object.keys(detail.metadata).length > 0 && (
				<DisclosureSection label="Metadata" defaultOpen={false}>
					<pre className="trajectory-pre">{fmtJson(detail.metadata)}</pre>
				</DisclosureSection>
			)}
		</>
	);
}

function ProviderAccessSection({
	providerAccesses,
}: {
	providerAccesses: ActivityTrajectoryDetail["providerAccesses"];
}) {
	if (providerAccesses.length === 0) return null;
	return (
		<DisclosureSection label={`Provider accesses (${providerAccesses.length})`} defaultOpen={false}>
			<div className="trajectory-provider-list">
				{providerAccesses.map((acc, i) => (
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
	);
}

function ActionSection({ actions }: { actions: ActivityTrajectoryDetail["actions"] }) {
	if (actions.length === 0) return null;
	return (
		<DisclosureSection label={`Actions (${actions.length})`} defaultOpen={false}>
			<div className="trajectory-action-list">
				{actions.map((a, i) => (
					<div key={`${a.attemptId}-${i}`} className="trajectory-action-card">
						<div className="trajectory-action-header">
							<span className={`badge ${a.success === false ? "err" : a.success === true ? "ok" : "muted"}`}>
								{a.success === false ? "failed" : a.success === true ? "ok" : "—"}
							</span>
							<span className="trajectory-action-name">{a.actionName ?? a.actionType ?? "action"}</span>
							<span className="hint">step {a.stepNumber}</span>
						</div>
						{a.reasoning && <div className="trajectory-action-reasoning">{a.reasoning}</div>}
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
	);
}

function LlmCallsSection({ calls, total }: { calls: ActivityLlmCall[]; total: number }) {
	return (
		<>
			<div className="trajectory-section-label">
				LLM calls {calls.length !== total && <span className="hint">({calls.length} of {total})</span>}
			</div>
			{calls.length === 0 ? (
				<div className="empty">No LLM calls recorded.</div>
			) : (
				<div className="trajectory-call-list">
					{calls.map((call, i) => (
						<TrajectoryLlmCallCard key={call.callId} index={i + 1} call={call} />
					))}
				</div>
			)}
		</>
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

function TrajectoryLlmCallCard({ index, call }: { index: number; call: ActivityLlmCall }) {
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

function IdentityBlock({ identity }: { identity: NonNullable<ActivityTrajectoryDetail["identity"]> }) {
	const rows: Array<[string, string]> = [];
	if (identity.agentName) rows.push(["Agent", identity.agentName]);
	if (identity.agentModel) rows.push(["Model", identity.agentModel]);
	if (identity.agentId) rows.push(["Agent id", identity.agentId]);
	if (identity.episodeId) rows.push(["Episode", identity.episodeId]);
	if (identity.scenarioId) rows.push(["Scenario", identity.scenarioId]);
	if (identity.batchId) rows.push(["Batch", identity.batchId]);
	if (identity.groupIndex !== undefined) rows.push(["Group index", String(identity.groupIndex)]);
	rows.push(["Trajectory id", identity.id]);
	if (rows.length === 0) return null;
	return (
		<div className="trajectory-identity">
			{rows.map(([k, v]) => (
				<div key={k} className="trajectory-identity-row">
					<span className="trajectory-identity-key">{k}</span>
					<span className="trajectory-identity-value">{v}</span>
				</div>
			))}
		</div>
	);
}

function KeyValueTable({ data }: { data: Record<string, unknown> }) {
	const entries = Object.entries(data);
	if (entries.length === 0) return null;
	return (
		<div className="trajectory-kv">
			{entries.map(([k, v]) => (
				<div key={k} className="trajectory-kv-row">
					<span className="trajectory-kv-key">{k}</span>
					<span className="trajectory-kv-value">{renderValue(v)}</span>
				</div>
			))}
		</div>
	);
}

function renderValue(v: unknown): React.ReactNode {
	if (v === null || v === undefined) return <span className="hint">—</span>;
	if (typeof v === "boolean") return <span className={`badge ${v ? "ok" : "muted"}`}>{String(v)}</span>;
	if (typeof v === "number") return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{v}</span>;
	if (typeof v === "string") return v;
	return <pre className="trajectory-pre" style={{ margin: 0, maxHeight: 200 }}>{fmtJson(v)}</pre>;
}

function RagTraceSection({ providerAccesses }: { providerAccesses: ActivityTrajectoryDetail["providerAccesses"] }) {
	const ragAccesses = providerAccesses.filter((p) => /knowledge|rag/i.test(p.providerName));
	if (ragAccesses.length === 0) return null;
	const fragments = ragAccesses.flatMap((acc) => extractFragments(acc.data));
	return (
		<DisclosureSection label={`RAG retrieval (${fragments.length} fragment${fragments.length === 1 ? "" : "s"})`} defaultOpen={true}>
			{fragments.length === 0 ? (
				<div className="hint">Knowledge provider ran but returned no fragments.</div>
			) : (
				<div className="trajectory-rag-list">
					{fragments.map((f, i) => (
						<div key={f.fragmentId ?? i} className="trajectory-rag-card">
							<div className="trajectory-rag-header">
								{typeof f.similarityScore === "number" && (
									<span className="badge info">sim {f.similarityScore.toFixed(3)}</span>
								)}
								{f.documentTitle && <span className="trajectory-rag-doc">{f.documentTitle}</span>}
								{f.fragmentId && (
									<span className="hint" style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10 }}>
										{f.fragmentId.slice(0, 8)}
									</span>
								)}
							</div>
							<div className="trajectory-rag-preview">{f.contentPreview}</div>
						</div>
					))}
				</div>
			)}
			{ragAccesses.length > 1 && (
				<div className="hint" style={{ marginTop: 6 }}>
					{ragAccesses.length} retrieval calls across this trajectory.
				</div>
			)}
		</DisclosureSection>
	);
}

interface RagFragment {
	fragmentId?: string;
	documentTitle?: string;
	similarityScore?: number;
	contentPreview: string;
}

function extractFragments(data: unknown): RagFragment[] {
	if (!data) return [];
	for (const arr of fragmentArrays(data)) {
		const out = arr.flatMap((fragment) => {
			const parsed = parseFragment(fragment);
			return parsed ? [parsed] : [];
		});
		if (out.length > 0) {
			return out;
		}
	}
	return [];
}

function fragmentArrays(data: unknown): unknown[][] {
	const found: unknown[][] = [];
	const seen = new Set<object>();
	collectFragmentArrays(data, found, seen, 0);
	return found;
}

function collectFragmentArrays(data: unknown, found: unknown[][], seen: Set<object>, depth: number): void {
	if (!data || typeof data !== "object" || depth > 6 || seen.has(data)) return;
	seen.add(data);
	if (Array.isArray(data)) {
		if (data.some((item) => parseFragment(item))) found.push(data);
		for (const item of data) collectFragmentArrays(item, found, seen, depth + 1);
		return;
	}
	for (const value of Object.values(data)) collectFragmentArrays(value, found, seen, depth + 1);
}

function parseFragment(fragment: unknown): RagFragment | null {
	if (!fragment || typeof fragment !== "object") return null;
	const o = fragment as Record<string, unknown>;
	const preview = fragmentPreview(o);
	if (!preview) return null;
	return {
		...(typeof o.fragmentId === "string" && { fragmentId: o.fragmentId }),
		...(typeof o.documentTitle === "string" && { documentTitle: o.documentTitle }),
		...(typeof o.similarityScore === "number" && { similarityScore: o.similarityScore }),
		...(typeof o.score === "number" && { similarityScore: o.score }),
		contentPreview: preview.slice(0, 480),
	};
}

function fragmentPreview(fragment: Record<string, unknown>): string {
	for (const key of ["contentPreview", "content", "text"]) {
		const value = fragment[key];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

function StepCard({ step }: { step: ActivityTrajectoryStepSummary }) {
	return (
		<div className="trajectory-step-card">
			<div className="trajectory-step-header">
				<span className="trajectory-step-number">step {step.stepNumber}</span>
				<span className="hint">{step.timestamp ? new Date(step.timestamp).toLocaleTimeString() : ""}</span>
				<span className="badge muted">{step.llmCallCount} LLM</span>
				<span className="badge muted">{step.providerAccessCount} prov</span>
				{step.hasAction && (
					<span className={`badge ${step.actionSuccess === false ? "err" : step.actionSuccess === true ? "ok" : "muted"}`}>
						{step.actionName ?? "action"}
					</span>
				)}
				{step.reward !== undefined && step.reward !== 0 && (
					<span className="badge info">reward {step.reward.toFixed(2)}</span>
				)}
				{step.done && <span className="badge ok">done</span>}
			</div>
			{step.reasoning && <div className="trajectory-step-reasoning">{step.reasoning}</div>}
			{step.observation !== undefined && (
				<details className="trajectory-call-section">
					<summary>observation</summary>
					<pre className="trajectory-pre">{fmtJson(step.observation)}</pre>
				</details>
			)}
			{step.environmentState && Object.keys(step.environmentState).length > 0 && (
				<details className="trajectory-call-section">
					<summary>environment state</summary>
					<KeyValueTable data={step.environmentState} />
				</details>
			)}
			{step.metadata && Object.keys(step.metadata).length > 0 && (
				<details className="trajectory-call-section">
					<summary>metadata</summary>
					<pre className="trajectory-pre">{fmtJson(step.metadata)}</pre>
				</details>
			)}
		</div>
	);
}
