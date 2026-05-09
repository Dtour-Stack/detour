import type { AuthFlowState } from "../../../../shared/index";
import type { AuthAccountSummary } from "../../../../shared/rpc/auth";
import {
	ALL_PROVIDER_IDS,
	PROVIDER_ENV,
	type AccountCredentialProvider,
	type SubscriptionProvider,
} from "../../auth";
import { saveAccount, type AccountCredentialRecord } from "@elizaos/agent/auth";
import type { RpcDeps } from "../types";

// Anthropic OAuth constants — duplicated from
// eliza/packages/agent/src/auth/vendor/pi-oauth/anthropic-login.ts so the
// post-hoc token exchange below doesn't have to spin up a full flow
// (which would generate a fresh PKCE verifier that mismatches the one
// embedded in the user's pasted blob's `state` half).
const ANTHROPIC_CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

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
		authListProviders: async (
			_params: Record<string, never>,
		): Promise<{ subscription: string[]; direct: string[]; all: string[] }> => {
			return {
				subscription: ["anthropic-subscription", "openai-codex"],
				direct: Object.keys(PROVIDER_ENV),
				all: [...ALL_PROVIDER_IDS],
			};
		},

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

		authGetFlow: async (params: { sessionId: string }): Promise<AuthFlowState> => {
			const state = deps.auth.getFlowState(params.sessionId);
			if (!state) throw new Error("flow not found");
			return state as AuthFlowState;
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
