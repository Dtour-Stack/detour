/**
 * Permission gating for agent-driven vault access.
 *
 * Resolution order (highest priority first):
 *   1. Process env (kill switches set at boot)
 *   2. In-process config snapshot pushed by the host (UI toggles)
 *   3. Built-in defaults (read-only, system keys denied)
 *
 * Three layers:
 *   1. Hard kill switch: deny=true → all actions refuse.
 *   2. Mode: "off" | "read" | "read-write" (default: "read")
 *   3. Allow-list / deny-list — comma-separated key prefixes.
 */

export type AgentVaultMode = "off" | "read" | "read-write";

export interface AgentPermissionConfig {
	deny: boolean;
	mode: AgentVaultMode;
	allowedPrefixes: readonly string[];
	deniedPrefixes: readonly string[];
}

export interface PermissionContext {
	readonly action: "read" | "write" | "list" | "delete";
	readonly target?: string;
}

export interface PermissionResult {
	readonly allowed: boolean;
	readonly reason?: string;
}

const DEFAULT_DENIED = ["_manager.", "_meta.", "_routing.", "pm.", "config.", "ui."];

const DEFAULT_CONFIG: AgentPermissionConfig = {
	deny: false,
	mode: "read",
	allowedPrefixes: [],
	deniedPrefixes: [],
};

let _config: AgentPermissionConfig = { ...DEFAULT_CONFIG };

/** Push a config snapshot from the host (UI toggles → /api/config/agent → here). */
export function setPermissionConfig(next: Partial<AgentPermissionConfig>): void {
	_config = {
		deny: next.deny ?? _config.deny,
		mode: next.mode ?? _config.mode,
		allowedPrefixes: next.allowedPrefixes ?? _config.allowedPrefixes,
		deniedPrefixes: next.deniedPrefixes ?? _config.deniedPrefixes,
	};
}

export function getPermissionConfig(): AgentPermissionConfig {
	return { ..._config };
}

function parseList(env: string | undefined): string[] {
	if (!env) return [];
	return env
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function effectiveMode(): AgentVaultMode {
	if (process.env.ELIZA_VAULT_AGENT_DENY === "1") return "off";
	if (_config.deny) return "off";
	const envMode = (process.env.ELIZA_VAULT_AGENT_MODE ?? "").toLowerCase();
	if (envMode === "off" || envMode === "read" || envMode === "read-write") return envMode;
	return _config.mode;
}

function effectiveAllowed(): string[] {
	const fromEnv = parseList(process.env.ELIZA_VAULT_AGENT_ALLOWED_KEYS);
	return fromEnv.length > 0 ? fromEnv : [..._config.allowedPrefixes];
}

function effectiveDenied(): string[] {
	const fromEnv = parseList(process.env.ELIZA_VAULT_AGENT_DENIED_KEYS);
	return [...DEFAULT_DENIED, ..._config.deniedPrefixes, ...fromEnv];
}

export function check(ctx: PermissionContext): PermissionResult {
	const mode = effectiveMode();
	if (mode === "off") {
		return { allowed: false, reason: "Vault access disabled (mode=off)" };
	}
	if (mode === "read" && (ctx.action === "write" || ctx.action === "delete")) {
		return { allowed: false, reason: "Vault is read-only for the agent (set mode to read-write to allow)" };
	}
	if (ctx.target) {
		for (const prefix of effectiveDenied()) {
			if (ctx.target.startsWith(prefix)) {
				return { allowed: false, reason: `Key "${ctx.target}" is in the deny-list (prefix "${prefix}")` };
			}
		}
		const allow = effectiveAllowed();
		if (allow.length > 0) {
			const ok = allow.some((prefix) => ctx.target!.startsWith(prefix));
			if (!ok) {
				return { allowed: false, reason: `Key "${ctx.target}" is not in the allow-list` };
			}
		}
	}
	return { allowed: true };
}
