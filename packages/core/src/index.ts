import { ApiServer } from "./api/server";
import { AuthService } from "./auth";
import { BackendOps } from "./backend-ops";
import { ConfigService } from "./config-service";
import { RuntimeService } from "./runtime";
import { VaultService } from "./vault";

export type CoreOptions = {
	port?: number;
	pgliteDataDir: string;
};

export type CoreHandle = {
	port: number;
	vault: VaultService;
	runtime: RuntimeService;
	auth: AuthService;
	api: ApiServer;
	stop: () => void;
};

export async function startCore(opts: CoreOptions): Promise<CoreHandle> {
	process.env.PGLITE_DATA_DIR = opts.pgliteDataDir;

	const vault = new VaultService();
	const auth = new AuthService();
	auth.enableClaudeCodeStealth();
	const config = new ConfigService(vault);
	await config.bootstrap(); // load persisted config + push to plugins
	const runtime = new RuntimeService(vault, auth);
	const backendOps = new BackendOps(vault);
	const api = new ApiServer(runtime, vault, auth, backendOps, config);
	const { port } = await api.start(opts.port ?? 2138);

	console.log(`[core] api listening on http://127.0.0.1:${port}`);

	const handle: CoreHandle = {
		port,
		vault,
		runtime,
		auth,
		api,
		stop: () => api.stop(),
	};
	return handle;
}

export { VaultService } from "./vault";
export { RuntimeService } from "./runtime";
export { AuthService } from "./auth";
export { ApiServer } from "./api/server";

// Re-export wire types for convenience (clients can also import from @detour/shared directly)
export type {
	ProviderId,
	ProviderInfo,
	BackendId,
	BackendStatus,
	WsClientMessage,
	WsServerMessage,
	SetProviderKeyBody,
	SetActiveProviderBody,
	SetEnabledBackendsBody,
	Health,
} from "@detour/shared";
