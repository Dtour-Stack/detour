import type { AuthFlowState } from "../../../../shared/index";
import type { AuthAccountSummary } from "../../../../shared/rpc/auth";
import {
	type AccountCredentialProvider,
	type SubscriptionProvider,
} from "../../auth";
import { saveAccount, type AccountCredentialRecord } from "@elizaos/agent/auth";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import type { RpcDeps } from "../types";

// Anthropic OAuth constants — duplicated from
// eliza/packages/agent/src/auth/vendor/pi-oauth/anthropic-login.ts so the
// post-hoc token exchange below doesn't have to spin up a full flow
// (which would generate a fresh PKCE verifier that mismatches the one
// embedded in the user's pasted blob's `state` half).
const ANTHROPIC_CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

// ElizaOS Cloud CLI-session device flow —
// pattern: POST /api/auth/cli-session with sessionId → user opens
// browser to /auth/cli-login?session=<id> → poll
// /api/auth/cli-session/<id> until { status: "success", apiKey }.
// Mirrors milady-ai/milady's `cloudLogin` /  `cloudLoginPoll` helpers
// (apps/homepage/src/lib/auth.ts) so an ElizaCloud account that works
// with one client works with the other.
const ELIZACLOUD_BASE = "https://www.elizacloud.ai";
const ELIZACLOUD_SESSION_CREATE = `${ELIZACLOUD_BASE}/api/auth/cli-session`;
const ELIZACLOUD_FLOW_POLL_INTERVAL_MS = 2_000;
const ELIZACLOUD_FLOW_TIMEOUT_MS = 5 * 60_000;

// OpenRouter PKCE flow constants —
// https://openrouter.ai/docs/guides/overview/auth/oauth
//
// OpenRouter dedupes callback URLs as "apps" on their side, so a
// stable callback URL across restarts is required (ephemeral ports
// trigger HTTP 409 "Failed to create or update app while creating
// auth code"). We route the callback through Detour's portless
// reverse proxy: bind an ephemeral local listener, register
// `detour-auth.localhost` → that port via portless, and use
// `http://detour-auth.localhost:<portlessProxyPort>/openrouter-callback`
// as the callback URL. The hostname is stable across runs even when
// the underlying ephemeral port rotates, so OpenRouter sees the same
// "app" each time. Portless naturally falls under their localhost
// allowlist (it resolves through 127.0.0.1 via the .localhost TLD).
const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_CALLBACK_PATH = "/openrouter-callback";
const OPENROUTER_CALLBACK_HOSTNAME = "detour-auth";
const OPENROUTER_FLOW_TIMEOUT_MS = 5 * 60_000;

const OPENROUTER_SUCCESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OpenRouter connected</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;padding:60px;text-align:center;background:#0a0a0a;color:#eee}h1{font-weight:500}p{opacity:.7}</style>
</head><body><h1>OpenRouter connected</h1><p>You can close this window — Detour has your key.</p></body></html>`;

function base64UrlEncode(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkcePair(): { verifier: string; challenge: string } {
	const verifier = base64UrlEncode(randomBytes(32));
	const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/**
 * Detect whether a user-pasted string is an Anthropic OAuth callback
 * `code#state` blob. The redirect page surfaces literally
 * `<base64url-code>#<base64url-state>` — both halves are URL-safe base64
 * and contain no `sk-` API-key prefix.
 */
export function looksLikeAnthropicOAuthCode(input: string): boolean {
	if (input.startsWith("sk-")) return false;
	const splits = input.split("#");
	if (splits.length !== 2) return false;
	const [code, state] = splits;
	if (!code || !state) return false;
	return /^[A-Za-z0-9_-]+$/.test(code) && /^[A-Za-z0-9_-]+$/.test(state);
}

/**
 * Auth RPC handlers — replaces the HTTP routes:
 *   GET    /api/auth/providers
 *   GET    /api/auth/accounts
 *   DELETE /api/auth/accounts/<provider>/<accountId>
 *   POST   /api/auth/flows
 *   GET    /api/auth/flows/<sessionId>
 *   DELETE /api/auth/flows/<sessionId>
 *   POST   /api/auth/flows/<sessionId>/code
 *
 * `authStartFlow` reproduces the subscribe-and-broadcast lifecycle from
 * server.ts:2532-2573: subscribe to flow updates, push each transition
 * via `deps.broadcaster.broadcast("authFlowUpdate", ...)`, and on success
 * rebuild the runtime + emit `providerChanged`. The legacy WS publish
 * path in server.ts also still runs and is bridged via registry.ts; the
 * resulting double-publish is harmless until WS is removed in Phase 2.
 */
export function authRequests(deps: RpcDeps) {
	return {
		authListAccounts: async (
			_params: Record<string, never>,
		): Promise<Record<string, AuthAccountSummary[]>> => {
			// AuthService.listAllAccounts already redacts via redactAccount().
			return deps.auth.listAllAccounts();
		},

		authDeleteAccount: async (params: {
			provider: string;
			accountId: string;
		}): Promise<{ ok: true }> => {
			deps.auth.deleteAccount(
				params.provider as AccountCredentialProvider,
				params.accountId,
			);
			await deps.runtime.rebuild().catch(() => {});
			deps.broadcaster.broadcast("providerChanged", {
				activeProvider: deps.runtime.getCurrentProvider(),
			});
			return { ok: true };
		},

		authStartFlow: async (params: {
			provider: "anthropic-subscription" | "openai-codex";
			label: string;
			accountId?: string;
		}): Promise<{
			sessionId: string;
			authUrl: string;
			needsCodeSubmission: boolean;
		}> => {
			const handle = await deps.auth.startFlow(params.provider as SubscriptionProvider, {
				label: params.label,
				accountId: params.accountId,
			});
			// Mirrors server.ts:2542-2563 — subscribe to flow state changes
			// and broadcast each via RPC; on success, rebuild the runtime so
			// the freshly-stored OAuth account becomes the active provider.
			deps.auth.subscribeFlow(handle.sessionId, (state) => {
				deps.broadcaster.broadcast("authFlowUpdate", {
					sessionId: handle.sessionId,
					state: state as AuthFlowState,
				});
				if (state.status === "success") {
					deps.runtime
						.rebuild()
						.then(() => {
							deps.broadcaster.broadcast("providerChanged", {
								activeProvider: deps.runtime.getCurrentProvider(),
							});
						})
						.catch((err) =>
							console.error("[runtime] rebuild after OAuth success failed:", err),
						);
				}
			});
			// Don't await completion — return immediately so the UI can display
			// the authUrl. Errors surface via subscribeFlow.
			handle.completion.catch(() => {});
			return {
				sessionId: handle.sessionId,
				authUrl: handle.authUrl,
				needsCodeSubmission: handle.needsCodeSubmission,
			};
		},

		authCancelFlow: async (params: { sessionId: string }): Promise<{ ok: true }> => {
			deps.auth.cancelFlow(params.sessionId, "user-cancelled");
			return { ok: true };
		},

		authSubmitFlowCode: async (params: {
			sessionId: string;
			code: string;
		}): Promise<{ ok: boolean }> => {
			const ok = deps.auth.submitFlowCode(params.sessionId, params.code);
			return { ok };
		},

		/**
		 * Start an OpenRouter PKCE OAuth flow. Opens a loopback HTTP
		 * listener on an ephemeral port, returns the auth URL the view
		 * should pop in a browser. The flow runs to completion in the
		 * background — status is broadcast through `authFlowUpdate`.
		 *
		 * Reference: https://openrouter.ai/docs/guides/overview/auth/oauth
		 *
		 * Unlike Anthropic/Codex this stores the resulting *user-scoped
		 * API key* (not OAuth tokens) under `OPENROUTER_API_KEY` in the
		 * vault, because that's what OpenRouter's exchange endpoint
		 * returns.
		 */
		authStartOpenRouterFlow: async (params: {
			label?: string;
		}): Promise<{
			sessionId: string;
			authUrl: string;
			needsCodeSubmission: false;
		}> => {
			const sessionId = crypto.randomUUID();
			const startedAt = Date.now();
			const { verifier, challenge } = generatePkcePair();

			let resolveCode: ((code: string) => void) | null = null;
			let rejectCode: ((err: Error) => void) | null = null;
			const codePromise = new Promise<string>((resolve, reject) => {
				resolveCode = resolve;
				rejectCode = reject;
			});

			const server: Server = createServer((req, res) => {
				try {
					const reqUrl = new URL(req.url ?? "", "http://127.0.0.1");
					if (reqUrl.pathname !== OPENROUTER_CALLBACK_PATH) {
						res.statusCode = 404;
						res.end("Not found");
						return;
					}
					const code = reqUrl.searchParams.get("code");
					if (!code) {
						res.statusCode = 400;
						res.end("Missing 'code' query param");
						rejectCode?.(new Error("OpenRouter callback missing 'code' query param"));
						return;
					}
					res.statusCode = 200;
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end(OPENROUTER_SUCCESS_HTML);
					resolveCode?.(code);
				} catch (err) {
					res.statusCode = 500;
					res.end("Internal error");
					rejectCode?.(err instanceof Error ? err : new Error(String(err)));
				}
			});

			// Bind an ephemeral local listener — port can rotate freely; the
			// portless route below gives OpenRouter a stable hostname.
			await new Promise<void>((resolve, reject) => {
				const onError = (err: Error) => {
					server.removeListener("error", onError);
					reject(err);
				};
				server.once("error", onError);
				server.listen(0, "127.0.0.1", () => {
					server.removeListener("error", onError);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				throw new Error("Failed to bind OpenRouter callback listener");
			}
			const localPort = address.port;

			// Register the route through Detour's portless proxy so the
			// callback URL the user sees is stable (`detour-auth.localhost:4848`)
			// across restarts — OpenRouter's "app" registry keys off the
			// callback URL so this avoids the 409 dedupe trap.
			const portlessSnap = deps.portless.snapshot();
			if (!portlessSnap.running) {
				server.close();
				throw new Error(
					"Portless proxy isn't running — required for OpenRouter callback routing. Check the Portless tab.",
				);
			}
			const fqHostname = `${OPENROUTER_CALLBACK_HOSTNAME}.${portlessSnap.tld}`;
			deps.portless.addRoute(fqHostname, localPort, { force: true });
			const callbackUrl = `http://${fqHostname}:${portlessSnap.proxyPort}${OPENROUTER_CALLBACK_PATH}`;
			const authUrl =
				`${OPENROUTER_AUTH_URL}?callback_url=${encodeURIComponent(callbackUrl)}` +
				`&code_challenge=${encodeURIComponent(challenge)}` +
				`&code_challenge_method=S256`;

			const initialState = {
				sessionId,
				providerId: "openrouter" as const,
				status: "pending" as const,
				authUrl,
				needsCodeSubmission: false,
				startedAt,
			};
			deps.broadcaster.broadcast("authFlowUpdate", { sessionId, state: initialState });

			const timeoutTimer = setTimeout(() => {
				rejectCode?.(new Error(`OpenRouter OAuth flow timed out after ${OPENROUTER_FLOW_TIMEOUT_MS / 1000}s`));
			}, OPENROUTER_FLOW_TIMEOUT_MS);

			// Drive the flow to completion in the background. Status updates
			// land via `authFlowUpdate`. The original RPC call returns
			// immediately with the authUrl so the view can open a browser.
			void (async () => {
				try {
					const code = await codePromise;
					clearTimeout(timeoutTimer);
					const exchange = await fetch(OPENROUTER_TOKEN_URL, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							code,
							code_verifier: verifier,
							code_challenge_method: "S256",
						}),
					});
					if (!exchange.ok) {
						const errText = await exchange.text().catch(() => exchange.statusText);
						throw new Error(`OpenRouter token exchange failed: ${errText}`);
					}
					const data = (await exchange.json()) as { key?: string };
					if (!data.key) throw new Error("OpenRouter response missing 'key'");
					await deps.vault.setProviderKey("openrouter", data.key);
					// Explicitly set OpenRouter as active after PKCE success
					await deps.vault.setActiveProvider("openrouter");
					console.log(`[auth] Imported OpenRouter API key via PKCE flow (sessionId=${sessionId})`);
					// Broadcast SUCCESS before kicking off the rebuild — the UI
					// only needs the key in the vault to flip "Configured", and
					// runtime.rebuild() can take many seconds (eliza plugin init,
					// PGlite migrations, channel plugin boot). Keeping the
					// success broadcast on the critical path made the
					// activeFlow card hang on "pending" until the runtime
					// finished, which looked like a stuck state.
					deps.broadcaster.broadcast("authFlowUpdate", {
						sessionId,
						state: { ...initialState, status: "success", endedAt: Date.now() },
					});
					// Broadcast providerChanged immediately so the UI updates
					// without waiting for the rebuild
					deps.broadcaster.broadcast("providerChanged", {
						activeProvider: "openrouter",
					});
					deps.runtime
						.rebuild()
						.then(() => {
							deps.broadcaster.broadcast("providerChanged", {
								activeProvider: deps.runtime.getCurrentProvider(),
							});
						})
						.catch((err) =>
							console.error("[runtime] rebuild after OpenRouter import failed:", err),
						);
				} catch (err) {
					clearTimeout(timeoutTimer);
					const message = err instanceof Error ? err.message : String(err);
					const isCancel = message.includes("timed out");
					deps.broadcaster.broadcast("authFlowUpdate", {
						sessionId,
						state: {
							...initialState,
							status: isCancel ? "timeout" : "error",
							error: message,
							endedAt: Date.now(),
						},
					});
				} finally {
					try { deps.portless.removeRoute(fqHostname); } catch { /* ignore */ }
					try { server.close(); } catch { /* ignore */ }
				}
			})();

			return { sessionId, authUrl, needsCodeSubmission: false };
		},

		/**
		 * ElizaOS Cloud CLI-session device flow. Mirrors the
		 * milady-ai/milady pattern (apps/homepage/src/lib/auth.ts):
		 *   1. Generate a sessionId, POST it to
		 *      https://www.elizacloud.ai/api/auth/cli-session.
		 *   2. Open browser to /auth/cli-login?session=<id>; user signs in.
		 *   3. Poll /api/auth/cli-session/<id> every 2s until status
		 *      flips to "success" with an apiKey, or until 5min timeout.
		 *   4. Store apiKey under ELIZAOS_CLOUD_API_KEY in the vault.
		 *
		 * Same broadcast/UI pattern as the OpenRouter handler — RPC
		 * returns immediately with the auth URL; status updates flow
		 * through `authFlowUpdate`.
		 */
		authStartElizaCloudFlow: async (_params: {
			label?: string;
		}): Promise<{
			sessionId: string;
			authUrl: string;
			needsCodeSubmission: false;
		}> => {
			const sessionId = crypto.randomUUID();
			const startedAt = Date.now();
			const authUrl = `${ELIZACLOUD_BASE}/auth/cli-login?session=${encodeURIComponent(sessionId)}`;

			// Create the session server-side BEFORE returning. If this
			// fails (network down, ElizaCloud 5xx), surface synchronously
			// so the UI shows an error instead of a stuck "pending" card.
			const createRes = await fetch(ELIZACLOUD_SESSION_CREATE, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId }),
				redirect: "manual",
			});
			if (!createRes.ok) {
				const errText = await createRes.text().catch(() => createRes.statusText);
				throw new Error(`ElizaCloud session create failed: ${createRes.status} ${errText}`);
			}

			const initialState = {
				sessionId,
				providerId: "elizacloud" as const,
				status: "pending" as const,
				authUrl,
				needsCodeSubmission: false,
				startedAt,
			};
			deps.broadcaster.broadcast("authFlowUpdate", { sessionId, state: initialState });

			// Poll in the background until success / timeout / error. The
			// API returns { status: string, apiKey?: string } — `apiKey`
			// only lands once the user completes the browser sign-in.
			void (async () => {
				const deadline = Date.now() + ELIZACLOUD_FLOW_TIMEOUT_MS;
				try {
					while (Date.now() < deadline) {
						const pollRes = await fetch(
							`${ELIZACLOUD_SESSION_CREATE}/${encodeURIComponent(sessionId)}`,
							{ redirect: "manual" },
						);
						if (pollRes.status === 404) {
							throw new Error("ElizaCloud session expired");
						}
						if (pollRes.ok) {
							const data = (await pollRes.json()) as { status?: string; apiKey?: string };
							if (data.apiKey) {
								await deps.vault.setProviderKey("elizacloud", data.apiKey);
								console.log(`[auth] Imported ElizaCloud API key via CLI-session flow (sessionId=${sessionId})`);
								deps.broadcaster.broadcast("authFlowUpdate", {
									sessionId,
									state: { ...initialState, status: "success", endedAt: Date.now() },
								});
								// Background rebuild — same rationale as
								// OpenRouter / Anthropic handlers.
								deps.runtime
									.rebuild()
									.then(() => {
										deps.broadcaster.broadcast("providerChanged", {
											activeProvider: deps.runtime.getCurrentProvider(),
										});
									})
									.catch((err) =>
										console.error("[runtime] rebuild after ElizaCloud import failed:", err),
									);
								return;
							}
							// status pending — keep polling.
						}
						await new Promise((resolve) => setTimeout(resolve, ELIZACLOUD_FLOW_POLL_INTERVAL_MS));
					}
					throw new Error(`ElizaCloud sign-in timed out after ${ELIZACLOUD_FLOW_TIMEOUT_MS / 1000}s`);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const isTimeout = message.includes("timed out") || message.includes("expired");
					deps.broadcaster.broadcast("authFlowUpdate", {
						sessionId,
						state: {
							...initialState,
							status: isTimeout ? "timeout" : "error",
							error: message,
							endedAt: Date.now(),
						},
					});
				}
			})();

			return { sessionId, authUrl, needsCodeSubmission: false };
		},

		/**
		 * Direct token-exchange for an Anthropic OAuth `code#state` blob.
		 * Used when the user pastes the redirect-page output anywhere
		 * (e.g. the API key field) instead of the dedicated flow box.
		 * Bypasses the session-bound `submitFlowCode` path — Anthropic's
		 * flow uses the PKCE verifier as the `state` parameter, so the
		 * exchange can be done with just the pasted blob.
		 */
		authImportAnthropicCode: async (params: {
			code: string;
			label?: string;
		}): Promise<{ ok: true; accountId: string }> => {
			const blob = params.code.trim();
			const splits = blob.split("#");
			if (splits.length !== 2) {
				throw new Error("Expected '<code>#<state>' format");
			}
			const [code, state] = splits;
			if (!code || !state) {
				throw new Error("Both halves of '<code>#<state>' are required");
			}
			const tokenResponse = await fetch(ANTHROPIC_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					grant_type: "authorization_code",
					client_id: ANTHROPIC_CLIENT_ID,
					code,
					state,
					redirect_uri: ANTHROPIC_REDIRECT_URI,
					// Anthropic stores the PKCE verifier in the `state` round-trip,
					// so the verifier IS the state half of the blob.
					code_verifier: state,
				}),
			});
			if (!tokenResponse.ok) {
				const errText = await tokenResponse.text().catch(() => tokenResponse.statusText);
				throw new Error(`Anthropic token exchange failed: ${errText}`);
			}
			const tokenData = (await tokenResponse.json()) as {
				refresh_token: string;
				access_token: string;
				expires_in: number;
			};
			const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;
			const accountId = crypto.randomUUID();
			const now = Date.now();
			const record: AccountCredentialRecord = {
				id: accountId,
				providerId: "anthropic-subscription",
				label: params.label?.trim() || "Default",
				source: "oauth",
				credentials: {
					access: tokenData.access_token,
					refresh: tokenData.refresh_token,
					expires: expiresAt,
				},
				createdAt: now,
				updatedAt: now,
			};
			saveAccount(record);
			console.log(`[auth] Imported anthropic-subscription account "${accountId}" via direct code exchange`);
			// Rebuild + broadcast so the new OAuth account immediately
			// becomes the active provider for chat.
			deps.runtime
				.rebuild()
				.then(() => {
					deps.broadcaster.broadcast("providerChanged", {
						activeProvider: deps.runtime.getCurrentProvider(),
					});
				})
				.catch((err) =>
					console.error("[runtime] rebuild after Anthropic code import failed:", err),
				);
			return { ok: true, accountId };
		},
	};
}
