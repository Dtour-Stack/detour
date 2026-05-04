export type ProviderId = "anthropic" | "openai";

export type ProviderInfo = {
	id: ProviderId;
	label: string;
	hasKey: boolean;
	active: boolean;
};

// Mirrors @elizaos/vault BackendStatus — duplicated here so non-Bun clients
// (web, cli) don't need the @elizaos/vault dep.
export type BackendId = "in-house" | "1password" | "protonpass" | "bitwarden";

export type BackendStatus = {
	readonly id: BackendId;
	readonly label: string;
	readonly available: boolean;
	readonly signedIn?: boolean;
	readonly detail?: string;
	readonly authMode?: "desktop-app" | "session-token" | null;
};

export type Health = { ok: true; version: string };

export type SetProviderKeyBody = { key: string };
export type SetActiveProviderBody = { id: ProviderId };
export type SetEnabledBackendsBody = { enabled: string[] };

// --- generic vault keys ---
export type VaultKeyDescriptor = {
	key: string;
	sensitive: boolean;
	source: "in-house" | "1password" | "bitwarden" | "protonpass";
	updatedAt?: string;
	createdAt?: string;
};

export type SetVaultKeyBody = { value: string; sensitive?: boolean };

// --- saved logins (1Password etc.) ---
export type SavedLoginEntry = {
	source: "in-house" | "1password" | "bitwarden";
	identifier: string;
	domain?: string;
	username?: string;
	label?: string;
};

export type SavedLoginListResult = {
	entries: SavedLoginEntry[];
	failures: { source: string; message: string }[];
};

export type RevealedLogin = {
	source: "in-house" | "1password" | "bitwarden";
	username?: string;
	password: string;
	totp?: string;
	domain?: string;
};

export type WsClientMessage =
	| { kind: "chat:send"; convId: string; text: string }
	| { kind: "ping" };

export type WsServerMessage =
	| { kind: "chat:delta"; convId: string; delta: string }
	| { kind: "chat:complete"; convId: string }
	| { kind: "chat:error"; convId: string; message: string }
	| { kind: "provider:changed"; activeProvider: ProviderId | null }
	| { kind: "auth:flow-update"; sessionId: string; state: AuthFlowState }
	| { kind: "backend:changed"; backendId: string }
	| { kind: "ui:open-settings" }
	| { kind: "pong" };

export type ThemeChoice = "system" | "light" | "dark";
export type UiPreferences = {
	theme: ThemeChoice;
	accent: string;
};

export type OpDiagnostic = {
	platform: string;
	opPath: string | null;
	opVersion: string | null;
	accountList: { exitCode: number; stdout: string; stderr: string };
	vaultList: {
		account: string | null;
		exitCode: number;
		stdout: string;
		stderr: string;
	} | null;
	desktopIntegrationDetected: boolean;
	sessionTokenStored: boolean;
	hint: string;
};

export type SigninResult = {
	backendId: "1password" | "bitwarden" | "protonpass";
	sessionStored: boolean;
	message: string;
};

export type AuthFlowStatus = "pending" | "success" | "error" | "cancelled" | "timeout";
export type AuthFlowState = {
	sessionId: string;
	providerId: string;
	status: AuthFlowStatus;
	authUrl?: string;
	needsCodeSubmission: boolean;
	account?: AccountRecord;
	error?: string;
	startedAt: number;
	endedAt?: number;
};

export type AccountRecord = {
	id: string;
	providerId: string;
	label: string;
	source: "oauth" | "api-key";
	credentials: { access: string; refresh: string; expires: number };
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	organizationId?: string;
	userId?: string;
	email?: string;
};

export type StartAuthFlowBody = {
	provider: "anthropic-subscription" | "openai-codex";
	label: string;
	accountId?: string;
};

export type SubmitFlowCodeBody = { code: string };
