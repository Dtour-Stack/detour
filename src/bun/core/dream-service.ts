/**
 * DreamService — Detour's memory-consolidation pass.
 *
 * Pattern mirror of Anthropic's Claude Dreaming (research preview, May 2026):
 * periodically read a batch of past sessions + the current memory store and
 * produce a structured DIFF over the memory store. Unlike ContinuousImprovementService
 * (which writes one durable reflection per tick) this service produces:
 *
 *   - additions    — new facts surfaced from session transcripts
 *   - merges       — duplicate memories collapsed onto a canonical id
 *   - replacements — stale memories superseded by newer ones
 *   - deletions    — contradicted or irrelevant entries to drop
 *
 * Critical safety property (matches Anthropic's contract): the input memory
 * store is NEVER mutated by the dream call. The model proposes a diff; the
 * diff is persisted as `detour-dream` + `detour-dream-pending` memories;
 * the user (or the auto-apply setting) decides whether to apply each change.
 *
 * Why not extend ContinuousImprovementService:
 *   - Different cadence (6h vs 30min) and different output shape.
 *   - Continuous-improvement writes "one new memory" per tick. Dream is a
 *     batch consolidation across the whole store — fundamentally different
 *     operation. Composing them keeps each cohesive.
 *
 * Cap-aware: skips the model call entirely when the active provider has a
 * recorded quota cap. Memory consolidation is not worth burning planner
 * tokens on when chat itself is degraded.
 */

import { createHash } from "node:crypto";
import {
	ModelType,
	logger,
	parseToonKeyValue,
	type IAgentRuntime,
	type Task,
	type TaskMetadata,
	type UUID,
} from "@elizaos/core";
import type { PensieveMemoryService, PensieveMemorySummary } from "./pensieve/memory-service";
import type { ActivityTrajectoryService, ActivityTrajectoryDetail } from "./activity/trajectory-service";
import { getProviderQuotaService } from "./provider-quota-service";
import type { RuntimeService } from "./runtime";
import {
	DETOUR_DREAM_CONSOLIDATION_DEFAULT,
	DETOUR_DREAM_CONSOLIDATION_TEMPLATE,
	renderPromptTemplate,
} from "./prompt-templates";

export const DETOUR_DREAM_TASK_NAME = "DETOUR_DREAM";
export const DREAM_MEMORY_TYPE = "detour-dream";
export const DREAM_PENDING_MEMORY_TYPE = "detour-dream-pending";
/**
 * Hermes Curator pattern: "Never auto-deletes — the worst outcome is
 * archival … which is recoverable." When a dream plan proposes a deletion,
 * we move the memory to this type instead of actually removing it.
 * `dreamsRestore` (UI button) can promote it back to a regular description.
 */
export const DREAM_ARCHIVED_MEMORY_TYPE = "detour-dream-archived";
const TASK_TAGS = ["queue", "repeat", "autonomy", "dream"];
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_TRAJECTORY_BATCH = 40;
const DEFAULT_MEMORY_SNAPSHOT = 120;
const MAX_INSTRUCTION_CHARS = 4_000;
const HASH_LIMIT = 50;

export type DreamDiffOp =
	| "addition"
	| "merge"
	| "replacement"
	| "deletion";

export interface DreamProposedAddition {
	op: "addition";
	text: string;
	path?: string;
	tags?: string[];
	category?: string;
	reason?: string;
}

export interface DreamProposedMerge {
	op: "merge";
	keepId: string;
	collapseIds: string[];
	canonicalText?: string;
	reason?: string;
}

export interface DreamProposedReplacement {
	op: "replacement";
	staleId: string;
	newText: string;
	reason?: string;
}

export interface DreamProposedDeletion {
	op: "deletion";
	id: string;
	reason?: string;
}

export type DreamProposedChange =
	| DreamProposedAddition
	| DreamProposedMerge
	| DreamProposedReplacement
	| DreamProposedDeletion;

export interface DreamPlan {
	additions: DreamProposedAddition[];
	merges: DreamProposedMerge[];
	replacements: DreamProposedReplacement[];
	deletions: DreamProposedDeletion[];
	notes?: string;
}

export interface DreamApplyResult {
	applied: number;
	skipped: number;
	failed: number;
	errors: string[];
}

interface DreamServiceDeps {
	runtimeService: RuntimeService;
	memories: PensieveMemoryService;
	trajectories: ActivityTrajectoryService;
}

function pickSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const v = runtime.getSetting?.(key);
	if (typeof v === "string" && v.trim().length > 0) return v;
	const env = process.env[key];
	if (typeof env === "string" && env.trim().length > 0) return env;
	return undefined;
}

function booleanSetting(runtime: IAgentRuntime, key: string, defaultValue: boolean): boolean {
	const v = pickSetting(runtime, key);
	if (v === undefined) return defaultValue;
	return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

function numberSetting(runtime: IAgentRuntime, key: string, defaultValue: number): number {
	const v = pickSetting(runtime, key);
	if (v === undefined) return defaultValue;
	const n = Number(v);
	return Number.isFinite(n) ? n : defaultValue;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function compactOne(text: string, max = 600): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function hashPlan(plan: DreamPlan): string {
	const norm = JSON.stringify({
		add: plan.additions.map((a) => compactOne(a.text)).sort(),
		merge: plan.merges.map((m) => [m.keepId, ...m.collapseIds].sort()).sort(),
		replace: plan.replacements.map((r) => [r.staleId, compactOne(r.newText)]).sort(),
		del: plan.deletions.map((d) => d.id).sort(),
	});
	return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

function buildTaskMetadata(current: unknown, runtime: IAgentRuntime): TaskMetadata {
	const intervalMs = Math.max(
		15 * 60_000,
		Math.min(24 * 60 * 60_000, numberSetting(runtime, "DETOUR_DREAM_INTERVAL_MS", DEFAULT_INTERVAL_MS)),
	);
	return {
		...(isRecord(current) ? current : {}),
		updateInterval: intervalMs,
		baseInterval: intervalMs,
		blocking: false,
		detourDream: { version: 1 },
	};
}

function renderTrajectoriesForPrompt(details: ActivityTrajectoryDetail[]): string {
	const lines: string[] = [];
	for (const d of details.slice(0, DEFAULT_TRAJECTORY_BATCH)) {
		const id = d.trajectory?.id ?? d.identity?.id ?? "?";
		const source = d.trajectory?.source ?? "?";
		const status = d.trajectory?.status ?? d.identity?.status ?? "?";
		const start = d.trajectory?.startTime ? new Date(d.trajectory.startTime).toISOString() : "?";
		const userPrompts = d.llmCalls
			.map((c) => c.userPrompt)
			.filter((p): p is string => typeof p === "string" && p.length > 0)
			.slice(0, 2);
		const actions = d.actions
			.map((a) => a.actionName ?? a.actionType)
			.filter((n): n is string => typeof n === "string" && n.length > 0)
			.slice(0, 4);
		lines.push(`- ${id} [${source}, ${status}, ${start}] actions=${actions.join(",") || "(none)"}`);
		for (const p of userPrompts) {
			lines.push(`    prompt: ${compactOne(p, 180)}`);
		}
	}
	return lines.join("\n");
}

function renderMemoriesForPrompt(rows: PensieveMemorySummary[]): string {
	return rows
		.slice(0, DEFAULT_MEMORY_SNAPSHOT)
		.map((row) => `- id=${row.id} path=${row.path}: ${compactOne(row.preview, 160)}`)
		.join("\n");
}

function parseDreamPlan(raw: unknown): DreamPlan | null {
	if (typeof raw !== "string") return null;
	// Codex routes through the TOON compiler so its output may be TOON,
	// not JSON, even when we asked for JSON. Try TOON first (most common
	// shape after the planner's pipeline), then JSON5/JSON as fallback.
	// Without this multi-format parse, every dream tick fails with
	// skipReason="parse-failed" and the agent's memory store never
	// consolidates.
	const fencedMatch = raw.match(/```(?:json|toon)?\s*([\s\S]*?)```/i);
	const body = (fencedMatch?.[1] ?? raw).trim();
	let json: unknown = null;
	const toonAttempt = parseToonKeyValue(body);
	if (toonAttempt && isRecord(toonAttempt)) {
		json = toonAttempt;
	} else {
		try {
			json = JSON.parse(body);
		} catch {
			// Last-ditch: extract first {...} substring (model often wraps
			// the JSON in prose) and try again.
			const obj = body.match(/\{[\s\S]*\}/);
			if (obj) {
				try {
					json = JSON.parse(obj[0]);
				} catch {
					return null;
				}
			} else {
				return null;
			}
		}
	}
	if (!isRecord(json)) return null;
	const out: DreamPlan = {
		additions: [],
		merges: [],
		replacements: [],
		deletions: [],
		...(typeof json.notes === "string" ? { notes: json.notes } : {}),
	};
	const adds = Array.isArray(json.additions) ? json.additions : [];
	for (const item of adds) {
		if (!isRecord(item) || typeof item.text !== "string") continue;
		out.additions.push({
			op: "addition",
			text: item.text,
			...(typeof item.path === "string" && { path: item.path }),
			...(Array.isArray(item.tags) && {
				tags: item.tags.filter((t): t is string => typeof t === "string"),
			}),
			...(typeof item.category === "string" && { category: item.category }),
			...(typeof item.reason === "string" && { reason: item.reason }),
		});
	}
	const merges = Array.isArray(json.merges) ? json.merges : [];
	for (const item of merges) {
		if (!isRecord(item) || typeof item.keepId !== "string") continue;
		const collapseIds = Array.isArray(item.collapseIds)
			? item.collapseIds.filter((id): id is string => typeof id === "string")
			: [];
		if (collapseIds.length === 0) continue;
		out.merges.push({
			op: "merge",
			keepId: item.keepId,
			collapseIds,
			...(typeof item.canonicalText === "string" && { canonicalText: item.canonicalText }),
			...(typeof item.reason === "string" && { reason: item.reason }),
		});
	}
	const replaces = Array.isArray(json.replacements) ? json.replacements : [];
	for (const item of replaces) {
		if (!isRecord(item) || typeof item.staleId !== "string" || typeof item.newText !== "string") continue;
		out.replacements.push({
			op: "replacement",
			staleId: item.staleId,
			newText: item.newText,
			...(typeof item.reason === "string" && { reason: item.reason }),
		});
	}
	const deletes = Array.isArray(json.deletions) ? json.deletions : [];
	for (const item of deletes) {
		if (!isRecord(item) || typeof item.id !== "string") continue;
		out.deletions.push({
			op: "deletion",
			id: item.id,
			...(typeof item.reason === "string" && { reason: item.reason }),
		});
	}
	return out;
}

function planIsEmpty(plan: DreamPlan): boolean {
	return (
		plan.additions.length === 0 &&
		plan.merges.length === 0 &&
		plan.replacements.length === 0 &&
		plan.deletions.length === 0
	);
}

function buildPrompt(
	runtime: IAgentRuntime,
	instructions: string,
	memories: PensieveMemorySummary[],
	trajectories: ActivityTrajectoryDetail[],
): string {
	const memoriesBlock = renderMemoriesForPrompt(memories) || "(empty)";
	const trajectoriesBlock = renderTrajectoriesForPrompt(trajectories) || "(empty)";
	return renderPromptTemplate(
		runtime,
		DETOUR_DREAM_CONSOLIDATION_TEMPLATE,
		{
			instructions: instructions.slice(0, MAX_INSTRUCTION_CHARS),
			memoriesBlock,
			trajectoriesBlock,
		},
		DETOUR_DREAM_CONSOLIDATION_DEFAULT,
	);
}

export class DreamService {
	private lastPlanHashes: string[] = [];

	constructor(private readonly deps: DreamServiceDeps) {}

	start(): void {
		this.deps.runtimeService.onAfterBuild(async (state) => {
			await this.attach(state.runtime);
		});
	}

	stop(): void {}

	async attach(runtime: IAgentRuntime): Promise<void> {
		const r = runtime as unknown as {
			registerTaskWorker?: (worker: {
				name: string;
				execute: (runtime: IAgentRuntime, options: Record<string, unknown>, task: Task) => Promise<unknown>;
			}) => void;
			getTaskWorker?: (name: string) => unknown;
		};
		if (!r.registerTaskWorker || !r.getTaskWorker) return;
		if (!r.getTaskWorker(DETOUR_DREAM_TASK_NAME)) {
			r.registerTaskWorker({
				name: DETOUR_DREAM_TASK_NAME,
				execute: async (rt, _options, task) => {
					await this.execute(rt, task);
					return undefined;
				},
			});
		}
		await this.ensureTask(runtime);
	}

	private async ensureTask(runtime: IAgentRuntime): Promise<void> {
		const r = runtime as unknown as {
			getTasks?: (params: { agentIds?: string[]; tags?: string[]; limit?: number }) => Promise<Task[]>;
			createTask?: (task: Task) => Promise<UUID>;
			updateTask?: (id: UUID, task: Partial<Task>) => Promise<void>;
			deleteTask?: (id: UUID) => Promise<void>;
			agentId?: UUID;
		};
		if (!booleanSetting(runtime, "DETOUR_DREAM_ENABLED", true)) return;
		if (!r.getTasks || !r.createTask) return;
		const tasks = await r.getTasks({
			...(r.agentId ? { agentIds: [r.agentId] } : {}),
			tags: ["dream"],
		});
		const dreamTasks = tasks.filter(
			(t) => t.name === DETOUR_DREAM_TASK_NAME && isRecord(t.metadata?.detourDream),
		);
		const [primary, ...duplicates] = dreamTasks;
		for (const duplicate of duplicates) {
			if (duplicate.id && r.deleteTask) {
				try {
					await r.deleteTask(duplicate.id);
				} catch (err) {
					logger.warn(
						{ src: "detour:dream", err: err instanceof Error ? err.message : err },
						"failed to delete duplicate dream task",
					);
				}
			}
		}
		const metadata = buildTaskMetadata(primary?.metadata, runtime);
		if (primary?.id) {
			await r.updateTask?.(primary.id, {
				description: "Consolidate Pensieve memories from recent sessions",
				tags: [...TASK_TAGS],
				metadata,
			});
			return;
		}
		await r.createTask({
			name: DETOUR_DREAM_TASK_NAME,
			description: "Consolidate Pensieve memories from recent sessions",
			tags: [...TASK_TAGS],
			metadata,
			dueAt: Date.now() + 30_000,
		});
	}

	/**
	 * Run a dream pass NOW (bypasses the scheduled task). Used by the
	 * "Run dream" button in the Pensieve UI and by /dream slash commands.
	 */
	async runNow(opts: { instructions?: string } = {}): Promise<{ planId?: string; plan: DreamPlan; skipReason?: string }> {
		const runtime = this.deps.runtimeService.peek();
		if (!runtime) return { plan: this.emptyPlan(), skipReason: "no-runtime" };
		return this.consolidate(runtime, opts.instructions);
	}

	private async execute(runtime: IAgentRuntime, task: Task): Promise<void> {
		if (!booleanSetting(runtime, "DETOUR_DREAM_ENABLED", true)) return;
		const result = await this.consolidate(runtime);
		const metadata = isRecord(task.metadata) ? task.metadata : {};
		await (runtime as unknown as {
			updateTask?: (id: UUID, task: Partial<Task>) => Promise<void>;
		}).updateTask?.(task.id as UUID, {
			metadata: {
				...metadata,
				dreamLastRunAt: Date.now(),
				...(result.planId ? { dreamLastPlanId: result.planId } : {}),
				...(result.skipReason ? { dreamLastSkipReason: result.skipReason } : {}),
				dreamLastPlanCounts: {
					additions: result.plan.additions.length,
					merges: result.plan.merges.length,
					replacements: result.plan.replacements.length,
					deletions: result.plan.deletions.length,
				},
				dreamLastPlanHashes: this.lastPlanHashes.slice(-HASH_LIMIT),
			},
		});
	}

	private async consolidate(
		runtime: IAgentRuntime,
		callerInstructions?: string,
	): Promise<{ planId?: string; plan: DreamPlan; skipReason?: string }> {
		// Cap-aware: bail before burning planner tokens when the active
		// provider is already capped. Dream is a luxury operation; chat is
		// the priority surface.
		const cap = getProviderQuotaService().getActiveCap();
		if (cap) {
			logger.info(
				{ src: "detour:dream", provider: cap.providerId, account: cap.accountLabel },
				"skipping dream tick — active provider is quota-capped",
			);
			return { plan: this.emptyPlan(), skipReason: "provider-capped" };
		}
		const memories = await this.deps.memories.list({ limit: DEFAULT_MEMORY_SNAPSHOT });
		const trajectoryList = await this.deps.trajectories.list({
			limit: DEFAULT_TRAJECTORY_BATCH,
			status: "completed",
		});
		const ids = trajectoryList.trajectories.map((t) => t.id).slice(0, DEFAULT_TRAJECTORY_BATCH);
		const details = await this.deps.trajectories.getMany(ids);
		const instructions =
			callerInstructions ??
			pickSetting(runtime, "DETOUR_DREAM_INSTRUCTIONS") ??
			[
				"Focus on durable user preferences, recurring failure modes, and capability gaps.",
				"Ignore one-off debugging notes, transient errors, and message-quote contents.",
				"When you find facts that contradict each other, prefer the most recent.",
			].join(" ");
		const prompt = buildPrompt(runtime, instructions, memories, details);
		let raw: unknown;
		try {
			raw = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt,
				maxTokens: 2400,
				temperature: 0.2,
			});
		} catch (err) {
			logger.warn(
				{ src: "detour:dream", err: err instanceof Error ? err.message : err },
				"dream model call failed",
			);
			return { plan: this.emptyPlan(), skipReason: "model-error" };
		}
		const parsed = parseDreamPlan(raw);
		if (!parsed) {
			logger.warn({ src: "detour:dream" }, "dream model output failed to parse as JSON plan");
			return { plan: this.emptyPlan(), skipReason: "parse-failed" };
		}
		if (planIsEmpty(parsed)) {
			logger.info({ src: "detour:dream" }, "dream produced empty plan — nothing to consolidate");
			return { plan: parsed, skipReason: "empty-plan" };
		}
		const plan = parsed;
		const hash = hashPlan(plan);
		if (this.lastPlanHashes.includes(hash)) {
			logger.info({ src: "detour:dream", hash }, "dream produced duplicate plan — skipping");
			return { plan, skipReason: "duplicate-plan" };
		}
		this.lastPlanHashes.push(hash);
		// Persist the dream record (the manifest) + one pending memory per
		// proposed change. Apply only addresses applying; this turn just
		// stages everything for review.
		const dreamRecord = await this.deps.memories.create({
			text: this.renderPlanSummary(plan),
			path: "/dreams",
			type: DREAM_MEMORY_TYPE,
			tags: ["dream", "dream-manifest"],
			extraMetadata: {
				dreamHash: hash,
				counts: {
					additions: plan.additions.length,
					merges: plan.merges.length,
					replacements: plan.replacements.length,
					deletions: plan.deletions.length,
				},
				notes: plan.notes,
				ranAt: Date.now(),
			},
		});
		if (!dreamRecord) {
			return { plan, skipReason: "manifest-write-failed" };
		}
		await this.stagePending(dreamRecord.id, plan);
		if (booleanSetting(runtime, "DETOUR_DREAM_AUTO_APPLY", false)) {
			const result = await this.apply(dreamRecord.id);
			logger.info({ src: "detour:dream", planId: dreamRecord.id, result }, "auto-applied dream plan");
		}
		return { planId: dreamRecord.id, plan };
	}

	private async stagePending(dreamId: string, plan: DreamPlan): Promise<void> {
		const flat: DreamProposedChange[] = [
			...plan.additions,
			...plan.merges,
			...plan.replacements,
			...plan.deletions,
		];
		for (const change of flat) {
			await this.deps.memories.create({
				text: this.renderChangePreview(change),
				path: `/dreams/${dreamId}`,
				type: DREAM_PENDING_MEMORY_TYPE,
				tags: ["dream", "dream-pending", `op:${change.op}`],
				extraMetadata: {
					dreamId,
					op: change.op,
					change,
				},
			});
		}
	}

	/**
	 * Apply a dream plan. Idempotent — re-applying a plan that was already
	 * applied just no-ops because the pending entries are removed on apply.
	 */
	async apply(dreamId: string): Promise<DreamApplyResult> {
		const result: DreamApplyResult = { applied: 0, skipped: 0, failed: 0, errors: [] };
		const pending = await this.deps.memories.list({
			type: DREAM_PENDING_MEMORY_TYPE,
			pathPrefix: `/dreams/${dreamId}`,
			limit: 500,
		});
		for (const row of pending) {
			const detail = await this.deps.memories.get(row.id as UUID);
			const meta = isRecord(detail?.metadata) ? detail.metadata : {};
			const change = meta.change;
			if (!isRecord(change) || typeof change.op !== "string") {
				result.skipped++;
				continue;
			}
			try {
				await this.applyOne(change as unknown as DreamProposedChange);
				await this.deps.memories.remove(row.id as UUID);
				result.applied++;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				result.errors.push(msg);
				result.failed++;
			}
		}
		return result;
	}

	/**
	 * Reject a dream plan: drops every pending change without touching
	 * memories. The manifest stays so the user can see "yes, this dream
	 * ran on date X but I rejected everything."
	 */
	async reject(dreamId: string): Promise<{ removed: number }> {
		const pending = await this.deps.memories.list({
			type: DREAM_PENDING_MEMORY_TYPE,
			pathPrefix: `/dreams/${dreamId}`,
			limit: 500,
		});
		let removed = 0;
		for (const row of pending) {
			if (await this.deps.memories.remove(row.id as UUID)) removed++;
		}
		return { removed };
	}

	/**
	 * Snapshot for the Pensieve "Dreams" pane.
	 */
	async snapshot(): Promise<{
		dreams: Array<{
			id: string;
			createdAt: number;
			summary: string;
			counts: Record<string, number>;
			notes?: string;
			pendingCount: number;
		}>;
	}> {
		const manifests = await this.deps.memories.list({
			type: DREAM_MEMORY_TYPE,
			pathPrefix: "/dreams",
			limit: 50,
		});
		const out: Awaited<ReturnType<DreamService["snapshot"]>>["dreams"] = [];
		for (const m of manifests) {
			const detail = await this.deps.memories.get(m.id as UUID);
			const meta = isRecord(detail?.metadata) ? detail.metadata : {};
			const counts = isRecord(meta.counts) ? (meta.counts as Record<string, number>) : {};
			const notes = typeof meta.notes === "string" ? meta.notes : undefined;
			const pending = await this.deps.memories.list({
				type: DREAM_PENDING_MEMORY_TYPE,
				pathPrefix: `/dreams/${m.id}`,
				limit: 200,
			});
			out.push({
				id: m.id,
				createdAt: m.createdAt ?? 0,
				summary: m.preview,
				counts,
				...(notes !== undefined && { notes }),
				pendingCount: pending.length,
			});
		}
		return { dreams: out };
	}

	private async applyOne(change: DreamProposedChange): Promise<void> {
		switch (change.op) {
			case "addition": {
				await this.deps.memories.create({
					text: change.text,
					path: change.path ?? "/dreams/additions",
					type: "description",
					tags: ["dream", "dream-applied", ...(change.tags ?? [])],
					extraMetadata: {
						dreamApplied: true,
						...(change.category && { category: change.category }),
						...(change.reason && { reason: change.reason }),
					},
				});
				return;
			}
			case "merge": {
				// Update the keep entry with canonical text (if provided);
				// remove the collapsed entries. Idempotent if collapse
				// targets are already gone — remove returns false but we
				// continue.
				if (change.canonicalText) {
					await this.deps.memories.update(change.keepId as UUID, {
						contentText: change.canonicalText,
					});
				}
				for (const id of change.collapseIds) {
					try {
						await this.deps.memories.remove(id as UUID);
					} catch {
						// best-effort — collapse target may already be gone
					}
				}
				return;
			}
			case "replacement": {
				await this.deps.memories.update(change.staleId as UUID, {
					contentText: change.newText,
				});
				return;
			}
			case "deletion": {
				// Hermes Curator safeguard: archive instead of delete. We
				// re-tag the memory with `detour-dream-archived` so it stops
				// surfacing in retrieval but stays recoverable via the
				// `restore()` method. The user said "trim memory" — Hermes'
				// 30d-stale / 90d-archived lifecycle is the right pressure;
				// outright deletion would be unrecoverable.
				const detail = await this.deps.memories.get(change.id as UUID);
				if (!detail) return; // already gone
				const previousMetadata = isRecord(detail.metadata) ? detail.metadata : {};
				await this.deps.memories.update(change.id as UUID, {
					type: DREAM_ARCHIVED_MEMORY_TYPE,
					metadata: {
						archived: true,
						archivedReason: change.reason ?? "dream-deletion",
						archivedAt: Date.now(),
						previousType: detail.type,
						// Stash the full pre-archive metadata so `restore`
						// can put the entry back exactly as it was without
						// the archived-* markers leaking through.
						preArchiveMetadata: previousMetadata,
					},
				});
				return;
			}
		}
	}

	/**
	 * Restore an archived memory back to its previous type. Mirrors
	 * Hermes' `curator restore <n>` command. Returns true when a memory
	 * was restored, false when the id wasn't an archived entry.
	 */
	async restore(memoryId: string): Promise<boolean> {
		const detail = await this.deps.memories.get(memoryId as UUID);
		if (!detail || detail.type !== DREAM_ARCHIVED_MEMORY_TYPE) return false;
		const meta = isRecord(detail.metadata) ? detail.metadata : {};
		const previousType =
			typeof meta.previousType === "string" ? meta.previousType : "description";
		const stashed = isRecord(meta.preArchiveMetadata)
			? (meta.preArchiveMetadata as Record<string, unknown>)
			: null;
		// Replace metadata wholesale with the pre-archive snapshot — the
		// memory-service merges patch.metadata with existing, so passing
		// the cleaned snapshot AND explicit-undefined for the archive keys
		// gives a clean restore without leftover archive markers.
		const restoredMeta: Record<string, unknown> = stashed
			? { ...stashed }
			: {};
		restoredMeta.archived = undefined;
		restoredMeta.archivedReason = undefined;
		restoredMeta.archivedAt = undefined;
		restoredMeta.previousType = undefined;
		restoredMeta.preArchiveMetadata = undefined;
		await this.deps.memories.update(memoryId as UUID, {
			type: previousType,
			metadata: restoredMeta,
		});
		return true;
	}

	private emptyPlan(): DreamPlan {
		return { additions: [], merges: [], replacements: [], deletions: [] };
	}

	private renderPlanSummary(plan: DreamPlan): string {
		const parts: string[] = [];
		if (plan.notes) parts.push(plan.notes);
		parts.push(
			`add=${plan.additions.length} merge=${plan.merges.length} replace=${plan.replacements.length} delete=${plan.deletions.length}`,
		);
		return parts.join(" — ");
	}

	private renderChangePreview(change: DreamProposedChange): string {
		switch (change.op) {
			case "addition":
				return `+ ${compactOne(change.text, 200)}${change.reason ? ` (${change.reason})` : ""}`;
			case "merge":
				return `~ merge ${change.collapseIds.length} into ${change.keepId}${change.reason ? ` (${change.reason})` : ""}`;
			case "replacement":
				return `* replace ${change.staleId}: ${compactOne(change.newText, 160)}`;
			case "deletion":
				return `- delete ${change.id}${change.reason ? ` (${change.reason})` : ""}`;
		}
	}
}
