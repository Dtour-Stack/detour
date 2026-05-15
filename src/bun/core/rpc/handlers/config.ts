import type {
	AgentCharacterConfig,
	AgentConfig,
	AgentHfSyncPolicy,
	ModelConfig,
	ThemeChoice,
	TrayPrefs,
	UiPreferences,
	WindowConfig,
} from "../../../../shared/index";

type TrayPrefsListener = (prefs: TrayPrefs) => void;
const trayPrefsBunSubscribers = new Set<TrayPrefsListener>();

/**
 * Subscribe (bun-side) to tray pref changes. Used by features that
 * need to react in-process — e.g. the status-widget feature toggles
 * its overlay window on/off when the user flips
 * `tray.statusWidgetEnabled` in Settings. The RPC broadcaster is for
 * view-side listeners only; this hook fires before that broadcast.
 */
export function onTrayPrefsChangedBunSide(fn: TrayPrefsListener): () => void {
	trayPrefsBunSubscribers.add(fn);
	return () => trayPrefsBunSubscribers.delete(fn);
}
import type { AgentHfDumpJob, AgentHfDumpStatus } from "../../../../shared/rpc/config";
import type { RpcDeps } from "../types";

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
		configGetTrayPrefs: async (_params: Record<string, never>): Promise<TrayPrefs> => {
			return await deps.config.getTrayPrefs();
		},
		configSetTrayPrefs: async (params: TrayPrefs): Promise<TrayPrefs> => {
			const sanitized = await deps.config.setTrayPrefs(params);
			deps.broadcaster.broadcast("trayPrefsChanged", { prefs: sanitized });
			for (const fn of trayPrefsBunSubscribers) {
				try { fn(sanitized); } catch { /* swallow */ }
			}
			return sanitized;
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
			return await deps.agentHfSync.status();
		},
		agentHfDumpStartSync: async (params: { destination?: string; limit?: number }): Promise<AgentHfDumpJob> => {
			return await deps.agentHfSync.startSync("manual", params);
		},
		agentHfDumpGetJob: async (params: { id: string }): Promise<AgentHfDumpJob | null> => {
			return deps.agentHfSync.getJob(params.id);
		},
		agentHfDumpSetPolicy: async (params: AgentHfSyncPolicy): Promise<AgentHfDumpStatus["policy"]> => {
			return await deps.agentHfSync.setPolicy(params);
		},
	};
}
