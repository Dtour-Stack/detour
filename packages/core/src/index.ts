import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ActivityService } from "./activity";
import { ApiServer } from "./api/server";
import { AuthService } from "./auth";
import { BackendOps } from "./backend-ops";
import { ChannelsService } from "./channels";
import { ChannelGatewayService } from "./channels/gateway";
import { ConfigService } from "./config-service";
import { InboxService } from "./inbox";
import { LlamaServerService } from "./llama/server-service";
import { PensieveService } from "./pensieve";
import { RuntimeService } from "./runtime";
import { VaultService } from "./vault";

export type CoreOptions = {
	port?: number;
	dataDir: string;
	pgliteDataDir: string;
};

/**
 * One-time migration: copy vault.json (+ audit) from a legacy location into
 * the current userData dir if the user's earlier session wrote there. This
 * happened because older builds used `~/.detour/eliza-state` while the
 * current build relies on Electrobun's userData (`~/Library/Application
 * Support/ai.detour.app/<channel>`). Without this migration the user
 * re-enters every credential because the Discord/Telegram tokens stored
 * earlier are silently invisible to the new path.
 *
 * Idempotent: skips if the destination already has vault.json.
 */
function migrateLegacyVault(targetStateDir: string): void {
	const targetVault = join(targetStateDir, "vault.json");
	if (existsSync(targetVault)) return;
	const candidates = [
		join(homedir(), ".detour", "eliza-state"),
	];
	for (const src of candidates) {
		const srcVault = join(src, "vault.json");
		if (!existsSync(srcVault)) continue;
		try {
			mkdirSync(targetStateDir, { recursive: true });
			cpSync(srcVault, targetVault, { mode: 0o600 });
			const srcAudit = join(src, "audit");
			if (existsSync(srcAudit)) {
				cpSync(srcAudit, join(targetStateDir, "audit"), { recursive: true });
			}
			console.log(`[vault] migrated legacy vault from ${src} → ${targetStateDir}`);
			return;
		} catch (err) {
			console.warn(
				`[vault] migration from ${src} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
}

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
	// Anchor @elizaos/vault at our userData dir so vault.json lives next to
	// PGlite (and per-channel: dev/stable separation comes for free). Must
	// run BEFORE migrateLegacyVault + VaultService construction since
	// createVault() reads ELIZA_STATE_DIR at call time.
	process.env.ELIZA_STATE_DIR = opts.dataDir;
	migrateLegacyVault(opts.dataDir);

	const vault = new VaultService();
	const auth = new AuthService();
	auth.enableClaudeCodeStealth();
	const config = new ConfigService(vault);
	await config.bootstrap(); // load persisted config + push to plugins
	const channels = new ChannelsService(vault);
	const runtime = new RuntimeService(vault, auth, channels);
	const backendOps = new BackendOps(vault);
	const pensieve = new PensieveService(runtime);
	pensieve.start();
	const activity = new ActivityService(runtime);
	activity.start();
	const gateway = new ChannelGatewayService();
	runtime.setGateway(gateway);
	runtime.onAfterBuild((state) => {
		gateway.attach(state.runtime);
	});
	const inbox = new InboxService(runtime, gateway);
	inbox.bindToGateway();
	// Local llama-server for embeddings (and later, optional chat fallback).
	// Lazy-spawned on first ensureRunning() call, with model auto-download.
	// We DO eagerly start it in the background so the first embedding call
	// (which fires from elizaOS evaluators on the first user message) doesn't
	// pay the 1-3s model-load cost. Failure is non-fatal — the embedding
	// plugin gracefully falls back to OpenAI key or zero vector.
	const llama = new LlamaServerService();
	void llama.ensureRunning().then((res) => {
		if (res) {
			// Tell our embedding plugin to use the local server. plugin-embedding-openai
			// already speaks OpenAI-compatible HTTP, so pointing OPENAI_EMBEDDING_URL
			// at the local server is enough.
			process.env.OPENAI_EMBEDDING_URL = `${res.url}/v1/embeddings`;
			process.env.OPENAI_EMBEDDING_API_KEY = process.env.OPENAI_EMBEDDING_API_KEY ?? "local-llama";
			process.env.OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "local";
			process.env.OPENAI_EMBEDDING_DIMENSIONS = process.env.OPENAI_EMBEDDING_DIMENSIONS ?? "384";
			console.log(`[core] local llama-server embeddings ready at ${res.url}`);
		} else {
			console.warn("[core] local llama-server unavailable; embeddings will fall back to OpenAI key or zeros");
		}
	}).catch((err) => {
		console.warn("[core] llama-server start failed:", err instanceof Error ? err.message : err);
	});

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
	const api = new ApiServer(runtime, vault, auth, backendOps, config, pensieve, activity, channels, gateway, inbox, llama);
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
			llama.stop();
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
