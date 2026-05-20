import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@elizaos/core";
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
import { CronService, type CronJobInput, type CronJobUpdate } from "./cron-service";
import { DiscordObservationService } from "./discord-observation-service";
import { InboxService } from "./inbox";
import { OwnerBindService } from "./owner-bind";
import { newTraceId, traceScope } from "./trace";
import { LlamaServerService } from "./llama/server-service";
import { PortlessService } from "./portless";
import { PensieveService } from "./pensieve";
import type { ListMemoriesOptions, PensieveMemoryService } from "./pensieve/memory-service";
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

type PensieveMemoryCreateInput = Parameters<PensieveMemoryService["create"]>[0];

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isPlainRecord(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a string`);
	}
	return value;
}

function optionalStringField(input: Record<string, unknown>, field: string): string | undefined {
	const value = input[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string`);
	}
	return value;
}

function optionalBooleanField(input: Record<string, unknown>, field: string): boolean | undefined {
	const value = input[field];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be a boolean`);
	}
	return value;
}

function optionalNumberField(input: Record<string, unknown>, field: string): number | undefined {
	const value = input[field];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${field} must be a finite number`);
	}
	return value;
}

function optionalStringArrayField(input: Record<string, unknown>, field: string): string[] | undefined {
	const value = input[field];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${field} must be an array of strings`);
	}
	return value;
}

function optionalRecordField(input: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
	const value = input[field];
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) {
		throw new Error(`${field} must be an object`);
	}
	return value;
}

function cronJobInput(value: unknown): CronJobInput {
	const input = requireRecord(value, "cron job input");
	const schedule = optionalStringField(input, "schedule");
	const prompt = optionalStringField(input, "prompt");
	if (!schedule) throw new Error("schedule must be a non-empty string");
	if (!prompt) throw new Error("prompt must be a non-empty string");
	const name = optionalStringField(input, "name");
	const enabled = optionalBooleanField(input, "enabled");
	const createdBy = optionalStringField(input, "createdBy");
	const out: CronJobInput = {
		schedule,
		prompt,
	};
	if (name !== undefined) out.name = name;
	if (enabled !== undefined) out.enabled = enabled;
	if (createdBy !== undefined) out.createdBy = createdBy;
	return out;
}

function cronJobUpdate(value: unknown): CronJobUpdate {
	const input = requireRecord(value, "cron job update");
	const name = optionalStringField(input, "name");
	const schedule = optionalStringField(input, "schedule");
	const prompt = optionalStringField(input, "prompt");
	const enabled = optionalBooleanField(input, "enabled");
	const out: CronJobUpdate = {};
	if (name !== undefined) out.name = name;
	if (schedule !== undefined) out.schedule = schedule;
	if (prompt !== undefined) out.prompt = prompt;
	if (enabled !== undefined) out.enabled = enabled;
	return out;
}

function listMemoriesOptions(value: unknown): ListMemoriesOptions {
	if (value === undefined || value === null) return {};
	const input = requireRecord(value, "memory list options");
	const roomId = optionalStringField(input, "roomId");
	const entityId = optionalStringField(input, "entityId");
	const type = optionalStringField(input, "type");
	const q = optionalStringField(input, "q");
	const limit = optionalNumberField(input, "limit");
	const offset = optionalNumberField(input, "offset");
	const tag = optionalStringField(input, "tag");
	const tableName = optionalStringField(input, "tableName");
	const pathPrefix = optionalStringField(input, "pathPrefix");
	const out: ListMemoriesOptions = {};
	if (roomId !== undefined) out.roomId = roomId;
	if (entityId !== undefined) out.entityId = entityId;
	if (type !== undefined) out.type = type;
	if (q !== undefined) out.q = q;
	if (limit !== undefined) out.limit = limit;
	if (offset !== undefined) out.offset = offset;
	if (tag !== undefined) out.tag = tag;
	if (tableName !== undefined) out.tableName = tableName;
	if (pathPrefix !== undefined) out.pathPrefix = pathPrefix;
	return out;
}

function memoryCreateInput(value: unknown): PensieveMemoryCreateInput {
	const input = requireRecord(value, "memory create input");
	const text = optionalStringField(input, "text");
	if (text === undefined) throw new Error("text must be a string");
	const path = optionalStringField(input, "path");
	const type = optionalStringField(input, "type");
	const tags = optionalStringArrayField(input, "tags");
	const roomId = optionalStringField(input, "roomId");
	const entityId = optionalStringField(input, "entityId");
	const worldId = optionalStringField(input, "worldId");
	const extraMetadata = optionalRecordField(input, "extraMetadata");
	const tableName = optionalStringField(input, "tableName");
	const out: PensieveMemoryCreateInput = { text };
	if (path !== undefined) out.path = path;
	if (type !== undefined) out.type = type;
	if (tags !== undefined) out.tags = tags;
	if (roomId !== undefined) out.roomId = roomId;
	if (entityId !== undefined) out.entityId = entityId;
	if (worldId !== undefined) out.worldId = worldId;
	if (extraMetadata !== undefined) out.extraMetadata = extraMetadata;
	if (tableName !== undefined) out.tableName = tableName;
	return out;
}

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
		logger.warn({ src: "core", err: errorMessage(err) }, "[Core] failed to create agent sandbox dir");
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
		catch (err) { logger.warn({ src: "cron", err: errorMessage(err) }, "[CronService] attachRuntime failed"); }
	});

	// Local llama-server for embeddings (and later, optional chat fallback).
	// Lazy-spawned on first ensureRunning() call, with model auto-download.
	const llama = new LlamaServerService();

	// Carrot bridge — load runtime-installable plugins ("carrots"), each in
	// its own isolated Bun Worker. The CarrotManager exposes a curated set
	// of core service methods; carrots invoke them over RPC. See
	// src/bun/core/carrots/README and src/bun/carrot-sdk/.
	const carrotManager = new (await import("./carrots")).CarrotManager();
	carrotManager.registerService("cron", {
		listJobs: () => cron.listJobs(),
		getJob: (id: unknown) => cron.getJob(requireString(id, "cron job id")),
		createJob: (input: unknown) => cron.createJob(cronJobInput(input)),
		updateJob: (id: unknown, patch: unknown) => cron.updateJob(requireString(id, "cron job id"), cronJobUpdate(patch)),
		deleteJob: (id: unknown) => cron.deleteJob(requireString(id, "cron job id")),
	});
	carrotManager.registerService("vault", {
		hasMasterKey: async () => {
			try {
				const v = await vault.vault();
				return v !== null && v !== undefined;
			} catch {
				return false;
			}
		},
	});
	carrotManager.registerService("pensieve", {
		listMemories: (opts: unknown) => pensieve.memories.list(listMemoriesOptions(opts)),
		getMemory: (id: unknown) => pensieve.memories.get(requireString(id, "memory id")),
		createMemory: (input: unknown) => pensieve.memories.create(memoryCreateInput(input)),
		deleteMemory: (id: unknown) => pensieve.memories.remove(requireString(id, "memory id")),
		listTemplates: () => pensieve.templates.listTemplates(),
		getTemplate: (id: unknown) => pensieve.templates.getTemplate(requireString(id, "template id")),
	});
	carrotManager.registerService("channels", {
		listChannels: async () => {
			const snap = activity.pluginsSnapshot();
			const loadedNames = snap.plugins.map((p) => p.name);
			const liveRuntime = runtime.peek();
			const result = await channels.snapshot(loadedNames, liveRuntime);
			return result.channels.map((c) => c.id);
		},
		getChannelStatus: async (channelId: unknown) => {
			const id = requireString(channelId, "channel id");
			const snap = activity.pluginsSnapshot();
			const loadedNames = snap.plugins.map((p) => p.name);
			const liveRuntime = runtime.peek();
			const result = await channels.snapshot(loadedNames, liveRuntime);
			const channel = result.channels.find((c) => c.id === id);
			if (!channel) {
				throw new Error(`Channel "${id}" not found`);
			}
			return channel;
		},
	});
	carrotManager.registerService("llama", {
		status: () => llama.status(),
		ensureRunning: () => llama.ensureRunning(),
	});
	const extraPlugins: Awaited<ReturnType<typeof carrotManager.loadFromDir>>[] = [];
	const carrotsDir = resolveCarrotsDir();
	if (carrotsDir) {
		try {
			const cronCarrotPlugin = await carrotManager.loadFromDir(join(carrotsDir, "cron-tools"));
			extraPlugins.push(cronCarrotPlugin);
			logger.info({ src: "carrots", count: extraPlugins.length, carrotsDir }, "[CarrotManager] loaded cron-tools");
		} catch (err) {
			logger.warn({ src: "carrots", carrotsDir, err: errorMessage(err) }, "[CarrotManager] failed to load cron-tools");
		}
	} else {
		logger.warn({ src: "carrots" }, "[CarrotManager] carrots dir not found");
	}
	runtime.setExtraPlugins(extraPlugins);

	// Portless — local-dev reverse proxy giving each app a stable
	// `<name>.localhost` URL instead of port-numbered URLs. v0 is HTTP-only
	// on a non-privileged port (no sudo, no certs). Persistent route
	// registry shared with the `portless` CLI via the standard state dir.
	const portless = new PortlessService();
	try { portless.start(); }
	catch (err) { logger.warn({ src: "portless", err: errorMessage(err) }, "[PortlessService] start failed"); }

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
			// Eliza's knowledge service validates EMBEDDING_PROVIDER ∈
			// {"local","openai","google"}. We ARE local — the llama-server
			// is bundled with Detour and runs in-process. Eliza's "local"
			// path calls runtime.useModel(ModelType.TEXT_EMBEDDING, …)
			// which routes through our embedding-openai plugin → the
			// llama-server. (The plugin happens to speak OpenAI's wire
			// shape, but that's an implementation detail; semantically
			// this is local-only inference with no network egress.)
			process.env.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER ?? "local";
			process.env.LOCAL_EMBEDDING_MODEL = process.env.LOCAL_EMBEDDING_MODEL ?? "local";
			process.env.LOCAL_EMBEDDING_DIMENSIONS = process.env.LOCAL_EMBEDDING_DIMENSIONS ?? "384";
			logger.info({ src: "llama", url: res.url }, "[LlamaServerService] embeddings ready");
		} else {
			logger.warn({ src: "llama" }, "[LlamaServerService] unavailable for embeddings");
		}
	} catch (err) {
		logger.warn({ src: "llama", err: errorMessage(err) }, "[LlamaServerService] start failed");
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
				logger.info({ src: "local-chat", url: result.url, modelPath: result.modelPath }, "[LocalChatService] ready");
			} else {
				logger.warn({ src: "local-chat" }, "[LocalChatService] enabled but failed to start");
			}
		} catch (err) {
			logger.warn({ src: "local-chat", err: errorMessage(err) }, "[LocalChatService] start failed");
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
				logger.info({ src: "companion", url: result.url, modelPath: result.modelPath }, "[CompanionService] ready");
			} else {
				logger.warn({ src: "companion" }, "[CompanionService] enabled but failed to start");
			}
		} catch (err) {
			logger.warn({ src: "companion", err: errorMessage(err) }, "[CompanionService] start failed");
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
					logger.info({ src: "contacts", entitiesCreated: result.entitiesCreated, relationshipsCreated: result.relationshipsCreated, contactsFound: result.contactsFound, skipped: result.skipped }, "[ContactImport] imported macOS contacts");
				} else if (!result.available && attempt < 3) {
					setTimeout(() => void tryImport(attempt + 1), attempt * 5000);
				} else if (result.error) {
					logger.warn({ src: "contacts", attempt, err: result.error }, "[ContactImport] import skipped");
				}
			} catch (err) {
				logger.warn({ src: "contacts", err: errorMessage(err) }, "[ContactImport] import failed");
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
			if (result.applied > 0) {
				logger.info({ src: "pensieve", applied: result.applied, names: result.names }, "[PensieveTemplatesService] applied templates to runtime");
			}
		} catch (err) {
			logger.warn({ src: "pensieve", err: errorMessage(err) }, "[PensieveTemplatesService] template injection failed");
		}
	});
	// Tray-state builder for the Swift DetourTray.app companion. Gathers
	// from every service it needs in one read — kept compact since the
	// tray polls every ~4s.
	const { LOCAL_CHAT_PRESETS } = await import("./llama/chat-service");
	const { COMPANION_MODEL_PRESETS } = await import("./llama/companion-service");
	const { isModelDownloaded } = await import("./llama/server-service");

	const buildTraySnapshot = async () => {
		const llamaSnap = llama.status();
		const localChatSnap = localChat.status();
		const companionSnap = companion.status();
		const memorySnap = arbiter.inspect();
		// Local MLX image/video — best-effort. The MLX socket may not
		// be reachable (Swift not running, or hardware not Apple Silicon).
		// We use connectTimeoutMs=0 so non-Apple-Silicon Macs (or pre-Swift
		// boot) fast-fail instead of stalling the 4s tray broadcaster.
		const { mlxRpc } = await import("./mlx-rpc-client");
		const FAST = 0;
		const localMlxImage = await (async () => {
			try {
				const presets = (await mlxRpc.call<{ presets: unknown[] }>("mlx.image.presets", {}, 2000, FAST)).presets;
				return { available: true, presets };
			} catch {
				return { available: false, presets: [] };
			}
		})();
		// Local video removed — no MLX port, no preset list to fetch.
		const localMlxStt = await (async () => {
			try {
				const presets = (await mlxRpc.call<{ presets: unknown[] }>("mlx.stt.presets", {}, 2000, FAST)).presets;
				return { available: true, presets };
			} catch {
				return { available: false, presets: [] };
			}
		})();
		const localMlxTts = await (async () => {
			try {
				const presets = (await mlxRpc.call<{ presets: unknown[] }>("mlx.tts.presets", {}, 2000, FAST)).presets;
				return { available: true, presets };
			} catch {
				return { available: false, presets: [] };
			}
		})();
		const localMlxVision = await (async () => {
			try {
				const presets = (await mlxRpc.call<{ presets: unknown[] }>("mlx.vision.presets", {}, 2000, FAST)).presets;
				return { available: true, presets };
			} catch {
				return { available: false, presets: [] };
			}
		})();
		const mlxHealth = await (async () => {
			try { return await mlxRpc.call("mlx.health", {}, 2000, FAST); } catch { return null; }
		})();
		const providers = await vault.listProviders().catch(() => [] as Awaited<ReturnType<typeof vault.listProviders>>);
		const activeProviderId = providers.find((p) => p.active)?.id ?? null;
		const trajectoriesResult = await activity.trajectories
			.list({ limit: 5, offset: 0 })
			.catch(() => ({ trajectories: [] as Array<{
				id: string;
				source?: string;
				startTime?: number;
				status?: string;
			}> }));
		const prefs = await config.getTrayPrefs().catch(() => null);
		const chatPresets = LOCAL_CHAT_PRESETS.map((p) => ({
			id: p.id,
			label: p.label,
			approxLiveRamGB: p.approxLiveRamGB,
			approxDiskGB: p.approxDiskGB,
			downloaded: isModelDownloaded(p.modelRef),
		}));
		const companionPresets = COMPANION_MODEL_PRESETS.map((p) => ({
			id: p.id,
			label: p.label,
			approxLiveRamGB: p.approxLiveRamGB,
			approxDiskGB: p.approxDiskMB / 1024,
			downloaded: isModelDownloaded(p.modelRef),
		}));
		return {
			activeProviderId,
			providers: providers.map((p) => ({
				id: p.id,
				label: p.label,
				active: !!p.active,
				configured: !!p.hasKey || (p.oauthAccountCount ?? 0) > 0,
			})),
			embed: {
				running: llamaSnap.running,
				...(llamaSnap.downloadProgress
					? {
						downloadPercent: llamaSnap.downloadProgress.percent,
						downloadedBytes: llamaSnap.downloadProgress.downloadedBytes,
						totalBytes: llamaSnap.downloadProgress.totalBytes,
					}
					: {}),
				lastError: llamaSnap.lastError,
			},
			localChat: {
				enabled: localChatSnap.enabled,
				running: localChatSnap.running,
				preset: localChatSnap.preset,
				...(localChatSnap.downloadProgress
					? {
						downloadPercent: localChatSnap.downloadProgress.percent,
						downloadedBytes: localChatSnap.downloadProgress.downloadedBytes,
						totalBytes: localChatSnap.downloadProgress.totalBytes,
					}
					: {}),
				lastArbiterRefusal: localChat.getLastArbiterRefusal(),
				presets: chatPresets,
			},
			companion: {
				enabled: companionSnap.enabled,
				running: companionSnap.running,
				preset: companionSnap.preset,
				sharedWithLocalChat: companionSnap.sharedWithLocalChat,
				...(companionSnap.downloadProgress
					? {
						downloadPercent: companionSnap.downloadProgress.percent,
						downloadedBytes: companionSnap.downloadProgress.downloadedBytes,
						totalBytes: companionSnap.downloadProgress.totalBytes,
					}
					: {}),
				lastArbiterRefusal: companion.getLastArbiterRefusal(),
				presets: companionPresets,
			},
			memory: {
				totalGB: memorySnap.totalGB,
				headroomGB: memorySnap.headroomGB,
				budgetGB: memorySnap.budgetGB,
				usedGB: memorySnap.usedGB,
			},
			localMlxImage: {
				enabled: process.env.LOCAL_MLX_IMAGE_ENABLED?.toLowerCase() === "true" || process.env.LOCAL_MLX_IMAGE_ENABLED === "1",
				available: localMlxImage.available,
				preset: process.env.LOCAL_MLX_IMAGE_PRESET ?? null,
				presets: localMlxImage.presets,
			},
			localMlxVideo: {
				enabled: false,
				available: false,
				preset: null,
				presets: [],
			},
			localMlxStt: {
				enabled: process.env.LOCAL_MLX_STT_ENABLED?.toLowerCase() === "true" || process.env.LOCAL_MLX_STT_ENABLED === "1",
				available: localMlxStt.available,
				preset: process.env.LOCAL_MLX_STT_PRESET ?? null,
				presets: localMlxStt.presets,
			},
			localMlxTts: {
				enabled: process.env.LOCAL_MLX_TTS_ENABLED?.toLowerCase() === "true" || process.env.LOCAL_MLX_TTS_ENABLED === "1",
				available: localMlxTts.available,
				preset: process.env.LOCAL_MLX_TTS_PRESET ?? null,
				presets: localMlxTts.presets,
			},
			localMlxVision: {
				enabled: process.env.LOCAL_MLX_VISION_ENABLED?.toLowerCase() === "true" || process.env.LOCAL_MLX_VISION_ENABLED === "1",
				available: localMlxVision.available,
				preset: process.env.LOCAL_MLX_VISION_PRESET ?? null,
				presets: localMlxVision.presets,
			},
			mlxHealth,
			modelRouting: await (async () => {
				const { ROUTING_CATALOG, ROUTED_TYPE_LABELS, getProviderFor } = await import("./model-routing");
				const cloudConfigured = new Set<string>(
					providers.filter((p) => p.hasKey || (p.oauthAccountCount ?? 0) > 0).map((p) => p.id)
				);
				const localAvailable = new Set<string>([
					...(localMlxImage.available ? ["local-mlx-image"] : []),
					...(localMlxStt.available ? ["local-mlx-stt"] : []),
					...(localMlxTts.available ? ["local-mlx-tts"] : []),
					...(localMlxVision.available ? ["local-mlx-vision"] : []),
				]);
				return ROUTING_CATALOG.map((entry) => {
					const explicit = getProviderFor(null, entry.type);
					return {
						type: entry.type,
						label: ROUTED_TYPE_LABELS[entry.type],
						selected: explicit ?? "",
						options: entry.options.map((opt) => ({
							id: opt.id,
							label: opt.label,
							kind: opt.kind,
							available: opt.kind === "local"
								? localAvailable.has(opt.id)
								: cloudConfigured.has(opt.id),
						})),
					};
				});
			})(),
			recentTrajectories: trajectoriesResult.trajectories.slice(0, 5).map((t) => ({
				id: t.id,
				...(t.source !== undefined ? { source: t.source } : {}),
				...(t.startTime !== undefined ? { startTime: t.startTime } : {}),
				...(t.status !== undefined ? { status: t.status } : {}),
			})),
			traySlots: prefs?.slots ?? [],
		};
	};

	const api = new ApiServer(
		runtime,
		activity,
		{ dream, improvement, agentHfSync, localChat, companion, pensieve, config },
		buildTraySnapshot,
	);
	const { port } = await api.start(opts.port ?? 2138);

	logger.info({ src: "core", port }, "[Core] API listening");

	// 2026 perf: typed RPC over Unix domain socket. Coexists with the
	// HTTP server above during migration. Per-call latency ~80µs vs
	// ~1ms for the HTTP loopback. Swift launcher uses this; legacy
	// HTTP callers (external curl, eval drivers) keep working unchanged.
	const { startRpcSocket, buildAgentMethods, startTrayBroadcaster } = await import("./rpc-socket");
	const rpcMethods = buildAgentMethods({
		runtime, activity, pensieve, config, vault, inbox,
		trayStateBuilder: buildTraySnapshot,
	});
	const rpcSocket = startRpcSocket(rpcMethods);
	// Push-based tray-state: bun polls every 4s, diffs, only emits
	// when the snapshot changes. Clients drop their HTTP polling.
	const stopTrayBroadcaster = startTrayBroadcaster(buildTraySnapshot);

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
			if (state) {
				logger.info({ src: "runtime", provider: state.provider }, "[RuntimeService] runtime warm");
			} else {
				logger.info({ src: "runtime" }, "[RuntimeService] runtime not built");
			}
		})
		.catch((err) => logger.warn({ src: "runtime", err: errorMessage(err) }, "[RuntimeService] eager build failed"));

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
			stopTrayBroadcaster();
			rpcSocket.stop();
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
