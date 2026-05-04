import { ActivityService } from "./activity";
import { ApiServer } from "./api/server";
import { AuthService } from "./auth";
import { BackendOps } from "./backend-ops";
import { ConfigService } from "./config-service";
import { PensieveService } from "./pensieve";
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

/**
 * macOS .app bundles launched from Finder/Launchd inherit a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`). That breaks our spawn-based detectors
 * for `op`, `bw`, `brew`, `npm`, and anything else users have installed under
 * Homebrew or in their home dir. Augment PATH at startup so child_process
 * spawns find these tools regardless of how the app was launched.
 *
 * Order: existing PATH entries → standard system → Homebrew → user-local. We
 * append rather than prepend so a user who explicitly set PATH (e.g. wrapper
 * launcher) keeps their precedence.
 */
function ensureUsefulPath(): void {
	const existing = (process.env.PATH ?? "").split(":").filter(Boolean);
	const home = process.env.HOME ?? "";
	const candidates = [
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
		home ? `${home}/.local/bin` : "",
		home ? `${home}/bin` : "",
	].filter(Boolean);
	const seen = new Set(existing);
	const merged = [...existing];
	for (const p of candidates) {
		if (!seen.has(p)) {
			merged.push(p);
			seen.add(p);
		}
	}
	process.env.PATH = merged.join(":");
}

export async function startCore(opts: CoreOptions): Promise<CoreHandle> {
	ensureUsefulPath();
	process.env.PGLITE_DATA_DIR = opts.pgliteDataDir;

	const vault = new VaultService();
	const auth = new AuthService();
	auth.enableClaudeCodeStealth();
	const config = new ConfigService(vault);
	await config.bootstrap(); // load persisted config + push to plugins
	const runtime = new RuntimeService(vault, auth);
	const backendOps = new BackendOps(vault);
	const pensieve = new PensieveService(runtime);
	pensieve.start();
	const activity = new ActivityService(runtime);
	activity.start();

	// Inject Pensieve templates into runtime.character.templates on every build.
	// Subsystems (messageHandler/reply/shouldRespond/reflection/think/etc.)
	// all read via `runtime.character.templates?.<name>` so this is the
	// integration point that makes user-authored templates actually used.
	runtime.onAfterBuild(async (state) => {
		try {
			const result = await pensieve.templates.applyTemplatesToRuntime(state.runtime);
			if (result.applied > 0) console.log(`[pensieve] applied ${result.applied} template(s) to character: ${result.names.join(", ")}`);
		} catch (err) {
			console.warn("[pensieve] template injection failed:", err instanceof Error ? err.message : err);
		}
	});
	const api = new ApiServer(runtime, vault, auth, backendOps, config, pensieve, activity);
	const { port } = await api.start(opts.port ?? 2138);

	console.log(`[core] api listening on http://127.0.0.1:${port}`);

	// Eager-build the runtime in the background so Pensieve / Activity have
	// real data the moment the user opens those windows — instead of
	// `available: false` until first chat. Failure (e.g. no provider configured
	// yet) is non-fatal: getOrBuild will simply retry on the next chat send.
	void runtime.getOrBuild()
		.then((state) => {
			if (state) console.log(`[core] runtime warm (provider=${state.provider})`);
			else console.log("[core] runtime not built — no provider configured");
		})
		.catch((err) => console.warn("[core] eager runtime build failed:", err));

	const handle: CoreHandle = {
		port,
		vault,
		runtime,
		auth,
		api,
		stop: () => {
			activity.stop();
			pensieve.stop();
			api.stop();
		},
	};
	return handle;
}

export { VaultService } from "./vault";
export { RuntimeService } from "./runtime";
export { AuthService } from "./auth";
export { ApiServer } from "./api/server";
export { PensieveService } from "./pensieve";
export { ActivityService } from "./activity";
export { PensieveMemoryService } from "./pensieve/memory-service";
export { PensieveRelationshipService } from "./pensieve/relationship-service";
export { PensieveTemplatesService } from "./pensieve/templates-service";
export type {
	PensieveTemplateSummary,
	PensieveTemplateDetail,
	PensievePromptVariable,
	PensieveTemplateRenderResult,
	PensieveMemorySummary,
	PensieveMemoryDetail,
} from "./pensieve";

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
