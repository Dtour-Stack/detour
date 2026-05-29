/**
 * SuperteamEarnService — orchestrates Superteam Earn API interactions,
 * vault-backed credentials, and config persistence.
 *
 * This is a "thin service" that owns credential lifecycle and delegates
 * HTTP work to SuperteamEarnClient. No autonomous polling — every
 * action is user-initiated via RPC (button click).
 *
 * Vault keys:
 *   - SUPERTEAM_EARN_API_KEY   → agent Bearer token (from registration)
 *   - SUPERTEAM_EARN_AGENT_ID  → agentId returned at registration
 *   - SUPERTEAM_EARN_CLAIM_CODE → claimCode for human payout
 *   - SUPERTEAM_EARN_USERNAME  → talent profile slug
 */

import { logger } from "@elizaos/core";
import {
	SuperteamEarnClient,
	type CreateCommentInput,
	type CreateSubmissionInput,
	type SuperteamComment,
	type SuperteamListing,
	type SuperteamListingDetails,
	type SuperteamResult,
	type SuperteamSubmission,
	type UpdateSubmissionInput,
} from "./superteam-earn-client";
import type { SuperteamEarnConfig, SuperteamEarnStatus } from "../../shared/index";
import type { VaultService } from "./vault";
import type { ConfigService } from "./config-service";

// ── Vault keys ────────────────────────────────────────────────────────

const VK_API_KEY = "SUPERTEAM_EARN_API_KEY";
const VK_AGENT_ID = "SUPERTEAM_EARN_AGENT_ID";
const VK_CLAIM_CODE = "SUPERTEAM_EARN_CLAIM_CODE";
const VK_USERNAME = "SUPERTEAM_EARN_USERNAME";

const DEFAULT_BASE_URL = "https://earn.superteam.fun";

// ── Service ───────────────────────────────────────────────────────────

export class SuperteamEarnService {
	private client: SuperteamEarnClient | null = null;

	constructor(
		private readonly vault: VaultService,
		private readonly config: ConfigService,
	) {}

	// ── Status ──────────────────────────────────────────────────────

	async getStatus(): Promise<SuperteamEarnStatus> {
		const manager = await this.vault.manager();
		const hasKey = await manager.has(VK_API_KEY);
		const agentId = hasKey && (await manager.has(VK_AGENT_ID))
			? await manager.get(VK_AGENT_ID)
			: null;
		const username = hasKey && (await manager.has(VK_USERNAME))
			? await manager.get(VK_USERNAME)
			: null;
		const claimCode = hasKey && (await manager.has(VK_CLAIM_CODE))
			? await manager.get(VK_CLAIM_CODE)
			: null;
		const cfg = await this.config.getSuperteamEarn();
		const claimUrl = claimCode
			? `${cfg.baseUrl}/earn/claim/${claimCode}`
			: null;
		return {
			configured: hasKey,
			agentId,
			username,
			claimCode,
			claimUrl,
		};
	}

	// ── Registration ───────────────────────────────────────────────

	async register(
		name: string,
	): Promise<SuperteamResult<{ agentId: string; username: string; claimCode: string; claimUrl: string }>> {
		const cfg = await this.config.getSuperteamEarn();
		const result = await SuperteamEarnClient.register(cfg.baseUrl, name);
		if (!result.ok) return result;

		// Persist credentials in vault
		const manager = await this.vault.manager();
		await manager.set(VK_API_KEY, result.data.apiKey, { sensitive: true });
		await manager.set(VK_AGENT_ID, result.data.agentId);
		await manager.set(VK_CLAIM_CODE, result.data.claimCode);
		await manager.set(VK_USERNAME, result.data.username);

		// Clear cached client so next call picks up the new key
		this.client = null;

		logger.info(
			{ src: "superteam-earn", agentId: result.data.agentId },
			"agent registered on Superteam Earn",
		);

		return {
			ok: true,
			data: {
				agentId: result.data.agentId,
				username: result.data.username,
				claimCode: result.data.claimCode,
				claimUrl: `${cfg.baseUrl}/earn/claim/${result.data.claimCode}`,
			},
		};
	}

	// ── Listings ────────────────────────────────────────────────────

	async listLive(opts?: {
		take?: number;
		deadline?: string;
		type?: "bounty" | "project" | "hackathon";
	}): Promise<SuperteamResult<SuperteamListing[]>> {
		const client = await this.ensureClient();
		if (!client) return { ok: false, error: "not configured — register first" };
		return client.listLive(opts);
	}

	async getDetails(
		slug: string,
	): Promise<SuperteamResult<SuperteamListingDetails>> {
		const client = await this.ensureClient();
		if (!client) return { ok: false, error: "not configured — register first" };
		return client.getListingDetails(slug);
	}

	// ── Submissions ────────────────────────────────────────────────

	async submit(
		params: CreateSubmissionInput,
	): Promise<SuperteamResult<SuperteamSubmission>> {
		const client = await this.ensureClient();
		if (!client) return { ok: false, error: "not configured — register first" };
		// Auto-inject telegram from config if not provided and it's set
		if (!params.telegram) {
			const cfg = await this.config.getSuperteamEarn();
			if (cfg.telegramUrl) {
				params = { ...params, telegram: cfg.telegramUrl };
			}
		}
		return client.createSubmission(params);
	}

	async updateSubmission(
		params: UpdateSubmissionInput,
	): Promise<SuperteamResult<SuperteamSubmission>> {
		const client = await this.ensureClient();
		if (!client) return { ok: false, error: "not configured — register first" };
		if (!params.telegram) {
			const cfg = await this.config.getSuperteamEarn();
			if (cfg.telegramUrl) {
				params = { ...params, telegram: cfg.telegramUrl };
			}
		}
		return client.updateSubmission(params);
	}

	// ── Comments ───────────────────────────────────────────────────

	async getComments(
		listingId: string,
		opts?: { skip?: number; take?: number },
	): Promise<SuperteamResult<SuperteamComment[]>> {
		const client = await this.ensureClient();
		if (!client) return { ok: false, error: "not configured — register first" };
		return client.getComments(listingId, opts);
	}

	async postComment(
		params: CreateCommentInput,
	): Promise<SuperteamResult<SuperteamComment>> {
		const client = await this.ensureClient();
		if (!client) return { ok: false, error: "not configured — register first" };
		return client.createComment(params);
	}

	// ── Private ────────────────────────────────────────────────────

	private async ensureClient(): Promise<SuperteamEarnClient | null> {
		if (this.client) return this.client;
		const manager = await this.vault.manager();
		if (!(await manager.has(VK_API_KEY))) return null;
		const apiKey = await manager.get(VK_API_KEY);
		const cfg = await this.config.getSuperteamEarn();
		this.client = new SuperteamEarnClient(apiKey, cfg.baseUrl);
		return this.client;
	}
}
