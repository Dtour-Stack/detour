import type {
	AgentCharacterConfig,
	AgentConfig,
	ModelConfig,
	ThemeChoice,
	UiPreferences,
	WindowConfig,
} from "../../../../shared/index";
import type { AgentHfDumpJob, AgentHfDumpStatus } from "../../../../shared/rpc/config";
import {
	DEFAULT_HF_BUCKET,
	hfDatasetSyncCommand,
	syncAgentDumpToHf,
} from "../../../plugins/agent-public-log/index";
import type { RpcDeps } from "../types";

const hfDumpJobs = new Map<string, AgentHfDumpJob>();
let activeHfDumpJobId: string | null = null;

function activeHfDumpJob(): AgentHfDumpJob | null {
	if (!activeHfDumpJobId) return null;
	return hfDumpJobs.get(activeHfDumpJobId) ?? null;
}

function pruneHfDumpJobs(): void {
	const jobs = [...hfDumpJobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	for (const job of jobs.slice(10)) hfDumpJobs.delete(job.id);
}

async function hfCliAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["hf", "version"], { env: process.env, stdout: "pipe", stderr: "pipe" });
		await Promise.all([
			proc.stdout ? new Response(proc.stdout as ReadableStream<Uint8Array>).text() : Promise.resolve(""),
			proc.stderr ? new Response(proc.stderr as ReadableStream<Uint8Array>).text() : Promise.resolve(""),
		]);
		return await proc.exited === 0;
	} catch {
		return false;
	}
}

function normalizeHfDumpLimit(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 200;
	return Math.min(2000, Math.max(1, Math.floor(value)));
}

/**
 * Config + UI preferences RPC handlers. Mirrors the HTTP routes in
 * src/bun/core/api/server.ts (`/api/config/*`, `/api/ui/preferences`).
 *
 * Setters return `{ ok: true }` to keep the wire shape explicit — view
 * call sites typically `await rpc.request.configSetX(body)` and ignore
 * the body, just like the legacy `client.setX()` did.
 *
 * Side effects preserved from the HTTP layer:
 *   - configSetCharacter rebuilds the runtime so a renamed agent / new
 *     system prompt takes effect without restarting the app.
 *   - configSetModels rebuilds the runtime so new model names are picked
 *     up by elizaOS immediately.
 *   - uiSetPreferences broadcasts `uiPreferencesChanged` so every open
 *     window (Pensieve, Activity, Channels, chat) re-applies theme/accent
 *     live.
 */
export function configRequests(deps: RpcDeps) {
	return {
		configGetAgent: async (_params: Record<string, never>): Promise<AgentConfig> => {
			return await deps.config.getAgent();
		},
		configSetAgent: async (params: AgentConfig): Promise<{ ok: true }> => {
			await deps.config.setAgent(params);
			return { ok: true };
		},
		configGetCharacter: async (_params: Record<string, never>): Promise<AgentCharacterConfig> => {
			return await deps.config.getCharacter();
		},
		configSetCharacter: async (params: AgentCharacterConfig): Promise<{ ok: true }> => {
			await deps.config.setCharacter(params);
			await deps.runtime.rebuild().catch(() => {});
			return { ok: true };
		},
		configGetModels: async (_params: Record<string, never>): Promise<ModelConfig> => {
			return await deps.config.getModels();
		},
		configSetModels: async (params: ModelConfig): Promise<{ ok: true }> => {
			await deps.config.setModels(params);
			// Rebuild runtime so new model names take effect immediately.
			await deps.runtime.rebuild().catch(() => {});
			return { ok: true };
		},
		configGetWindow: async (_params: Record<string, never>): Promise<WindowConfig> => {
			return await deps.config.getWindow();
		},
		configSetWindow: async (params: WindowConfig): Promise<{ ok: true }> => {
			await deps.config.setWindow(params);
			return { ok: true };
		},
		uiGetPreferences: async (_params: Record<string, never>): Promise<UiPreferences> => {
			const v = await deps.vault.vault();
			const theme = ((await v.has("ui.theme")) ? await v.get("ui.theme") : "system") as ThemeChoice;
			const accent = ((await v.has("ui.accent")) ? await v.get("ui.accent") : "#0a84ff") as string;
			return { theme, accent };
		},
		uiSetPreferences: async (params: Partial<UiPreferences>): Promise<{ ok: true }> => {
			const v = await deps.vault.vault();
			if (typeof params.theme === "string") await v.set("ui.theme", params.theme);
			if (typeof params.accent === "string") await v.set("ui.accent", params.accent);
			// Broadcast so other open windows re-apply theme/accent without reload.
			const theme = ((await v.has("ui.theme")) ? await v.get("ui.theme") : "system") as ThemeChoice;
			const accent = ((await v.has("ui.accent")) ? await v.get("ui.accent") : "#0a84ff") as string;
			deps.broadcaster.broadcast("uiPreferencesChanged", { preferences: { theme, accent } });
			return { ok: true };
		},
		agentHfDumpStatus: async (_params: Record<string, never>): Promise<AgentHfDumpStatus> => {
			return {
				defaultDestination: DEFAULT_HF_BUCKET,
				hfAvailable: await hfCliAvailable(),
				activeJob: activeHfDumpJob(),
			};
		},
		agentHfDumpStartSync: async (params: { destination?: string; limit?: number }): Promise<AgentHfDumpJob> => {
			const existing = activeHfDumpJob();
			if (existing?.status === "running") return existing;
			const destination = params.destination?.trim() || DEFAULT_HF_BUCKET;
			if (!destination.startsWith("hf://")) {
				throw new Error("Hugging Face destination must start with `hf://`.");
			}
			const runtime = deps.runtime.peek();
			if (!runtime) throw new Error("Agent runtime is not ready yet.");
			const limit = normalizeHfDumpLimit(params.limit);
			const job: AgentHfDumpJob = {
				id: crypto.randomUUID(),
				destination,
				command: hfDatasetSyncCommand(destination),
				status: "running",
				startedAt: new Date().toISOString(),
				finishedAt: null,
				counts: null,
				stdout: null,
				stderr: null,
				error: null,
			};
			hfDumpJobs.set(job.id, job);
			activeHfDumpJobId = job.id;
			void (async () => {
				try {
					const result = await syncAgentDumpToHf(runtime, { destination, limit });
					job.status = "succeeded";
					job.counts = result.counts;
					job.stdout = result.stdout;
					job.stderr = result.stderr;
				} catch (err) {
					job.status = "failed";
					job.error = err instanceof Error ? err.message : String(err);
				} finally {
					job.finishedAt = new Date().toISOString();
					if (activeHfDumpJobId === job.id) activeHfDumpJobId = null;
					pruneHfDumpJobs();
				}
			})();
			return job;
		},
		agentHfDumpGetJob: async (params: { id: string }): Promise<AgentHfDumpJob | null> => {
			return hfDumpJobs.get(params.id) ?? null;
		},
	};
}
