/**
 * CompanionService — Detour's small sidekick model.
 *
 * Spawns a dedicated llama-server subprocess running eliza-1 0.6B
 * (or a configured alternative) on its own port, separate from the
 * embedding server and the chat-completion server. Exposes 5 job
 * methods the agent's hot paths can call to offload light decisions
 * from the cloud planner:
 *
 *   triage()         — should this turn even hit the planner?
 *   shouldRespond()  — should this Discord/X observation tick fire?
 *   memoryQuery()    — rewrite a vague user prompt into retrieval queries
 *   compress()       — squash long history into a token-budget summary
 *   personaPrePass() — frame the user's intent for the planner in one line
 *
 * Each job is a short `/v1/completions` POST to the local model with a
 * tight prompt + stop tokens + low max_tokens. On a 0.6B base model
 * (e.g. eliza-1-0_6b-32k) every call lands in 50-250ms with ~3 GB
 * live RAM total — the "widest range for least cost" tier.
 *
 * Failure mode: every job returns a "null/skip" sentinel rather than
 * throwing. The agent's existing paths run normally if the companion
 * is down or slow; nothing is load-bearing.
 */

import { totalmem } from "node:os";
import { logger } from "@elizaos/core";
import {
	LlamaServerService,
	type LlamaServerStatus,
} from "./server-service";
import type { LocalChatService } from "./chat-service";
import type { MemoryArbiter } from "./memory-arbiter";
import {
	compressPrompt,
	memoryQueryPrompt,
	parseMemoryQueryOutput,
	parseShouldRespondOutput,
	parseTriageOutput,
	personaPrePassPrompt,
	shouldRespondPrompt,
	triagePrompt,
	type TriageLabel,
} from "./companion-jobs";
import type {
	CompanionBackend,
	CompanionBackendAvailability,
} from "./companion-backend";
import { CompanionClassicalBackend } from "./companion-classical-backend";

/**
 * Companion model presets — tiny GGUFs suitable for the five
 * classifier/generator jobs. All sit in the ~600 MB to ~1.7 GB range,
 * targeting <100ms first-token on M-series. eliza-1 0.6B is the
 * branded default; Qwen3-Instruct variants are listed for users who
 * prefer instruction-tuned weights (better triage/persona accuracy
 * out of the box, no APOLLO step required).
 */
export type CompanionModelPreset = {
	id: string;
	label: string;
	modelRef: string;
	approxDiskMB: number;
	approxLiveRamGB: number;
	contextSize: number;
	license: "apache-2.0" | "other-attested";
	mode: "completion" | "chat";
	description: string;
};

export const COMPANION_MODEL_PRESETS: CompanionModelPreset[] = [
	{
		id: "qwen3-0_6b-q4",
		label: "Qwen3-0.6B Q4_K_M (recommended)",
		modelRef: "hf://unsloth/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf",
		approxDiskMB: 460,
		approxLiveRamGB: 2,
		contextSize: 16384,
		license: "apache-2.0",
		mode: "chat",
		description:
			"Clean upstream Qwen3-0.6B from unsloth. Same size class as eliza-1 0.6B but properly instruct-tuned, so triage / shouldRespond / personaPrePass land first try with no fine-tune needed.",
	},
	{
		id: "qwen3-1_7b-q4",
		label: "Qwen3-1.7B Q4_K_M",
		modelRef: "hf://unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf",
		approxDiskMB: 1100,
		approxLiveRamGB: 4,
		contextSize: 16384,
		license: "apache-2.0",
		mode: "chat",
		description:
			"Bigger Qwen3 sibling. Sharper triage + persona framing; trades ~2 GB more RAM. Worth it if you have headroom.",
	},
	{
		id: "eliza-1-0_6b",
		label: "eliza-1 0.6B (base, completion mode)",
		modelRef: "hf://elizaos/eliza-1/bundles/0_6b/text/eliza-1-0_6b-32k.gguf",
		approxDiskMB: 609,
		approxLiveRamGB: 3,
		contextSize: 16384,
		license: "other-attested",
		mode: "completion",
		description:
			"elizaOS branded 0.6B base weights. Not instruction-tuned in v1; rougher accuracy than Qwen3-Instruct until elizaOS ships APOLLO-trained variants.",
	},
];

/**
 * Default companion model. Qwen3-0.6B-Q4_K_M wins for chat-style jobs
 * (triage / shouldRespond / personaPrePass) because it's actually
 * instruction-tuned. eliza-1 0.6B is available as a preset for
 * branding/training-data alignment.
 */
export const DEFAULT_COMPANION_PRESET =
	COMPANION_MODEL_PRESETS.find((p) => p.id === "qwen3-0_6b-q4") ??
	COMPANION_MODEL_PRESETS[0]!;

const DEFAULT_COMPANION_MODEL = DEFAULT_COMPANION_PRESET.modelRef;

/** Per-job HTTP timeout. Long enough for cold-start; short enough that
 *  a stuck companion doesn't stall the agent loop. */
const JOB_TIMEOUT_MS = 8_000;

/** Default sampling temperature for the deterministic-ish classifier
 *  jobs. compress() / personaPrePass() override to 0.4 for slight variety. */
const DEFAULT_TEMPERATURE = 0.1;

export type CompanionJobName =
	| "triage"
	| "shouldRespond"
	| "memoryQuery"
	| "compress"
	| "personaPrePass";

/**
 * Per-job backend assignment. "classical" routes to the
 * embedding-based / heuristic / extractive path (fast, deterministic,
 * works without the LLM running). "llm" routes to the on-device
 * 0.6B–1.7B sidecar. "off" disables the job entirely.
 *
 * Defaults below favor classical for the 4 classifier/extraction
 * jobs and LLM for personaPrePass (the only truly generative job).
 * Users can override per-job in Settings → Local AI → Companion;
 * the matrix is hidden behind an "Advanced" disclosure so casual
 * users see one recommended preset.
 */
export type CompanionBackendChoice = "classical" | "llm" | "off";

export const DEFAULT_JOB_ASSIGNMENTS: Record<CompanionJobName, CompanionBackendChoice> = {
	triage: "classical",
	shouldRespond: "classical",
	memoryQuery: "classical",
	compress: "classical",
	personaPrePass: "llm",
};

export interface CompanionStatus extends LlamaServerStatus {
	readonly enabled: boolean;
	readonly modelRef: string;
	readonly contextSize: number;
	readonly ramFitsCompanion: boolean | null;
	readonly recentJobs: CompanionJobLog[];
	/** Active model preset id (from COMPANION_MODEL_PRESETS). */
	readonly preset: string | null;
	/** All known presets so the UI can render a picker. */
	readonly presets: CompanionModelPreset[];
	/**
	 * When true, the companion is reusing the local-chat server (same
	 * modelRef) instead of running its own llama-server. `pid` / `url` /
	 * `modelPath` in this status will reflect the chat server, not a
	 * dedicated companion process. UI should label this clearly.
	 */
	readonly sharedWithLocalChat: boolean;
	/** Per-job backend routing. UI surfaces as a matrix in "Advanced." */
	readonly assignments: Record<CompanionJobName, CompanionBackendChoice>;
	/** Health of each backend so the UI can show which dispatch paths are live. */
	readonly backends: {
		classical: { available: boolean; reason: string | null };
		llm: { available: boolean; reason: string | null };
	};
	/**
	 * APOLLO fine-tune readiness. When the bucket has accumulated
	 * ≥APOLLO_FINETUNE_THRESHOLD successful trajectories since the last
	 * fine-tune cycle, the UI shows a "ready to retrain" indicator
	 * pointing at docs/companion-apollo-finetune.md. Readiness is just
	 * a signal — fine-tuning is always user-initiated and runs
	 * cloud-side per the runbook.
	 */
	readonly fineTune: {
		readyToRetrain: boolean;
		successfulTrajectoriesSinceLastCycle: number;
		threshold: number;
		runbookPath: string;
	};
}

/**
 * Number of successful trajectories that must accumulate before the
 * companion's APOLLO fine-tune cycle is worth running. Below this the
 * SFT corpus overfits; above this the marginal turn adds noise. Mirror
 * of the threshold in docs/companion-apollo-finetune.md.
 */
export const APOLLO_FINETUNE_THRESHOLD = 500;

export interface CompanionJobLog {
	readonly job: CompanionJobName;
	readonly startedAt: number;
	readonly durationMs: number;
	readonly ok: boolean;
	readonly summary: string;
	/** Which backend handled this job. "skip" = job was disabled. */
	readonly backend: CompanionBackendChoice;
}

const MAX_RECENT_JOBS = 25;

function pickSetting(name: string): string | undefined {
	const v = process.env[name];
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function asBool(v: string | undefined): boolean {
	if (!v) return false;
	const n = v.toLowerCase();
	return ["1", "true", "yes", "on"].includes(n);
}

/**
 * Persistence hook. Called after every job to durably record what the
 * companion did, so the HF auto-dump pipeline can pick it up (the dump
 * walks memory tables; companion jobs land as `companion-job` typed
 * entries and flow into `data/memories/...` in the dataset). Hook is
 * optional — when unset (e.g. tests, early startup), jobs are kept
 * only in the in-memory ring buffer.
 */
type CompanionJobPersistHook = (entry: CompanionJobLog) => Promise<void>;

/**
 * Counter source for "how many successful trajectories accumulated
 * since the last APOLLO fine-tune cycle?" The companion doesn't track
 * trajectories itself; this is a thin readiness probe injected by
 * core/index.ts that consults the trajectory store. Returning null
 * means "couldn't check" — UI shows "—" rather than a false zero.
 */
type CompanionTrajectoryCountProbe = () => Promise<number | null>;

export class CompanionService {
	private llama: LlamaServerService | null = null;
	private modelRef: string = DEFAULT_COMPANION_MODEL;
	private presetId: string = DEFAULT_COMPANION_PRESET.id;
	private contextSize = 16384;
	private recentJobs: CompanionJobLog[] = [];
	private persistHook: CompanionJobPersistHook | null = null;
	private trajectoryCountProbe: CompanionTrajectoryCountProbe | null = null;
	private cachedTrajectoryCount: number | null = null;
	private cachedTrajectoryCountAt = 0;
	private static readonly TRAJECTORY_COUNT_CACHE_MS = 60_000;
	private assignments: Record<CompanionJobName, CompanionBackendChoice> = {
		...DEFAULT_JOB_ASSIGNMENTS,
	};
	private classical: CompanionBackend = new CompanionClassicalBackend();
	private llm: CompanionBackend;
	/**
	 * When set and the chat server is running the SAME modelRef the
	 * companion would otherwise spawn, the companion skips its own server
	 * and routes job calls to the chat server's port. Re-resolved on every
	 * `requireUrl()` call (not cached) so a chat-server stop degrades to
	 * classical-only on the next call without respawn races.
	 */
	private localChatRef: LocalChatService | null = null;
	private sharedWithLocalChat = false;
	private arbiter: MemoryArbiter | null = null;
	private lastArbiterRefusal: string | null = null;

	constructor() {
		this.llm = new CompanionLlmBackend(this);
	}

	attachLocalChat(ref: LocalChatService | null): void {
		this.localChatRef = ref;
	}

	attachArbiter(arbiter: MemoryArbiter | null): void {
		this.arbiter = arbiter;
	}

	getLastArbiterRefusal(): string | null {
		return this.lastArbiterRefusal;
	}

	/** Idempotent. Shared mode skips this path — never spawns or reserves. */
	private tearDownOwnedProcess(): void {
		if (!this.llama) return;
		try {
			this.llama.stop();
		} catch {
			/* best-effort */
		}
		this.llama = null;
		this.arbiter?.release("companion");
	}

	/**
	 * Internal accessor used by CompanionLlmBackend so it can reach the
	 * live llama-server URL + recordJob. Not exported on the public surface.
	 */
	_internals() {
		return {
			requireUrl: () => this.requireUrl(),
			recordJob: (entry: CompanionJobLog) => this.recordJob(entry),
		};
	}

	setTrajectoryCountProbe(probe: CompanionTrajectoryCountProbe | null): void {
		this.trajectoryCountProbe = probe;
	}

	/**
	 * Wire a persistence callback so each completed job lands in the
	 * memory store (and therefore in the HF auto-dump). Set once at
	 * boot; idempotent.
	 */
	setPersistHook(hook: CompanionJobPersistHook | null): void {
		this.persistHook = hook;
	}

	status(): CompanionStatus {
		// In shared mode the companion has no owned process — surface the
		// chat server's url/pid as the "live" handle so callers see *some*
		// running endpoint, but flag sharedWithLocalChat so the UI can
		// label it. If shared is requested but chat stopped, inner falls
		// through to "not running" which correctly reflects reality.
		const sharedInfo = this.sharedWithLocalChat
			? this.localChatRef?.getActiveServerInfo() ?? null
			: null;
		const inner = this.llama?.status() ?? (sharedInfo
			? {
				running: true,
				url: sharedInfo.url,
				modelPath: sharedInfo.modelRef,
				pid: null as number | null,
				startedAt: null as number | null,
				lastError: null as string | null,
			}
			: {
				running: false,
				url: null as string | null,
				modelPath: null as string | null,
				pid: null as number | null,
				startedAt: null as number | null,
				lastError: null as string | null,
			});
		const totalGB = totalmem() / 1024 ** 3;
		// 0.6B + KV cache + headroom ≈ 4 GB total budget recommended
		const ramFitsCompanion = Number.isFinite(totalGB)
			? totalGB >= 8
			: null;
		// Best-effort cached read of the trajectory count probe — never
		// blocks the status call, falls back to "—" in the UI when
		// stale or unavailable.
		const now = Date.now();
		if (
			this.trajectoryCountProbe &&
			now - this.cachedTrajectoryCountAt > CompanionService.TRAJECTORY_COUNT_CACHE_MS
		) {
			this.cachedTrajectoryCountAt = now;
			void this.trajectoryCountProbe()
				.then((n) => {
					this.cachedTrajectoryCount = n;
				})
				.catch(() => {
					this.cachedTrajectoryCount = null;
				});
		}
		const successfulTrajectoriesSinceLastCycle = this.cachedTrajectoryCount ?? 0;
		const readyToRetrain =
			successfulTrajectoriesSinceLastCycle >= APOLLO_FINETUNE_THRESHOLD;
		return {
			...inner,
			enabled: asBool(pickSetting("DETOUR_COMPANION_ENABLED")),
			modelRef: this.modelRef,
			contextSize: this.contextSize,
			ramFitsCompanion,
			recentJobs: [...this.recentJobs],
			preset: this.presetId,
			presets: COMPANION_MODEL_PRESETS,
			sharedWithLocalChat: this.sharedWithLocalChat && sharedInfo !== null,
			assignments: { ...this.assignments },
			backends: {
				classical: this.classical.availability(),
				llm: this.llm.availability(),
			},
			fineTune: {
				readyToRetrain,
				successfulTrajectoriesSinceLastCycle,
				threshold: APOLLO_FINETUNE_THRESHOLD,
				runbookPath: "docs/companion-apollo-finetune.md",
			},
		};
	}

	/**
	 * Swap per-job backend routing. Only `classical`, `llm`, and `off`
	 * are accepted; an unknown choice is silently coerced to the
	 * existing assignment so callers can't poison the table.
	 */
	setJobBackend(job: CompanionJobName, choice: CompanionBackendChoice): void {
		if (choice !== "classical" && choice !== "llm" && choice !== "off") {
			return;
		}
		this.assignments[job] = choice;
	}

	getJobBackend(job: CompanionJobName): CompanionBackendChoice {
		return this.assignments[job];
	}

	/**
	 * Reset all per-job assignments to the recommended defaults
	 * (classical for the 4 classifiers, llm for personaPrePass).
	 */
	resetAssignments(): void {
		this.assignments = { ...DEFAULT_JOB_ASSIGNMENTS };
	}

	currentPresetId(): string {
		return this.presetId;
	}

	currentModelRef(): string {
		return this.modelRef;
	}

	async start(
		config: {
			modelRef?: string;
			contextSize?: number;
			preset?: string;
		} = {},
	): Promise<{ url: string; modelPath: string } | null> {
		// Resolve preset → modelRef. Explicit modelRef wins; then explicit
		// preset id; then env override; then env-supplied raw ref; finally
		// the default preset. Caller can pass either form.
		let preset: CompanionModelPreset | null = null;
		if (config.preset) {
			preset =
				COMPANION_MODEL_PRESETS.find((p) => p.id === config.preset) ?? null;
		}
		const envPreset = pickSetting("DETOUR_COMPANION_PRESET");
		if (!preset && envPreset) {
			preset =
				COMPANION_MODEL_PRESETS.find((p) => p.id === envPreset) ?? null;
		}
		const modelRef =
			config.modelRef ??
			(preset ? preset.modelRef : undefined) ??
			pickSetting("DETOUR_COMPANION_MODEL_REF") ??
			DEFAULT_COMPANION_MODEL;
		// Reverse-lookup preset id from modelRef when one wasn't supplied
		// explicitly — this keeps the UI's preset dropdown in sync even
		// when the model was selected via raw ref.
		if (!preset) {
			preset =
				COMPANION_MODEL_PRESETS.find((p) => p.modelRef === modelRef) ??
				DEFAULT_COMPANION_PRESET;
		}
		const contextSize = config.contextSize ?? preset.contextSize ?? 16384;
		// Dedup: if chat is already running our modelRef, reuse its port.
		// Saves the duplicate ~3 GB live RAM. requireUrl() re-resolves on
		// every call so a chat-stop degrades to classical-only cleanly.
		// DETOUR_COMPANION_URL is intentionally NOT set here — that env
		// would persist past chat-stop and defeat the graceful fallback.
		const sharedFromChat = this.localChatRef?.getActiveServerInfo() ?? null;
		if (sharedFromChat && sharedFromChat.modelRef === modelRef) {
			this.tearDownOwnedProcess();
			this.modelRef = modelRef;
			this.presetId = preset.id;
			this.contextSize = contextSize;
			this.sharedWithLocalChat = true;
			this.lastArbiterRefusal = null;
			return { url: sharedFromChat.url, modelPath: modelRef };
		}
		// Re-entry with same modelRef: return the existing handle.
		if (this.llama && this.modelRef === modelRef && !this.sharedWithLocalChat) {
			const s = this.llama.status();
			if (s.running && s.url) {
				this.presetId = preset.id;
				this.contextSize = contextSize;
				return { url: s.url, modelPath: s.modelPath ?? "" };
			}
		}
		this.tearDownOwnedProcess();
		// Arbiter only gates the owned-process branch; shared mode above
		// allocates nothing and is exempt.
		if (this.arbiter) {
			const decision = this.arbiter.shouldAllowStart(
				"companion",
				preset.approxLiveRamGB,
			);
			if (!decision.ok) {
				this.lastArbiterRefusal = decision.reason ?? "memory budget exceeded";
				return null;
			}
		}
		this.lastArbiterRefusal = null;
		this.modelRef = modelRef;
		this.presetId = preset.id;
		this.contextSize = contextSize;
		this.sharedWithLocalChat = false;
		this.llama = new LlamaServerService({
			modelRef,
			embeddingOnly: false,
			contextSize,
			threads: 2,
			// CPU-only. Free up Metal working set for the embedding
			// server + local-chat. 0.6B Q4 stays under ~500ms on CPU,
			// and personaPrePass is the only LLM-routed job by default
			// (the other four go through the classical backend).
			gpuLayers: 0,
			// Separate pid-file so reapOrphan() never kills the
			// embedding or local-chat servers (all three would otherwise
			// share `${ELIZA_STATE_DIR}/llama/server.pid`).
			instanceId: "companion",
		});
		const result = await this.llama.ensureRunning();
		if (!result) return null;
		// Reserve only after a successful spawn — a failed start mustn't
		// leak a phantom reservation that blocks the next attempt.
		if (this.arbiter) {
			this.arbiter.reserve("companion", preset.approxLiveRamGB);
		}
		process.env.DETOUR_COMPANION_URL = result.url;
		return result;
	}

	stop(): void {
		// Shared mode: never stop the chat server (not ours to kill) and
		// never touch the arbiter (we never reserved). Owned process:
		// tearDownOwnedProcess handles both.
		this.tearDownOwnedProcess();
		this.sharedWithLocalChat = false;
		delete process.env.DETOUR_COMPANION_URL;
	}

	// ── job entry points ──────────────────────────────────────────────────
	//
	// Each method consults the per-job assignment, runs the chosen
	// backend, and — when that backend returns null (couldn't decide /
	// not running) — optionally falls back to the *other* backend if
	// it's healthy. The recentJobs log records which backend actually
	// served the call so the UI can show "classical: skip" vs
	// "llm: chat" side by side.

	async triage(userText: string): Promise<TriageLabel | null> {
		return this.dispatch("triage", (backend) => backend.triage(userText), {
			format: (label) => `→ ${label}`,
		});
	}

	async shouldRespond(
		agentName: string,
		channel: string,
		recentMessages: { author: string; text: string }[],
	): Promise<boolean | null> {
		return this.dispatch(
			"shouldRespond",
			(backend) => backend.shouldRespond(agentName, channel, recentMessages),
			{
				format: (decision) => `${channel} → ${decision ? "yes" : "no"}`,
			},
		);
	}

	async memoryQuery(userText: string): Promise<string[] | null> {
		return this.dispatch(
			"memoryQuery",
			(backend) => backend.memoryQuery(userText),
			{
				format: (queries) => `${queries.length} queries`,
			},
		);
	}

	async compress(history: string, targetTokens = 200): Promise<string | null> {
		return this.dispatch(
			"compress",
			(backend) => backend.compress(history, targetTokens),
			{
				format: (out) => `${history.length}c → ${out.length}c`,
			},
		);
	}

	async personaPrePass(
		agentName: string,
		userText: string,
	): Promise<string | null> {
		return this.dispatch(
			"personaPrePass",
			(backend) => backend.personaPrePass(agentName, userText),
			{
				format: (out) => out.slice(0, 100),
			},
		);
	}

	private async dispatch<T>(
		job: CompanionJobName,
		fn: (backend: CompanionBackend) => Promise<T | null>,
		opts: { format: (value: T) => string },
	): Promise<T | null> {
		const choice = this.assignments[job];
		const startedAt = Date.now();
		if (choice === "off") {
			this.recordJob({
				job,
				startedAt,
				durationMs: 0,
				ok: false,
				summary: "off (disabled)",
				backend: "off",
			});
			return null;
		}
		const primary = choice === "llm" ? this.llm : this.classical;
		const secondary = choice === "llm" ? this.classical : this.llm;
		const value = primary.availability().available ? await fn(primary) : null;
		if (value !== null && value !== undefined) {
			this.recordJob({
				job,
				startedAt,
				durationMs: Date.now() - startedAt,
				ok: true,
				summary: opts.format(value),
				backend: primary.kind,
			});
			return value;
		}
		// Soft fallback: if the chosen backend declined, try the other
		// one when it's healthy. Skipped for personaPrePass-from-classical
		// because the classical backend always returns null and falling
		// through is the desired behavior.
		if (secondary.availability().available) {
			const fallback = await fn(secondary);
			if (fallback !== null && fallback !== undefined) {
				this.recordJob({
					job,
					startedAt,
					durationMs: Date.now() - startedAt,
					ok: true,
					summary: `[fallback ${secondary.kind}] ${opts.format(fallback)}`,
					backend: secondary.kind,
				});
				return fallback;
			}
		}
		this.recordJob({
			job,
			startedAt,
			durationMs: Date.now() - startedAt,
			ok: false,
			summary: "no decision",
			backend: choice,
		});
		return null;
	}

	// ── internals ─────────────────────────────────────────────────────────

	private requireUrl(): string | null {
		// Resolution order: owned process → shared chat (if same modelRef)
		// → DETOUR_COMPANION_URL manual override. Re-resolved on every call
		// so a chat stop in shared mode drops cleanly to null next call,
		// letting the dispatcher fall back to classical without races.
		const own = this.llama?.status().url ?? null;
		if (own) return own;
		if (this.sharedWithLocalChat) {
			const shared = this.localChatRef?.getActiveServerInfo() ?? null;
			if (shared && shared.modelRef === this.modelRef) return shared.url;
		}
		return pickSetting("DETOUR_COMPANION_URL") ?? null;
	}

	private async callCompletion(
		url: string,
		prompt: string,
		options: { stop: string[]; maxTokens: number; temperature: number },
	): Promise<string | null> {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), JOB_TIMEOUT_MS);
		try {
			const body = {
				prompt,
				stop: options.stop,
				max_tokens: options.maxTokens,
				temperature: options.temperature,
				stream: false,
			};
			const res = await fetch(`${url}/v1/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: ctl.signal,
			});
			if (!res.ok) {
				logger.debug(
					{
						src: "companion",
						status: res.status,
						err: (await res.text()).slice(0, 200),
					},
					"companion HTTP non-OK",
				);
				return null;
			}
			const data = (await res.json()) as {
				choices?: Array<{ text?: string }>;
			};
			return data.choices?.[0]?.text ?? null;
		} catch (err) {
			logger.debug(
				{
					src: "companion",
					err: err instanceof Error ? err.message : String(err),
				},
				"companion call failed (swallowed — agent paths unaffected)",
			);
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	private recordJob(entry: CompanionJobLog): void {
		this.recentJobs.push(entry);
		if (this.recentJobs.length > MAX_RECENT_JOBS) {
			this.recentJobs.splice(0, this.recentJobs.length - MAX_RECENT_JOBS);
		}
		// Best-effort persistence to the memory store so the HF auto-dump
		// pipeline (which walks all memory tables) captures companion
		// activity. Persistence failures must never block the agent loop.
		if (this.persistHook) {
			void this.persistHook(entry).catch(() => {
				// swallow
			});
		}
	}

	/**
	 * Used by CompanionLlmBackend to share the existing /v1/completions
	 * call machinery. Kept as a method rather than re-implementing inside
	 * the backend so we don't double the fetch + timeout + logging code.
	 */
	async _callCompletion(
		url: string,
		prompt: string,
		options: { stop: string[]; maxTokens: number; temperature: number },
	): Promise<string | null> {
		return this.callCompletion(url, prompt, options);
	}
}

/**
 * CompanionLlmBackend — adapter that fronts the existing llama-server
 * sidecar with the CompanionBackend interface. It reuses the service's
 * prompt builders + parsers from `companion-jobs.ts` so the formatting
 * logic stays in one place.
 *
 * Availability is "URL reachable" — when the companion service hasn't
 * been started, the LLM backend declares itself unavailable and the
 * dispatcher routes through the classical fallback.
 */
class CompanionLlmBackend implements CompanionBackend {
	readonly kind = "llm" as const;

	constructor(private readonly service: CompanionService) {}

	availability(): CompanionBackendAvailability {
		const url =
			this.service._internals().requireUrl();
		if (!url) {
			return {
				available: false,
				reason: "companion llama-server not running",
			};
		}
		return { available: true, reason: null };
	}

	async triage(userText: string): Promise<TriageLabel | null> {
		const url = this.service._internals().requireUrl();
		if (!url) return null;
		const { input, stop, maxTokens } = triagePrompt(userText);
		const raw = await this.service._callCompletion(url, input, {
			stop,
			maxTokens,
			temperature: DEFAULT_TEMPERATURE,
		});
		if (raw === null) return null;
		return parseTriageOutput(raw);
	}

	async shouldRespond(
		agentName: string,
		channel: string,
		recentMessages: { author: string; text: string }[],
	): Promise<boolean | null> {
		const url = this.service._internals().requireUrl();
		if (!url) return null;
		const { input, stop, maxTokens } = shouldRespondPrompt(
			agentName,
			channel,
			recentMessages,
		);
		const raw = await this.service._callCompletion(url, input, {
			stop,
			maxTokens,
			temperature: DEFAULT_TEMPERATURE,
		});
		if (raw === null) return null;
		return parseShouldRespondOutput(raw);
	}

	async memoryQuery(userText: string): Promise<string[] | null> {
		const url = this.service._internals().requireUrl();
		if (!url) return null;
		const { input, stop, maxTokens } = memoryQueryPrompt(userText);
		const raw = await this.service._callCompletion(url, input, {
			stop,
			maxTokens,
			temperature: 0.3,
		});
		if (raw === null) return null;
		const queries = parseMemoryQueryOutput(raw);
		return queries.length > 0 ? queries : null;
	}

	async compress(history: string, targetTokens = 200): Promise<string | null> {
		const url = this.service._internals().requireUrl();
		if (!url) return null;
		const { input, stop, maxTokens } = compressPrompt(history, targetTokens);
		const raw = await this.service._callCompletion(url, input, {
			stop,
			maxTokens,
			temperature: 0.4,
		});
		if (raw === null) return null;
		const trimmed = raw.replace(/^\s+|\s+$/g, "");
		return trimmed || null;
	}

	async personaPrePass(
		agentName: string,
		userText: string,
	): Promise<string | null> {
		const url = this.service._internals().requireUrl();
		if (!url) return null;
		const { input, stop, maxTokens } = personaPrePassPrompt(
			agentName,
			userText,
		);
		const raw = await this.service._callCompletion(url, input, {
			stop,
			maxTokens,
			temperature: 0.4,
		});
		if (raw === null) return null;
		const trimmed = raw.replace(/^\s+|\s+$/g, "").split("\n")[0] ?? "";
		return trimmed || null;
	}
}
