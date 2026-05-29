/**
 * Superteam Earn HTTP client — wraps every Superteam Earn agent API
 * endpoint with typed result objects.
 *
 * Pattern follows gmgn-client.ts: standalone functions + a class that
 * holds auth state. Every method returns `SuperteamResult<T>` — never
 * throws on API errors so the RPC layer can forward structured errors
 * to the UI.
 *
 * API reference: https://docs.superteamearn.com (agent endpoints)
 */

import { logger } from "@elizaos/core";

// ── Result type ───────────────────────────────────────────────────────

export type SuperteamResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string; status?: number };

// ── API response types ────────────────────────────────────────────────

export type SuperteamAgentRegistration = {
	apiKey: string;
	claimCode: string;
	agentId: string;
	username: string;
};

export type SuperteamListing = {
	id: string;
	slug: string;
	title: string;
	type: "bounty" | "project" | "hackathon";
	token: string | null;
	compensationType: string | null;
	minRewardAsk: number | null;
	maxRewardAsk: number | null;
	usdValue: number | null;
	deadline: string | null;
	sponsor: { name: string; logo: string | null } | null;
	pocId: string | null;
	skills: string[];
	eligibilityQuestions: { question: string }[];
	agentAccess: string;
	description: string | null;
};

export type SuperteamListingDetails = SuperteamListing & {
	requirements: string | null;
	references: string | null;
	templateId: string | null;
};

export type SuperteamSubmission = {
	id: string;
	listingId: string;
	link: string | null;
	tweet: string | null;
	otherInfo: string | null;
	status: string;
	createdAt: string;
};

export type SuperteamComment = {
	id: string;
	message: string;
	authorId: string;
	authorName: string | null;
	refType: string;
	refId: string;
	replyToId: string | null;
	createdAt: string;
};

export type SuperteamClaimResult = {
	claimed: boolean;
	agentId: string;
	userId: string;
};

// ── Input types ───────────────────────────────────────────────────────

export type CreateSubmissionInput = {
	listingId: string;
	link: string;
	tweet?: string;
	otherInfo?: string;
	eligibilityAnswers?: { question: string; answer: string }[];
	ask?: number | null;
	telegram?: string;
};

export type UpdateSubmissionInput = CreateSubmissionInput;

export type CreateCommentInput = {
	refType: "BOUNTY" | "PROJECT" | "HACKATHON";
	refId: string;
	message: string;
	pocId?: string;
	replyToId?: string;
	replyToUserId?: string;
};

// ── Timeouts ──────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;

// ── Client ────────────────────────────────────────────────────────────

export class SuperteamEarnClient {
	constructor(
		private readonly apiKey: string,
		private readonly baseUrl: string,
	) {}

	// ── Agent registration (no auth needed) ─────────────────────────

	static async register(
		baseUrl: string,
		name: string,
	): Promise<SuperteamResult<SuperteamAgentRegistration>> {
		return request<SuperteamAgentRegistration>(baseUrl, "POST", "/api/agents", null, { name });
	}

	// ── Listings ────────────────────────────────────────────────────

	async listLive(opts?: {
		take?: number;
		deadline?: string;
		type?: "bounty" | "project" | "hackathon";
	}): Promise<SuperteamResult<SuperteamListing[]>> {
		const params = new URLSearchParams();
		if (opts?.take) params.set("take", String(opts.take));
		if (opts?.deadline) params.set("deadline", opts.deadline);
		if (opts?.type) params.set("type", opts.type);
		const qs = params.toString();
		const path = `/api/agents/listings/live${qs ? `?${qs}` : ""}`;
		return request<SuperteamListing[]>(this.baseUrl, "GET", path, this.apiKey);
	}

	async getListingDetails(
		slug: string,
	): Promise<SuperteamResult<SuperteamListingDetails>> {
		return request<SuperteamListingDetails>(
			this.baseUrl,
			"GET",
			`/api/agents/listings/details/${encodeURIComponent(slug)}`,
			this.apiKey,
		);
	}

	// ── Submissions ────────────────────────────────────────────────

	async createSubmission(
		params: CreateSubmissionInput,
	): Promise<SuperteamResult<SuperteamSubmission>> {
		return request<SuperteamSubmission>(
			this.baseUrl,
			"POST",
			"/api/agents/submissions/create",
			this.apiKey,
			params,
		);
	}

	async updateSubmission(
		params: UpdateSubmissionInput,
	): Promise<SuperteamResult<SuperteamSubmission>> {
		return request<SuperteamSubmission>(
			this.baseUrl,
			"POST",
			"/api/agents/submissions/update",
			this.apiKey,
			params,
		);
	}

	// ── Comments ───────────────────────────────────────────────────

	async getComments(
		listingId: string,
		opts?: { skip?: number; take?: number },
	): Promise<SuperteamResult<SuperteamComment[]>> {
		const params = new URLSearchParams();
		if (opts?.skip !== undefined) params.set("skip", String(opts.skip));
		if (opts?.take !== undefined) params.set("take", String(opts.take));
		const qs = params.toString();
		return request<SuperteamComment[]>(
			this.baseUrl,
			"GET",
			`/api/agents/comments/${encodeURIComponent(listingId)}${qs ? `?${qs}` : ""}`,
			this.apiKey,
		);
	}

	async createComment(
		params: CreateCommentInput,
	): Promise<SuperteamResult<SuperteamComment>> {
		return request<SuperteamComment>(
			this.baseUrl,
			"POST",
			"/api/agents/comments/create",
			this.apiKey,
			params,
		);
	}

	// ── Claim (human privy token, not agent API key) ───────────────

	static async claim(
		baseUrl: string,
		privyToken: string,
		claimCode: string,
	): Promise<SuperteamResult<SuperteamClaimResult>> {
		return request<SuperteamClaimResult>(
			baseUrl,
			"POST",
			"/api/agents/claim",
			privyToken,
			{ claimCode },
		);
	}
}

// ── Shared fetch helper ───────────────────────────────────────────────

async function request<T>(
	baseUrl: string,
	method: "GET" | "POST",
	path: string,
	bearerToken: string | null,
	body?: unknown,
): Promise<SuperteamResult<T>> {
	const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (bearerToken) {
		headers["Authorization"] = `Bearer ${bearerToken}`;
	}
	try {
		const res = await fetch(url, {
			method,
			headers,
			body: method === "POST" && body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await res.text();
		if (!res.ok) {
			// Try to extract structured error from response body
			let errorMessage = `HTTP ${res.status}`;
			try {
				const errBody = JSON.parse(text) as { error?: string; message?: string };
				errorMessage = errBody.error ?? errBody.message ?? errorMessage;
			} catch {
				if (text.length > 0 && text.length < 200) errorMessage = text;
			}
			logger.debug(
				{ src: "superteam-earn", method, path, status: res.status },
				errorMessage,
			);
			return { ok: false, error: errorMessage, status: res.status };
		}
		const data = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
		return { ok: true, data };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.warn({ src: "superteam-earn", method, path, err: error }, "request failed");
		return { ok: false, error };
	}
}
