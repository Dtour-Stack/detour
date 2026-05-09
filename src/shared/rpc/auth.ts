import type { AccountRecord, AuthFlowState } from "../index";

/**
 * Account credential providers — mirrors `AccountCredentialProvider` from
 * `@elizaos/agent/auth`. Kept as `string` on the wire to avoid coupling
 * the shared schema to the agent package.
 */

// `listAllAccounts` returns redacted summaries (no `credentials`), one per
// account-credential provider id. The bun-side handler maps records via
// `redactAccount(...)`. The wire type matches AuthService.AccountSummary —
// duplicated here so the shared schema stays bun-independent.
export type AuthAccountSummary = {
	id: string;
	providerId: string;
	label: string;
	source: "oauth" | "api-key";
	expires?: number;
	expired?: boolean;
	tokenPreview?: string;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	organizationId?: string;
	userId?: string;
	email?: string;
};

export type AuthRequests = {
	authListProviders: {
		params: Record<string, never>;
		response: { subscription: string[]; direct: string[]; all: string[] };
	};
	authListAccounts: {
		params: Record<string, never>;
		response: Record<string, AuthAccountSummary[]>;
	};
	authDeleteAccount: {
		params: { provider: string; accountId: string };
		response: { ok: true };
	};
	authStartFlow: {
		params: {
			provider: "anthropic-subscription" | "openai-codex";
			label: string;
			accountId?: string;
		};
		response: {
			sessionId: string;
			authUrl: string;
			needsCodeSubmission: boolean;
		};
	};
	authGetFlow: {
		params: { sessionId: string };
		response: AuthFlowState;
	};
	authCancelFlow: {
		params: { sessionId: string };
		response: { ok: true };
	};
	authSubmitFlowCode: {
		params: { sessionId: string; code: string };
		response: { ok: boolean };
	};
	// Direct token-exchange import for the Anthropic OAuth `code#state`
	// blob (the redirect-page output of the Pro/Max OAuth flow). Lets a
	// user paste the blob anywhere — the API key field, a fresh app
	// install, or after a stale flow timed out — without needing the
	// originating session's PKCE state. Anthropic's flow encodes the
	// PKCE verifier directly into the `state` half, so the server-side
	// token exchange can be done from the blob alone (see
	// eliza/packages/agent/src/auth/vendor/pi-oauth/anthropic-login.ts:58).
	authImportAnthropicCode: {
		params: { code: string; label?: string };
		response: { ok: true; accountId: string };
	};
	// OpenRouter OAuth (PKCE) — start a flow that opens browser to
	// openrouter.ai/auth, captures the code via a loopback listener,
	// exchanges it for a user-controlled API key, and stores under
	// OPENROUTER_API_KEY. Status is broadcast through `authFlowUpdate`.
	// Reference: https://openrouter.ai/docs/guides/overview/auth/oauth
	authStartOpenRouterFlow: {
		params: { label?: string };
		response: {
			sessionId: string;
			authUrl: string;
			needsCodeSubmission: false;
		};
	};
	// ElizaOS Cloud CLI-session device flow — POST to create a session,
	// open browser to /auth/cli-login?session=<id>, poll until the
	// returned status flips to "success" with an apiKey. Stores under
	// ELIZAOS_CLOUD_API_KEY. Pattern mirrors the milady-ai/milady client
	// implementation at apps/homepage/src/lib/auth.ts.
	authStartElizaCloudFlow: {
		params: { label?: string };
		response: {
			sessionId: string;
			authUrl: string;
			needsCodeSubmission: false;
		};
	};
};

export type AuthMessages = {
	// Replaces ws `auth:flow-update`. Pushed for every state transition of
	// an in-flight OAuth flow (pending → success | error | cancelled |
	// timeout). Bridged from the legacy WS publish via
	// src/bun/core/rpc/registry.ts; the canonical RPC handler in
	// src/bun/core/rpc/handlers/auth.ts also broadcasts directly. The
	// double-publish is harmless until Phase 2 deletes the WS path.
	//
	// `AccountRecord` is exported here so the schema stays bun-independent
	// even though `AuthFlowState.account` includes credentials. Listeners
	// MUST treat the payload as untrusted and re-redact before display —
	// the existing ProvidersTab call site reads only `state.status` and
	// `state.error`, not `state.account`, so this is safe.
	authFlowUpdate: { sessionId: string; state: AuthFlowState };
};

// Keep AccountRecord re-exported from the shared module so call sites
// that destructure off the message payload don't have to import from two
// files.
export type { AccountRecord };
