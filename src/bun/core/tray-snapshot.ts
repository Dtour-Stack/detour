import type { ActivityService } from "./activity";
import type { ConfigService } from "./config-service";
import type { CompanionService } from "./llama/companion-service";
import type { LocalChatService } from "./llama/chat-service";
import type { MemoryArbiter } from "./llama/memory-arbiter";
import type { LlamaServerService, LlamaServerStatus } from "./llama/server-service";
import type { VaultService } from "./vault";

type LocalMlxState = {
	available: boolean;
	presets: unknown[];
};

interface TraySnapshotDeps {
	vault: VaultService;
	activity: ActivityService;
	config: ConfigService;
	llama: LlamaServerService;
	localChat: LocalChatService;
	companion: CompanionService;
	arbiter: MemoryArbiter;
}

function downloadProgressFields(progress: LlamaServerStatus["downloadProgress"]) {
	if (!progress) return {};
	return {
		downloadPercent: progress.percent,
		downloadedBytes: progress.downloadedBytes,
		totalBytes: progress.totalBytes,
	};
}

function isEnabled(name: string): boolean {
	const value = process.env[name]?.toLowerCase();
	return value === "true" || value === "1";
}

async function localMlxPresets(
	mlxRpc: typeof import("./mlx-rpc-client")["mlxRpc"],
	method: string,
): Promise<LocalMlxState> {
	try {
		const presets = (await mlxRpc.call<{ presets: unknown[] }>(method, {}, 2000, 0)).presets;
		return { available: true, presets };
	} catch {
		return { available: false, presets: [] };
	}
}

async function localMlxStates() {
	const { mlxRpc } = await import("./mlx-rpc-client");
	return {
		image: await localMlxPresets(mlxRpc, "mlx.image.presets"),
		stt: await localMlxPresets(mlxRpc, "mlx.stt.presets"),
		tts: await localMlxPresets(mlxRpc, "mlx.tts.presets"),
		vision: await localMlxPresets(mlxRpc, "mlx.vision.presets"),
		health: await localMlxHealth(mlxRpc),
	};
}

async function localMlxHealth(mlxRpc: typeof import("./mlx-rpc-client")["mlxRpc"]) {
	try {
		return await mlxRpc.call("mlx.health", {}, 2000, 0);
	} catch {
		return null;
	}
}

function localMlxWire(envName: string, presetName: string, state: LocalMlxState) {
	return {
		enabled: isEnabled(envName),
		available: state.available,
		preset: process.env[presetName] ?? null,
		presets: state.presets,
	};
}

function localAvailableProviders(states: Awaited<ReturnType<typeof localMlxStates>>): Set<string> {
	const ids: string[] = [];
	if (states.image.available) ids.push("local-mlx-image");
	if (states.stt.available) ids.push("local-mlx-stt");
	if (states.tts.available) ids.push("local-mlx-tts");
	if (states.vision.available) ids.push("local-mlx-vision");
	return new Set(ids);
}

function recentTrajectoryWire(
	trajectories: Array<{ id: string; source?: string; startTime?: number; status?: string }>,
) {
	return trajectories.slice(0, 5).map((trajectory) => ({
		id: trajectory.id,
		...(trajectory.source !== undefined ? { source: trajectory.source } : {}),
		...(trajectory.startTime !== undefined ? { startTime: trajectory.startTime } : {}),
		...(trajectory.status !== undefined ? { status: trajectory.status } : {}),
	}));
}

export async function createTraySnapshotBuilder({
	vault,
	activity,
	config,
	llama,
	localChat,
	companion,
	arbiter,
}: TraySnapshotDeps) {
	const { LOCAL_CHAT_PRESETS } = await import("./llama/chat-service");
	const { COMPANION_MODEL_PRESETS } = await import("./llama/companion-service");
	const { isModelDownloaded } = await import("./llama/server-service");

	const chatPresets = LOCAL_CHAT_PRESETS.map((preset) => ({
		id: preset.id,
		label: preset.label,
		approxLiveRamGB: preset.approxLiveRamGB,
		approxDiskGB: preset.approxDiskGB,
		downloaded: isModelDownloaded(preset.modelRef),
	}));
	const companionPresets = COMPANION_MODEL_PRESETS.map((preset) => ({
		id: preset.id,
		label: preset.label,
		approxLiveRamGB: preset.approxLiveRamGB,
		approxDiskGB: preset.approxDiskMB / 1024,
		downloaded: isModelDownloaded(preset.modelRef),
	}));

	return async () => {
		const llamaSnap = llama.status();
		const localChatSnap = localChat.status();
		const companionSnap = companion.status();
		const memorySnap = arbiter.inspect();
		const mlx = await localMlxStates();
		const providers = await vault.listProviders().catch(() => [] as Awaited<ReturnType<typeof vault.listProviders>>);
		const trajectoriesResult = await activity.trajectories.list({ limit: 5, offset: 0 })
			.catch(() => ({ trajectories: [] as Array<{ id: string; source?: string; startTime?: number; status?: string }> }));
		const prefs = await config.getTrayPrefs().catch(() => null);
		const cloudConfigured = new Set<string>(
			providers.filter((provider) => provider.hasKey || (provider.oauthAccountCount ?? 0) > 0).map((provider) => provider.id),
		);
		const localAvailable = localAvailableProviders(mlx);
		const { ROUTING_CATALOG, ROUTED_TYPE_LABELS, getProviderFor } = await import("./model-routing");

		return {
			activeProviderId: providers.find((provider) => provider.active)?.id ?? null,
			providers: providers.map((provider) => ({
				id: provider.id,
				label: provider.label,
				active: !!provider.active,
				configured: !!provider.hasKey || (provider.oauthAccountCount ?? 0) > 0,
			})),
			embed: {
				running: llamaSnap.running,
				...downloadProgressFields(llamaSnap.downloadProgress),
				lastError: llamaSnap.lastError,
			},
			localChat: {
				enabled: localChatSnap.enabled,
				running: localChatSnap.running,
				preset: localChatSnap.preset,
				...downloadProgressFields(localChatSnap.downloadProgress),
				lastArbiterRefusal: localChat.getLastArbiterRefusal(),
				presets: chatPresets,
			},
			companion: {
				enabled: companionSnap.enabled,
				running: companionSnap.running,
				preset: companionSnap.preset,
				sharedWithLocalChat: companionSnap.sharedWithLocalChat,
				...downloadProgressFields(companionSnap.downloadProgress),
				lastArbiterRefusal: companion.getLastArbiterRefusal(),
				presets: companionPresets,
			},
			memory: {
				totalGB: memorySnap.totalGB,
				headroomGB: memorySnap.headroomGB,
				budgetGB: memorySnap.budgetGB,
				usedGB: memorySnap.usedGB,
			},
			localMlxImage: localMlxWire("LOCAL_MLX_IMAGE_ENABLED", "LOCAL_MLX_IMAGE_PRESET", mlx.image),
			localMlxVideo: {
				enabled: false,
				available: false,
				preset: null,
				presets: [],
			},
			localMlxStt: localMlxWire("LOCAL_MLX_STT_ENABLED", "LOCAL_MLX_STT_PRESET", mlx.stt),
			localMlxTts: localMlxWire("LOCAL_MLX_TTS_ENABLED", "LOCAL_MLX_TTS_PRESET", mlx.tts),
			localMlxVision: localMlxWire("LOCAL_MLX_VISION_ENABLED", "LOCAL_MLX_VISION_PRESET", mlx.vision),
			mlxHealth: mlx.health,
			modelRouting: ROUTING_CATALOG.map((entry) => ({
				type: entry.type,
				label: ROUTED_TYPE_LABELS[entry.type],
				selected: getProviderFor(null, entry.type) ?? "",
				options: entry.options.map((option) => ({
					id: option.id,
					label: option.label,
					kind: option.kind,
					available: option.kind === "local"
						? localAvailable.has(option.id)
						: cloudConfigured.has(option.id),
				})),
			})),
			recentTrajectories: recentTrajectoryWire(trajectoriesResult.trajectories),
			traySlots: prefs?.slots ?? [],
		};
	};
}
