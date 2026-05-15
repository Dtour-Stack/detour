/**
 * Local llama-server status. Mirrors the wire shape of `GET /api/llama/status`
 * (returned by `LlamaServerService.status()`); see
 * src/bun/core/llama/server-service.ts.
 */
export type LlamaServerStatusWire = {
	readonly running: boolean;
	readonly url: string | null;
	readonly modelPath: string | null;
	readonly pid: number | null;
	readonly startedAt: number | null;
	readonly lastError: string | null;
	readonly downloadProgress?: {
		downloadedBytes: number;
		totalBytes: number;
		percent: number;
	} | null;
};

/**
 * Local chat-server status. Same shape as the embedding-server status
 * plus a few chat-specific fields: the active preset id, the user's
 * enable toggle, and whether the machine has enough RAM for the
 * selected preset.
 */
export type LocalChatStatusWire = LlamaServerStatusWire & {
	readonly enabled: boolean;
	readonly preset: string | null;
	readonly ramFitsModel: boolean | null;
};

export type LocalChatPresetWire = {
	readonly id: string;
	readonly label: string;
	readonly modelRef: string;
	readonly approxDiskGB: number;
	readonly approxLiveRamGB: number;
	readonly contextSize: number;
	readonly license: string;
	readonly description: string;
};

/**
 * Companion (small sidecar) status. The 0.6B helper that does triage,
 * shouldRespond, memoryQuery, compress, personaPrePass. Same lifecycle
 * shape as local-chat plus a recent-jobs ring buffer for the UI.
 */
export type CompanionJobName =
	| "triage"
	| "shouldRespond"
	| "memoryQuery"
	| "compress"
	| "personaPrePass";

export type CompanionBackendChoiceWire = "classical" | "llm" | "off";

export type CompanionJobLogWire = {
	readonly job: CompanionJobName | string;
	readonly startedAt: number;
	readonly durationMs: number;
	readonly ok: boolean;
	readonly summary: string;
	readonly backend: CompanionBackendChoiceWire;
};

export type CompanionModelPresetWire = {
	readonly id: string;
	readonly label: string;
	readonly modelRef: string;
	readonly approxDiskMB: number;
	readonly approxLiveRamGB: number;
	readonly contextSize: number;
	readonly license: string;
	readonly mode: "completion" | "chat";
	readonly description: string;
};

export type CompanionBackendHealthWire = {
	readonly available: boolean;
	readonly reason: string | null;
};

export type CompanionStatusWire = LlamaServerStatusWire & {
	readonly enabled: boolean;
	readonly modelRef: string;
	readonly contextSize: number;
	readonly ramFitsCompanion: boolean | null;
	readonly recentJobs: CompanionJobLogWire[];
	readonly preset: string | null;
	readonly presets: CompanionModelPresetWire[];
	readonly assignments: Record<CompanionJobName, CompanionBackendChoiceWire>;
	readonly backends: {
		classical: CompanionBackendHealthWire;
		llm: CompanionBackendHealthWire;
	};
	readonly fineTune: {
		readyToRetrain: boolean;
		successfulTrajectoriesSinceLastCycle: number;
		threshold: number;
		runbookPath: string;
	};
};

export type LlamaRequests = {
	llamaStatus: {
		params: Record<string, never>;
		response: LlamaServerStatusWire;
	};
	localChatStatus: {
		params: Record<string, never>;
		response: LocalChatStatusWire & { presets: LocalChatPresetWire[] };
	};
	localChatStart: {
		params: {
			preset?: string;
			customModelRef?: string;
			contextSize?: number;
		};
		response: LocalChatStatusWire;
	};
	localChatStop: {
		params: Record<string, never>;
		response: LocalChatStatusWire;
	};
	localChatSetPrimary: {
		params: { primary: boolean };
		response: { primary: boolean };
	};
	companionStatus: {
		params: Record<string, never>;
		response: CompanionStatusWire;
	};
	companionStart: {
		params: { modelRef?: string; contextSize?: number; preset?: string };
		response: CompanionStatusWire;
	};
	companionStop: {
		params: Record<string, never>;
		response: CompanionStatusWire;
	};
	/**
	 * Update the per-job backend assignment matrix. Send only the
	 * jobs whose assignment is changing; omitted keys are left alone.
	 * Returns the refreshed status so the caller can re-render.
	 */
	companionSetAssignments: {
		params: {
			assignments: Partial<Record<CompanionJobName, CompanionBackendChoiceWire>>;
		};
		response: CompanionStatusWire;
	};
	/** Reset every job back to the recommended defaults. */
	companionResetAssignments: {
		params: Record<string, never>;
		response: CompanionStatusWire;
	};
};
