import type { BackendStatus } from "../index";

export type VaultRequests = {
	vaultListBackends: {
		params: Record<string, never>;
		response: BackendStatus[];
	};
};

export type VaultMessages = {
	// Fired when an enabled-backend toggle, signin, or signout changes the
	// effective backend set. Replaces ws `backend:changed`.
	backendChanged: { backendId: string };
};
