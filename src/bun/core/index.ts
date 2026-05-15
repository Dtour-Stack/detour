import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearSkillsDirCache } from "@elizaos/skills";
import { ActivityService } from "./activity";
import { AgentHfSyncService } from "./agent-hf-sync-service";
import { ApiServer } from "./api/server";
import { AuthService } from "./auth";
import { BackendOps } from "./backend-ops";
import { ChannelsService } from "./channels";
import { ChannelGatewayService } from "./channels/gateway";
import { ConfigService } from "./config-service";
import { ContinuousImprovementService } from "./continuous-improvement-service";
import { DreamService } from "./dream-service";
import { GoalService } from "./goal-service";
import { attachGoalService } from "../plugins/detour-goal/index";
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
	stop: () => Promise<void>;
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

/**
 * Point @elizaos/skills at the repo's bundled skills before any runtime
 * import resolves paths (Electrobun / packaged layouts may not match
 * resolver heuristics). Clears the resolver cache so a later `getSkillsDir()`
 * picks up the override.
 */
function ensureBundledSkillsEnv(): void {
	if (process.env.ELIZAOS_BUNDLED_SKILLS_DIR?.trim()) {
		return;
	}
	const candidates: string[] = [
		join(import.meta.dir, "..", "..", "..", "eliza", "packages", "skills", "skills"),
	];
	if (typeof process.execPath === "string" && process.execPath.length > 0) {
		const ex = dirname(process.execPath);
		candidates.push(
			join(ex, "..", "Resources", "app", "node_modules", "@elizaos", "skills", "skills"),
			join(ex, "..", "Resources", "app", "eliza", "packages", "skills", "skills"),
			join(ex, "node_modules", "@elizaos", "skills", "skills"),
		);
	}
	for (const dir of candidates) {
		if (!existsSync(dir)) continue;
		process.env.ELIZAOS_BUNDLED_SKILLS_DIR = dir;
		try {
			clearSkillsDirCache();
		} catch {
			/* non-fatal if skills package not linked in a minimal build */
		}
		return;
	}
}

export async function startCore(opts: CoreOptions): Promise<CoreHandle> {
	ensureUsefulPath();
	ensureBundledSkillsEnv();
	process.env.PGLITE_DATA_DIR = opts.pgliteDataDir;
	// Anchor @elizaos/vault + auth at the canonical Detour data dir (~/.detour).
	// `<ELIZA_STATE_DIR>/auth/` is a SYMLINK to ~/.eliza/auth/, so eliza's
	// listAccounts() reads the same OAuth pool the user's other eliza apps use.
	// Must run BEFORE VaultService construction since createVault() reads
	// ELIZA_STATE_DIR at call time.
	process.env.ELIZA_STATE_DIR = opts.dataDir;
	// Per-agent sandbox dir for plugin-coding-tools. Pre-created here so
	// the path exists before any FILE/WRITE action fires; surfaced to the
	// agent via runtime settings (DETOUR_AGENT_SANDBOX) in
	// runtime.ts:buildRuntimeSettings.
	try {
		const agentSandboxDir = join(opts.dataDir, "agent-sandbox");
		mkdirSync(agentSandboxDir, { recursive: true });
		process.env.DETOUR_AGENT_SANDBOX = agentSandboxDir;
	} catch (err) {
		console.warn("[core] failed to create agent sandbox dir:", err instanceof Error ? err.message : err);
	}

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
	const agentHfSync = new AgentHfSyncService({
		runtime,
		config,
		trajectories: activity.trajectories,
	});
	agentHfSync.start();
	const gateway = new ChannelGatewayService();
	const improvement = new ContinuousImprovementService(runtime, pensieve.memories, activity.logs);
	improvement.start();
	// Goal service: capture explicit user goals + thread into sub-agent
	// spawns. Resolver passes through RuntimeService.peek() so we never
	// trigger a runtime rebuild from a goal read.
	const goal = new GoalService(() => runtime.peek(), pensieve.memories);
	attachGoalService(goal);
	runtime.setGoalService(goal);
	// Guaranteed spawn-action wrap: runs once the AgentRuntime is fully
	// assembled (orchestrator's PTYService + CodingWorkspaceService have
	// finished their async start), so CREATE_TASK / SPAWN_AGENT are in
	// runtime.actions when we walk it. Idempotent — re-builds also fire
	// the hook but the wrap marker makes subsequent passes no-ops.
	runtime.onAfterBuild(async (state) => {
		const { wrapSpawnActionsOnRuntime } = await import("../plugins/detour-goal/index");
		wrapSpawnActionsOnRuntime(state.runtime);
	});
	// Dream service: scheduled memory consolidation (Anthropic-dream pattern).
	// Registers a task worker on every runtime build via onAfterBuild.
	const dream = new DreamService({
		runtimeService: runtime,
		memories: pensieve.memories,
		trajectories: activity.trajectories,
	});
	dream.start();
	const discordObservations = new DiscordObservationService(runtime, pensieve.memories, gateway);
	discordObservations.start();
	// The companion is created later (line ~300) so we capture a
	// reference here that gets populated when it's ready. The gate
	// safely returns null if the companion hasn't booted yet — no
	// startup-order dependency, no race.
	let companionRef: import("./llama/companion-service").CompanionService | null = null;
	discordObservations.setShouldRespondHook(async ({ agentName, channel, recentMessages }) => {
		if (!companionRef) return null;
		return companionRef.shouldRespond(agentName, channel, recentMessages);
	});
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
				// Dedup by source so a job that ticks every 5-10 minutes
				// doesn't stack hundreds of identical pending inbox items
				// when the agent is failing or slow. If the previous tick is
				// still acting, the new fire is skipped; if it's pending
				// (last attempt failed), it's refreshed and re-prompted.
				dedupeBySource: true,
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

	// Shared RAM-budget gate for the three llama tiers; see memory-arbiter.ts.
	// Embedding is already running by this point — reserve its ~0.5 GB
	// working set so chat/companion checks see the real budget.
	const { MemoryArbiter } = await import("./llama/memory-arbiter");
	const arbiter = new MemoryArbiter();
	arbiter.reserve("embedding", 0.5);

	// Local chat service — second llama-server instance for chat completions.
	// Off by default; user enables from Settings → Local AI. When enabled,
	// the `local-chat` plugin (already registered in basePlugins) reads the
	// URL from DETOUR_LOCAL_CHAT_URL and routes TEXT_SMALL/MEDIUM/LARGE
	// against it.
	const { LocalChatService } = await import("./llama/chat-service");
	const localChat = new LocalChatService();
	localChat.attachArbiter(arbiter);
	if (process.env.DETOUR_LOCAL_CHAT_ENABLED === "true") {
		try {
			const result = await localChat.start();
			if (result) {
				console.log(`[core] local-chat ready at ${result.url} model=${result.modelPath}`);
			} else {
				console.warn("[core] local-chat enabled but failed to start");
			}
		} catch (err) {
			console.warn(
				"[core] local-chat start failed:",
				err instanceof Error ? err.message : err,
			);
		}
	}

	// Companion — small 0.6B sidecar model. Runs 5 light jobs to
	// offload trivial decisions (triage, should-respond, memory query
	// rewrite, context compression, persona pre-pass) from the cloud
	// planner. Off by default. When DETOUR_COMPANION_ENABLED=true is
	// set, auto-starts at boot; the runtime then wires the
	// shouldRespond gate into the Discord observation tick. Every
	// failure path returns null — agent hot paths never block on the
	// companion.
	const { CompanionService } = await import("./llama/companion-service");
	const companion = new CompanionService();
	// Wire the companion → local-chat dedup: when the user picks the same
	// modelRef for both tiers (e.g. eliza-1 0.6B for chat AND companion,
	// or Qwen3-0.6B for both), companion.start() will reuse the chat
	// server's port instead of spawning a duplicate ~3 GB process. Lookup
	// is re-resolved on each call, so stopping local-chat cleanly drops
	// the companion to classical-only.
	companion.attachLocalChat(localChat);
	companion.attachArbiter(arbiter);
	companionRef = companion;
	// Wire the Pensieve query-expansion hook to the companion's
	// memoryQuery job. When the companion is off this returns null
	// and Pensieve runs its literal-text path; no race, no startup
	// dependency.
	pensieve.memories.setMemoryQueryHook(async (userText) => {
		return companion.memoryQuery(userText);
	});
	// Persist every companion job to the memory store so the HF
	// auto-dump captures companion activity in the corpus that feeds
	// APOLLO fine-tuning. Cheap writes; the agent's main flow doesn't
	// retrieve `companion-job` entries (they're tagged for export only).
	companion.setPersistHook(async (entry) => {
		await pensieve.memories.create({
			text: `[companion:${entry.job}] ${entry.summary} (${entry.durationMs}ms ${entry.ok ? "ok" : "fail"})`,
			path: `/companion/${entry.job}`,
			type: "companion-job",
			tags: ["companion", `job:${entry.job}`, entry.ok ? "ok" : "fail"],
			extraMetadata: {
				job: entry.job,
				startedAt: entry.startedAt,
				durationMs: entry.durationMs,
				ok: entry.ok,
				summary: entry.summary,
			},
		});
	});
	// Wire APOLLO fine-tune readiness probe: count successful
	// trajectories since the last fine-tune marker. When the count
	// crosses APOLLO_FINETUNE_THRESHOLD, the LocalAITab Companion
	// section shows a "ready to retrain" indicator pointing at the
	// runbook in docs/companion-apollo-finetune.md.
	companion.setTrajectoryCountProbe(async () => {
		try {
			const result = await activity.trajectories.list({
				limit: 1,
				status: "completed",
			});
			return typeof result.total === "number" ? result.total : null;
		} catch {
			return null;
		}
	});
	// Wire the planner pre-pass (personaPrePass + compress + triage).
	// dpe-fallback-plugin reads this on every dynamicPromptExecFromState
	// call. Null returns are safe; the planner runs unchanged.
	const { setCompanionPlannerHook } = await import("./dpe-fallback-plugin");
	setCompanionPlannerHook({
		personaPrePass: (agentName, userText) =>
			companion.personaPrePass(agentName, userText),
		compress: (history, target) => companion.compress(history, target),
		triage: (userText) => companion.triage(userText),
	});
	if (process.env.DETOUR_COMPANION_ENABLED === "true") {
		try {
			const result = await companion.start();
			if (result) {
				console.log(
					`[core] companion ready at ${result.url} model=${result.modelPath}`,
				);
			} else {
				console.warn("[core] companion enabled but failed to start");
			}
		} catch (err) {
			console.warn(
				"[core] companion start failed:",
				err instanceof Error ? err.message : err,
			);
		}
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
	const api = new ApiServer(runtime, activity, {
		dream,
		improvement,
		agentHfSync,
		localChat,
		companion,
	});
	const { port } = await api.start(opts.port ?? 2138);

	console.log(`[core] api listening on http://127.0.0.1:${port}`);

	// Per-project static-file preview server registry. Hands out
	// stable `<slug>.localhost:<portlessPort>` URLs for static + carrot
	// projects; nextjs projects register their own dev-server port via
	// agentProjectRegisterPreviewPort.
	const { PreviewServerRegistry, setPreviewRegistry } = await import("./preview-server-registry");
	const previewServers = new PreviewServerRegistry(portless);
	setPreviewRegistry(previewServers);

	// Compose the dependency bag every typed-RPC handler reads from.
	// Per docs/rpc-migration.md — handlers are window-agnostic; the same
	// bag is mounted on every webview's RPC instance via WindowFactory.
	const rpcDeps = buildRpcDeps({
		runtime, vault, auth, backendOps, config, pensieve, activity,
		agentHfSync, channels, gateway, inbox, llama, localChat, companion, cron, ownerBind, portless, previewServers,
		goal, dream, memoryArbiter: arbiter,
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
		stop: async () => {
			discordObservations.stop();
			improvement.stop();
			agentHfSync.stop();
			dream.stop();
			activity.stop();
			pensieve.stop();
			cron.stop();
			api.stop();
			llama.stop();
			carrotManager.stopAll();
			await previewServers.stopAll();
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
	SetProviderKeyBody,
	SetActiveProviderBody,
	SetEnabledBackendsBody,
	Health,
} from "../../shared/index";
