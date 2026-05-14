// Wraps the @elizaos/agent/auth subsystem (per-account OAuth + storage).
// Surfaces a thin API for the rest of core to drive flows and read state.

import { randomUUID } from "node:crypto";
import {
	listAccounts,
	deleteAccount,
	saveAccount,
	startAnthropicOAuthFlow,
	startCodexOAuthFlow,
	getFlowState,
	subscribeFlow,
	cancelFlow,
	submitFlowCode,
	type AccountCredentialRecord,
	type FlowState,
	type OAuthFlowHandle,
	type SubscriptionProvider,
	type AccountCredentialProvider,
	SUBSCRIPTION_PROVIDER_IDS,
	DIRECT_ACCOUNT_PROVIDER_IDS,
	DIRECT_ACCOUNT_PROVIDER_ENV,
	installClaudeCodeStealthFetchInterceptor,
} from "@elizaos/agent/auth";

export type {
	AccountCredentialRecord,
	FlowState,
	OAuthFlowHandle,
	SubscriptionProvider,
	AccountCredentialProvider,
};

export const ALL_PROVIDER_IDS = [
	...SUBSCRIPTION_PROVIDER_IDS,
	...DIRECT_ACCOUNT_PROVIDER_IDS,
] as const;

export const PROVIDER_ENV = DIRECT_ACCOUNT_PROVIDER_ENV;

export type AccountSummary = {
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

function redactAccount(record: AccountCredentialRecord): AccountSummary {
	const expires = record.credentials?.expires;
	const access = record.credentials?.access ?? "";
	const tokenPreview =
		access.length > 16
			? `${access.slice(0, 12)}…${access.slice(-4)}`
			: undefined;
	return {
		id: record.id,
		providerId: record.providerId,
		label: record.label,
		source: record.source,
		expires,
		expired: typeof expires === "number" ? expires > 0 && expires < Date.now() : undefined,
		tokenPreview,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		lastUsedAt: record.lastUsedAt,
		organizationId: record.organizationId,
		userId: record.userId,
		email: record.email,
	};
}

export class AuthService {
	private stealthInstalled = false;

	/**
	 * Install the Claude Code stealth fetch interceptor — lets us use
	 * stored Claude Code OAuth tokens (sk-ant-oat01-…) for Anthropic
	 * API calls. Idempotent.
	 */
	enableClaudeCodeStealth(): void {
		if (this.stealthInstalled) return;
		installClaudeCodeStealthFetchInterceptor();
		this.stealthInstalled = true;
	}

	listAccounts(provider: AccountCredentialProvider): AccountSummary[] {
		return listAccounts(provider).map(redactAccount);
	}

	listAllAccounts(): Record<string, AccountSummary[]> {
		const out: Record<string, AccountSummary[]> = {};
		for (const p of ALL_PROVIDER_IDS) {
			out[p] = listAccounts(p as AccountCredentialProvider).map(redactAccount);
		}
		return out;
	}

	deleteAccount(provider: AccountCredentialProvider, accountId: string): void {
		deleteAccount(provider, accountId);
	}

	/**
	 * Stack an additional API-key account on a provider's storage table.
	 *
	 * Direct-provider tables (`openai-api`, `anthropic-api`, etc.) already
	 * carry an `id + label + source: "api-key"` shape — we just write the
	 * key as the `access` field and leave `refresh` empty since API keys
	 * don't refresh. The runtime's providerAttempts walker reads these
	 * tables alongside OAuth accounts so the user can have multiple
	 * labeled API keys per provider AND the runtime will rotate through
	 * them when one hits a quota cap.
	 *
	 * Returns the generated accountId so the UI can address future
	 * delete / rename ops at this specific key.
	 */
	addApiKeyAccount(opts: {
		provider: "openai-api" | "anthropic-api" | "deepseek-api" | "zai-api" | "moonshot-api";
		label: string;
		key: string;
	}): { id: string } {
		if (!opts.key.trim()) throw new Error("addApiKeyAccount: key is empty");
		const id = randomUUID();
		const now = Date.now();
		const record: AccountCredentialRecord = {
			id,
			providerId: opts.provider,
			label: opts.label || "API key",
			source: "api-key",
			credentials: { access: opts.key, refresh: "", expires: 0 },
			createdAt: now,
			updatedAt: now,
		};
		saveAccount(record);
		return { id };
	}

	async startFlow(
		provider: SubscriptionProvider,
		opts: { label: string; accountId?: string },
	): Promise<OAuthFlowHandle> {
		if (provider === "anthropic-subscription") return startAnthropicOAuthFlow(opts);
		if (provider === "openai-codex") return startCodexOAuthFlow(opts);
		throw new Error(`Unknown subscription provider: ${provider}`);
	}

	getFlowState(sessionId: string): FlowState | null {
		return getFlowState(sessionId);
	}

	subscribeFlow(
		sessionId: string,
		listener: (state: FlowState) => void,
	): () => void {
		return subscribeFlow(sessionId, listener);
	}

	cancelFlow(sessionId: string, reason?: string): boolean {
		return cancelFlow(sessionId, reason);
	}

	submitFlowCode(sessionId: string, code: string): boolean {
		return submitFlowCode(sessionId, code);
	}
}
