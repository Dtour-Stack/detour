import type { Server, ServerWebSocket } from "bun";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeService } from "../runtime";
import type { AuthService } from "../auth";
import { ALL_PROVIDER_IDS, PROVIDER_ENV } from "../auth";
import type { BackendOps, InstallableBackendId } from "../backend-ops";
import type { ConfigService } from "../config-service";
import type { ActivityService } from "../activity";
import type { ChannelsService } from "../channels";
import type { ChannelGatewayService } from "../channels/gateway";
import type { CronService } from "../cron-service";
import type { OwnerBindService, OwnerConnector } from "../owner-bind";
import { newTraceId, traceScope } from "../trace";
import type { InboxService, InboxKind, InboxStatus } from "../inbox";
import type { LlamaServerService } from "../llama/server-service";
import type { PensieveService } from "../pensieve";
import { pensieveAudit } from "../pensieve";
import { listPermissions, openPermissionPane, type PermissionId } from "../os-permissions";
import { fetchOpenRouterModels } from "../openrouter-models";
import {
	BACKEND_INSTALL_SPECS,
	buildInstallCommand,
	categorizeKey,
	currentPlatform,
	deleteSavedLogin,
	detectPackageManagers,
	inferProviderId,
	listVaultInventory,
	readEntryMeta,
	readRoutingConfig,
	removeEntryMeta,
	resolveRunnableMethods,
	setEntryMeta,
	setSavedLogin,
	type SavedLogin,
	type VaultService,
	writeRoutingConfig,
} from "../vault";
import type {
	WsClientMessage,
	WsServerMessage,
	SetProviderKeyBody,
	SetActiveProviderBody,
	SetEnabledBackendsBody,
	ChroniclerConfig,
	ProviderId,
	BrowserCommand,
	BrowserCommandInput,
	BrowserCommandResult,
} from "@detour/shared";

const VERSION = "0.0.1";

type WsData = { id: string };

type Listener = (msg: WsServerMessage) => void;

const BROWSER_CONTROL_GLOBAL = Symbol.for("detour.browser.control");
const MAX_BROWSER_COMMANDS = 100;
const INBOX_STATUSES = new Set(["pending", "acting", "acknowledged", "acted", "dismissed"]);

function parseInboxStatus(value: unknown): InboxStatus | null {
	return typeof value === "string" && INBOX_STATUSES.has(value) ? value as InboxStatus : null;
}

type BrowserControlGlobal = {
	enqueue(command: BrowserCommandInput): BrowserCommand;
	enqueueAndWait(command: BrowserCommandInput, timeoutMs?: number): Promise<BrowserCommandResult>;
};

export type WindowCommand =
	| { kind: "hide" }
	| { kind: "pin"; on: boolean }
	| { kind: "resize"; width: number; height: number };

export type WindowController = (cmd: WindowCommand) => void;

export class ApiServer {
	private server: Server<WsData> | null = null;
	private port = 0;
	private subscribers = new Map<string, ServerWebSocket<WsData>>();
	private lockFile = join(homedir(), ".detour", "runtime.json");
	private windowController: WindowController | null = null;
	private channelReloadTimer: ReturnType<typeof setTimeout> | null = null;
	private browserCommands: BrowserCommand[] = [];
	private browserResults = new Map<string, BrowserCommandResult>();
	private browserWaiters = new Map<string, {
		resolve: (result: BrowserCommandResult) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	/**
	 * Debounce runtime reloads triggered by channel credential changes.
	 * Without this, pasting Discord token + Telegram token + iMessage flag
	 * back-to-back fires three rebuilds; each restarts the Telegraf poll
	 * before the previous one's long-poll has timed out, triggering
	 * Telegram's "409 Conflict: terminated by other getUpdates request"
	 * cascade. Coalesce changes within 1.5s into a single rebuild.
	 */
	private scheduleChannelReload(): void {
		if (this.channelReloadTimer) clearTimeout(this.channelReloadTimer);
		this.channelReloadTimer = setTimeout(() => {
			this.channelReloadTimer = null;
			void this.runtime.rebuild().catch((err) => {
				console.warn("[channels] debounced auto-reload failed:", err);
			});
		}, 1500);
	}

	private installBrowserControlGlobal(): void {
		(globalThis as Record<symbol, BrowserControlGlobal>)[BROWSER_CONTROL_GLOBAL] = {
			enqueue: (command) => this.enqueueBrowserCommand(command),
			enqueueAndWait: (command, timeoutMs) => this.enqueueBrowserCommandAndWait(command, timeoutMs),
		};
	}

	private removeBrowserControlGlobal(): void {
		const g = globalThis as Record<symbol, BrowserControlGlobal | undefined>;
		if (g[BROWSER_CONTROL_GLOBAL]?.enqueue) {
			delete g[BROWSER_CONTROL_GLOBAL];
		}
	}

	private enqueueBrowserCommand(input: BrowserCommandInput): BrowserCommand {
		const command = {
			...input,
			id: crypto.randomUUID(),
			time: Date.now(),
		} as BrowserCommand;
		this.browserCommands.push(command);
		if (this.browserCommands.length > MAX_BROWSER_COMMANDS) {
			this.browserCommands.splice(0, this.browserCommands.length - MAX_BROWSER_COMMANDS);
		}
		this.broadcast({ kind: "ui:open-browser" });
		this.broadcast({ kind: "browser:command", command });
		return command;
	}

	private enqueueBrowserCommandAndWait(input: BrowserCommandInput, timeoutMs = 30_000): Promise<BrowserCommandResult> {
		const command = this.enqueueBrowserCommand(input);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.browserWaiters.delete(command.id);
				resolve({
					ok: false,
					error: `Browser command timed out after ${timeoutMs}ms`,
					time: Date.now(),
				});
			}, timeoutMs);
			this.browserWaiters.set(command.id, { resolve, timer });
		});
	}

	private finishBrowserCommand(commandId: string, result: Omit<BrowserCommandResult, "time"> & { time?: number }): BrowserCommandResult {
		const complete: BrowserCommandResult = {
			...result,
			time: typeof result.time === "number" ? result.time : Date.now(),
		};
		this.browserResults.set(commandId, complete);
		if (this.browserResults.size > MAX_BROWSER_COMMANDS) {
			const first = this.browserResults.keys().next().value;
			if (typeof first === "string") this.browserResults.delete(first);
		}
		const waiter = this.browserWaiters.get(commandId);
		if (waiter) {
			clearTimeout(waiter.timer);
			this.browserWaiters.delete(commandId);
			waiter.resolve(complete);
		}
		return complete;
	}

	private parseBrowserCommand(body: unknown): BrowserCommandInput | null {
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		const bag = body as Record<string, unknown>;
			if (bag.kind === "open") {
			const url = typeof bag.url === "string" ? bag.url.trim() : "";
			if (!url || url.length > 2048) return null;
			return {
				kind: "open",
				url,
				...(typeof bag.newTab === "boolean" ? { newTab: bag.newTab } : {}),
				...(typeof bag.tabId === "string" ? { tabId: bag.tabId } : {}),
				source: "api",
			};
			}
			if (bag.kind === "inspect") {
				return {
					kind: "inspect",
					...(typeof bag.tabId === "string" ? { tabId: bag.tabId } : {}),
					...(typeof bag.timeoutMs === "number" ? { timeoutMs: bag.timeoutMs } : {}),
					source: "api",
				};
			}
			if (bag.kind === "script") {
				const script = typeof bag.script === "string" ? bag.script.trim() : "";
				if (!script || script.length > 100_000) return null;
				return {
					kind: "script",
					script,
					...(typeof bag.tabId === "string" ? { tabId: bag.tabId } : {}),
					...(typeof bag.timeoutMs === "number" ? { timeoutMs: bag.timeoutMs } : {}),
					source: "api",
				};
			}
			if (bag.kind === "fill-login") {
			const source = bag.source;
			const identifier = typeof bag.identifier === "string" ? bag.identifier.trim() : "";
			if ((source !== "in-house" && source !== "1password" && source !== "bitwarden") || !identifier) {
				return null;
			}
			const targetUrl = typeof bag.targetUrl === "string" && bag.targetUrl.trim().length > 0
				? bag.targetUrl.trim()
				: undefined;
			return {
				kind: "fill-login",
				source,
				identifier,
					...(targetUrl ? { targetUrl } : {}),
					...(typeof bag.newTab === "boolean" ? { newTab: bag.newTab } : {}),
					...(typeof bag.tabId === "string" ? { tabId: bag.tabId } : {}),
					...(typeof bag.timeoutMs === "number" ? { timeoutMs: bag.timeoutMs } : {}),
				};
			}
		return null;
	}

	setWindowController(fn: WindowController | null): void {
		this.windowController = fn;
	}

	constructor(
		private readonly runtime: RuntimeService,
		private readonly vault: VaultService,
		private readonly auth: AuthService,
		private readonly backendOps: BackendOps,
		private readonly config: ConfigService,
		private readonly pensieve: PensieveService,
		private readonly activity: ActivityService,
		private readonly channels: ChannelsService,
		private readonly gateway: ChannelGatewayService,
		private readonly inbox: InboxService,
		private readonly llama: LlamaServerService,
		private readonly cron: CronService,
		private readonly ownerBind: OwnerBindService,
	) {}

	async start(preferredPort = 2138): Promise<{ port: number }> {
		this.installBrowserControlGlobal();
		// Try preferred port first; fall back to ephemeral if taken
		try {
			return await this.tryStart(preferredPort);
		} catch (err) {
			if ((err as { code?: string }).code === "EADDRINUSE") {
				console.warn(`[core] port ${preferredPort} in use, falling back to ephemeral`);
				return this.tryStart(0);
			}
			throw err;
		}
	}

	private async tryStart(port: number): Promise<{ port: number }> {
		const json = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { "content-type": "application/json" },
			});
		const ok = () => json({ ok: true });
		const error = (message: string, status = 400) =>
			json({ ok: false, error: message }, status);

		this.server = Bun.serve<WsData, never>({
			port,
			hostname: "127.0.0.1",
			fetch: async (req, server) => {
				const url = new URL(req.url);
				const path = url.pathname;

				if (path === "/ws") {
					const id = crypto.randomUUID();
					if (server.upgrade(req, { data: { id } })) return;
					return error("upgrade failed", 426);
				}

				try {
					if (req.method === "GET" && path === "/api/health") {
						return json({ ok: true, version: VERSION });
					}
					if (req.method === "GET" && path === "/api/providers") {
						const list = await this.vault.listProviders();
						await this.runtime.getOrBuild().catch(() => {});
						const runtimeProvider = this.runtime.getCurrentProvider();
						const enriched = list.map((p) => ({
							...p,
							active: runtimeProvider === p.id,
						}));
						return json(enriched);
					}
					if (req.method === "GET" && path === "/api/providers/openrouter/models") {
						const manager = await this.vault.manager();
						const apiKey = await manager.has("OPENROUTER_API_KEY")
							? await manager.get("OPENROUTER_API_KEY")
							: undefined;
						return json(await fetchOpenRouterModels({ apiKey }));
					}
					const setKey = path.match(/^\/api\/providers\/([^/]+)\/key$/);
					if (req.method === "PUT" && setKey) {
						const id = setKey[1] as ProviderId;
						const body = (await req.json()) as SetProviderKeyBody;
						await this.vault.setProviderKey(id, body.key);
						const current = this.runtime.getCurrentProvider();
						if (!current || current === id) await this.runtime.rebuild();
						this.broadcast({
							kind: "provider:changed",
							activeProvider: await this.vault.getActiveProvider(),
						});
						return ok();
					}
					if (req.method === "DELETE" && setKey) {
						const id = setKey[1] as ProviderId;
						await this.vault.removeProviderKey(id);
						if (this.runtime.getCurrentProvider() === id) {
							await this.runtime.rebuild();
						}
						this.broadcast({
							kind: "provider:changed",
							activeProvider: await this.vault.getActiveProvider(),
						});
						return ok();
					}
					if (req.method === "PUT" && path === "/api/providers/active") {
						const body = (await req.json()) as SetActiveProviderBody;
						await this.vault.setActiveProvider(body.id);
						await this.runtime.rebuild();
						this.broadcast({
							kind: "provider:changed",
							activeProvider: body.id,
						});
						return ok();
					}
					if (req.method === "GET" && path === "/api/backends") {
						const manager = await this.vault.manager();
						return json(await manager.detectBackends());
					}
					if (req.method === "GET" && path === "/api/backends/enabled") {
						const manager = await this.vault.manager();
						const prefs = await manager.getPreferences();
						return json({ enabled: prefs.enabled });
					}
					if (req.method === "PUT" && path === "/api/backends/enabled") {
						const body = (await req.json()) as SetEnabledBackendsBody;
						const manager = await this.vault.manager();
						const prefs = await manager.getPreferences();
						await manager.setPreferences({
							...prefs,
							enabled: body.enabled as any,
						});
						return ok();
					}
					// --- backend ops: diagnose / signin / signout ---
					if (req.method === "GET" && path === "/api/backends/1password/diagnose") {
						return json(await this.backendOps.diagnoseOnePassword());
					}
					const signInMatch = path.match(/^\/api\/backends\/([^/]+)\/signin$/);
					if (req.method === "POST" && signInMatch) {
						const id = decodeURIComponent(signInMatch[1] ?? "") as InstallableBackendId;
						const body = (await req.json()) as Omit<
							Parameters<typeof this.backendOps.signIn>[0],
							"backendId"
						>;
						const result = await this.backendOps.signIn({ backendId: id, ...body });
						this.broadcast({ kind: "backend:changed", backendId: id });
						return json(result);
					}
					const signOutMatch = path.match(/^\/api\/backends\/([^/]+)\/signout$/);
					if (req.method === "POST" && signOutMatch) {
						const id = decodeURIComponent(signOutMatch[1] ?? "") as InstallableBackendId;
						await this.backendOps.signOut(id);
						this.broadcast({ kind: "backend:changed", backendId: id });
						return ok();
					}

					// --- system browser (OAuth flows can't use window.open from inside a webview) ---
					if (req.method === "POST" && path === "/api/external/open") {
						const body = (await req.json()) as { url: string };
						if (typeof body.url !== "string" || !/^https?:\/\//i.test(body.url)) {
							return error("invalid url", 400);
						}
						const cmd =
							process.platform === "darwin"
								? "open"
								: process.platform === "win32"
									? "start"
									: "xdg-open";
						const { spawn: sp } = await import("node:child_process");
						sp(cmd, [body.url], { stdio: "ignore", detached: true, shell: false }).unref();
						return ok();
					}

					if (req.method === "GET" && path === "/api/browser/commands") {
						const after = url.searchParams.get("after") ?? "";
						const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : 0;
						const afterIndex = after
							? this.browserCommands.findIndex((command) => command.id === after)
							: -1;
						const commands = afterIndex >= 0
							? this.browserCommands.slice(afterIndex + 1)
							: this.browserCommands.filter((command) => !since || command.time >= since);
						return json({ commands: commands.filter((command) => !this.browserResults.has(command.id)) });
					}
					if (req.method === "POST" && path === "/api/browser/commands") {
						const input = this.parseBrowserCommand(await req.json());
						if (!input) return error("invalid browser command", 400);
						return json({ command: this.enqueueBrowserCommand(input) });
					}
					const browserResultMatch = path.match(/^\/api\/browser\/commands\/([^/]+)\/result$/);
					if (req.method === "POST" && browserResultMatch) {
						const id = decodeURIComponent(browserResultMatch[1] ?? "");
						const body = await req.json() as Record<string, unknown>;
						const okResult = body.ok === true;
						const result = this.finishBrowserCommand(id, {
							ok: okResult,
							...(body.result !== undefined ? { result: body.result } : {}),
							...(typeof body.error === "string" ? { error: body.error } : {}),
							...(typeof body.text === "string" ? { text: body.text } : {}),
						});
						return json({ result });
					}

					// --- window control (chat popup) ---
					if (req.method === "POST" && path === "/api/window/hide") {
						this.windowController?.({ kind: "hide" });
						return ok();
					}
					if (req.method === "POST" && path === "/api/window/pin") {
						const body = (await req.json()) as { on: boolean };
						this.windowController?.({ kind: "pin", on: !!body.on });
						return ok();
					}
					if (req.method === "POST" && path === "/api/window/resize") {
						const body = (await req.json()) as { width: number; height: number };
						this.windowController?.({
							kind: "resize",
							width: Math.max(320, Math.min(2000, Number(body.width) || 0)),
							height: Math.max(320, Math.min(2000, Number(body.height) || 0)),
						});
						return ok();
					}

					// --- OS permissions (macOS TCC) ---
					if (req.method === "GET" && path === "/api/os/permissions") {
						return json(await listPermissions());
					}
					const osPermOpen = path.match(/^\/api\/os\/permissions\/([^/]+)\/open$/);
					if (req.method === "POST" && osPermOpen) {
						const id = decodeURIComponent(osPermOpen[1] ?? "") as PermissionId;
						try {
							await openPermissionPane(id);
							return ok();
						} catch (err) {
							return error(err instanceof Error ? err.message : String(err), 400);
						}
					}

					// --- App configuration (agent permissions, models, window) ---
					if (req.method === "GET" && path === "/api/config/agent") {
						return json(await this.config.getAgent());
					}
					if (req.method === "PUT" && path === "/api/config/agent") {
						const body = (await req.json()) as Parameters<ConfigService["setAgent"]>[0];
						await this.config.setAgent(body);
						return ok();
					}
					if (req.method === "GET" && path === "/api/config/character") {
						return json(await this.config.getCharacter());
					}
					if (req.method === "PUT" && path === "/api/config/character") {
						const body = (await req.json()) as Parameters<ConfigService["setCharacter"]>[0];
						await this.config.setCharacter(body);
						await this.runtime.rebuild().catch(() => {});
						return ok();
					}
					if (req.method === "GET" && path === "/api/config/models") {
						return json(await this.config.getModels());
					}
					if (req.method === "PUT" && path === "/api/config/models") {
						const body = (await req.json()) as Parameters<ConfigService["setModels"]>[0];
						await this.config.setModels(body);
						// Rebuild runtime so new model names take effect immediately
						await this.runtime.rebuild().catch(() => {});
						return ok();
					}
					if (req.method === "GET" && path === "/api/config/window") {
						return json(await this.config.getWindow());
					}
					if (req.method === "PUT" && path === "/api/config/window") {
						const body = (await req.json()) as Parameters<ConfigService["setWindow"]>[0];
						await this.config.setWindow(body);
						return ok();
					}

					// --- UI preferences (theme + accent), persisted to vault ---
					if (req.method === "GET" && path === "/api/ui/preferences") {
						const v = await this.vault.vault();
						const theme = (await v.has("ui.theme")) ? await v.get("ui.theme") : "system";
						const accent = (await v.has("ui.accent")) ? await v.get("ui.accent") : "#0a84ff";
						return json({ theme, accent });
					}
					if (req.method === "PUT" && path === "/api/ui/preferences") {
						const body = (await req.json()) as { theme?: string; accent?: string };
						const v = await this.vault.vault();
						if (typeof body.theme === "string") await v.set("ui.theme", body.theme);
						if (typeof body.accent === "string") await v.set("ui.accent", body.accent);
						// Broadcast so other open windows (Pensieve, Activity, Channels)
						// can re-apply the new theme/accent live without a reload.
						const theme = ((await v.has("ui.theme")) ? await v.get("ui.theme") : "system") as
							| "system"
							| "light"
							| "dark";
						const accent = (await v.has("ui.accent")) ? await v.get("ui.accent") : "#0a84ff";
						this.broadcast({
							kind: "ui:preferences-changed",
							preferences: { theme, accent },
						});
						return ok();
					}

					if (req.method === "GET" && path === "/api/backends/install") {
						const platform = currentPlatform();
						const pms = await detectPackageManagers();
						const specs = await Promise.all(
							Object.values(BACKEND_INSTALL_SPECS).map(async (spec: any) => {
								const runnable = await resolveRunnableMethods(spec.id, platform);
								const commands = runnable.map((m: any) => buildInstallCommand(m));
								return { id: spec.id, methods: runnable, commands };
							}),
						);
						return json({ platform, packageManagers: pms, specs });
					}

					// --- generic vault inventory + per-key CRUD ---
					if (req.method === "GET" && path === "/api/vault/inventory") {
						const manager = await this.vault.manager();
						const items = await listVaultInventory(manager.vault);
						const enriched = await Promise.all(
							items.map(async (item: any) => ({
								...item,
								category: categorizeKey(item.key),
								provider: inferProviderId(item.key) ?? null,
								meta: await readEntryMeta(manager.vault, item.key).catch(() => null),
							})),
						);
						return json(enriched);
					}
					if (req.method === "GET" && path === "/api/vault/stats") {
						const v = await this.vault.vault();
						return json(await v.stats());
					}
					if (req.method === "GET" && path === "/api/vault/keys") {
						const manager = await this.vault.manager();
						const prefix = url.searchParams.get("prefix") ?? undefined;
						return json([...(await manager.list(prefix))]);
					}
					const vaultKey = path.match(/^\/api\/vault\/keys\/(.+?)(\/meta)?$/);
					if (vaultKey) {
						const key = decodeURIComponent(vaultKey[1] ?? "");
						const isMeta = vaultKey[2] === "/meta";
						const v = await this.vault.vault();
						const manager = await this.vault.manager();

						if (isMeta) {
							if (req.method === "GET") {
								return json(await readEntryMeta(v, key));
							}
							if (req.method === "PUT") {
								const meta = (await req.json()) as any;
								await setEntryMeta(v, key, meta);
								return ok();
							}
							if (req.method === "DELETE") {
								await removeEntryMeta(v, key);
								return ok();
							}
						} else {
							if (req.method === "GET") {
								const reveal = url.searchParams.get("reveal") === "1";
								const exists = await manager.has(key);
								if (!exists) return error("not found", 404);
								const desc = await v.describe(key);
								if (!reveal) return json({ key, descriptor: desc });
								const value = await v.reveal(key, "tray-app:vault-ui");
								return json({ key, descriptor: desc, value });
							}
							if (req.method === "PUT") {
								const body = (await req.json()) as {
									value: string;
									sensitive?: boolean;
								};
								await manager.set(key, body.value, {
									sensitive: body.sensitive ?? true,
								});
								return ok();
							}
							if (req.method === "DELETE") {
								await manager.remove(key);
								return ok();
							}
						}
					}

					// --- saved logins (in-house + 1Password + Bitwarden) ---
					if (req.method === "GET" && path === "/api/saved-logins") {
						const manager = await this.vault.manager();
						return json(await manager.listAllSavedLogins());
					}
					if (req.method === "POST" && path === "/api/saved-logins") {
						// in-house only
						const body = (await req.json()) as Omit<SavedLogin, "lastModified">;
						const v = await this.vault.vault();
						await setSavedLogin(v, body);
						return ok();
					}
					const reveal = path.match(
						/^\/api\/saved-logins\/([^/]+)\/(.+)$/,
					);
					if (reveal) {
						const source = decodeURIComponent(reveal[1] ?? "") as
							| "in-house"
							| "1password"
							| "bitwarden";
						const identifier = decodeURIComponent(reveal[2] ?? "");
						if (req.method === "GET") {
							const manager = await this.vault.manager();
							try {
								return json(await manager.revealSavedLogin(source, identifier));
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								// 1Password items without a `password` field (passkeys, SSO/social
								// logins, identity items mis-categorized as Login) trip the
								// hard error in eliza. Fall back to op item get and surface the
								// metadata we can read instead of failing the whole request.
								if (source === "1password" && /no password field/i.test(msg)) {
									const fallback = await readOnePasswordItemMetadata(identifier);
									return json({
										source: "1password",
										identifier,
										username: fallback.username ?? "",
										password: "",
										domain: fallback.domain ?? null,
										...(fallback.totp ? { totp: fallback.totp } : {}),
										note: fallback.note,
									});
								}
								throw err;
							}
						}
						if (req.method === "DELETE" && source === "in-house") {
							// in-house identifier is "<domain>:<username>"
							const sep = identifier.lastIndexOf(":");
							if (sep < 0) return error("invalid in-house identifier", 400);
							const domain = identifier.slice(0, sep);
							const username = identifier.slice(sep + 1);
							const v = await this.vault.vault();
							await deleteSavedLogin(v, domain, username);
							return ok();
						}
					}

					// --- routing profiles ---
					if (req.method === "GET" && path === "/api/routing") {
						const v = await this.vault.vault();
						return json(await readRoutingConfig(v));
					}
					if (req.method === "PUT" && path === "/api/routing") {
						const body = (await req.json()) as any;
						const v = await this.vault.vault();
						await writeRoutingConfig(v, body);
						return ok();
					}

					// --- Activity (operational: runtime, logs, trajectories, tasks) ---
					if (req.method === "GET" && path === "/api/activity/runtime") {
						return json(this.activity.runtimeSnapshot());
					}
					if (req.method === "GET" && path === "/api/activity/logs") {
						const level = url.searchParams.get("level") ?? undefined;
						const source = url.searchParams.get("source") ?? undefined;
						const q = url.searchParams.get("q") ?? undefined;
						const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
						const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined;
						return json(this.activity.logs.list({
							...(level ? { level } : {}),
							...(source ? { source } : {}),
							...(q ? { q } : {}),
							...(limit ? { limit } : {}),
							...(since ? { since } : {}),
						}));
					}
					if (req.method === "GET" && path === "/api/activity/trajectories") {
						const limit = Number(url.searchParams.get("limit") ?? 50);
						const offset = Number(url.searchParams.get("offset") ?? 0);
						const status = url.searchParams.get("status") ?? undefined;
						const source = url.searchParams.get("source") ?? undefined;
						const q = url.searchParams.get("q") ?? undefined;
						return json(await this.activity.trajectories.list({
							limit, offset,
							...(status ? { status } : {}),
							...(source ? { source } : {}),
							...(q ? { q } : {}),
						}));
					}
					const trajGet = path.match(/^\/api\/activity\/trajectories\/([^/]+)$/);
					if (req.method === "GET" && trajGet) {
						return json(await this.activity.trajectories.get(decodeURIComponent(trajGet[1] ?? "")));
					}
					if (req.method === "POST" && path === "/api/activity/trajectories/export") {
						const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
						const ids = Array.isArray(body.ids) && body.ids.length > 0
							? body.ids
							: ((await this.activity.trajectories.list({ limit: 500 })).trajectories.map((t) => t.id));
						const details = await this.activity.trajectories.getMany(ids);
						return json({
							exportedAt: Date.now(),
							count: details.length,
							trajectories: details,
						});
					}

					// --- Pensieve (knowledge: memories + relationships + graph + templates) ---
					if (req.method === "GET" && path === "/api/pensieve/memories/tree") {
						return json(await this.pensieve.memories.tree());
					}
					if (req.method === "GET" && path === "/api/pensieve/memories") {
						const opts: Record<string, unknown> = {
							limit: Number(url.searchParams.get("limit") ?? 100),
						};
						for (const key of ["roomId", "entityId", "type", "tag", "q", "pathPrefix"]) {
							const v = url.searchParams.get(key);
							if (v) opts[key] = v;
						}
						return json(await this.pensieve.memories.list(opts as Parameters<typeof this.pensieve.memories.list>[0]));
					}
					if (req.method === "GET" && path === "/api/pensieve/knowledge/status") {
						return json({ available: this.pensieve.knowledge.available() });
					}
					if (req.method === "GET" && path === "/api/pensieve/embedding-map") {
						return json(await this.pensieve.embeddingMap.snapshot());
					}
					if (req.method === "GET" && path === "/api/pensieve/chronicler/status") {
						return json(this.pensieve.chronicler.status());
					}
					if (req.method === "GET" && path === "/api/pensieve/chronicler/config") {
						return json(this.pensieve.chronicler.getConfig());
					}
					if (req.method === "PUT" && path === "/api/pensieve/chronicler/config") {
						const raw = (await req.json()) as Partial<ChroniclerConfig> | null;
						if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
							return error("invalid chronicler config", 400);
						}
						const body = raw;
						if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
							return error("enabled must be boolean", 400);
						}
						if (body.includeWindowTitles !== undefined && typeof body.includeWindowTitles !== "boolean") {
							return error("includeWindowTitles must be boolean", 400);
						}
						if (body.intervalMs !== undefined && typeof body.intervalMs !== "number") {
							return error("intervalMs must be number", 400);
						}
						if (body.maxWindowsPerScreen !== undefined && typeof body.maxWindowsPerScreen !== "number") {
							return error("maxWindowsPerScreen must be number", 400);
						}
						const current = this.pensieve.chronicler.getConfig();
						const next = await this.pensieve.chronicler.configure({
							enabled: body.enabled ?? current.enabled,
							intervalMs: body.intervalMs ?? current.intervalMs,
							includeWindowTitles: body.includeWindowTitles ?? current.includeWindowTitles,
							maxWindowsPerScreen: body.maxWindowsPerScreen ?? current.maxWindowsPerScreen,
						});
						pensieveAudit({
							action: "chronicler.configure",
							success: true,
							target: next.enabled ? "enabled" : "disabled",
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return json(next);
					}
					if (req.method === "POST" && path === "/api/pensieve/chronicler/sample") {
						try {
							const observation = await this.pensieve.chronicler.sampleNow();
							pensieveAudit({
								action: "chronicler.sample",
								target: observation.id,
								success: true,
								caller: "ui-pensieve",
								ts: Date.now(),
							});
							return json(observation);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							pensieveAudit({
								action: "chronicler.sample",
								success: false,
								error: msg,
								caller: "ui-pensieve",
								ts: Date.now(),
							});
							return error(msg, 400);
						}
					}
					if (req.method === "GET" && path === "/api/pensieve/chronicler/recent") {
						const limit = Number(url.searchParams.get("limit") ?? 20);
						return json(this.pensieve.chronicler.recent(limit));
					}
					if (req.method === "POST" && path === "/api/pensieve/knowledge/ingest") {
						const body = (await req.json()) as {
							filename: string;
							contentType?: string;
							content: string;
							metadata?: Record<string, unknown>;
						};
						let success = false;
						let result: unknown = null;
						let errMsg: string | undefined;
						try {
							result = await this.pensieve.knowledge.ingest({
								filename: body.filename,
								contentType: body.contentType ?? "text/plain",
								content: body.content,
								...(body.metadata ? { metadata: body.metadata } : {}),
							});
							success = !!result;
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "knowledge.ingest",
							target: body.filename,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success
							? json({ ok: true, ...result as Record<string, unknown> })
							: error(errMsg ?? "knowledge service not available", 400);
					}
					if (req.method === "POST" && path === "/api/pensieve/memories") {
						const body = (await req.json()) as {
							text: string;
							path?: string;
							type?: string;
							tags?: string[];
							extraMetadata?: Record<string, unknown>;
						};
						let success = false;
						let errMsg: string | undefined;
						let createdId: string | undefined;
						try {
							const created = await this.pensieve.memories.create(body);
							success = !!created;
							createdId = created?.id;
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "memory.create",
							target: createdId,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? json({ ok: true, id: createdId }) : error(errMsg ?? "create failed", 400);
					}
					if (req.method === "POST" && path === "/api/pensieve/memories/search") {
						const body = (await req.json()) as { text: string; limit?: number };
						return json(await this.pensieve.memories.search(body.text, body.limit ?? 30));
					}
					const memGet = path.match(/^\/api\/pensieve\/memories\/([^/]+)$/);
					if (req.method === "GET" && memGet) {
						const id = decodeURIComponent(memGet[1] ?? "") as never;
						const detail = await this.pensieve.memories.get(id);
						if (!detail) return error("not found", 404);
						const backlinks = await this.pensieve.graph.backlinksForMemory(memGet[1] ?? "");
						return json({ ...detail, backlinks });
					}
					if (req.method === "PATCH" && memGet) {
						const id = decodeURIComponent(memGet[1] ?? "") as never;
						const body = (await req.json()) as { contentText?: string; tags?: string[]; path?: string };
						let success = false;
						let errMsg: string | undefined;
						try {
							success = await this.pensieve.memories.update(id, body);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "memory.update",
							target: memGet[1],
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "update failed", 400);
					}
					if (req.method === "DELETE" && memGet) {
						const id = decodeURIComponent(memGet[1] ?? "") as never;
						let success = false;
						let errMsg: string | undefined;
						try {
							success = await this.pensieve.memories.remove(id);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "memory.delete",
							target: memGet[1],
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "delete failed", 400);
					}
					if (req.method === "GET" && path === "/api/pensieve/relationships/persons") {
						const limit = Number(url.searchParams.get("limit") ?? 100);
						return json(await this.pensieve.relationships.listPersons(limit));
					}
					const personGet = path.match(/^\/api\/pensieve\/relationships\/([^/]+)$/);
					if (req.method === "GET" && personGet) {
						const id = decodeURIComponent(personGet[1] ?? "") as never;
						const detail = await this.pensieve.relationships.getPerson(id);
						if (!detail) return error("not found", 404);
						return json(detail);
					}
					if (req.method === "GET" && path === "/api/pensieve/relationships") {
						const ids = (url.searchParams.get("entityIds") ?? "").split(",").filter(Boolean) as never[];
						const tags = (url.searchParams.get("tags") ?? "").split(",").filter(Boolean);
						const limit = Number(url.searchParams.get("limit") ?? 200);
						return json(await this.pensieve.relationships.listRelationships(ids, tags, limit));
					}
					if (req.method === "POST" && path === "/api/pensieve/relationships") {
						const body = (await req.json()) as Parameters<typeof this.pensieve.relationships.create>[0];
						let success = false;
						let errMsg: string | undefined;
						try {
							success = await this.pensieve.relationships.create(body);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "relationship.create",
							target: `${body?.sourceEntityId}↔${body?.targetEntityId}`,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "create failed", 400);
					}
					const relPair = path.match(/^\/api\/pensieve\/relationships\/([^/]+)\/([^/]+)$/);
					if (req.method === "PATCH" && relPair) {
						const source = decodeURIComponent(relPair[1] ?? "") as never;
						const target = decodeURIComponent(relPair[2] ?? "") as never;
						const body = (await req.json()) as { tags?: string[]; metadata?: Record<string, unknown> };
						let success = false;
						let errMsg: string | undefined;
						try {
							success = await this.pensieve.relationships.update(source, target, body);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "relationship.update",
							target: `${relPair[1]}↔${relPair[2]}`,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "update failed", 400);
					}
					if (req.method === "DELETE" && relPair) {
						const source = decodeURIComponent(relPair[1] ?? "") as never;
						const target = decodeURIComponent(relPair[2] ?? "") as never;
						let success = false;
						let errMsg: string | undefined;
						try {
							success = await this.pensieve.relationships.remove(source, target);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "relationship.delete",
							target: `${relPair[1]}↔${relPair[2]}`,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "delete failed", 400);
					}
					// --- Pensieve templates + prompt variables ---
					if (req.method === "GET" && path === "/api/pensieve/templates") {
						return json(await this.pensieve.templates.listTemplates());
					}
					if (req.method === "POST" && path === "/api/pensieve/templates") {
						const body = (await req.json()) as { name: string; body: string; tags?: string[] };
						let success = false;
						let id: string | undefined;
						let errMsg: string | undefined;
						try {
							const created = await this.pensieve.templates.createTemplate(body);
							success = !!created;
							id = created?.id;
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "template.create",
							target: id,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? json({ ok: true, id }) : error(errMsg ?? "create failed", 400);
					}
					const tplDetail = path.match(/^\/api\/pensieve\/templates\/([^/]+)$/);
					if (req.method === "GET" && tplDetail) {
						const id = decodeURIComponent(tplDetail[1] ?? "");
						const detail = await this.pensieve.templates.getTemplate(id);
						return detail ? json(detail) : error("not found", 404);
					}
					if (req.method === "PATCH" && tplDetail) {
						const id = decodeURIComponent(tplDetail[1] ?? "");
						const body = (await req.json()) as { body?: string; tags?: string[]; path?: string };
						let success = false;
						let errMsg: string | undefined;
						try {
							success = await this.pensieve.templates.updateTemplate(id, body);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "template.update",
							target: id,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "update failed", 400);
					}
					if (req.method === "DELETE" && tplDetail) {
						const id = decodeURIComponent(tplDetail[1] ?? "");
						let success = false;
						let errMsg: string | undefined;
						try {
							success = await this.pensieve.templates.deleteTemplate(id);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "template.delete",
							target: id,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "delete failed", 400);
					}
					const tplRender = path.match(/^\/api\/pensieve\/templates\/([^/]+)\/render$/);
					if (req.method === "POST" && tplRender) {
						const id = decodeURIComponent(tplRender[1] ?? "");
						const body = (await req.json().catch(() => ({}))) as { vars?: Record<string, string> };
						const result = await this.pensieve.templates.renderTemplate(id, body.vars ?? {});
						pensieveAudit({
							action: "template.render",
							target: id,
							success: !!result,
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return result ? json(result) : error("not found", 404);
					}
					if (req.method === "GET" && path === "/api/pensieve/template-vars") {
						return json(await this.pensieve.templates.listVariables());
					}
					const varRoute = path.match(/^\/api\/pensieve\/template-vars\/([^/]+)$/);
					if (req.method === "PUT" && varRoute) {
						const name = decodeURIComponent(varRoute[1] ?? "");
						const body = (await req.json()) as { value: string };
						let success = false;
						let errMsg: string | undefined;
						try {
							const v = await this.pensieve.templates.setVariable(name, body.value);
							success = !!v;
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "promptvar.set",
							target: name,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-pensieve",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "set failed", 400);
					}
					if (req.method === "DELETE" && varRoute) {
						const name = decodeURIComponent(varRoute[1] ?? "");
						let success = false;
						try {
							success = await this.pensieve.templates.deleteVariable(name);
						} catch (err) {
							const m = err instanceof Error ? err.message : String(err);
							pensieveAudit({ action: "promptvar.delete", target: name, success: false, error: m, caller: "ui-pensieve", ts: Date.now() });
							return error(m, 400);
						}
						pensieveAudit({ action: "promptvar.delete", target: name, success, caller: "ui-pensieve", ts: Date.now() });
						return success ? ok() : error("not found", 404);
					}

					// --- Channels (Discord/Telegram/iMessage) ---
					if (req.method === "GET" && path === "/api/channels") {
						const snap = this.activity.pluginsSnapshot();
						const loadedNames = snap.plugins.map((p) => p.name);
						const liveRuntime = this.runtime.peek();
						return json(await this.channels.snapshot(loadedNames, liveRuntime));
					}
					if (req.method === "POST" && path === "/api/channels/credentials") {
						const body = (await req.json()) as { key: string; value: string; skipValidate?: boolean };
						// Pre-flight validation against the channel's authoritative
						// API. We'd rather reject a dead token loudly than save it
						// and have the user wonder why the bot is silently broken
						// (the historical Discord pain point). Pass skipValidate=true
						// to bypass — useful if the API is briefly down.
						if (!body.skipValidate) {
							const validation = await validateChannelCredential(body.key, body.value);
							if (!validation.ok) {
								return error(validation.error, 400);
							}
						}
						await this.channels.setCredential(body.key, body.value);
						this.scheduleChannelReload();
						return json({ ok: true, reloadScheduled: true, validated: !body.skipValidate });
					}
					const credDelete = path.match(/^\/api\/channels\/credentials\/([^/]+)$/);
					if (req.method === "DELETE" && credDelete) {
						await this.channels.clearCredential(decodeURIComponent(credDelete[1] ?? ""));
						this.scheduleChannelReload();
						return json({ ok: true, reloadScheduled: true });
					}
					if (req.method === "POST" && path === "/api/channels/reload") {
						// Fire-and-forget — telegram's 5-attempt retry-with-backoff
						// can stall the rebuild promise for up to ~3 minutes on a
						// bad/conflicted token. Schedule via the same debouncer so
						// double-clicks coalesce, and let the UI poll status.
						this.scheduleChannelReload();
						return json({ ok: true, reloadScheduled: true });
					}

					// --- Discord channel discovery + history backfill ---
					// List the bot's reachable guilds + text channels.
					if (req.method === "GET" && path === "/api/channels/discord/guilds") {
						const live = this.runtime.peek();
						const svc = live ? (live as unknown as { getService?: (t: string) => unknown }).getService?.("discord") as
							{ client?: { guilds?: { cache?: Map<string, { id: string; name: string; channels?: { cache?: Map<string, { id: string; name: string; type?: number }> } }> } } } | null
							: null;
						const cache = svc?.client?.guilds?.cache;
						if (!cache) return json({ guilds: [] });
						const out: Array<{ id: string; name: string; channels: Array<{ id: string; name: string; type: number }> }> = [];
						for (const [, g] of cache) {
							const channels: Array<{ id: string; name: string; type: number }> = [];
							const ch = g.channels?.cache;
							if (ch) for (const [, c] of ch) {
								channels.push({ id: c.id, name: c.name, type: c.type ?? -1 });
							}
							out.push({ id: g.id, name: g.name, channels });
						}
						return json({ guilds: out });
					}
					// Backfill a Discord channel's history into memories.
					// Fire-and-forget — backfill can take minutes on large channels.
					if (req.method === "POST" && path === "/api/channels/discord/backfill") {
						const body = (await req.json()) as { channelId: string; limit?: number; force?: boolean };
						const live = this.runtime.peek();
						const svc = live ? (live as unknown as { getService?: (t: string) => unknown }).getService?.("discord") as
							{ fetchChannelHistory?: (channelId: string, opts: { limit?: number; force?: boolean }) => Promise<{ stats: { fetched: number; stored: number; pages: number; fullyBackfilled: boolean } }> }
							: null;
						if (!svc?.fetchChannelHistory) return error("Discord service not loaded", 400);
						// Run in background; client polls trajectories/memories to see progress.
						void svc.fetchChannelHistory(body.channelId, { limit: body.limit ?? 200, force: !!body.force })
							.then((r) => console.log(`[discord] backfill complete for ${body.channelId}:`, r.stats))
							.catch((err) => console.warn(`[discord] backfill failed for ${body.channelId}:`, err instanceof Error ? err.message : err));
						return json({ ok: true, scheduled: true, channelId: body.channelId });
					}

					// --- Channel gateway (unified inbound/outbound feed) ---
					if (req.method === "GET" && path === "/api/gateway/feed") {
						const channel = url.searchParams.get("channel") ?? undefined;
						const direction = url.searchParams.get("direction") ?? undefined;
						const roomId = url.searchParams.get("roomId") ?? undefined;
						const entityId = url.searchParams.get("entityId") ?? undefined;
						const q = url.searchParams.get("q") ?? undefined;
						const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined;
						const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
						return json(this.gateway.list({
							...(channel ? { channel: channel as never } : {}),
							...(direction ? { direction: direction as never } : {}),
							...(roomId ? { roomId } : {}),
							...(entityId ? { entityId } : {}),
							...(q ? { q } : {}),
							...(since ? { since } : {}),
							...(limit ? { limit } : {}),
						}));
					}
					if (req.method === "GET" && path === "/api/gateway/identities") {
						const all = url.searchParams.get("all") === "1";
						return json({
							identities: all ? this.gateway.allIdentities() : this.gateway.identityCandidates(),
						});
					}

					// --- Inbox (notifications + actionable channel signals) ---
					if (req.method === "GET" && path === "/api/inbox") {
						const status = url.searchParams.get("status") as InboxStatus | null;
						const kind = url.searchParams.get("kind") as InboxKind | null;
						const source = url.searchParams.get("source") ?? undefined;
						const channel = url.searchParams.get("channel") ?? undefined;
						const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined;
						const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
						return json(this.inbox.list({
							...(status ? { status } : {}),
							...(kind ? { kind } : {}),
							...(source ? { source } : {}),
							...(channel ? { channel } : {}),
							...(since ? { since } : {}),
							...(limit ? { limit } : {}),
						}));
					}
					if (req.method === "GET" && path === "/api/inbox/stats") {
						return json(this.inbox.stats());
					}

					// --- Local llama server status ---
					if (req.method === "GET" && path === "/api/llama/status") {
						return json(this.llama.status());
					}

					// --- Debug: probe text-model pipeline end-to-end ---
					if (req.method === "POST" && path === "/api/debug/text-model") {
						const body = (await req.json().catch(() => ({}))) as { type?: string; prompt?: string };
						const modelType = body.type ?? "TEXT_LARGE";
						const prompt = body.prompt ?? "Reply with the single word: pong";
						const live = this.runtime.peek();
						if (!live) return error("runtime not built", 503);
						const r = live as unknown as {
							useModel?: (type: string, params: unknown) => Promise<unknown>;
							getModel?: (type: string) => unknown;
							models?: Map<string, unknown[]>;
						};
						const handlers = r.models?.get?.(modelType);
						const handlerCount = Array.isArray(handlers) ? handlers.length : (handlers ? 1 : 0);
						const hasModel = typeof r.getModel === "function" && r.getModel(modelType) !== undefined;
						let result: unknown = null;
						let err: string | null = null;
						const t0 = Date.now();
						try {
							if (typeof r.useModel === "function") {
								result = await r.useModel(modelType, { prompt, maxTokens: 50, temperature: 0 });
							} else {
								err = "runtime.useModel is not a function";
							}
						} catch (e) {
							err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
						}
						const latency = Date.now() - t0;
						return json({
							modelType,
							handlerCount,
							hasModel,
							latencyMs: latency,
							error: err,
							result: typeof result === "string" ? result.slice(0, 500) : result,
						});
					}

					// --- Debug: probe embedding pipeline end-to-end ---
					if (req.method === "POST" && path === "/api/debug/embedding") {
						const body = (await req.json().catch(() => ({}))) as { text?: string; storeAs?: string };
						const text = body.text ?? "hello world";
						const live = this.runtime.peek();
						if (!live) return error("runtime not built", 503);
						const r = live as unknown as {
							useModel?: (type: string, params: unknown) => Promise<unknown>;
							getModel?: (type: string) => unknown;
							services?: Map<string, unknown>;
							getService?: (t: string) => unknown;
							adapter?: { embeddingDimension?: string };
							createMemory?: (m: unknown, table: string) => Promise<string>;
							queueEmbeddingGeneration?: (m: unknown, prio?: string) => Promise<void>;
							updateMemory?: (m: unknown) => Promise<boolean>;
							agentId?: string;
						};
						const hasModel = typeof r.getModel === "function" && r.getModel("TEXT_EMBEDDING") !== undefined;
						const embSvc = r.getService?.("embedding-generation") as {
							isDisabled?: boolean;
							batchQueue?: { size?: number; isStarted?: boolean } | null;
						} | null | undefined;
						const adapter = r.adapter as { embeddingDimension?: string } | undefined;
						let vec: unknown = null;
						let modelErr: string | null = null;
						const t0 = Date.now();
						try {
							if (typeof r.useModel === "function") {
								vec = await r.useModel("TEXT_EMBEDDING", { text });
							}
						} catch (err) {
							modelErr = err instanceof Error ? err.message : String(err);
						}
						const ms = Date.now() - t0;
						const arr = Array.isArray(vec) ? (vec as number[]) : [];
						const nonZero = arr.filter((n) => Math.abs(n) > 1e-9).length;
						// If asked, write a memory + manually call updateMemory with embedding
						// to bypass the queue and test the storage path directly.
						let writeResult: { ok: boolean; memoryId?: string; error?: string } | null = null;
						if (body.storeAs && typeof r.createMemory === "function" && typeof r.updateMemory === "function") {
							try {
								const memId = await r.createMemory({
									entityId: r.agentId,
									roomId: r.agentId,
									agentId: r.agentId,
									content: { text, source: "debug" },
									createdAt: Date.now(),
								}, body.storeAs);
								await r.updateMemory({ id: memId, embedding: arr });
								writeResult = { ok: true, memoryId: String(memId) };
							} catch (err) {
								writeResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
							}
						}
						return json({
							hasModel,
							adapterEmbeddingDimension: adapter?.embeddingDimension ?? null,
							embeddingServiceRegistered: embSvc !== null && embSvc !== undefined,
							embeddingServiceDisabled: embSvc?.isDisabled ?? null,
							queueStarted: embSvc?.batchQueue?.isStarted ?? null,
							queueSize: embSvc?.batchQueue?.size ?? null,
							durationMs: ms,
							dim: arr.length,
							nonZero,
							first5: arr.slice(0, 5),
							modelErr,
							writeResult,
						});
					}
					if (req.method === "POST" && path === "/api/inbox") {
						const body = (await req.json()) as {
							kind?: InboxKind;
							title?: string;
							body?: string;
							source?: string;
							channel?: string;
							fromHandle?: string;
							meta?: Record<string, unknown>;
							prompt?: boolean;
						};
						if (!body.title) return error("title required", 400);
						const item = await this.inbox.post({
							kind: body.kind ?? "notification",
							title: body.title,
							body: body.body ?? "",
							...(body.source ? { source: body.source } : {}),
							...(body.channel ? { channel: body.channel } : {}),
							...(body.fromHandle ? { fromHandle: body.fromHandle } : {}),
							...(body.meta ? { meta: body.meta } : {}),
							...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
						});
						return json({ ok: true, item });
					}
					const inboxStatusUpdate = path.match(/^\/api\/inbox\/([^/]+)\/status$/);
					if (req.method === "PATCH" && inboxStatusUpdate) {
						const id = decodeURIComponent(inboxStatusUpdate[1] ?? "");
						const body = (await req.json()) as { status?: InboxStatus };
						const status = parseInboxStatus(body.status);
						if (!status) return error("valid status required", 400);
						const updated = this.inbox.updateStatus(id, status);
						if (!updated) return error("inbox item not found", 404);
						return json({ ok: true, item: updated });
					}
					const inboxAct = path.match(/^\/api\/inbox\/([^/]+)\/act$/);
					if (req.method === "POST" && inboxAct) {
						const id = decodeURIComponent(inboxAct[1] ?? "");
						const updated = await this.inbox.act(id);
						if (!updated) return error("inbox item not found", 404);
						return json({ ok: true, item: updated });
					}

					// --- Cron / scheduled prompts ---
					if (req.method === "GET" && path === "/api/cron") {
						return json({ jobs: this.cron.listJobs() });
					}
					if (req.method === "POST" && path === "/api/cron") {
						const body = (await req.json()) as {
							schedule?: string;
							prompt?: string;
							name?: string;
							enabled?: boolean;
						};
						if (!body.schedule) return error("schedule required", 400);
						if (!body.prompt) return error("prompt required", 400);
						try {
							const job = await this.cron.createJob({
								schedule: body.schedule,
								prompt: body.prompt,
								...(body.name ? { name: body.name } : {}),
								...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
								createdBy: "ui",
							});
							return json({ ok: true, job });
						} catch (err) {
							return error(err instanceof Error ? err.message : String(err), 400);
						}
					}
					// --- Owner-bind (eliza /eliza_pair flow) ---
					if (req.method === "POST" && path === "/api/owner-bind/code") {
						const body = (await req.json()) as { connector?: string };
						const connector = body.connector;
						if (connector !== "telegram" && connector !== "discord" && connector !== "wechat" && connector !== "matrix") {
							return error("connector must be telegram | discord | wechat | matrix", 400);
						}
						const issued = this.ownerBind.generateCode(connector);
						return json({ ok: true, ...issued, connector });
					}
					const ownerStatus = path.match(/^\/api\/owner-bind\/(telegram|discord|wechat|matrix)$/);
					if (ownerStatus) {
						const connector = (ownerStatus[1] ?? "") as OwnerConnector;
						if (req.method === "GET") {
							const owner = await this.ownerBind.getOwner(connector);
							return json({ connector, bound: !!owner, owner });
						}
						if (req.method === "DELETE") {
							await this.ownerBind.unbind(connector);
							return json({ ok: true });
						}
					}

					const cronById = path.match(/^\/api\/cron\/([^/]+)$/);
					if (cronById) {
						const id = decodeURIComponent(cronById[1] ?? "");
						if (req.method === "GET") {
							const job = this.cron.getJob(id);
							if (!job) return error("not found", 404);
							return json({ job });
						}
						if (req.method === "PATCH") {
							const body = (await req.json()) as {
								schedule?: string;
								prompt?: string;
								name?: string;
								enabled?: boolean;
							};
							try {
								const job = await this.cron.updateJob(id, body);
								if (!job) return error("not found", 404);
								return json({ ok: true, job });
							} catch (err) {
								return error(err instanceof Error ? err.message : String(err), 400);
							}
						}
						if (req.method === "DELETE") {
							const removed = await this.cron.deleteJob(id);
							if (!removed) return error("not found", 404);
							return json({ ok: true });
						}
					}

					// --- Activity DB inspector (read-only) ---
					if (req.method === "GET" && path === "/api/activity/db/tables") {
						return json({ available: this.activity.db.available(), tables: await this.activity.db.listTables() });
					}
					const dbDescribe = path.match(/^\/api\/activity\/db\/tables\/([^/]+)\/([^/]+)$/);
					if (req.method === "GET" && dbDescribe) {
						const schema = decodeURIComponent(dbDescribe[1] ?? "");
						const name = decodeURIComponent(dbDescribe[2] ?? "");
						const detail = await this.activity.db.describeTable(schema, name);
						return detail ? json(detail) : error("not found", 404);
					}
					if (req.method === "POST" && path === "/api/activity/db/query") {
						const body = (await req.json()) as { sql: string };
						try {
							const result = await this.activity.db.query(body.sql);
							return json(result);
						} catch (err) {
							const m = err instanceof Error ? err.message : String(err);
							return error(m, 400);
						}
					}

					// --- Activity plugins ---
					if (req.method === "GET" && path === "/api/activity/plugins") {
						return json(this.activity.pluginsSnapshot());
					}
					if (req.method === "POST" && path === "/api/activity/plugins/rebuild") {
						const result = await this.runtime.rebuild();
						return json({ ok: !!result, provider: result?.provider ?? null });
					}

					// --- Activity autonomy ---
					if (req.method === "GET" && path === "/api/activity/autonomy") {
						return json(await this.activity.autonomy.snapshot());
					}
					if (req.method === "POST" && path === "/api/activity/autonomy/enable") {
						const success = await this.activity.autonomy.setEnabled(true);
						pensieveAudit({ action: "autonomy.enable", success, caller: "ui-activity", ts: Date.now() });
						return success ? ok() : error("autonomy service not available", 400);
					}
					if (req.method === "POST" && path === "/api/activity/autonomy/disable") {
						const success = await this.activity.autonomy.setEnabled(false);
						pensieveAudit({ action: "autonomy.disable", success, caller: "ui-activity", ts: Date.now() });
						return success ? ok() : error("autonomy service not available", 400);
					}
					if (req.method === "POST" && path === "/api/activity/autonomy/interval") {
						const body = (await req.json()) as { intervalMs: number };
						const success = await this.activity.autonomy.setIntervalMs(body.intervalMs);
						pensieveAudit({ action: "autonomy.interval", target: String(body.intervalMs), success, caller: "ui-activity", ts: Date.now() });
						return success ? ok() : error("could not set interval", 400);
					}

					// --- Activity tasks (heartbeat / cron / autonomous) ---
					if (req.method === "GET" && path === "/api/activity/tasks") {
						return json(await this.activity.tasks.snapshot());
					}
					const taskAction = path.match(/^\/api\/activity\/tasks\/([^/]+)\/(run|pause|resume)$/);
					if (req.method === "POST" && taskAction) {
						const id = decodeURIComponent(taskAction[1] ?? "");
						const action = taskAction[2] ?? "";
						let success = false;
						let errMsg: string | undefined;
						try {
							if (action === "run") success = await this.activity.tasks.runNow(id);
							else if (action === "pause") success = await this.activity.tasks.pause(id, true);
							else if (action === "resume") success = await this.activity.tasks.pause(id, false);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: `task.${action}` as "task.run" | "task.pause" | "task.resume",
							target: id,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-activity",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? `${action} failed`, 400);
					}
					const taskDelete = path.match(/^\/api\/activity\/tasks\/([^/]+)$/);
					if (req.method === "DELETE" && taskDelete) {
						const id = decodeURIComponent(taskDelete[1] ?? "");
						let success = false;
						let errMsg: string | undefined;
						try {
							success = await this.activity.tasks.remove(id);
						} catch (err) {
							errMsg = err instanceof Error ? err.message : String(err);
						}
						pensieveAudit({
							action: "task.delete",
							target: id,
							success,
							...(errMsg ? { error: errMsg } : {}),
							caller: "ui-activity",
							ts: Date.now(),
						});
						return success ? ok() : error(errMsg ?? "delete failed", 400);
					}

					if (req.method === "GET" && path === "/api/pensieve/graph") {
						const filter: Record<string, unknown> = {};
						const dateFrom = url.searchParams.get("dateFrom");
						const dateTo = url.searchParams.get("dateTo");
						if (dateFrom) filter.dateFrom = Number(dateFrom);
						if (dateTo) filter.dateTo = Number(dateTo);
						const entityIds = (url.searchParams.get("entityIds") ?? "").split(",").filter(Boolean);
						const types = (url.searchParams.get("types") ?? "").split(",").filter(Boolean);
						const tags = (url.searchParams.get("tags") ?? "").split(",").filter(Boolean);
						if (entityIds.length) filter.entityIds = entityIds;
						if (types.length) filter.types = types;
						if (tags.length) filter.tags = tags;
						return json(await this.pensieve.graph.snapshot(filter as Parameters<typeof this.pensieve.graph.snapshot>[0]));
					}

					// --- auth: account providers + OAuth flows ---
					if (req.method === "GET" && path === "/api/auth/providers") {
						return json({
							subscription: ["anthropic-subscription", "openai-codex"],
							direct: Object.keys(PROVIDER_ENV),
							all: ALL_PROVIDER_IDS,
						});
					}
					if (req.method === "GET" && path === "/api/auth/accounts") {
						return json(this.auth.listAllAccounts());
					}
					const accountList = path.match(/^\/api\/auth\/accounts\/([^/]+)$/);
					if (req.method === "GET" && accountList) {
						const provider = decodeURIComponent(accountList[1] ?? "") as any;
						return json(this.auth.listAccounts(provider));
					}
					const accountDelete = path.match(/^\/api\/auth\/accounts\/([^/]+)\/(.+)$/);
					if (req.method === "DELETE" && accountDelete) {
						const provider = decodeURIComponent(accountDelete[1] ?? "") as any;
						const accountId = decodeURIComponent(accountDelete[2] ?? "");
						this.auth.deleteAccount(provider, accountId);
						await this.runtime.rebuild().catch(() => {});
						this.broadcast({
							kind: "provider:changed",
							activeProvider: this.runtime.getCurrentProvider(),
						});
						return ok();
					}
					if (req.method === "POST" && path === "/api/auth/flows") {
						const body = (await req.json()) as {
							provider: "anthropic-subscription" | "openai-codex";
							label: string;
							accountId?: string;
						};
						const handle = await this.auth.startFlow(body.provider, {
							label: body.label,
							accountId: body.accountId,
						});
						// Subscribe and broadcast WS updates. On success, rebuild the
						// runtime so the chat picks up the freshly-stored OAuth account.
						this.auth.subscribeFlow(handle.sessionId, (state) => {
							this.broadcast({
								kind: "auth:flow-update",
								sessionId: handle.sessionId,
								state: state as any,
							});
							if (state.status === "success") {
								this.runtime
									.rebuild()
									.then(() => {
										this.broadcast({
											kind: "provider:changed",
											activeProvider: this.runtime.getCurrentProvider(),
										});
									})
									.catch((err) =>
										console.error("[runtime] rebuild after OAuth success failed:", err),
									);
							}
						});
						// Don't await completion — return immediately so the UI can display authUrl
						handle.completion.catch(() => {
							// errors are surfaced via subscribeFlow
						});
						return json({
							sessionId: handle.sessionId,
							authUrl: handle.authUrl,
							needsCodeSubmission: handle.needsCodeSubmission,
						});
					}
					const flowState = path.match(/^\/api\/auth\/flows\/([^/]+)$/);
					if (req.method === "GET" && flowState) {
						const sessionId = decodeURIComponent(flowState[1] ?? "");
						const state = this.auth.getFlowState(sessionId);
						if (!state) return error("flow not found", 404);
						return json(state);
					}
					if (req.method === "DELETE" && flowState) {
						const sessionId = decodeURIComponent(flowState[1] ?? "");
						this.auth.cancelFlow(sessionId, "user-cancelled");
						return ok();
					}
					const flowSubmit = path.match(/^\/api\/auth\/flows\/([^/]+)\/code$/);
					if (req.method === "POST" && flowSubmit) {
						const sessionId = decodeURIComponent(flowSubmit[1] ?? "");
						const body = (await req.json()) as { code: string };
						const ok2 = this.auth.submitFlowCode(sessionId, body.code);
						return json({ ok: ok2 });
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return error(msg, 500);
				}

				return error("not found", 404);
			},
			websocket: {
				open: (ws) => {
					this.subscribers.set(ws.data.id, ws);
				},
				close: (ws) => {
					this.subscribers.delete(ws.data.id);
				},
				message: async (ws, raw) => {
					let msg: WsClientMessage;
					try {
						msg = JSON.parse(raw.toString()) as WsClientMessage;
					} catch {
						return;
					}
					if (msg.kind === "ping") {
						this.send(ws, { kind: "pong" });
						return;
					}
					if (msg.kind === "log:webview") {
						this.activity.logs.captureWebviewLog({
							level: msg.level,
							msg: msg.msg,
							...(msg.source ? { source: msg.source } : {}),
							...(msg.traceId ? { traceId: msg.traceId } : {}),
							...(msg.extras ? { extras: msg.extras } : {}),
						});
						return;
					}
					if (msg.kind === "chat:send") {
						const { convId, text } = msg;
						// One trace id per chat send. Stamps every log line emitted
						// during the eliza pipeline (via AsyncLocalStorage) and
						// every chat:* WS message back to the webview, so the
						// React side can correlate its own console output with
						// server-side logs for the same turn.
						const traceId = newTraceId();
						let completeFired = false;
						let idleTimer: ReturnType<typeof setTimeout> | null = null;
						const fireComplete = () => {
							if (completeFired) return;
							completeFired = true;
							if (idleTimer) clearTimeout(idleTimer);
							this.broadcast({ kind: "chat:complete", convId, traceId });
						};
						const armIdle = () => {
							if (idleTimer) clearTimeout(idleTimer);
							idleTimer = setTimeout(fireComplete, 1500);
						};
						await traceScope(traceId, async () => {
							try {
								await this.runtime.sendMessage(text, (delta) => {
									this.broadcast({ kind: "chat:delta", convId, delta, traceId });
									armIdle();
								});
								fireComplete();
							} catch (err) {
								if (idleTimer) clearTimeout(idleTimer);
								const message = err instanceof Error ? err.message : String(err);
								this.broadcast({ kind: "chat:error", convId, message, traceId });
							}
						});
					}
				},
			},
		});

		this.port = this.server.port ?? port;
		this.writeLockfile();
		return { port: this.port };
	}

	stop(): void {
		this.removeBrowserControlGlobal();
		this.removeLockfile();
		this.server?.stop(true);
		this.server = null;
		for (const ws of this.subscribers.values()) ws.close();
		this.subscribers.clear();
		for (const [id, waiter] of this.browserWaiters.entries()) {
			clearTimeout(waiter.timer);
			waiter.resolve({ ok: false, error: `Browser command ${id} canceled because API server stopped.`, time: Date.now() });
		}
		this.browserWaiters.clear();
	}

	listen(handler: Listener): () => void {
		// Local listener for in-process use (e.g. tray window).
		const wrapper = (msg: WsServerMessage) => handler(msg);
		this.localListeners.add(wrapper);
		return () => this.localListeners.delete(wrapper);
	}

	private localListeners = new Set<Listener>();

	private send(ws: ServerWebSocket<WsData>, msg: WsServerMessage) {
		ws.send(JSON.stringify(msg));
	}

	/** Public broadcast — used by features outside the API server (e.g. tray to push `ui:open-settings`). */
	publish(msg: WsServerMessage): void {
		this.broadcast(msg);
	}

	private broadcast(msg: WsServerMessage) {
		const payload = JSON.stringify(msg);
		for (const ws of this.subscribers.values()) ws.send(payload);
		for (const fn of this.localListeners) fn(msg);
	}

	private writeLockfile() {
		try {
			mkdirSync(join(homedir(), ".detour"), { recursive: true });
			writeFileSync(
				this.lockFile,
				JSON.stringify({
					port: this.port,
					pid: process.pid,
					startedAt: new Date().toISOString(),
				}),
			);
		} catch (err) {
			console.error("Failed to write runtime lockfile:", err);
		}
	}

	private removeLockfile() {
		try {
			if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
		} catch {
			// best effort
		}
	}
}

/**
 * Pre-flight check that a channel credential is actually valid before we
 * commit it to vault. Each channel hits its authoritative `/me`-style
 * endpoint with the supplied token; a non-2xx response means we reject
 * the save and tell the user exactly what's wrong, instead of silently
 * storing a dead token and letting the plugin fail at next runtime build.
 *
 * Returns `{ok: true}` on successful validation OR if we don't know how
 * to validate the key (not a token we recognize). Returns `{ok: false,
 * error: "..."}` only when validation actively failed (auth rejection,
 * network reachable but bad token).
 */
async function validateChannelCredential(
	key: string,
	value: string,
): Promise<{ ok: true; info?: string } | { ok: false; error: string }> {
	const trimmed = value.trim();
	if (trimmed.length === 0) return { ok: false, error: `${key} is empty` };
	const TIMEOUT = 5000;
	const fetchWithTimeout = async (url: string, init: RequestInit = {}): Promise<Response> => {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), TIMEOUT);
		try {
			return await fetch(url, { ...init, signal: ctl.signal });
		} finally {
			clearTimeout(t);
		}
	};
	if (key === "DISCORD_API_TOKEN" || key === "DISCORD_BOT_TOKEN") {
		try {
			const res = await fetchWithTimeout("https://discord.com/api/v10/users/@me", {
				headers: { Authorization: `Bot ${trimmed}` },
			});
			if (res.status === 401) return { ok: false, error: "Discord rejected the token (401 Unauthorized) — regenerate it in Developer Portal → Bot → Reset Token." };
			if (res.status === 403) return { ok: false, error: "Discord rejected the token (403 Forbidden) — bot lacks required permissions." };
			if (!res.ok) return { ok: false, error: `Discord token check failed: HTTP ${res.status}` };
			const body = await res.json() as { username?: string; id?: string };
			if (!body.id || !body.username) return { ok: false, error: "Discord responded but token didn't return a bot user" };
			return { ok: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Could not reach Discord to validate token: ${msg}` };
		}
	}
	if (key === "TELEGRAM_BOT_TOKEN") {
		try {
			const res = await fetchWithTimeout(`https://api.telegram.org/bot${encodeURIComponent(trimmed)}/getMe`);
			const body = await res.json() as { ok?: boolean; description?: string; result?: { username?: string } };
			if (!body.ok) return { ok: false, error: `Telegram rejected the token: ${body.description ?? "unknown error"}` };
			if (!body.result?.username) return { ok: false, error: "Telegram responded but didn't return bot info" };
			return { ok: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Could not reach Telegram to validate token: ${msg}` };
		}
	}
	if (key === "OPENAI_EMBEDDING_API_KEY" || key === "OPENAI_API_KEY") {
		try {
			const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
				headers: { Authorization: `Bearer ${trimmed}` },
			});
			if (res.status === 401) return { ok: false, error: "OpenAI rejected the API key (401 Unauthorized)." };
			if (!res.ok) return { ok: false, error: `OpenAI key check failed: HTTP ${res.status}` };
			return { ok: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Could not reach OpenAI to validate key: ${msg}` };
		}
	}
	if (key === "X_AUTH_TOKEN" || key === "X_CT0") {
		// Validate by hitting a cheap authenticated endpoint. We need BOTH
		// cookies to make a request, so look up whichever isn't being saved
		// from the running process env (set by previous saves) and pair
		// them. If only one is set, accept silently — the other half will
		// be checked once both are stored.
		const otherKey = key === "X_AUTH_TOKEN" ? "X_CT0" : "X_AUTH_TOKEN";
		const otherValue = process.env[otherKey];
		if (!otherValue) {
			return { ok: true }; // can't validate alone; defer to runtime
		}
		const authToken = key === "X_AUTH_TOKEN" ? trimmed : otherValue;
		const ct0 = key === "X_CT0" ? trimmed : otherValue;
		try {
			const { XClient } = await import("@detour/plugin-x-tweets");
			const client = new XClient({ cookies: { authToken, ct0 } });
			const viewer = await client.viewer();
			return { ok: true, info: `signed in as @${viewer.screenName}` };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
				return {
					ok: false,
					error: "X rejected the cookies (auth_token + ct0). Re-export both from x.com via Cookie-Editor and try again.",
				};
			}
			return { ok: false, error: `Could not reach X to validate cookies: ${msg}` };
		}
	}
	// Unknown / non-validatable key — accept silently.
	return { ok: true };
}

/**
 * Read a 1Password item via `op item get` and pull metadata that matters
 * even when the password field is missing (passkeys, SSO, identity items).
 * Used as the fallback when eliza's `revealSavedLogin` throws "no password field".
 */
async function readOnePasswordItemMetadata(
	externalId: string,
): Promise<{
	username: string | null;
	domain: string | null;
	totp: string | null;
	note: string;
}> {
	const out = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
		const child = spawn("op", ["item", "get", externalId, "--format=json"], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
	});
	if (out.code !== 0) {
		return {
			username: null,
			domain: null,
			totp: null,
			note: `op item get failed: ${out.stderr.trim() || "unknown error"}`,
		};
	}
	try {
		const item = JSON.parse(out.stdout) as {
			category?: string;
			urls?: Array<{ href?: string; primary?: boolean }>;
			fields?: Array<{ id?: string; label?: string; purpose?: string; value?: string; type?: string }>;
		};
		const username =
			item.fields?.find((f) => f.purpose === "USERNAME" && typeof f.value === "string")?.value ??
			item.fields?.find((f) => f.label?.toLowerCase() === "username")?.value ??
			null;
		const totp =
			item.fields?.find((f) => f.type?.toUpperCase() === "OTP")?.value ??
			item.fields?.find((f) => f.label?.toLowerCase().includes("one-time"))?.value ??
			null;
		const url = item.urls?.find((u) => u.primary)?.href ?? item.urls?.[0]?.href ?? null;
		const domain = url
			? (() => {
					try {
						return new URL(url.includes("://") ? url : `https://${url}`).hostname;
					} catch {
						return null;
					}
				})()
			: null;
		const noteParts: string[] = [];
		noteParts.push(`Item type: ${item.category ?? "unknown"}.`);
		const hasPasskey = item.fields?.some((f) => f.type?.toUpperCase() === "PASSKEY");
		if (hasPasskey) noteParts.push("This is a passkey — passwordless. Use the 1Password app to sign in.");
		else noteParts.push("This item has no password field (likely SSO / social-login).");
		return { username, domain, totp, note: noteParts.join(" ") };
	} catch (err) {
		return {
			username: null,
			domain: null,
			totp: null,
			note: `Could not parse op item: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
