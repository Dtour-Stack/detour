import type {
	CompanionBackendChoiceWire,
	CompanionJobName,
	CompanionStatusWire,
	LlamaMemoryBudgetWire,
	LlamaServerStatusWire,
	LocalChatPresetWire,
	LocalChatStatusWire,
} from "../../../../shared/rpc/llama";
import { LOCAL_CHAT_PRESETS } from "../../llama/chat-service";
import type { RpcDeps } from "../types";

const VALID_BACKEND_CHOICES = new Set<CompanionBackendChoiceWire>([
	"classical",
	"llm",
	"off",
]);

const VALID_JOB_NAMES = new Set<CompanionJobName>([
	"triage",
	"shouldRespond",
	"memoryQuery",
	"compress",
	"personaPrePass",
]);

/**
 * Local llama-server status (embeddings) + local-chat lifecycle.
 *
 * Embeddings: pure read of LlamaServerService.status().
 * Chat: start/stop a second llama-server instance backed by LocalChatService.
 *   Status carries the preset id, enable flag, and a RAM-fit hint so the UI
 *   can warn before booting a preset that won't fit.
 *   localChatSetPrimary toggles DETOUR_LOCAL_CHAT_PRIMARY which flips the
 *   plugin's priority (5 → 200) so local outranks cloud providers when on.
 */
export function llamaRequests(deps: RpcDeps) {
	const toStatusWire = (s: ReturnType<typeof deps.localChat.status>): LocalChatStatusWire => ({
		running: s.running,
		url: s.url,
		modelPath: s.modelPath,
		pid: s.pid,
		startedAt: s.startedAt,
		lastError: s.lastError,
		...(s.downloadProgress !== undefined
			? { downloadProgress: s.downloadProgress }
			: {}),
		enabled: s.enabled,
		preset: s.preset,
		ramFitsModel: s.ramFitsModel,
		lastArbiterRefusal: deps.localChat.getLastArbiterRefusal(),
	});
	const presets: LocalChatPresetWire[] = LOCAL_CHAT_PRESETS.map((p) => ({
		id: p.id,
		label: p.label,
		modelRef: p.modelRef,
		approxDiskGB: p.approxDiskGB,
		approxLiveRamGB: p.approxLiveRamGB,
		contextSize: p.contextSize,
		license: p.license,
		description: p.description,
	}));
	return {
		llamaStatus: async (
			_params: Record<string, never>,
		): Promise<LlamaServerStatusWire> => {
			return deps.llama.status();
		},
		localChatStatus: async (
			_params: Record<string, never>,
		): Promise<LocalChatStatusWire & { presets: LocalChatPresetWire[] }> => {
			return { ...toStatusWire(deps.localChat.status()), presets };
		},
		localChatStart: async (params: {
			preset?: string;
			customModelRef?: string;
			contextSize?: number;
		}): Promise<LocalChatStatusWire> => {
			process.env.DETOUR_LOCAL_CHAT_ENABLED = "true";
			const config: {
				preset?: string;
				customModelRef?: string;
				contextSize?: number;
			} = {};
			if (typeof params.preset === "string" && params.preset.length > 0)
				config.preset = params.preset;
			if (
				typeof params.customModelRef === "string" &&
				params.customModelRef.length > 0
			)
				config.customModelRef = params.customModelRef;
			if (typeof params.contextSize === "number" && params.contextSize > 0)
				config.contextSize = params.contextSize;
			await deps.localChat.start(config);
			return toStatusWire(deps.localChat.status());
		},
		localChatStop: async (
			_params: Record<string, never>,
		): Promise<LocalChatStatusWire> => {
			deps.localChat.stop();
			delete process.env.DETOUR_LOCAL_CHAT_ENABLED;
			return toStatusWire(deps.localChat.status());
		},
		localChatSetPrimary: async (params: {
			primary: boolean;
		}): Promise<{ primary: boolean }> => {
			if (params.primary) {
				process.env.DETOUR_LOCAL_CHAT_PRIMARY = "true";
			} else {
				delete process.env.DETOUR_LOCAL_CHAT_PRIMARY;
			}
			return { primary: params.primary };
		},
		companionStatus: async (
			_params: Record<string, never>,
		): Promise<CompanionStatusWire> => {
			return toCompanionStatusWire(deps.companion.status(), deps);
		},
		companionStart: async (params: {
			modelRef?: string;
			contextSize?: number;
			preset?: string;
		}): Promise<CompanionStatusWire> => {
			process.env.DETOUR_COMPANION_ENABLED = "true";
			const config: {
				modelRef?: string;
				contextSize?: number;
				preset?: string;
			} = {};
			if (typeof params.modelRef === "string" && params.modelRef.length > 0)
				config.modelRef = params.modelRef;
			if (typeof params.contextSize === "number" && params.contextSize > 0)
				config.contextSize = params.contextSize;
			if (typeof params.preset === "string" && params.preset.length > 0)
				config.preset = params.preset;
			await deps.companion.start(config);
			return toCompanionStatusWire(deps.companion.status(), deps);
		},
		companionStop: async (
			_params: Record<string, never>,
		): Promise<CompanionStatusWire> => {
			deps.companion.stop();
			delete process.env.DETOUR_COMPANION_ENABLED;
			return toCompanionStatusWire(deps.companion.status(), deps);
		},
		companionSetAssignments: async (params: {
			assignments: Partial<
				Record<CompanionJobName, CompanionBackendChoiceWire>
			>;
		}): Promise<CompanionStatusWire> => {
			const raw = params.assignments ?? {};
			for (const [job, choice] of Object.entries(raw)) {
				if (!VALID_JOB_NAMES.has(job as CompanionJobName)) continue;
				if (!choice || !VALID_BACKEND_CHOICES.has(choice)) continue;
				deps.companion.setJobBackend(job as CompanionJobName, choice);
			}
			return toCompanionStatusWire(deps.companion.status(), deps);
		},
		companionResetAssignments: async (
			_params: Record<string, never>,
		): Promise<CompanionStatusWire> => {
			deps.companion.resetAssignments();
			return toCompanionStatusWire(deps.companion.status(), deps);
		},
		llamaMemoryBudget: async (
			_params: Record<string, never>,
		): Promise<LlamaMemoryBudgetWire> => {
			return deps.memoryArbiter.inspect();
		},
	};
}

function toCompanionStatusWire(
	s: ReturnType<RpcDeps["companion"]["status"]>,
	deps: RpcDeps,
): CompanionStatusWire {
	return {
		running: s.running,
		url: s.url,
		modelPath: s.modelPath,
		pid: s.pid,
		startedAt: s.startedAt,
		lastError: s.lastError,
		...(s.downloadProgress !== undefined
			? { downloadProgress: s.downloadProgress }
			: {}),
		enabled: s.enabled,
		modelRef: s.modelRef,
		contextSize: s.contextSize,
		ramFitsCompanion: s.ramFitsCompanion,
		recentJobs: s.recentJobs.map((j) => ({
			job: j.job,
			startedAt: j.startedAt,
			durationMs: j.durationMs,
			ok: j.ok,
			summary: j.summary,
			backend: j.backend,
		})),
		preset: s.preset,
		presets: s.presets.map((p) => ({
			id: p.id,
			label: p.label,
			modelRef: p.modelRef,
			approxDiskMB: p.approxDiskMB,
			approxLiveRamGB: p.approxLiveRamGB,
			contextSize: p.contextSize,
			license: p.license,
			mode: p.mode,
			description: p.description,
		})),
		sharedWithLocalChat: s.sharedWithLocalChat,
		lastArbiterRefusal: deps.companion.getLastArbiterRefusal(),
		assignments: s.assignments,
		backends: s.backends,
		fineTune: s.fineTune,
	};
}
