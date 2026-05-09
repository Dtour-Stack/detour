import type { AuthFlowState } from "../../../../shared/index";
import type { AuthAccountSummary } from "../../../../shared/rpc/auth";
import {
	ALL_PROVIDER_IDS,
	PROVIDER_ENV,
	type AccountCredentialProvider,
	type SubscriptionProvider,
} from "../../auth";
import type { RpcDeps } from "../types";

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
	};
}
