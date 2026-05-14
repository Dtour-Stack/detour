import { logger, type IAgentRuntime } from "@elizaos/core";
import type { AgentHfSyncPolicy, AgentHfSyncReason, AgentHfSyncState } from "../../shared/index";
import type { AgentHfDumpJob, AgentHfDumpStatus } from "../../shared/rpc/config";
import type { ActivityTrajectoryService } from "./activity/trajectory-service";
import type { ConfigService } from "./config-service";
import type { RuntimeService } from "./runtime";
import {
	DEFAULT_HF_BUCKET,
	hfDatasetSyncCommand,
	type AgentHfDatasetSyncResult,
	syncAgentDumpToHf,
} from "../plugins/agent-public-log/index";

type SyncFn = (
	runtime: IAgentRuntime,
	options: { destination?: string; limit?: number },
) => Promise<AgentHfDatasetSyncResult>;

type AgentHfSyncDeps = {
	runtime: Pick<RuntimeService, "peek">;
	config: Pick<
		ConfigService,
		| "getAgentHfSyncPolicy"
		| "setAgentHfSyncPolicy"
		| "getAgentHfSyncState"
		| "setAgentHfSyncState"
	>;
	trajectories: Pick<ActivityTrajectoryService, "list">;
	sync?: SyncFn;
	checkIntervalMs?: number;
};

const DEFAULT_CHECK_INTERVAL_MS = 60_000;

export class AgentHfSyncService {
	private readonly jobs = new Map<string, AgentHfDumpJob>();
	private activeJobId: string | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly sync: SyncFn;
	private readonly checkIntervalMs: number;

	constructor(private readonly deps: AgentHfSyncDeps) {
		this.sync = deps.sync ?? syncAgentDumpToHf;
		this.checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.checkNow().catch((err) => {
				logger.warn({ src: "agent-hf-sync", err: err instanceof Error ? err.message : err }, "autonomous sync check failed");
			});
		}, this.checkIntervalMs);
		void this.checkNow().catch((err) => {
			logger.warn({ src: "agent-hf-sync", err: err instanceof Error ? err.message : err }, "initial sync check failed");
		});
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async status(): Promise<AgentHfDumpStatus> {
		const [policy, state, hfAvailable] = await Promise.all([
			this.deps.config.getAgentHfSyncPolicy(),
			this.deps.config.getAgentHfSyncState(),
			this.hfCliAvailable(),
		]);
		return {
			defaultDestination: DEFAULT_HF_BUCKET,
			hfAvailable,
			activeJob: this.activeJob(),
			policy,
			state,
		};
	}

	async setPolicy(next: AgentHfSyncPolicy): Promise<AgentHfSyncPolicy> {
		const policy = await this.deps.config.setAgentHfSyncPolicy(next);
		if (policy.enabled) {
			void this.checkNow().catch((err) => {
				logger.warn({ src: "agent-hf-sync", err: err instanceof Error ? err.message : err }, "post-policy sync check failed");
			});
		}
		return policy;
	}

	getJob(id: string): AgentHfDumpJob | null {
		return this.jobs.get(id) ?? null;
	}

	async startSync(
		reason: AgentHfSyncReason,
		options: { destination?: string; limit?: number } = {},
	): Promise<AgentHfDumpJob> {
		const existing = this.activeJob();
		if (existing?.status === "running") return existing;
		const policy = await this.deps.config.getAgentHfSyncPolicy();
		const destination = options.destination?.trim() || policy.destination;
		if (!destination.startsWith("hf://")) {
			throw new Error("Hugging Face destination must start with `hf://`.");
		}
		const runtime = this.deps.runtime.peek();
		if (!runtime) throw new Error("Agent runtime is not ready yet.");
		const limit = this.limit(options.limit ?? policy.limit);
		const total = await this.trajectoryTotal().catch(() => null);
		const job = this.createJob(reason, destination);
		void this.runJob(job, runtime, { destination, limit, trajectoryTotal: total });
		return job;
	}

	async checkNow(now = new Date()): Promise<AgentHfDumpJob | null> {
		const policy = await this.deps.config.getAgentHfSyncPolicy();
		if (!policy.enabled) return null;
		if (this.activeJob()?.status === "running") return null;
		const state = await this.deps.config.getAgentHfSyncState();
		const total = await this.trajectoryTotal().catch((err) => {
			logger.warn({ src: "agent-hf-sync", err: err instanceof Error ? err.message : err }, "trajectory count unavailable");
			return null;
		});
		const reason = await this.reasonToSync(policy, state, now, total);
		if (!reason) return null;
		const runtime = this.deps.runtime.peek();
		if (!runtime) return null;
		const job = this.createJob(reason, policy.destination);
		void this.runJob(job, runtime, {
			destination: policy.destination,
			limit: policy.limit,
			trajectoryTotal: total,
			dailyDateUtc: reason === "daily" ? this.utcDate(now) : undefined,
		});
		return job;
	}

	private async reasonToSync(
		policy: AgentHfSyncPolicy,
		state: AgentHfSyncState,
		now: Date,
		total: number | null,
	): Promise<AgentHfSyncReason | null> {
		if (!this.afterCooldown(state, now, policy)) return null;
		if (!this.afterMinInterval(state, now, policy)) return null;
		if (policy.syncOnStartup && !state.lastSuccessAt) return "startup";
		if (policy.daily && this.dailyDue(policy, state, now)) return "daily";
		if (total !== null) {
			const baseline = state.lastSyncedTrajectoryTotal ?? state.lastObservedTrajectoryTotal;
			if (baseline === null) {
				await this.updateState({
					...state,
					lastObservedTrajectoryTotal: total,
				});
				return null;
			}
			if (total - baseline >= policy.everyNewTrajectories) return "trajectory-threshold";
		}
		return null;
	}

	private createJob(reason: AgentHfSyncReason, destination: string): AgentHfDumpJob {
		const job: AgentHfDumpJob = {
			id: crypto.randomUUID(),
			destination,
			command: hfDatasetSyncCommand(destination),
			reason,
			status: "running",
			startedAt: new Date().toISOString(),
			finishedAt: null,
			counts: null,
			stdout: null,
			stderr: null,
			error: null,
		};
		this.jobs.set(job.id, job);
		this.activeJobId = job.id;
		this.pruneJobs();
		return job;
	}

	private async runJob(
		job: AgentHfDumpJob,
		runtime: IAgentRuntime,
		options: { destination: string; limit: number; trajectoryTotal: number | null; dailyDateUtc?: string },
	): Promise<void> {
		const attemptAt = job.startedAt;
		try {
			const result = await this.sync(runtime, {
				destination: options.destination,
				limit: options.limit,
			});
			job.status = "succeeded";
			job.counts = result.counts;
			job.stdout = result.stdout;
			job.stderr = result.stderr;
			const state = await this.deps.config.getAgentHfSyncState();
			await this.updateState({
				...state,
				lastAttemptAt: attemptAt,
				lastSuccessAt: new Date().toISOString(),
				lastFailureAt: null,
				lastError: null,
				lastReason: job.reason,
				lastSyncedTrajectoryTotal: options.trajectoryTotal,
				lastObservedTrajectoryTotal: options.trajectoryTotal,
				lastDailySyncDateUtc: options.dailyDateUtc ?? state.lastDailySyncDateUtc,
				lastCounts: result.counts,
			});
			logger.info({ src: "agent-hf-sync", reason: job.reason, destination: job.destination }, "agent data dump synced to Hugging Face");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			job.status = "failed";
			job.error = message;
			const state = await this.deps.config.getAgentHfSyncState();
			await this.updateState({
				...state,
				lastAttemptAt: attemptAt,
				lastFailureAt: new Date().toISOString(),
				lastError: message,
				lastReason: job.reason,
				lastObservedTrajectoryTotal: options.trajectoryTotal ?? state.lastObservedTrajectoryTotal,
			});
			logger.warn({ src: "agent-hf-sync", reason: job.reason, destination: job.destination, err: message }, "Hugging Face sync failed");
		} finally {
			job.finishedAt = new Date().toISOString();
			if (this.activeJobId === job.id) this.activeJobId = null;
			this.pruneJobs();
		}
	}

	private async updateState(next: AgentHfSyncState): Promise<void> {
		await this.deps.config.setAgentHfSyncState(next);
	}

	private async trajectoryTotal(): Promise<number | null> {
		const result = await this.deps.trajectories.list({ limit: 1, offset: 0 });
		return typeof result.total === "number" && Number.isFinite(result.total) ? result.total : null;
	}

	private activeJob(): AgentHfDumpJob | null {
		if (!this.activeJobId) return null;
		return this.jobs.get(this.activeJobId) ?? null;
	}

	private pruneJobs(): void {
		const jobs = [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		for (const job of jobs.slice(10)) this.jobs.delete(job.id);
	}

	private limit(value: number): number {
		return Math.min(2000, Math.max(1, Math.floor(value)));
	}

	private afterMinInterval(state: AgentHfSyncState, now: Date, policy: AgentHfSyncPolicy): boolean {
		if (!state.lastAttemptAt) return true;
		return now.getTime() - Date.parse(state.lastAttemptAt) >= policy.minIntervalMinutes * 60_000;
	}

	private afterCooldown(state: AgentHfSyncState, now: Date, policy: AgentHfSyncPolicy): boolean {
		if (!state.lastFailureAt) return true;
		return now.getTime() - Date.parse(state.lastFailureAt) >= policy.failureCooldownMinutes * 60_000;
	}

	private dailyDue(policy: AgentHfSyncPolicy, state: AgentHfSyncState, now: Date): boolean {
		const day = this.utcDate(now);
		if (state.lastDailySyncDateUtc === day) return false;
		return this.utcMinutes(now) >= this.policyMinutes(policy.dailyTimeUtc);
	}

	private utcDate(now: Date): string {
		return now.toISOString().slice(0, 10);
	}

	private utcMinutes(now: Date): number {
		return now.getUTCHours() * 60 + now.getUTCMinutes();
	}

	private policyMinutes(time: string): number {
		const [hh, mm] = time.split(":");
		const h = Number(hh);
		const m = Number(mm);
		if (!Number.isFinite(h) || !Number.isFinite(m)) return 3 * 60;
		return Math.max(0, Math.min(23, Math.floor(h))) * 60 + Math.max(0, Math.min(59, Math.floor(m)));
	}

	private async hfCliAvailable(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["hf", "version"], { env: process.env, stdout: "pipe", stderr: "pipe" });
			await Promise.all([
				proc.stdout ? new Response(proc.stdout as ReadableStream<Uint8Array>).text() : Promise.resolve(""),
				proc.stderr ? new Response(proc.stderr as ReadableStream<Uint8Array>).text() : Promise.resolve(""),
			]);
			return await proc.exited === 0;
		} catch {
			return false;
		}
	}
}
