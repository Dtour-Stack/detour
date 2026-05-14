import type {
	AgentCharacterConfig,
	AgentConfig,
	AgentDataDumpCounts,
	AgentHfSyncPolicy,
	AgentHfSyncReason,
	AgentHfSyncState,
	ModelConfig,
	UiPreferences,
	WindowConfig,
} from "../index";

export type AgentHfDumpJobStatus = "running" | "succeeded" | "failed";

export type AgentHfDumpJob = {
	id: string;
	destination: string;
	command: string;
	reason: AgentHfSyncReason;
	status: AgentHfDumpJobStatus;
	startedAt: string;
	finishedAt: string | null;
	counts: AgentDataDumpCounts | null;
	stdout: string | null;
	stderr: string | null;
	error: string | null;
};

export type AgentHfDumpStatus = {
	defaultDestination: string;
	hfAvailable: boolean;
	activeJob: AgentHfDumpJob | null;
	policy: AgentHfSyncPolicy;
	state: AgentHfSyncState;
};

/**
 * App configuration RPC: agent permissions, character, models, window,
 * and UI preferences (theme + accent). Wire shapes match the legacy HTTP
 * routes 1:1 — bodies are the full config object, GETs return the full
 * config, setters return `{ ok: true }`.
 */
export type ConfigRequests = {
	configGetAgent: {
		params: Record<string, never>;
		response: AgentConfig;
	};
	configSetAgent: {
		params: AgentConfig;
		response: { ok: true };
	};
	configGetCharacter: {
		params: Record<string, never>;
		response: AgentCharacterConfig;
	};
	configSetCharacter: {
		params: AgentCharacterConfig;
		response: { ok: true };
	};
	configGetModels: {
		params: Record<string, never>;
		response: ModelConfig;
	};
	configSetModels: {
		params: ModelConfig;
		response: { ok: true };
	};
	configGetWindow: {
		params: Record<string, never>;
		response: WindowConfig;
	};
	configSetWindow: {
		params: WindowConfig;
		response: { ok: true };
	};
	uiGetPreferences: {
		params: Record<string, never>;
		response: UiPreferences;
	};
	uiSetPreferences: {
		params: Partial<UiPreferences>;
		response: { ok: true };
	};
	agentHfDumpStatus: {
		params: Record<string, never>;
		response: AgentHfDumpStatus;
	};
	agentHfDumpStartSync: {
		params: { destination?: string; limit?: number };
		response: AgentHfDumpJob;
	};
	agentHfDumpGetJob: {
		params: { id: string };
		response: AgentHfDumpJob | null;
	};
	agentHfDumpSetPolicy: {
		params: AgentHfSyncPolicy;
		response: AgentHfSyncPolicy;
	};
};

export type ConfigMessages = {
	// Replaces ws `ui:preferences-changed`. Broadcast whenever any window
	// saves new theme/accent so other open windows (Pensieve, Activity,
	// Channels, chat popup) re-apply live without a reload.
	uiPreferencesChanged: { preferences: UiPreferences };
};
