/**
 * App-level config persistence. Stores everything under `config.*` vault keys
 * (non-sensitive) and pushes snapshots into the plugins that consume them
 * (plugin-vault-tools' permission gate; plugin-codex-chatgpt's model picker
 * via env vars set at apply-time).
 *
 * Bootstrap on startup loads stored config and pushes it to the plugins so
 * the agent's permission state survives restarts without env vars.
 */

import type { AgentConfig, ModelConfig, WindowConfig } from "@detour/shared";
import { setPermissionConfig, type AgentVaultMode } from "@detour/plugin-vault-tools";
import type { VaultService } from "./vault";

const DEFAULT_AGENT: AgentConfig = {
	deny: false,
	mode: "read",
	allowedPrefixes: [],
	deniedPrefixes: [],
};

const DEFAULT_MODELS: ModelConfig = {
	codexLarge: "gpt-5.2",
	codexSmall: "gpt-5.2",
	codexImage: "gpt-5.2",
	providerPriority: ["anthropic-subscription", "openai-codex", "anthropic-api", "openai-api"],
};

const DEFAULT_WINDOW: WindowConfig = {
	width: 480,
	height: 720,
	hideOnBlur: false,
	alwaysOnTop: true,
};

const KEY_AGENT = "config.agent";
const KEY_MODELS = "config.models";
const KEY_WINDOW = "config.window";

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
		};
		return next;
	}

	async setAgent(next: AgentConfig): Promise<void> {
		const sanitized: AgentConfig = {
			deny: !!next.deny,
			mode: this.parseMode(next.mode),
			allowedPrefixes: (next.allowedPrefixes ?? []).map(String),
			deniedPrefixes: (next.deniedPrefixes ?? []).map(String),
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
	}

	// ── Models (codex overrides + provider priority) ───────────────────

	async getModels(): Promise<ModelConfig> {
		const raw = await this.readJson(KEY_MODELS);
		if (!raw) return { ...DEFAULT_MODELS };
		return {
			codexLarge: typeof raw.codexLarge === "string" && raw.codexLarge ? raw.codexLarge : DEFAULT_MODELS.codexLarge,
			codexSmall: typeof raw.codexSmall === "string" && raw.codexSmall ? raw.codexSmall : DEFAULT_MODELS.codexSmall,
			codexImage: typeof raw.codexImage === "string" && raw.codexImage ? raw.codexImage : DEFAULT_MODELS.codexImage,
			providerPriority: Array.isArray(raw.providerPriority) && raw.providerPriority.length > 0
				? (raw.providerPriority as ModelConfig["providerPriority"])
				: DEFAULT_MODELS.providerPriority,
		};
	}

	async setModels(next: ModelConfig): Promise<void> {
		await this.writeJson(KEY_MODELS, next);
		this.applyModels(next);
	}

	private applyModels(cfg: ModelConfig): void {
		// Plugin-codex-chatgpt reads these via getSetting (which falls through to env).
		process.env.CODEX_MODEL_LARGE = cfg.codexLarge;
		process.env.CODEX_MODEL_SMALL = cfg.codexSmall;
		process.env.CODEX_MODEL_IMAGE = cfg.codexImage;
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

	// ── Helpers ────────────────────────────────────────────────────────

	private parseMode(value: unknown): AgentVaultMode {
		return value === "off" || value === "read" || value === "read-write" ? value : "read";
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
