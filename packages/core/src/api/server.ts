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
import { listPermissions, openPermissionPane, type PermissionId } from "../os-permissions";
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
	ProviderId,
} from "@detour/shared";

const VERSION = "0.0.1";

type WsData = { id: string };

type Listener = (msg: WsServerMessage) => void;

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

	setWindowController(fn: WindowController | null): void {
		this.windowController = fn;
	}

	constructor(
		private readonly runtime: RuntimeService,
		private readonly vault: VaultService,
		private readonly auth: AuthService,
		private readonly backendOps: BackendOps,
		private readonly config: ConfigService,
	) {}

	async start(preferredPort = 2138): Promise<{ port: number }> {
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
						// Trigger build if no runtime exists so OAuth-derived providers
						// surface as active without waiting for the first chat message.
						await this.runtime.getOrBuild().catch(() => {});
						const runtimeProvider = this.runtime.getCurrentProvider();
						const enriched = list.map((p) => ({
							...p,
							active: p.active || runtimeProvider === p.id,
						}));
						return json(enriched);
					}
					const setKey = path.match(/^\/api\/providers\/([^/]+)\/key$/);
					if (req.method === "PUT" && setKey) {
						const id = setKey[1] as ProviderId;
						const body = (await req.json()) as SetProviderKeyBody;
						await this.vault.setProviderKey(id, body.key);
						const wasFirst = this.runtime.getCurrentProvider() === null;
						if (wasFirst) await this.runtime.rebuild();
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
					if (msg.kind === "chat:send") {
						const { convId, text } = msg;
						try {
							await this.runtime.sendMessage(text, (delta) =>
								this.broadcast({ kind: "chat:delta", convId, delta }),
							);
							this.broadcast({ kind: "chat:complete", convId });
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							this.broadcast({ kind: "chat:error", convId, message });
						}
					}
				},
			},
		});

		this.port = this.server.port ?? port;
		this.writeLockfile();
		return { port: this.port };
	}

	stop(): void {
		this.removeLockfile();
		this.server?.stop(true);
		this.server = null;
		for (const ws of this.subscribers.values()) ws.close();
		this.subscribers.clear();
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
