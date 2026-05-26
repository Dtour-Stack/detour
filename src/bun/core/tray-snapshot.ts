import type { ActivityService } from "./activity";
import type { ConfigService } from "./config-service";
import type { CompanionService } from "./llama/companion-service";
import type { LocalChatService } from "./llama/chat-service";
import type { MemoryArbiter } from "./llama/memory-arbiter";
import type { LlamaServerService, LlamaServerStatus } from "./llama/server-service";
import type { VaultService } from "./vault";

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
		const providers = await vault.listProviders().catch(() => [] as Awaited<ReturnType<typeof vault.listProviders>>);
		const trajectoriesResult = await activity.trajectories.list({ limit: 5, offset: 0 })
			.catch(() => ({ trajectories: [] as Array<{ id: string; source?: string; startTime?: number; status?: string }> }));
		const prefs = await config.getTrayPrefs().catch(() => null);
		const cloudConfigured = new Set<string>(
			providers.filter((provider) => provider.hasKey || (provider.oauthAccountCount ?? 0) > 0).map((provider) => provider.id),
		);
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
			modelRouting: ROUTING_CATALOG.map((entry) => ({
				type: entry.type,
				label: ROUTED_TYPE_LABELS[entry.type],
				selected: getProviderFor(null, entry.type) ?? "",
				options: entry.options.map((option) => ({
					id: option.id,
					label: option.label,
					kind: option.kind,
					available: option.kind === "local"
						? option.id === "local-chat" || option.id === "local-bge"
						: cloudConfigured.has(option.id),
				})),
			})),
			recentTrajectories: recentTrajectoryWire(trajectoriesResult.trajectories),
			traySlots: prefs?.slots ?? [],
		};
	};
}
