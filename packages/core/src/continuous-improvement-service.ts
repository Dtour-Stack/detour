import { createHash } from "node:crypto";
import {
	logger,
	ModelType,
	parseToonKeyValue,
	type IAgentRuntime,
	type Task,
	type TaskMetadata,
	type UUID,
} from "@elizaos/core";
import type { ActivityLogEntry, ActivityLogService } from "./activity/log-service";
import type { PensieveMemoryService, PensieveMemorySummary } from "./pensieve/memory-service";
import type { RuntimeService } from "./runtime";

export const CONTINUOUS_IMPROVEMENT_TASK_NAME = "CONTINUOUS_IMPROVEMENT";
const TASK_TAGS = ["queue", "repeat", "autonomy", "continuous-improvement"];
const DEFAULT_INTERVAL_MS = 30 * 60_000;
const HASH_LIMIT = 50;

type ContinuousImprovementDecision = {
	should_write?: boolean | string;
	category?: string;
	memory?: string;
	user_profile?: string;
	skill_candidate?: string;
	reason?: string;
};

type RuntimeTaskSurface = IAgentRuntime & {
	getTasks?: (params: { agentIds?: string[]; tags?: string[]; limit?: number }) => Promise<Task[]>;
	createTask?: (task: Task) => Promise<UUID>;
	updateTask?: (id: UUID, task: Partial<Task>) => Promise<void>;
	deleteTask?: (id: UUID) => Promise<void>;
	getTaskWorker?: (name: string) => unknown;
	registerTaskWorker?: (worker: {
		name: string;
		execute: (runtime: IAgentRuntime, options: Record<string, unknown>, task: Task) => Promise<unknown>;
	}) => void;
};

function pickSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const v = runtime.getSetting(key);
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

function readTimestamp(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function readModelBoolean(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value !== "string") return false;
	return ["true", "yes", "1", "write", "save"].includes(value.trim().toLowerCase());
}

function compact(text: string | undefined, max = 800): string {
	return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function buildMetadata(current: unknown, runtime: IAgentRuntime): TaskMetadata {
	const intervalMs = Math.max(
		5 * 60_000,
		Math.min(24 * 60 * 60_000, numberSetting(runtime, "CONTINUOUS_IMPROVEMENT_INTERVAL_MS", DEFAULT_INTERVAL_MS)),
	);
	return {
		...(isRecord(current) ? current : {}),
		updateInterval: intervalMs,
		baseInterval: intervalMs,
		blocking: false,
		continuousImprovement: {
			version: 1,
		},
	};
}

function isImprovementTask(task: Task): boolean {
	return task.name === CONTINUOUS_IMPROVEMENT_TASK_NAME && isRecord(task.metadata?.continuousImprovement);
}

function hasQueueTag(task: Task): boolean {
	return Array.isArray(task.tags) && task.tags.includes("queue");
}

async function ensureTask(runtime: RuntimeTaskSurface): Promise<UUID | null> {
	if (!booleanSetting(runtime, "CONTINUOUS_IMPROVEMENT_ENABLED", true)) return null;
	if (!runtime.getTasks || !runtime.createTask) return null;
	const tasks = await runtime.getTasks({
		agentIds: [runtime.agentId],
		tags: ["continuous-improvement"],
	});
	const existing = tasks
		.filter(isImprovementTask)
		.sort((a, b) => {
			const aq = hasQueueTag(a) ? 1 : 0;
			const bq = hasQueueTag(b) ? 1 : 0;
			if (aq !== bq) return bq - aq;
			return readTimestamp(b.metadata?.continuousImprovementLastRunAt) - readTimestamp(a.metadata?.continuousImprovementLastRunAt);
		});
	const [primary, ...duplicates] = existing;
	for (const duplicate of duplicates) {
		if (duplicate.id && runtime.deleteTask) await runtime.deleteTask(duplicate.id);
	}
	const metadata = buildMetadata(primary?.metadata, runtime);
	if (primary?.id) {
		await runtime.updateTask?.(primary.id, {
			description: "Reflect on recent activity and persist durable agent improvements",
			tags: [...TASK_TAGS],
			metadata,
		});
		return primary.id;
	}
	return runtime.createTask({
		name: CONTINUOUS_IMPROVEMENT_TASK_NAME,
		description: "Reflect on recent activity and persist durable agent improvements",
		tags: [...TASK_TAGS],
		metadata,
		dueAt: Date.now() + 15_000,
	});
}

function renderLogs(logs: ActivityLogEntry[]): string {
	return logs
		.slice(-40)
		.map((entry) => {
			const source = entry.source ? `[${entry.source}] ` : "";
			return `${entry.levelName} ${source}${compact(entry.msg, 220)}`;
		})
		.join("\n");
}

function renderMemories(memories: PensieveMemorySummary[]): string {
	return memories
		.slice(0, 25)
		.map((memory) => `- ${memory.path}: ${compact(memory.preview, 180)}`)
		.join("\n");
}

function fallbackImprovement(logs: ActivityLogEntry[], modelError: string): ContinuousImprovementDecision {
	const actionable = [...logs]
		.reverse()
		.find((entry) => entry.levelName === "error" || entry.levelName === "warn");
	if (!actionable) {
		return {
			should_write: true,
			category: "tool-quirk",
			memory:
				`Continuous improvement model pass could not run (${compact(modelError, 180)}). Keep the worker resilient: record the failure, retry later, and avoid blocking other autonomy tasks on reflection calls.`,
			reason: "model unavailable",
		};
	}
	const source = actionable.source ? `${actionable.source}: ` : "";
	return {
		should_write: true,
		category: actionable.levelName === "error" ? "tool-quirk" : "eval-guardrail",
		memory:
			`Continuous improvement observed ${actionable.levelName} ${source}${compact(actionable.msg, 260)}. Future runs should check whether this is recurring before proposing prompt, tool, or workflow changes.`,
		reason: "fallback reflection from recent logs",
	};
}

async function decideImprovement(
	runtime: IAgentRuntime,
	logs: ActivityLogEntry[],
	memories: PensieveMemorySummary[],
): Promise<ContinuousImprovementDecision> {
	const prompt = [
		"You are Detour's continuous-improvement loop.",
		"Use the Hermes Agent pattern: bounded curated memory, skill creation after non-trivial workflows, session search for recall, tool orchestration, evaluation traces, and human-reviewed self-evolution.",
		"Your job is to extract one durable improvement from recent activity. Do not rewrite code, alter prompts, or claim a change has been made. Save only useful, non-secret, non-ephemeral learning.",
		"",
		"Save when there is:",
		"- a user preference, correction, repeated frustration, or workflow habit",
		"- a project convention, tool quirk, integration failure pattern, or working recovery path",
		"- a candidate skill/procedure the agent should reuse later",
		"- a measurable guardrail/eval idea for future self-evolution",
		"",
		"Skip trivial observations, raw logs, secrets, tokens, private message contents, one-off stack traces, or anything already obvious from AGENTS.md.",
		"",
		"Recent logs:",
		renderLogs(logs) || "(none)",
		"",
		"Recent memories:",
		renderMemories(memories) || "(none)",
		"",
		"Output TOON only:",
		"should_write: true | false",
		"category: user-preference | workflow | tool-quirk | skill-candidate | eval-guardrail | skip",
		"memory: <one compact durable memory, required when should_write is true>",
		"user_profile: <optional compact user preference>",
		"skill_candidate: <optional reusable workflow idea>",
		"reason: <brief>",
	].join("\n");
	const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
	return parseToonKeyValue<ContinuousImprovementDecision>(String(raw)) ?? {
		should_write: false,
		category: "skip",
		reason: "unparseable model output",
	};
}

export class ContinuousImprovementService {
	constructor(
		private readonly runtimeService: RuntimeService,
		private readonly memories: PensieveMemoryService,
		private readonly logs: ActivityLogService,
	) {}

	start(): void {
		this.runtimeService.onAfterBuild(async (state) => {
			await this.attach(state.runtime);
		});
	}

	stop(): void {}

	async attach(runtime: IAgentRuntime): Promise<void> {
		const r = runtime as RuntimeTaskSurface;
		if (!r.registerTaskWorker || !r.getTaskWorker) return;
		if (!r.getTaskWorker(CONTINUOUS_IMPROVEMENT_TASK_NAME)) {
			r.registerTaskWorker({
				name: CONTINUOUS_IMPROVEMENT_TASK_NAME,
				execute: async (rt, _options, task) => {
					await this.execute(rt, task);
					return undefined;
				},
			});
		}
		await ensureTask(r);
	}

	private async execute(runtime: IAgentRuntime, task: Task): Promise<void> {
		if (!booleanSetting(runtime, "CONTINUOUS_IMPROVEMENT_ENABLED", true)) return;
		const metadata = isRecord(task.metadata) ? task.metadata : {};
		const lastRunAt = readTimestamp(metadata.continuousImprovementLastRunAt);
		const since = lastRunAt > 0 ? lastRunAt : Date.now() - 2 * 60 * 60_000;
		const logs = this.logs.list({ since, limit: 160 });
		const recentMemories = await this.memories.list({ limit: 40 });
		let modelError: string | undefined;
		const decision = await decideImprovement(runtime, logs, recentMemories).catch((err) => {
			modelError = err instanceof Error ? err.message : String(err);
			logger.warn({ src: "continuous-improvement", error: modelError }, "model reflection failed; using deterministic fallback");
			return fallbackImprovement(logs, modelError);
		});
		const category = compact(decision.category, 80) || "skip";
		const memory = compact(decision.memory, 900);
		const profile = compact(decision.user_profile, 500);
		const skillCandidate = compact(decision.skill_candidate, 700);
		const hashes = readStringArray(metadata.continuousImprovementHashes);
		const createdIds: string[] = [];
		let result = "skip";
		let proposal = compact(decision.reason, 300);

		if (readModelBoolean(decision.should_write) && memory.length > 0) {
			const hash = hashText(`${category}\n${memory}`);
			if (!hashes.includes(hash)) {
				const created = await this.memories.create({
					text: memory,
					path: "/improvement/reflections",
					type: "description",
					tags: ["continuous-improvement", category],
					extraMetadata: {
						source: "continuous-improvement",
						category,
						reason: decision.reason,
						logCount: logs.length,
						memoryCount: recentMemories.length,
					},
				});
				if (created) {
					createdIds.push(created.id);
					hashes.push(hash);
					result = "memory_written";
					proposal = memory;
				} else {
					result = "memory_write_failed";
				}
			} else {
				result = "duplicate_skip";
			}
		}

		if (profile.length > 0) {
			const hash = hashText(`profile\n${profile}`);
			if (!hashes.includes(hash)) {
				const created = await this.memories.create({
					text: profile,
					path: "/profile/user",
					type: "description",
					tags: ["continuous-improvement", "user-model"],
					extraMetadata: { source: "continuous-improvement", category: "user-profile" },
				});
				if (created) {
					createdIds.push(created.id);
					hashes.push(hash);
				}
			}
		}

		if (skillCandidate.length > 0) {
			const hash = hashText(`skill\n${skillCandidate}`);
			if (!hashes.includes(hash)) {
				const created = await this.memories.create({
					text: skillCandidate,
					path: "/improvement/skill-candidates",
					type: "description",
					tags: ["continuous-improvement", "skill-candidate"],
					extraMetadata: { source: "continuous-improvement", category: "skill-candidate" },
				});
				if (created) {
					createdIds.push(created.id);
					hashes.push(hash);
				}
			}
		}

		if (task.id) {
			await (runtime as RuntimeTaskSurface).updateTask?.(task.id, {
				metadata: {
					...metadata,
					continuousImprovementLastRunAt: Date.now(),
					continuousImprovementLastResult: result,
					continuousImprovementLastCategory: category,
					continuousImprovementLastProposal: proposal,
					...(modelError ? { continuousImprovementLastError: modelError } : {}),
					continuousImprovementLastMemoryIds: createdIds,
					continuousImprovementHashes: hashes.slice(-HASH_LIMIT),
				},
			});
		}
		logger.info(
			{ src: "continuous-improvement", result, category, createdCount: createdIds.length },
			"continuous improvement tick complete",
		);
	}
}
