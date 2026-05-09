import type {
	BackendInstall,
	BackendStatus,
	OpDiagnostic,
	RevealedLogin,
	SavedLoginsListResult,
	SignInBackendBody,
	SigninResult,
	VaultInventoryItem,
	VaultKeyResult,
	VaultStats,
} from "../index";

export type VaultRequests = {
	vaultListBackends: {
		params: Record<string, never>;
		response: BackendStatus[];
	};

	// --- enabled backends ---
	vaultGetEnabledBackends: {
		params: Record<string, never>;
		response: { enabled: string[] };
	};
	vaultSetEnabledBackends: {
		params: { enabled: string[] };
		response: { ok: true };
	};

	// --- install metadata ---
	vaultGetInstall: {
		params: Record<string, never>;
		response: BackendInstall;
	};

	// --- backend ops: diagnose / signin / signout ---
	vaultDiagnose1password: {
		params: Record<string, never>;
		response: OpDiagnostic;
	};
	vaultSigninBackend: {
		params: { id: "1password" | "bitwarden" } & SignInBackendBody;
		response: SigninResult;
	};
	vaultSignoutBackend: {
		params: { id: "1password" | "bitwarden" };
		response: { ok: true };
	};

	// --- generic vault inventory + per-key CRUD ---
	vaultInventory: {
		params: Record<string, never>;
		response: VaultInventoryItem[];
	};
	vaultStats: {
		params: Record<string, never>;
		response: VaultStats;
	};
	vaultGetKey: {
		params: { key: string; reveal?: boolean };
		response: VaultKeyResult;
	};
	vaultSetKey: {
		params: { key: string; value: string; sensitive?: boolean };
		response: { ok: true };
	};
	vaultRemoveKey: {
		params: { key: string };
		response: { ok: true };
	};

	// --- saved logins ---
	savedLoginsList: {
		params: Record<string, never>;
		response: SavedLoginsListResult;
	};
	savedLoginsReveal: {
		params: {
			source: "in-house" | "1password" | "bitwarden";
			identifier: string;
		};
		response: RevealedLogin;
	};
};

export type VaultMessages = {
	// Fired when an enabled-backend toggle, signin, or signout changes the
	// effective backend set. Replaces ws `backend:changed`.
	backendChanged: { backendId: string };
};
