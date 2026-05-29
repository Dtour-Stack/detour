/**
 * Superteam Earn RPC handlers — 10 endpoints, one per UI button.
 *
 *   - superteamEarnStatus          → dashboard card
 *   - superteamEarnRegister        → "Register Agent" button
 *   - superteamEarnGetConfig       → load settings form
 *   - superteamEarnSetConfig       → save settings form
 *   - superteamEarnListings        → "Browse Listings" button
 *   - superteamEarnListingDetails  → click a listing row
 *   - superteamEarnSubmit          → "Submit Work" button
 *   - superteamEarnUpdateSubmission→ "Edit Submission" button
 *   - superteamEarnComments        → view listing comments
 *   - superteamEarnPostComment     → "Post Comment" button
 */

import type { RpcDeps } from "../types";
import type { SuperteamEarnConfig, SuperteamEarnStatus } from "../../../../shared/index";
import type {
	SuperteamResult,
	SuperteamListing,
	SuperteamListingDetails,
	SuperteamSubmission,
	SuperteamComment,
	CreateSubmissionInput,
	UpdateSubmissionInput,
	CreateCommentInput,
} from "../../superteam-earn-client";

export function superteamEarnRequests(deps: RpcDeps) {
	return {
		superteamEarnStatus: async (
			_params: Record<string, never>,
		): Promise<SuperteamEarnStatus> => {
			return deps.superteamEarn.getStatus();
		},

		superteamEarnRegister: async (
			params: { name: string },
		): Promise<SuperteamResult<{ agentId: string; username: string; claimCode: string; claimUrl: string }>> => {
			if (!params.name || typeof params.name !== "string") {
				return { ok: false, error: "name is required" };
			}
			return deps.superteamEarn.register(params.name.trim());
		},

		superteamEarnGetConfig: async (
			_params: Record<string, never>,
		): Promise<SuperteamEarnConfig> => {
			return deps.config.getSuperteamEarn();
		},

		superteamEarnSetConfig: async (
			params: Partial<SuperteamEarnConfig>,
		): Promise<SuperteamEarnConfig> => {
			const current = await deps.config.getSuperteamEarn();
			return deps.config.setSuperteamEarn({ ...current, ...params });
		},

		superteamEarnListings: async (
			params: { take?: number; deadline?: string; type?: "bounty" | "project" | "hackathon" },
		): Promise<SuperteamResult<SuperteamListing[]>> => {
			return deps.superteamEarn.listLive(params);
		},

		superteamEarnListingDetails: async (
			params: { slug: string },
		): Promise<SuperteamResult<SuperteamListingDetails>> => {
			if (!params.slug) return { ok: false, error: "slug is required" };
			return deps.superteamEarn.getDetails(params.slug);
		},

		superteamEarnSubmit: async (
			params: CreateSubmissionInput,
		): Promise<SuperteamResult<SuperteamSubmission>> => {
			if (!params.listingId) return { ok: false, error: "listingId is required" };
			if (!params.link && !params.otherInfo) {
				return { ok: false, error: "link or otherInfo is required" };
			}
			return deps.superteamEarn.submit(params);
		},

		superteamEarnUpdateSubmission: async (
			params: UpdateSubmissionInput,
		): Promise<SuperteamResult<SuperteamSubmission>> => {
			if (!params.listingId) return { ok: false, error: "listingId is required" };
			return deps.superteamEarn.updateSubmission(params);
		},

		superteamEarnComments: async (
			params: { listingId: string; skip?: number; take?: number },
		): Promise<SuperteamResult<SuperteamComment[]>> => {
			if (!params.listingId) return { ok: false, error: "listingId is required" };
			return deps.superteamEarn.getComments(params.listingId, {
				skip: params.skip,
				take: params.take,
			});
		},

		superteamEarnPostComment: async (
			params: CreateCommentInput,
		): Promise<SuperteamResult<SuperteamComment>> => {
			if (!params.refId) return { ok: false, error: "refId is required" };
			if (!params.message) return { ok: false, error: "message is required" };
			return deps.superteamEarn.postComment(params);
		},
	};
}
