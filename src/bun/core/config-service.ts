/**
 * App-level config persistence. Stores everything under `config.*` vault keys
 * (non-sensitive) and pushes snapshots into the plugins that consume them
 * (plugin-vault-tools' permission gate; plugin-codex-chatgpt's model picker
 * via env vars set at apply-time).
 *
 * Bootstrap on startup loads stored config and pushes it to the plugins so
 * the agent's permission state survives restarts without env vars.
 */

import {
	AGENT_HF_SYNC_DEFAULT_DESTINATION,
	type AgentCharacterConfig,
	type AgentCharacterMessageExample,
	type AgentConfig,
	type AgentHfSyncPolicy,
	type AgentHfSyncReason,
	type AgentHfSyncState,
	type ChroniclerConfig,
	type ModelConfig,
	type WindowConfig,
} from "../../shared/index";
import { setPermissionConfig, type AgentVaultMode } from "../plugins/vault-tools/index";
import type { VaultService } from "./vault";
import { DEFAULT_AGENT_CHARACTER } from "./agent-character";

const DEFAULT_AGENT: AgentConfig = {
	deny: false,
	mode: "read",
	allowedPrefixes: [],
	deniedPrefixes: [],
	browserUse: true,
	computerUse: false,
	elevatedCoding: false,
};

const DEFAULT_MODELS: ModelConfig = {
	codexLarge: "gpt-5.2",
	codexSmall: "gpt-5.2",
	codexImage: "gpt-5.2",
	openRouterTextLarge: "openrouter/free",
	openRouterTextSmall: "openrouter/free",
	openRouterEmbedding: "openai/text-embedding-3-small",
	openRouterImage: "google/gemini-2.5-flash-image",
	openRouterVideo: "google/veo-3.1",
	openRouterVision: "openrouter/free",
	// ElizaOS Cloud model defaults — empty strings let the plugin fall
	// back to its own defaults if the user hasn't overridden them.
	elizaCloudLarge: "",
	elizaCloudMedium: "",
	elizaCloudSmall: "",
	elizaCloudNano: "",
	elizaCloudMega: "",
	elizaCloudResponseHandler: "",
	elizaCloudImage: "google/gemini-2.5-flash-image",
	elizaCloudVideo: "fal-ai/veo3",
};

const DEFAULT_WINDOW: WindowConfig = {
	width: 480,
	height: 720,
	hideOnBlur: false,
	alwaysOnTop: true,
};

const DEFAULT_CHRONICLER: ChroniclerConfig = {
	enabled: false,
	intervalMs: 60_000,
	includeWindowTitles: true,
	maxWindowsPerScreen: 8,
};

const DEFAULT_HF_SYNC_POLICY: AgentHfSyncPolicy = {
	enabled: false,
	destination: AGENT_HF_SYNC_DEFAULT_DESTINATION,
	limit: 200,
	syncOnStartup: true,
	daily: false,
	dailyTimeUtc: "03:00",
	everyNewTrajectories: 50,
	minIntervalMinutes: 30,
	failureCooldownMinutes: 30,
};

const DEFAULT_HF_SYNC_STATE: AgentHfSyncState = {
	lastAttemptAt: null,
	lastSuccessAt: null,
	lastFailureAt: null,
	lastError: null,
	lastReason: null,
	lastSyncedTrajectoryTotal: null,
	lastObservedTrajectoryTotal: null,
	lastDailySyncDateUtc: null,
	lastCounts: null,
};

const KEY_AGENT = "config.agent";
const KEY_CHARACTER = "config.character";
const KEY_MODELS = "config.models";
const KEY_WINDOW = "config.window";
const KEY_CHRONICLER = "config.chronicler";
const KEY_HF_SYNC_POLICY = "config.agentHfSyncPolicy";
const KEY_HF_SYNC_STATE = "config.agentHfSyncState";

function configuredString(raw: Record<string, unknown>, key: keyof ModelConfig): string | null {
	const value = raw[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function modelString(raw: Record<string, unknown>, key: keyof ModelConfig): string {
	return configuredString(raw, key) ?? String(DEFAULT_MODELS[key]);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

export class ConfigService {
	constructor(private readonly vault: VaultService) {}

	async bootstrap(): Promise<void> {
		const agent = await this.getAgent();
		this.applyAgent(agent);
		const models = await this.getModels();
		this.applyModels(models);
	}

	// ── Agent (vault-tools permissions) ────────────────────────────────

	async getAgent(): Promise<AgentConfig> {
		const raw = await this.readJson(KEY_AGENT);
		if (!raw) return { ...DEFAULT_AGENT };
		const next: AgentConfig = {
			deny: typeof raw.deny === "boolean" ? raw.deny : DEFAULT_AGENT.deny,
			mode: this.parseMode(raw.mode),
			allowedPrefixes: Array.isArray(raw.allowedPrefixes) ? raw.allowedPrefixes.filter((p: unknown): p is string => typeof p === "string") : [],
			deniedPrefixes: Array.isArray(raw.deniedPrefixes) ? raw.deniedPrefixes.filter((p: unknown): p is string => typeof p === "string") : [],
			browserUse: typeof raw.browserUse === "boolean" ? raw.browserUse : DEFAULT_AGENT.browserUse,
			computerUse: typeof raw.computerUse === "boolean" ? raw.computerUse : DEFAULT_AGENT.computerUse,
			elevatedCoding: typeof raw.elevatedCoding === "boolean" ? raw.elevatedCoding : false,
		};
		return next;
	}

	async setAgent(next: AgentConfig): Promise<void> {
		const sanitized: AgentConfig = {
			deny: !!next.deny,
			mode: this.parseMode(next.mode),
			allowedPrefixes: (next.allowedPrefixes ?? []).map(String),
			deniedPrefixes: (next.deniedPrefixes ?? []).map(String),
			browserUse: next.browserUse !== false,
			computerUse: !!next.computerUse,
			elevatedCoding: !!next.elevatedCoding,
		};
		await this.writeJson(KEY_AGENT, sanitized);
		this.applyAgent(sanitized);
	}

	private applyAgent(cfg: AgentConfig): void {
		setPermissionConfig({
			deny: cfg.deny,
			mode: cfg.mode,
			allowedPrefixes: cfg.allowedPrefixes,
			deniedPrefixes: cfg.deniedPrefixes,
		});
		// Mirror the elevated-coding flag into env so the running runtime
		// (already booted, won't see new runtime.settings until a rebuild)
		// can reflect the change immediately. The capabilitiesPlugin's
		// codingBriefProvider reads this on every turn.
		if (cfg.elevatedCoding) process.env.DETOUR_ELEVATED_CODING = "true";
		else delete process.env.DETOUR_ELEVATED_CODING;
		process.env.DETOUR_BROWSER_USE_ENABLED = cfg.browserUse === false ? "false" : "true";
		if (cfg.computerUse) process.env.DETOUR_COMPUTER_USE_ENABLED = "true";
		else delete process.env.DETOUR_COMPUTER_USE_ENABLED;
	}

	// ── Agent character ────────────────────────────────────────────────

	async getCharacter(): Promise<AgentCharacterConfig> {
		const raw = await this.readJson(KEY_CHARACTER);
		if (!raw) return structuredClone(DEFAULT_AGENT_CHARACTER);
		return this.sanitizeCharacter(raw);
	}

	async setCharacter(next: AgentCharacterConfig): Promise<AgentCharacterConfig> {
		const sanitized = this.sanitizeCharacter(recordFromUnknown(next));
		await this.writeJson(KEY_CHARACTER, sanitized);
		return sanitized;
	}

	// ── Models (codex overrides + provider priority) ───────────────────

	async getModels(): Promise<ModelConfig> {
		const raw = await this.readJson(KEY_MODELS);
		if (!raw) return { ...DEFAULT_MODELS };
		return {
			codexLarge: modelString(raw, "codexLarge"),
			codexSmall: modelString(raw, "codexSmall"),
			codexImage: modelString(raw, "codexImage"),
			openRouterTextLarge: modelString(raw, "openRouterTextLarge"),
			openRouterTextSmall: modelString(raw, "openRouterTextSmall"),
			openRouterEmbedding: modelString(raw, "openRouterEmbedding"),
			openRouterImage: modelString(raw, "openRouterImage"),
			openRouterVideo: modelString(raw, "openRouterVideo"),
			openRouterVision: modelString(raw, "openRouterVision"),
			elizaCloudLarge: modelString(raw, "elizaCloudLarge"),
			elizaCloudMedium: modelString(raw, "elizaCloudMedium"),
			elizaCloudSmall: modelString(raw, "elizaCloudSmall"),
			elizaCloudNano: modelString(raw, "elizaCloudNano"),
			elizaCloudMega: modelString(raw, "elizaCloudMega"),
			elizaCloudResponseHandler: modelString(raw, "elizaCloudResponseHandler"),
			elizaCloudImage: modelString(raw, "elizaCloudImage"),
			elizaCloudVideo: modelString(raw, "elizaCloudVideo"),
		};
	}

	async setModels(next: ModelConfig): Promise<void> {
		await this.writeJson(KEY_MODELS, next);
		this.applyModels(next);
	}

	private applyModels(cfg: ModelConfig): void {
		process.env.CODEX_MODEL_LARGE = cfg.codexLarge;
		process.env.CODEX_MODEL_SMALL = cfg.codexSmall;
		process.env.CODEX_MODEL_IMAGE = cfg.codexImage;
		process.env.OPENROUTER_MODEL_TEXT_LARGE = cfg.openRouterTextLarge;
		process.env.OPENROUTER_MODEL_TEXT_SMALL = cfg.openRouterTextSmall;
		process.env.OPENROUTER_MODEL_EMBEDDING = cfg.openRouterEmbedding;
		process.env.OPENROUTER_MODEL_IMAGE = cfg.openRouterImage;
		process.env.OPENROUTER_MODEL_VIDEO = cfg.openRouterVideo;
		process.env.OPENROUTER_MODEL_VISION = cfg.openRouterVision;
		// ElizaOS Cloud — env-var names match the plugin's reader
		// (eliza/plugins/plugin-elizacloud/utils/config.ts).
		this.applyElizaCloudEnv("ELIZAOS_CLOUD_LARGE_MODEL", cfg.elizaCloudLarge);
		this.applyElizaCloudEnv("ELIZAOS_CLOUD_MEDIUM_MODEL", cfg.elizaCloudMedium);
		this.applyElizaCloudEnv("ELIZAOS_CLOUD_SMALL_MODEL", cfg.elizaCloudSmall);
		this.applyElizaCloudEnv("ELIZAOS_CLOUD_NANO_MODEL", cfg.elizaCloudNano);
		this.applyElizaCloudEnv("ELIZAOS_CLOUD_MEGA_MODEL", cfg.elizaCloudMega);
		this.applyElizaCloudEnv("ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL", cfg.elizaCloudResponseHandler);
		this.applyElizaCloudEnv("ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL", cfg.elizaCloudImage);
		this.applyElizaCloudEnv("ELIZAOS_CLOUD_VIDEO_GENERATION_MODEL", cfg.elizaCloudVideo);
	}

	private applyElizaCloudEnv(name: string, value: string): void {
		// Empty value = let the plugin's own default kick in. We have to
		// explicitly delete (not set to "") because the plugin treats
		// empty-string as a configured override.
		if (value) {
			process.env[name] = value;
		} else {
			delete process.env[name];
		}
	}

	// ── Window ─────────────────────────────────────────────────────────

	async getWindow(): Promise<WindowConfig> {
		const raw = await this.readJson(KEY_WINDOW);
		if (!raw) return { ...DEFAULT_WINDOW };
		return {
			width: typeof raw.width === "number" ? raw.width : DEFAULT_WINDOW.width,
			height: typeof raw.height === "number" ? raw.height : DEFAULT_WINDOW.height,
			hideOnBlur: typeof raw.hideOnBlur === "boolean" ? raw.hideOnBlur : DEFAULT_WINDOW.hideOnBlur,
			alwaysOnTop: typeof raw.alwaysOnTop === "boolean" ? raw.alwaysOnTop : DEFAULT_WINDOW.alwaysOnTop,
		};
	}

	async setWindow(next: WindowConfig): Promise<void> {
		await this.writeJson(KEY_WINDOW, next);
	}

	async getChronicler(): Promise<ChroniclerConfig> {
		const raw = await this.readJson(KEY_CHRONICLER);
		if (!raw) return { ...DEFAULT_CHRONICLER };
		return this.sanitizeChronicler(raw);
	}

	async setChronicler(next: ChroniclerConfig): Promise<ChroniclerConfig> {
		const sanitized = this.sanitizeChronicler({
			enabled: next.enabled,
			intervalMs: next.intervalMs,
			includeWindowTitles: next.includeWindowTitles,
			maxWindowsPerScreen: next.maxWindowsPerScreen,
		});
		await this.writeJson(KEY_CHRONICLER, sanitized);
		return sanitized;
	}

	async getAgentHfSyncPolicy(): Promise<AgentHfSyncPolicy> {
		const raw = await this.readJson(KEY_HF_SYNC_POLICY);
		if (!raw) return { ...DEFAULT_HF_SYNC_POLICY };
		return this.sanitizeHfSyncPolicy(raw);
	}

	async setAgentHfSyncPolicy(next: AgentHfSyncPolicy): Promise<AgentHfSyncPolicy> {
		const sanitized = this.sanitizeHfSyncPolicy(recordFromUnknown(next));
		await this.writeJson(KEY_HF_SYNC_POLICY, sanitized);
		return sanitized;
	}

	async getAgentHfSyncState(): Promise<AgentHfSyncState> {
		const raw = await this.readJson(KEY_HF_SYNC_STATE);
		if (!raw) return { ...DEFAULT_HF_SYNC_STATE };
		return this.sanitizeHfSyncState(raw);
	}

	async setAgentHfSyncState(next: AgentHfSyncState): Promise<AgentHfSyncState> {
		const sanitized = this.sanitizeHfSyncState(recordFromUnknown(next));
		await this.writeJson(KEY_HF_SYNC_STATE, sanitized);
		return sanitized;
	}

	// ── Helpers ────────────────────────────────────────────────────────

	private parseMode(value: unknown): AgentVaultMode {
		return value === "off" || value === "read" || value === "read-write" ? value : "read";
	}

	private sanitizeChronicler(raw: Record<string, unknown>): ChroniclerConfig {
		const intervalMs = typeof raw.intervalMs === "number" && Number.isFinite(raw.intervalMs)
			? Math.max(15_000, Math.min(600_000, Math.round(raw.intervalMs)))
			: DEFAULT_CHRONICLER.intervalMs;
		const maxWindowsPerScreen = typeof raw.maxWindowsPerScreen === "number" && Number.isFinite(raw.maxWindowsPerScreen)
			? Math.max(1, Math.min(30, Math.round(raw.maxWindowsPerScreen)))
			: DEFAULT_CHRONICLER.maxWindowsPerScreen;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CHRONICLER.enabled,
			intervalMs,
			includeWindowTitles: typeof raw.includeWindowTitles === "boolean" ? raw.includeWindowTitles : DEFAULT_CHRONICLER.includeWindowTitles,
			maxWindowsPerScreen,
		};
	}

	private sanitizeHfSyncPolicy(raw: Record<string, unknown>): AgentHfSyncPolicy {
		const destination = typeof raw.destination === "string" && raw.destination.trim().startsWith("hf://")
			? raw.destination.trim()
			: DEFAULT_HF_SYNC_POLICY.destination;
		const dailyTimeUtc = typeof raw.dailyTimeUtc === "string" && /^\d{2}:\d{2}$/.test(raw.dailyTimeUtc)
			? raw.dailyTimeUtc
			: DEFAULT_HF_SYNC_POLICY.dailyTimeUtc;
		const limit = this.clampedNumber(raw.limit, 1, 2000, DEFAULT_HF_SYNC_POLICY.limit);
		const everyNewTrajectories = this.clampedNumber(raw.everyNewTrajectories, 1, 10_000, DEFAULT_HF_SYNC_POLICY.everyNewTrajectories);
		const minIntervalMinutes = this.clampedNumber(raw.minIntervalMinutes, 1, 24 * 60, DEFAULT_HF_SYNC_POLICY.minIntervalMinutes);
		const failureCooldownMinutes = this.clampedNumber(raw.failureCooldownMinutes, 1, 24 * 60, DEFAULT_HF_SYNC_POLICY.failureCooldownMinutes);
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_HF_SYNC_POLICY.enabled,
			destination,
			limit,
			syncOnStartup: typeof raw.syncOnStartup === "boolean" ? raw.syncOnStartup : DEFAULT_HF_SYNC_POLICY.syncOnStartup,
			daily: typeof raw.daily === "boolean" ? raw.daily : DEFAULT_HF_SYNC_POLICY.daily,
			dailyTimeUtc,
			everyNewTrajectories,
			minIntervalMinutes,
			failureCooldownMinutes,
		};
	}

	private sanitizeHfSyncState(raw: Record<string, unknown>): AgentHfSyncState {
		const reason = raw.lastReason;
		const lastReason: AgentHfSyncReason | null =
			reason === "manual" || reason === "startup" || reason === "daily" || reason === "trajectory-threshold"
				? reason
				: null;
		return {
			lastAttemptAt: this.nullableString(raw.lastAttemptAt),
			lastSuccessAt: this.nullableString(raw.lastSuccessAt),
			lastFailureAt: this.nullableString(raw.lastFailureAt),
			lastError: this.nullableString(raw.lastError),
			lastReason,
			lastSyncedTrajectoryTotal: this.nullableNumber(raw.lastSyncedTrajectoryTotal),
			lastObservedTrajectoryTotal: this.nullableNumber(raw.lastObservedTrajectoryTotal),
			lastDailySyncDateUtc: this.nullableString(raw.lastDailySyncDateUtc),
			lastCounts: this.sanitizeDumpCounts(raw.lastCounts),
		};
	}

	private sanitizeDumpCounts(raw: unknown): AgentHfSyncState["lastCounts"] {
		const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
		if (!obj) return null;
		return {
			trajectories: this.clampedNumber(obj.trajectories, 0, Number.MAX_SAFE_INTEGER, 0),
			trajectoryDetails: this.clampedNumber(obj.trajectoryDetails, 0, Number.MAX_SAFE_INTEGER, 0),
			memories: this.clampedNumber(obj.memories, 0, Number.MAX_SAFE_INTEGER, 0),
			memoryTables: this.clampedNumber(obj.memoryTables, 0, Number.MAX_SAFE_INTEGER, 0),
			relationships: this.clampedNumber(obj.relationships, 0, Number.MAX_SAFE_INTEGER, 0),
			redactedMemories: this.clampedNumber(obj.redactedMemories, 0, Number.MAX_SAFE_INTEGER, 0),
			totalTrajectoriesScanned: this.clampedNumber(obj.totalTrajectoriesScanned, 0, Number.MAX_SAFE_INTEGER, 0),
			totalMemoriesScanned: this.clampedNumber(obj.totalMemoriesScanned, 0, Number.MAX_SAFE_INTEGER, 0),
			dataBytes: this.clampedNumber(obj.dataBytes, 0, Number.MAX_SAFE_INTEGER, 0),
		};
	}

	private clampedNumber(raw: unknown, min: number, max: number, fallback: number): number {
		return typeof raw === "number" && Number.isFinite(raw)
			? Math.max(min, Math.min(max, Math.round(raw)))
			: fallback;
	}

	private nullableString(raw: unknown): string | null {
		return typeof raw === "string" && raw.length > 0 ? raw : null;
	}

	private nullableNumber(raw: unknown): number | null {
		return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
	}

	private sanitizeCharacter(raw: Record<string, unknown>): AgentCharacterConfig {
		return {
			name: this.cleanString(raw.name, DEFAULT_AGENT_CHARACTER.name),
			username: this.cleanString(raw.username, DEFAULT_AGENT_CHARACTER.username),
			system: this.cleanString(raw.system, DEFAULT_AGENT_CHARACTER.system),
			bio: this.cleanStringArray(raw.bio, DEFAULT_AGENT_CHARACTER.bio),
			lore: this.cleanStringArray(raw.lore, DEFAULT_AGENT_CHARACTER.lore),
			adjectives: this.cleanStringArray(raw.adjectives, DEFAULT_AGENT_CHARACTER.adjectives),
			topics: this.cleanStringArray(raw.topics, DEFAULT_AGENT_CHARACTER.topics),
			style: this.cleanStyle(raw.style),
			postExamples: this.cleanStringArray(raw.postExamples, DEFAULT_AGENT_CHARACTER.postExamples),
			messageExamples: this.cleanMessageExamples(raw.messageExamples),
		};
	}

	private cleanStyle(raw: unknown): AgentCharacterConfig["style"] {
		const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
		return {
			all: this.cleanStringArray(obj.all, DEFAULT_AGENT_CHARACTER.style.all),
			chat: this.cleanStringArray(obj.chat, DEFAULT_AGENT_CHARACTER.style.chat),
			post: this.cleanStringArray(obj.post, DEFAULT_AGENT_CHARACTER.style.post),
		};
	}

	private cleanMessageExamples(raw: unknown): AgentCharacterMessageExample[][] {
		if (!Array.isArray(raw)) return DEFAULT_AGENT_CHARACTER.messageExamples;
		const groups = raw.flatMap((group): AgentCharacterMessageExample[][] => {
			if (!Array.isArray(group)) return [];
			const messages = group.flatMap((item): AgentCharacterMessageExample[] => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return [];
				const obj = item as Record<string, unknown>;
				const content = obj.content && typeof obj.content === "object" && !Array.isArray(obj.content)
					? obj.content as Record<string, unknown>
					: {};
				const text = this.cleanString(content.text, "");
				if (!text) return [];
				return [{
					name: this.cleanString(obj.name, "{{user}}"),
					content: {
						text,
						actions: this.cleanOptionalStringArray(content.actions),
						providers: this.cleanOptionalStringArray(content.providers),
					},
				}];
			});
			return messages.length > 0 ? [messages] : [];
		});
		return groups.length > 0 ? groups : DEFAULT_AGENT_CHARACTER.messageExamples;
	}

	private cleanString(raw: unknown, fallback: string): string {
		return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : fallback;
	}

	private cleanStringArray(raw: unknown, fallback: string[]): string[] {
		if (!Array.isArray(raw)) return [...fallback];
		const values = raw.map((value) => typeof value === "string" ? value.trim() : "").filter((value) => value.length > 0);
		return values.length > 0 ? values : [...fallback];
	}

	private cleanOptionalStringArray(raw: unknown): string[] | undefined {
		if (!Array.isArray(raw)) return undefined;
		const values = raw.map((value) => typeof value === "string" ? value.trim() : "").filter((value) => value.length > 0);
		return values.length > 0 ? values : undefined;
	}

	private async readJson(key: string): Promise<Record<string, unknown> | null> {
		const v = await this.vault.vault();
		if (!(await v.has(key))) return null;
		try {
			const raw = await v.get(key);
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	private async writeJson(key: string, value: unknown): Promise<void> {
		const v = await this.vault.vault();
		await v.set(key, JSON.stringify(value));
	}
}
