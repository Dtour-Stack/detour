import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ActivityService } from "./activity";
import { ApiServer } from "./api/server";
import { AuthService } from "./auth";
import { BackendOps } from "./backend-ops";
import { ChannelsService } from "./channels";
import { ChannelGatewayService } from "./channels/gateway";
import { ConfigService } from "./config-service";
import { ContinuousImprovementService } from "./continuous-improvement-service";
import { CronService } from "./cron-service";
import { DiscordObservationService } from "./discord-observation-service";
import { InboxService } from "./inbox";
import { OwnerBindService } from "./owner-bind";
import { newTraceId, traceScope } from "./trace";
import { LlamaServerService } from "./llama/server-service";
import { PortlessService } from "./portless";
import { PensieveService } from "./pensieve";
import { RuntimeService } from "./runtime";
import { VaultService } from "./vault";
import { buildRpcDeps } from "./rpc/registry";
import type { RpcDeps } from "./rpc/types";

export type CoreOptions = {
	port?: number;
	dataDir: string;
	pgliteDataDir: string;
};

export type CoreHandle = {
	port: number;
	vault: VaultService;
	runtime: RuntimeService;
	auth: AuthService;
	api: ApiServer;
	portless: PortlessService;
	rpcDeps: RpcDeps;
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
	// Anchor @elizaos/vault + auth at the canonical Detour data dir (~/.detour).
	// `<ELIZA_STATE_DIR>/auth/` is a SYMLINK to ~/.eliza/auth/, so eliza's
	// listAccounts() reads the same OAuth pool the user's other eliza apps use.
	// Must run BEFORE VaultService construction since createVault() reads
	// ELIZA_STATE_DIR at call time.
	process.env.ELIZA_STATE_DIR = opts.dataDir;

	const vault = new VaultService();
	const auth = new AuthService();
	auth.enableClaudeCodeStealth();
	const config = new ConfigService(vault);
	await config.bootstrap(); // load persisted config + push to plugins
	const channels = new ChannelsService(vault);
	const runtime = new RuntimeService(vault, auth, channels, undefined, config);
	const backendOps = new BackendOps(vault);
	const pensieve = new PensieveService(runtime, config);
	pensieve.start();
	const activity = new ActivityService(runtime);
	activity.start();
	const gateway = new ChannelGatewayService();
	const improvement = new ContinuousImprovementService(runtime, pensieve.memories, activity.logs);
	improvement.start();
	const discordObservations = new DiscordObservationService(runtime, pensieve.memories, gateway);
	discordObservations.start();
	runtime.setGateway(gateway);
	runtime.onAfterBuild((state) => {
		gateway.attach(state.runtime);
	});
	const inbox = new InboxService(runtime, gateway);
	inbox.bindToGateway();
	// Cron / scheduled prompts. JSON-persisted, mirrored as eliza Tasks so they
	// show in Activity > Tasks. Dispatcher routes a fired job through the inbox
	// pipeline so the agent processes it via the same messageService.handleMessage
	// path as user messages.
	// Owner-bind: backs eliza's /eliza_pair (Telegram) + /eliza-pair (Discord)
	// flows. Without this, the slash commands silently no-op.
	const ownerBind = new OwnerBindService(vault);
	runtime.setOwnerBind(ownerBind);

	const cron = new CronService();
	cron.setDispatcher(async (job) => {
		// Each cron fire opens its own trace scope so every log line + the
		// downstream inbox/messageService chain is correlatable to this run.
		const traceId = newTraceId();
		await traceScope(traceId, () =>
			inbox.post({
				kind: "task",
				title: `[cron] ${job.name}`,
				body: job.prompt,
				source: `cron:${job.id}`,
				prompt: true,
			}),
		);
	});
	cron.start();
	runtime.onAfterBuild(async (state) => {
		try { await cron.attachRuntime(state.runtime); }
		catch (err) { console.warn("[cron] attachRuntime failed:", err instanceof Error ? err.message : err); }
	});

	// Carrot bridge — load runtime-installable plugins ("carrots"), each in
	// its own isolated Bun Worker. The CarrotManager exposes a curated set
	// of core service methods; carrots invoke them over RPC. See
	// src/bun/core/carrots/README and src/bun/carrot-sdk/.
	const carrotManager = new (await import("./carrots")).CarrotManager();
	carrotManager.registerService("cron", {
		listJobs: () => cron.listJobs(),
		getJob: (id: unknown) => cron.getJob(String(id)),
		createJob: (input: unknown) => cron.createJob(input as Parameters<typeof cron.createJob>[0]),
		updateJob: (id: unknown, patch: unknown) => cron.updateJob(String(id), patch as Parameters<typeof cron.updateJob>[1]),
		deleteJob: (id: unknown) => cron.deleteJob(String(id)),
	});
	const extraPlugins: Awaited<ReturnType<typeof carrotManager.loadFromDir>>[] = [];
	const carrotsDir = resolveCarrotsDir();
	if (carrotsDir) {
		try {
			const cronCarrotPlugin = await carrotManager.loadFromDir(join(carrotsDir, "cron-tools"));
			extraPlugins.push(cronCarrotPlugin);
			console.log(`[carrots] loaded cron-tools (${extraPlugins.length} carrot(s) loaded from ${carrotsDir})`);
		} catch (err) {
			console.warn("[carrots] failed to load cron-tools:", err instanceof Error ? err.message : err);
		}
	} else {
		console.warn("[carrots] carrots dir not found — skipping carrot load");
	}
	runtime.setExtraPlugins(extraPlugins);

	// Portless — local-dev reverse proxy giving each app a stable
	// `<name>.localhost` URL instead of port-numbered URLs. v0 is HTTP-only
	// on a non-privileged port (no sudo, no certs). Persistent route
	// registry shared with the `portless` CLI via the standard state dir.
	const portless = new PortlessService();
	try { portless.start(); }
	catch (err) { console.warn("[portless] start failed:", err instanceof Error ? err.message : err); }
	// Local llama-server for embeddings (and later, optional chat fallback).
	// Lazy-spawned on first ensureRunning() call, with model auto-download.
	// We DO eagerly start it in the background so the first embedding call
	// (which fires from elizaOS evaluators on the first user message) doesn't
	// pay the 1-3s model-load cost. Failure is non-fatal — the embedding
	// plugin gracefully falls back to OpenAI key or zero vector.
	const llama = new LlamaServerService();
	// AWAIT llama startup BEFORE the runtime builds. Previously this was a
	// fire-and-forget Promise — the env vars below were set asynchronously,
	// so the embedding plugin's settings were already cached as undefined by
	// the time runtime.initialize() ran. Plugin then defaulted to
	// api.openai.com → OpenRouter fallback → "Invalid embedding received".
	// Blocking ~1s on first launch (model already on disk → fast) is the
	// price we pay for the embedding plugin to see OPENAI_EMBEDDING_URL
	// when it loads.
	try {
		const res = await llama.ensureRunning();
		if (res) {
			process.env.OPENAI_EMBEDDING_URL = `${res.url}/v1/embeddings`;
			process.env.OPENAI_EMBEDDING_API_KEY = process.env.OPENAI_EMBEDDING_API_KEY ?? "local-llama";
			process.env.OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "local";
			process.env.OPENAI_EMBEDDING_DIMENSIONS = process.env.OPENAI_EMBEDDING_DIMENSIONS ?? "384";
			console.log(`[core] local llama-server embeddings ready at ${res.url}`);
		} else {
			console.warn("[core] local llama-server unavailable; embeddings will fall back to OpenAI key or zeros");
		}
	} catch (err) {
		console.warn("[core] llama-server start failed:", err instanceof Error ? err.message : err);
	}

	// Import macOS contacts → entity graph + relationships, on every build
	// where the iMessage plugin is live. The iMessage service starts async
	// AFTER this hook fires (and itself spawns AppleScript to read Contacts.app
	// which can take several seconds), so we schedule the import on a delay
	// and retry once if the service isn't ready yet. Idempotent: stable
	// entity IDs derived from contact UUIDs.
	runtime.onAfterBuild(async (state) => {
		const tryImport = async (attempt: number): Promise<void> => {
			try {
				const { importImessageContacts } = await import("./channels/contact-import");
				const result = await importImessageContacts(state.runtime);
				if (result.available && result.contactsFound > 0) {
					console.log(`[contacts] imported ${result.entitiesCreated} entities + ${result.relationshipsCreated} relationships from ${result.contactsFound} macOS contacts (skipped ${result.skipped})`);
				} else if (!result.available && attempt < 3) {
					setTimeout(() => void tryImport(attempt + 1), attempt * 5000);
				} else if (result.error) {
					console.warn(`[contacts] import skipped after ${attempt} attempt(s): ${result.error}`);
				}
			} catch (err) {
				console.warn("[contacts] import failed:", err instanceof Error ? err.message : err);
			}
		};
		setTimeout(() => void tryImport(1), 5000);
	});

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
	const api = new ApiServer(runtime, activity);
	const { port } = await api.start(opts.port ?? 2138);

	console.log(`[core] api listening on http://127.0.0.1:${port}`);

	// Compose the dependency bag every typed-RPC handler reads from.
	// Per docs/rpc-migration.md — handlers are window-agnostic; the same
	// bag is mounted on every webview's RPC instance via WindowFactory.
	const rpcDeps = buildRpcDeps({
		runtime, vault, auth, backendOps, config, pensieve, activity,
		channels, gateway, inbox, llama, cron, ownerBind, portless,
	});

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
		portless,
		rpcDeps,
		stop: () => {
			discordObservations.stop();
			improvement.stop();
			activity.stop();
			pensieve.stop();
			cron.stop();
			api.stop();
			llama.stop();
			carrotManager.stopAll();
			portless.stop();
		},
	};
	return handle;
}

/**
 * Resolve the directory holding carrots. Carrot workers are spawned as
 * their own Bun.Worker processes that read TS source from disk, so the
 * host needs an actual filesystem path even when running from a bundled
 * `.app`. Resolution order:
 *
 *   1. DETOUR_CARROTS_DIR env override.
 *   2. Bundled .app: <execPath>/../Resources/app/carrots — populated by
 *      the `carrots/cron-tools → carrots/cron-tools` copy entry in
 *      electrobun.config.ts.
 *   3. Dev source: walk up from `process.execPath` looking for
 *      `electrobun.config.ts`, use that dir's `carrots/`. Useful when
 *      running `bun src/bun/index.ts` directly without going through
 *      `electrobun dev` — though in practice `electrobun dev` builds a
 *      bundle and (2) catches it.
 *   4. <cwd>/carrots — last-resort fallback.
 */
function resolveCarrotsDir(): string | null {
	const fromEnv = process.env.DETOUR_CARROTS_DIR?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	if (process.execPath) {
		const bundled = join(dirname(process.execPath), "..", "Resources", "app", "carrots");
		if (existsSync(bundled)) return bundled;
	}

	if (process.execPath) {
		let dir = dirname(process.execPath);
		for (let i = 0; i < 12; i++) {
			if (existsSync(join(dir, "electrobun.config.ts"))) {
				const carrots = join(dir, "carrots");
				if (existsSync(carrots)) return carrots;
				return null;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const fromCwd = join(process.cwd(), "carrots");
	if (existsSync(fromCwd)) return fromCwd;

	return null;
}

export { VaultService } from "./vault";
export { RuntimeService } from "./runtime";
export { AuthService } from "./auth";
export { ApiServer } from "./api/server";
export { ContinuousImprovementService, CONTINUOUS_IMPROVEMENT_TASK_NAME } from "./continuous-improvement-service";
export { DiscordObservationService, DISCORD_OBSERVATION_TASK_NAME } from "./discord-observation-service";
export { PensieveService } from "./pensieve";
export { ActivityService } from "./activity";
export { PensieveMemoryService } from "./pensieve/memory-service";
export { PensieveRelationshipService } from "./pensieve/relationship-service";
export { PensieveTemplatesService } from "./pensieve/templates-service";
export { PensieveChroniclerService } from "./pensieve/chronicler-service";
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
} from "../../shared/index";
