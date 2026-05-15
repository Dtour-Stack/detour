/**
 * LocalChatService — a second llama-server instance dedicated to chat
 * completions. Embeddings run on their own LlamaServerService (small
 * model, 512 ctx); this service runs a larger chat model (Qwen3 family
 * by default) on a separate port so the two never contend for the same
 * model handle.
 *
 * Lifecycle:
 *   - Disabled by default. The user enables it from Settings → Local AI
 *     ("Enable local chat") which sets DETOUR_LOCAL_CHAT_ENABLED=true and
 *     triggers .ensureRunning(). On disable, .stop() reaps the subprocess.
 *   - Auto-downloads the model to ~/.detour/llama/models/<file>.gguf on
 *     first start (same path as the embedding model — they share a dir).
 *   - The local-chat plugin reads DETOUR_LOCAL_CHAT_URL after start so
 *     its TEXT_SMALL/MEDIUM/LARGE handlers POST to the right port.
 *
 * Defaults to Qwen3-4B-Instruct Q4_K_M because that's the smallest Qwen3
 * that produces useful conversational replies (1.7B exists but quality
 * is rough) AND fits comfortably on a 16 GB machine alongside Detour
 * itself (3 GB on disk, ~7 GB live with 8K ctx).
 *
 * Hardware-aware: --threads = max(2, cpus()-2), --ctx-size from setting
 * with a 32K cap so a single bad config doesn't blow RAM, Metal accel
 * via --n-gpu-layers 99 on macOS.
 */

import { cpus, totalmem } from "node:os";
import { LlamaServerService, type LlamaServerStatus } from "./server-service";
import type { MemoryArbiter } from "./memory-arbiter";

/**
 * Quick-pick presets that the UI surfaces. Keep these conservative for
 * RAM: a user with 16 GB shouldn't be able to pick a 27B-Q4 model and
 * silently swap to disk.
 */
export interface LocalChatModelPreset {
	id: string;
	label: string;
	modelRef: string;
	approxDiskGB: number;
	approxLiveRamGB: number;
	contextSize: number;
	license: "apache-2.0" | "llama" | "other-attested" | "other-unattested";
	description: string;
	/**
	 * "chat" — instruct-tuned model; route to /v1/chat/completions.
	 * "completion" — base/raw model; route to /v1/completions with a
	 *   simple Q:/A: scaffold so the weights have something to continue.
	 *   Use for eliza-1 v1 bundles (and any other base model) so they
	 *   actually emit text instead of returning empty content. This
	 *   keeps the trajectory pipeline producing useful (prompt, output)
	 *   pairs even for un-fine-tuned weights — exactly what APOLLO-style
	 *   training corpora need.
	 *
	 * Defaults to "chat" when omitted.
	 */
	mode?: "chat" | "completion";
}

// Presets are sorted smallest-to-largest by live RAM so the picker
// shows them in a sensible order. Detour downloads each from Hugging
// Face on first use — no clones, no vendor builds, no external runtimes.
//
// Two families:
//
//   • Qwen3-Instruct (via unsloth) — Apache-2.0, properly chat-tuned.
//     These are the WORKING chat models today: ship a TOON document,
//     follow instructions, answer questions in one or two sentences
//     when asked. Default + recommended.
//
//   • elizaos/eliza-1 — official elizaOS bundles. Per their own README:
//     "raw/base Qwen-lineage GGUF weights ... they are not fine-tuned.
//      APOLLO is the required optimizer for later fine-tuned releases."
//     So eliza-1 v1 is BASE weights. A base model fed a chat-template
//     prompt produces empty or rambling output (the chat template asks
//     for assistant-role responses the base model was never trained to
//     emit). Kept in the picker so the user can experiment AND so the
//     entries are ready when elizaOS ships an APOLLO-trained variant.
//
// The 27B tier is intentionally not listed — at 36 GB live RAM it's
// unrunnable on the typical 16-24 GB machine. Advanced users with
// 40+ GB can still pass a `customModelRef` to LocalChatService.start
// pointing at `hf://elizaos/eliza-1/bundles/27b/text/eliza-1-27b-128k.gguf`.
export const LOCAL_CHAT_PRESETS: LocalChatModelPreset[] = [
	{
		id: "eliza-1-0_6b-32k",
		label: "eliza-1 0.6B (base, completion mode)",
		modelRef: "hf://elizaos/eliza-1/bundles/0_6b/text/eliza-1-0_6b-32k.gguf",
		approxDiskGB: 0.6,
		approxLiveRamGB: 3,
		contextSize: 16384,
		license: "other-attested",
		mode: "completion",
		description:
			"eliza-1 0.6B raw weights, routed through /v1/completions with a Q:/A: scaffold. Use it to chat AND capture trajectories that feed APOLLO-style training back to elizaOS.",
	},
	{
		id: "eliza-1-1_7b-32k",
		label: "eliza-1 1.7B (base, completion mode)",
		modelRef: "hf://elizaos/eliza-1/bundles/1_7b/text/eliza-1-1_7b-32k.gguf",
		approxDiskGB: 1.7,
		approxLiveRamGB: 5,
		contextSize: 16384,
		license: "other-attested",
		mode: "completion",
		description:
			"eliza-1 1.7B base — Q:/A: completion scaffold; trajectories feed elizaOS training.",
	},
	{
		id: "qwen3-4b-instruct-q4",
		label: "Qwen3-4B-Instruct Q4_K_M (recommended)",
		modelRef:
			"hf://unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
		approxDiskGB: 2.5,
		approxLiveRamGB: 6,
		contextSize: 8192,
		license: "apache-2.0",
		description:
			"Recommended chat default. Properly instruct-tuned, follows prompts, answers questions. Apache-2.0 from upstream Qwen via unsloth.",
	},
	{
		id: "eliza-1-4b-64k",
		label: "eliza-1 4B (base, completion mode)",
		modelRef: "hf://elizaos/eliza-1/bundles/4b/text/eliza-1-4b-64k.gguf",
		approxDiskGB: 2.8,
		approxLiveRamGB: 8,
		contextSize: 32768,
		license: "other-attested",
		mode: "completion",
		description:
			"eliza-1 4B base — Q:/A: completion scaffold. Sweet spot for 16 GB Macs. Chat with it AND capture trajectories that feed elizaOS's training pipeline.",
	},
	{
		id: "qwen3-8b-q4",
		label: "Qwen3-8B Q4_K_M",
		modelRef: "hf://unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf",
		approxDiskGB: 5,
		approxLiveRamGB: 11,
		contextSize: 8192,
		license: "apache-2.0",
		description:
			"Smarter than 4B; needs 16+ GB to coexist with Detour comfortably.",
	},
	{
		id: "eliza-1-9b-64k",
		label: "eliza-1 9B (base, completion mode)",
		modelRef: "hf://elizaos/eliza-1/bundles/9b/text/eliza-1-9b-64k.gguf",
		approxDiskGB: 5.4,
		approxLiveRamGB: 14,
		contextSize: 32768,
		license: "other-attested",
		mode: "completion",
		description:
			"eliza-1 9B base — Q:/A: completion scaffold. Largest eliza tier that fits on a 24 GB Mac.",
	},
	{
		id: "qwen3-14b-q4",
		label: "Qwen3-14B Q4_K_M",
		modelRef: "hf://unsloth/Qwen3-14B-GGUF/Qwen3-14B-Q4_K_M.gguf",
		approxDiskGB: 8.5,
		approxLiveRamGB: 18,
		contextSize: 8192,
		license: "apache-2.0",
		description:
			"Best Qwen3 chat at reasonable RAM; needs 24+ GB unified memory.",
	},
];

/**
 * Default preset = Qwen3-4B-Instruct (recommended chat). The eliza-1
 * presets are listed in the picker so they're ready when elizaOS ships
 * fine-tuned variants, but auto-pick goes to Qwen3-Instruct because
 * it's the ONLY size-class entry that reliably follows chat
 * instructions today. Users who pick an eliza-1 base preset see the
 * "base — preview" tag in the UI and know what they're getting.
 */
export const DEFAULT_LOCAL_CHAT_PRESET =
	LOCAL_CHAT_PRESETS.find((p) => p.id === "qwen3-4b-instruct-q4") ??
	LOCAL_CHAT_PRESETS[0]!;

export interface LocalChatStatus extends LlamaServerStatus {
	readonly enabled: boolean;
	readonly preset: string | null;
	readonly ramFitsModel: boolean | null;
}

export interface LocalChatConfig {
	enabled?: boolean;
	preset?: string;
	customModelRef?: string;
	contextSize?: number;
}

function pickSetting(name: string): string | undefined {
	const v = process.env[name];
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function asBoolean(value: string | undefined, dflt: boolean): boolean {
	if (value === undefined) return dflt;
	const n = value.toLowerCase();
	if (["1", "true", "yes", "on"].includes(n)) return true;
	if (["0", "false", "no", "off"].includes(n)) return false;
	return dflt;
}

function resolvePresetByIdOrRef(idOrRef: string): LocalChatModelPreset | null {
	if (!idOrRef) return null;
	const byId = LOCAL_CHAT_PRESETS.find((p) => p.id === idOrRef);
	if (byId) return byId;
	const byRef = LOCAL_CHAT_PRESETS.find((p) => p.modelRef === idOrRef);
	if (byRef) return byRef;
	return null;
}

/**
 * Returns true when the machine has enough RAM for the preset's
 * estimated live working set, with a 4 GB headroom for Detour itself
 * + the OS. False = will likely swap. Null when totalmem reports 0.
 */
export function machineFitsPreset(preset: LocalChatModelPreset): boolean | null {
	const totalBytes = totalmem();
	if (!totalBytes) return null;
	const totalGB = totalBytes / 1024 ** 3;
	const headroom = 4;
	return totalGB >= preset.approxLiveRamGB + headroom;
}

/** Companion's dedup check compares against `modelRef` for equality. */
export interface LocalChatActiveServerInfo {
	readonly url: string;
	readonly modelRef: string;
	readonly presetId: string;
}

export class LocalChatService {
	private llama: LlamaServerService | null = null;
	private currentPresetId: string | null = null;
	private currentModelRef: string | null = null;
	private arbiter: MemoryArbiter | null = null;

	attachArbiter(arbiter: MemoryArbiter | null): void {
		this.arbiter = arbiter;
	}

	getActiveServerInfo(): LocalChatActiveServerInfo | null {
		if (!this.llama) return null;
		const status = this.llama.status();
		if (!status.running || !status.url) return null;
		if (!this.currentModelRef || !this.currentPresetId) return null;
		return {
			url: status.url,
			modelRef: this.currentModelRef,
			presetId: this.currentPresetId,
		};
	}

	status(): LocalChatStatus {
		const inner = this.llama?.status() ?? {
			running: false,
			url: null,
			modelPath: null,
			pid: null,
			startedAt: null,
			lastError: null,
		};
		const presetId = this.currentPresetId;
		const preset = presetId ? resolvePresetByIdOrRef(presetId) : null;
		return {
			...inner,
			enabled: asBoolean(pickSetting("DETOUR_LOCAL_CHAT_ENABLED"), false),
			preset: presetId,
			ramFitsModel: preset ? machineFitsPreset(preset) : null,
		};
	}

	/**
	 * Spin up the chat instance. Returns { url, modelPath } or null on
	 * failure. Idempotent — calling twice while running returns the
	 * existing instance.
	 */
	async start(config: LocalChatConfig = {}): Promise<{ url: string; modelPath: string } | null> {
		// Reuse running instance if config didn't change.
		const presetId = config.preset
			?? pickSetting("DETOUR_LOCAL_CHAT_PRESET")
			?? DEFAULT_LOCAL_CHAT_PRESET.id;
		if (this.llama && this.currentPresetId === presetId) {
			const status = this.llama.status();
			if (status.running && status.url) {
				return { url: status.url, modelPath: status.modelPath ?? "" };
			}
		}
		// Tear down any prior instance — different preset means different
		// model file, must restart. Skip arbiter release here: a fresh
		// successful reservation comes right below, and tearDown clears it.
		this.tearDown();
		const preset = resolvePresetByIdOrRef(presetId) ?? DEFAULT_LOCAL_CHAT_PRESET;
		const modelRef = config.customModelRef ?? preset.modelRef;
		const ctx = config.contextSize ?? preset.contextSize;
		const threads = Math.max(2, cpus().length - 2);
		// Gate BEFORE allocating; refusal surfaces via getLastArbiterRefusal.
		if (this.arbiter) {
			const decision = this.arbiter.shouldAllowStart("chat", preset.approxLiveRamGB);
			if (!decision.ok) {
				this.lastArbiterRefusal = decision.reason ?? "memory budget exceeded";
				return null;
			}
		}
		this.lastArbiterRefusal = null;
		this.currentPresetId = preset.id;
		this.currentModelRef = modelRef;
		this.llama = new LlamaServerService({
			modelRef,
			embeddingOnly: false,
			contextSize: ctx,
			threads,
			// Separate pid-file so starting/restarting local-chat never
			// reaps the embedding server or the companion (all three
			// would otherwise share the legacy "server.pid").
			instanceId: "chat",
		});
		const result = await this.llama.ensureRunning();
		if (!result) return null;
		// Reserve only after success so a failed spawn doesn't leak a slot.
		this.arbiter?.reserve("chat", preset.approxLiveRamGB);
		process.env.DETOUR_LOCAL_CHAT_URL = result.url;
		process.env.DETOUR_LOCAL_CHAT_MODEL = preset.id;
		// `mode` selects /v1/chat/completions vs /v1/completions+Q:A wrap.
		process.env.DETOUR_LOCAL_CHAT_MODE = preset.mode ?? "chat";
		return result;
	}

	stop(): void {
		this.tearDown();
	}

	/**
	 * Idempotent. Drops handle + preset state, releases arbiter slot,
	 * clears the env vars the local-chat plugin reads.
	 */
	private tearDown(): void {
		if (!this.llama) return;
		try {
			this.llama.stop();
		} catch {
			/* best-effort */
		}
		this.llama = null;
		this.currentPresetId = null;
		this.currentModelRef = null;
		this.arbiter?.release("chat");
		delete process.env.DETOUR_LOCAL_CHAT_URL;
		delete process.env.DETOUR_LOCAL_CHAT_MODEL;
		delete process.env.DETOUR_LOCAL_CHAT_MODE;
	}

	private lastArbiterRefusal: string | null = null;
	getLastArbiterRefusal(): string | null {
		return this.lastArbiterRefusal;
	}
}
