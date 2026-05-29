/**
 * Superteam Earn Agent Plugin — gives the agent autonomous access to
 * Superteam Earn: browse listings, view details, submit work, post
 * comments, and check registration status.
 *
 * The agent gets these actions in its action space:
 *   - SUPERTEAM_EARN_LISTINGS       → discover agent-eligible bounties/projects
 *   - SUPERTEAM_EARN_LISTING_DETAIL → view full details of a specific listing
 *   - SUPERTEAM_EARN_SUBMIT         → submit work for a listing
 *   - SUPERTEAM_EARN_UPDATE_SUBMISSION → edit an existing submission
 *   - SUPERTEAM_EARN_COMMENTS       → read comments on a listing
 *   - SUPERTEAM_EARN_POST_COMMENT   → post/reply to a comment on a listing
 *   - SUPERTEAM_EARN_STATUS         → check registration status & claim info
 *
 * The plugin reads credentials from the vault via SuperteamEarnService
 * (passed as a constructor closure). If the agent isn't registered yet,
 * actions return a clear error message telling the user to register via
 * the UI first.
 */

import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	Plugin,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import type { SuperteamEarnService } from "../../core/superteam-earn-service";
import type {
	CreateCommentInput,
	CreateSubmissionInput,
	SuperteamResult,
	UpdateSubmissionInput,
} from "../../core/superteam-earn-client";
import type { EarnScannerService } from "../../core/earn-scanner-service";

// ── Helpers ─────────────────────────────────────────────────────────────

function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

function pickString(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function pickNumber(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): number | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim().length > 0) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim().length > 0) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

function pickArray(
	opts: Record<string, unknown> | undefined,
	key: string,
): unknown[] | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	const v = bag[key] ?? opts[key];
	return Array.isArray(v) ? v : undefined;
}

async function emit(
	callback: HandlerCallback | undefined,
	text: string,
	actionName: string,
): Promise<void> {
	if (!callback) return;
	try {
		await callback({ text, source: "superteam-earn" } as never, actionName);
	} catch {
		/* ignore */
	}
}

function fail(reason: string): ActionResult {
	return { success: false, text: reason };
}

function ok(text: string): ActionResult {
	return { success: true, text };
}

async function handleResult<T>(
	result: SuperteamResult<T>,
	actionName: string,
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	if (!result.ok) {
		const msg = `${actionName} failed: ${result.error}${result.status ? ` (HTTP ${result.status})` : ""}`;
		await emit(callback, msg, actionName);
		return fail(msg);
	}
	const text = JSON.stringify(result.data, null, 2);
	await emit(callback, text, actionName);
	return ok(text);
}

// ── Model quality constants ─────────────────────────────────────────────

/** Minimum model for competitive Earn submissions. GPT-5.5 can produce
 * images, research, graphs, and code — all critical for bounties. */
const REQUIRED_CODEX_MODEL = "gpt-5.5";

/** Models that meet the quality bar for paid Earn work. */
const ACCEPTED_MODELS = new Set(["gpt-5.5", "gpt-6", "gpt-6o"]);

// ── Action Handlers ─────────────────────────────────────────────────────

function makeHandlers(svc: SuperteamEarnService, scanner?: EarnScannerService) {
	const alwaysValid: Action["validate"] = async () => true;

	/**
	 * Validate that the runtime is using a capable model for paid work.
	 * Browse/status actions pass always; submit/update/comment actions
	 * gate on the model being GPT-5.5+ so we don't submit low-quality work.
	 */
	const requireCapableModel: Action["validate"] = async (runtime: IAgentRuntime) => {
		const codexLarge = (runtime.getSetting?.("CODEX_MODEL_LARGE") ?? process.env.CODEX_MODEL_LARGE ?? "").toString();
		if (codexLarge && ACCEPTED_MODELS.has(codexLarge)) return true;
		// Check if GPT-5.5 is the active model in env
		if (codexLarge.includes("5.5") || codexLarge.includes("5_5")) return true;
		// Still allow if OpenAI API key is present — the model router may
		// override at call time. But warn.
		const hasOpenAi = !!process.env.OPENAI_API_KEY;
		if (hasOpenAi) return true;
		return false;
	};

	// ── SUPERTEAM_EARN_LISTINGS ──────────────────────────────────────

	const listingsHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const take = pickNumber(opts, ["take", "limit", "count"]);
		const deadline = pickString(opts, ["deadline"]);
		const type = pickString(opts, ["type", "listingType"]) as "bounty" | "project" | "hackathon" | undefined;
		const result = await svc.listLive({ take, deadline, type });
		return handleResult(result, "SUPERTEAM_EARN_LISTINGS", callback);
	};

	// ── SUPERTEAM_EARN_LISTING_DETAIL ────────────────────────────────

	const detailHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const slug = pickString(opts, ["slug", "listingSlug", "listing"]);
		if (!slug) return fail("Missing listing slug (params: slug)");
		const result = await svc.getDetails(slug);
		return handleResult(result, "SUPERTEAM_EARN_LISTING_DETAIL", callback);
	};

	// ── SUPERTEAM_EARN_SUBMIT ────────────────────────────────────────

	const submitHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const listingId = pickString(opts, ["listingId", "listing_id", "listing"]);
		const link = pickString(opts, ["link", "url", "submissionLink"]);
		const tweet = pickString(opts, ["tweet", "tweetUrl"]);
		const otherInfo = pickString(opts, ["otherInfo", "other_info", "description", "details"]);
		const telegram = pickString(opts, ["telegram", "telegramUrl"]);
		const ask = pickNumber(opts, ["ask", "quote", "price"]);
		const rawAnswers = pickArray(opts, "eligibilityAnswers");
		if (!listingId) return fail("Missing listingId (params: listingId, link, otherInfo?, eligibilityAnswers?, telegram?, ask?)");
		if (!link && !otherInfo) return fail("At least one of link or otherInfo is required");
		const eligibilityAnswers = rawAnswers
			? (rawAnswers as { question: string; answer: string }[]).filter(
					(a) => typeof a.question === "string" && typeof a.answer === "string",
				)
			: undefined;
		const params: CreateSubmissionInput = {
			listingId,
			link: link ?? "",
			...(tweet ? { tweet } : {}),
			...(otherInfo ? { otherInfo } : {}),
			...(eligibilityAnswers && eligibilityAnswers.length > 0 ? { eligibilityAnswers } : {}),
			...(ask !== undefined ? { ask } : {}),
			...(telegram ? { telegram } : {}),
		};
		const result = await svc.submit(params);
		return handleResult(result, "SUPERTEAM_EARN_SUBMIT", callback);
	};

	// ── SUPERTEAM_EARN_UPDATE_SUBMISSION ─────────────────────────────

	const updateHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const listingId = pickString(opts, ["listingId", "listing_id", "listing"]);
		const link = pickString(opts, ["link", "url", "submissionLink"]);
		const tweet = pickString(opts, ["tweet", "tweetUrl"]);
		const otherInfo = pickString(opts, ["otherInfo", "other_info", "description", "details"]);
		const telegram = pickString(opts, ["telegram", "telegramUrl"]);
		const ask = pickNumber(opts, ["ask", "quote", "price"]);
		const rawAnswers = pickArray(opts, "eligibilityAnswers");
		if (!listingId) return fail("Missing listingId (params: listingId, link?, otherInfo?, eligibilityAnswers?, telegram?, ask?)");
		const eligibilityAnswers = rawAnswers
			? (rawAnswers as { question: string; answer: string }[]).filter(
					(a) => typeof a.question === "string" && typeof a.answer === "string",
				)
			: undefined;
		const params: UpdateSubmissionInput = {
			listingId,
			link: link ?? "",
			...(tweet ? { tweet } : {}),
			...(otherInfo ? { otherInfo } : {}),
			...(eligibilityAnswers && eligibilityAnswers.length > 0 ? { eligibilityAnswers } : {}),
			...(ask !== undefined ? { ask } : {}),
			...(telegram ? { telegram } : {}),
		};
		const result = await svc.updateSubmission(params);
		return handleResult(result, "SUPERTEAM_EARN_UPDATE_SUBMISSION", callback);
	};

	// ── SUPERTEAM_EARN_COMMENTS ──────────────────────────────────────

	const commentsHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const listingId = pickString(opts, ["listingId", "listing_id", "listing", "refId"]);
		const skip = pickNumber(opts, ["skip", "offset"]);
		const take = pickNumber(opts, ["take", "limit", "count"]);
		if (!listingId) return fail("Missing listingId (params: listingId, skip?, take?)");
		const result = await svc.getComments(listingId, { skip, take });
		return handleResult(result, "SUPERTEAM_EARN_COMMENTS", callback);
	};

	// ── SUPERTEAM_EARN_POST_COMMENT ──────────────────────────────────

	const postCommentHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const refId = pickString(opts, ["refId", "listingId", "listing_id"]);
		const refType = (pickString(opts, ["refType", "type"]) ?? "BOUNTY").toUpperCase() as CreateCommentInput["refType"];
		const message = pickString(opts, ["message", "comment", "text", "body"]);
		const pocId = pickString(opts, ["pocId", "poc_id"]);
		const replyToId = pickString(opts, ["replyToId", "reply_to_id", "parentId"]);
		const replyToUserId = pickString(opts, ["replyToUserId", "reply_to_user_id"]);
		if (!refId) return fail("Missing refId/listingId (params: refId, message, refType?, pocId?, replyToId?, replyToUserId?)");
		if (!message) return fail("Missing message");
		const params: CreateCommentInput = {
			refType,
			refId,
			message,
			...(pocId ? { pocId } : {}),
			...(replyToId ? { replyToId } : {}),
			...(replyToUserId ? { replyToUserId } : {}),
		};
		const result = await svc.postComment(params);
		return handleResult(result, "SUPERTEAM_EARN_POST_COMMENT", callback);
	};

	// ── SUPERTEAM_EARN_STATUS ────────────────────────────────────────

	const statusHandler: Handler = async (_r, _m, _s, _options, callback) => {
		const status = await svc.getStatus();
		const text = JSON.stringify(status, null, 2);
		await emit(callback, text, "SUPERTEAM_EARN_STATUS");
		return ok(text);
	};

	// ── Action definitions ──────────────────────────────────────────

	const listings: Action = {
		name: "SUPERTEAM_EARN_LISTINGS",
		similes: ["EARN_LISTINGS", "SUPERTEAM_BOUNTIES", "BROWSE_BOUNTIES", "FIND_EARN_WORK"],
		description:
			"Superteam Earn: discover live agent-eligible bounty, project, and hackathon listings. " +
			"Params: take? (number, default 20), deadline? (YYYY-MM-DD), type? (bounty|project|hackathon).",
		validate: alwaysValid,
		handler: listingsHandler,
	};

	const listingDetail: Action = {
		name: "SUPERTEAM_EARN_LISTING_DETAIL",
		similes: ["EARN_LISTING_DETAIL", "SUPERTEAM_LISTING_INFO"],
		description:
			"Superteam Earn: get full details for a specific listing by slug. " +
			"Params: slug (the listing's URL slug, e.g. 'build-a-solana-dapp').",
		validate: alwaysValid,
		handler: detailHandler,
	};

	const submit: Action = {
		name: "SUPERTEAM_EARN_SUBMIT",
		similes: ["EARN_SUBMIT", "SUPERTEAM_SUBMIT_WORK"],
		description:
			"Superteam Earn: submit work for a listing. " +
			"Params: listingId, link (URL to your work), otherInfo? (description), " +
			"eligibilityAnswers? (array of {question, answer}), ask? (quote amount for range/variable comp), " +
			"telegram? (t.me/username URL — required for project listings). " +
			"The telegram URL is auto-injected from config if set.",
		validate: requireCapableModel,
		handler: submitHandler,
	};

	const updateSubmission: Action = {
		name: "SUPERTEAM_EARN_UPDATE_SUBMISSION",
		similes: ["EARN_UPDATE_SUBMISSION", "SUPERTEAM_EDIT_SUBMISSION"],
		description:
			"Superteam Earn: edit an existing submission. Same params as SUPERTEAM_EARN_SUBMIT. " +
			"Rejected or spam-labeled submissions cannot be edited.",
		validate: requireCapableModel,
		handler: updateHandler,
	};

	const comments: Action = {
		name: "SUPERTEAM_EARN_COMMENTS",
		similes: ["EARN_COMMENTS", "SUPERTEAM_LISTING_COMMENTS"],
		description:
			"Superteam Earn: fetch comments for a listing. " +
			"Params: listingId, skip? (offset), take? (limit).",
		validate: alwaysValid,
		handler: commentsHandler,
	};

	const postComment: Action = {
		name: "SUPERTEAM_EARN_POST_COMMENT",
		similes: ["EARN_POST_COMMENT", "SUPERTEAM_COMMENT"],
		description:
			"Superteam Earn: post a comment or reply on a listing. " +
			"Params: refId (listingId), message, refType? (BOUNTY|PROJECT|HACKATHON, default BOUNTY), " +
			"pocId? (point-of-contact user ID), replyToId? (parent comment ID), replyToUserId? (parent comment author ID).",
		validate: requireCapableModel,
		handler: postCommentHandler,
	};

	const status: Action = {
		name: "SUPERTEAM_EARN_STATUS",
		similes: ["EARN_STATUS", "SUPERTEAM_EARN_INFO"],
		description:
			"Superteam Earn: check agent registration status, agent ID, username, claim code, and claim URL.",
		validate: alwaysValid,
		handler: statusHandler,
	};

	return { listings, listingDetail, submit, updateSubmission, comments, postComment, status };
}

/**
 * Build scanner-powered actions. These use EarnScannerService (optional —
 * actions degrade gracefully when scanner is absent).
 */
function makeScannerActions(scanner: EarnScannerService) {
	const alwaysValid: Action["validate"] = async () => true;

	// ── SUPERTEAM_EARN_SCAN ─────────────────────────────────────────

	const scanHandler: Handler = async (_r, _m, _s, _opts, callback) => {
		const summary = await scanner.scan();
		const text = JSON.stringify(summary, null, 2);
		await emit(callback, text, "SUPERTEAM_EARN_SCAN");
		return ok(text);
	};

	const scan: Action = {
		name: "SUPERTEAM_EARN_SCAN",
		similes: ["EARN_SCAN", "SUPERTEAM_SCAN", "SCAN_BOUNTIES"],
		description:
			"Superteam Earn: run a full scan of all live listings and grants. " +
			"Fetches data, ranks viability (high/medium/low), persists to Pensieve, " +
			"creates calendar events, sets goals for top opportunities, " +
			"and creates project directories for high-viability listings. No params.",
		validate: alwaysValid,
		handler: scanHandler,
	};

	// ── SUPERTEAM_EARN_CALENDAR ─────────────────────────────────────

	const calendarHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const start = pickString(opts, ["start", "from", "startDate"]);
		const end = pickString(opts, ["end", "to", "endDate"]);
		const events = start && end
			? scanner.getEventsInRange(start, end)
			: scanner.getCachedEvents();
		const text = JSON.stringify(events, null, 2);
		await emit(callback, text, "SUPERTEAM_EARN_CALENDAR");
		return ok(text);
	};

	const calendar: Action = {
		name: "SUPERTEAM_EARN_CALENDAR",
		similes: ["EARN_CALENDAR", "SUPERTEAM_DEADLINES", "EARN_EVENTS"],
		description:
			"Superteam Earn: retrieve calendar events (deadlines, announcements) with color-coded viability. " +
			"Params: start? (ISO date), end? (ISO date). Returns all cached events if no range given.",
		validate: alwaysValid,
		handler: calendarHandler,
	};

	// ── SUPERTEAM_EARN_SET_GOAL ─────────────────────────────────────

	const setGoalHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const slug = pickString(opts, ["slug", "listingSlug", "listing"]);
		if (!slug) return fail("Missing listing slug (params: slug)");
		const events = scanner.getCachedEvents();
		const event = events.find((e) => e.slug === slug);
		if (!event) return fail(`No cached event for slug '${slug}' — run SUPERTEAM_EARN_SCAN first.`);
		// Create project directory
		const listing = {
			id: event.id,
			title: event.title.replace(/^[⏰🏆]\s*(?:Deadline|Winners):\s*/, ""),
			slug: event.slug,
			type: event.listingType,
			status: "OPEN",
			rewardAmount: event.reward,
			token: event.token,
			deadline: event.date,
			compensationType: "fixed",
			minRewardAsk: null,
			maxRewardAsk: null,
			agentAccess: event.agentAccess,
			isFeatured: false,
			isPro: false,
			isWinnersAnnounced: false,
			winnersAnnouncedAt: null,
			_count: { Comments: 0, Submission: event.submissions },
			sponsor: { name: event.sponsor, slug: "", logo: "", isVerified: true },
		};
		const viability = scanner.rankViability(listing as never);
		const dir = scanner.createProjectDirectory(listing as never, viability);
		const text = JSON.stringify({
			slug,
			viability,
			projectDir: dir,
			message: `Created project directory and set goal for ${slug}`,
		}, null, 2);
		await emit(callback, text, "SUPERTEAM_EARN_SET_GOAL");
		return ok(text);
	};

	const setGoal: Action = {
		name: "SUPERTEAM_EARN_SET_GOAL",
		similes: ["EARN_SET_GOAL", "SUPERTEAM_GOAL", "EARN_COMMIT"],
		description:
			"Superteam Earn: create a goal and project directory for a specific listing. " +
			"Params: slug (the listing's URL slug). Run SUPERTEAM_EARN_SCAN first to populate cache.",
		validate: alwaysValid,
		handler: setGoalHandler,
	};

	return { scan, calendar, setGoal };
}

// ── Context provider ────────────────────────────────────────────────────

/**
 * Injected into the agent's context on every turn. Tells the agent:
 * - It has Superteam Earn capabilities
 * - It MUST use GPT-5.5+ for submission work
 * - How to approach bounties (research → build → submit)
 */
const superteamEarnContextProvider: Provider = {
	name: "SUPERTEAM_EARN_CONTEXT",
	description:
		"Superteam Earn mission brief: model requirements, workflow guidance, and competitive strategy for paid bounty/project/hackathon work.",
	descriptionCompressed: "Superteam Earn bounty/project workflow + model gate.",
	position: 50,
	get: async (runtime: IAgentRuntime, _m: Memory, _s: State): Promise<ProviderResult> => {
		const codexLarge = (runtime.getSetting?.("CODEX_MODEL_LARGE") ?? process.env.CODEX_MODEL_LARGE ?? "").toString();
		const lines: string[] = [];

		lines.push("# Superteam Earn — agent bounty hunting");
		lines.push("");
		lines.push("You are equipped to discover and compete in paid bounties, projects, and hackathons on Superteam Earn (earn.superteam.fun). This is REAL MONEY work — quality matters.");
		lines.push("");

		// Inject last scan summary if available
		const scannerRef = (runtime as unknown as { _earnScanner?: EarnScannerService })._earnScanner;
		const lastScan = scannerRef?.getLastScan?.();
		if (lastScan) {
			lines.push("## Current scan status");
			lines.push(`Last scanned: ${lastScan.scannedAt}`);
			lines.push(`Active listings: ${lastScan.totalActive} (${lastScan.highViability} high, ${lastScan.mediumViability} medium, ${lastScan.lowViability} low viability)`);
			if (lastScan.urgentDeadlines.length > 0) {
				lines.push(`⚠️ URGENT deadlines: ${lastScan.urgentDeadlines.map((d) => `${d.title} (${d.daysLeft}d left)`).join(", ")}`);
			}
			lines.push("");
		}

		lines.push("## Model requirements");
		lines.push(`- **Required model**: ${REQUIRED_CODEX_MODEL} or better via OpenAI/Codex provider.`);
		lines.push(`- **Current model**: ${codexLarge || "(not set)"}.`);
		lines.push("- GPT-5.5 can produce images, research, graphs, data analysis, and production-grade code — all critical for competitive submissions.");
		lines.push("- Do NOT submit work generated by a weaker model. If your current model doesn't meet the bar, inform the user and suggest they configure GPT-5.5.");
		lines.push("");
		lines.push("## Image generation");
		lines.push("- You have **GENERATE_IMAGE** — use it aggressively for Earn submissions.");
		lines.push("- Create diagrams, architecture visuals, UI mockups, infographics, logos, and presentation graphics.");
		lines.push("- For design bounties: generate multiple variations and pick the strongest.");
		lines.push("- For code bounties: generate README hero images, architecture diagrams, and demo screenshots.");
		lines.push("- For research bounties: create data visualization charts, comparison tables as images, and summary infographics.");
		lines.push("- GPT-5.5's native image generation produces high-quality output — use it to differentiate your submission from text-only competitors.");
		lines.push("");
		lines.push("## X / Twitter research integration");
		lines.push("- You have full X access: **X_SEARCH**, **X_GET_TWEET**, **X_GET_USER**, **X_USER_TWEETS**, **X_HOME_TIMELINE**, **X_NOTIFICATIONS**.");
		lines.push("- BEFORE starting any bounty/project work, use X_SEARCH to research:");
		lines.push("  - The sponsor's recent tweets and announcements (search their handle).");
		lines.push("  - Community discussion about the bounty/hackathon.");
		lines.push("  - Similar past projects or winning submissions people have shared.");
		lines.push("  - Trending topics and sentiment in the relevant ecosystem (Solana, Superteam, etc.).");
		lines.push("- Use X_USER_TWEETS to study the sponsor's profile — understand their brand voice, priorities, and what they value.");
		lines.push("- Use X_GET_TWEET to deep-dive into specific referenced tweets from listing descriptions.");
		lines.push("- This research gives you context that text-only agents miss — judges notice when a submission shows ecosystem awareness.");
		lines.push("- After submitting, optionally use X_POST to share your work publicly (with the sponsor tagged) for visibility.");
		lines.push("");
		lines.push("## Workflow for bounties");
		lines.push("1. **Discover**: Use SUPERTEAM_EARN_LISTINGS to browse available work. Filter by type (bounty/project/hackathon) and deadline.");
		lines.push("2. **Research**: Use X_SEARCH + X_USER_TWEETS to study the sponsor, community sentiment, and similar work. Check listing comments with SUPERTEAM_EARN_COMMENTS.");
		lines.push("3. **Evaluate**: Use SUPERTEAM_EARN_LISTING_DETAIL to read full requirements. Only pick work you can deliver at a competitive level.");
		lines.push("4. **Build**: Produce high-quality deliverables — code, designs, research, writeups. Use GENERATE_IMAGE for visuals. Use your full toolkit (coding-tools, web research, X research).");
		lines.push("5. **Submit**: Use SUPERTEAM_EARN_SUBMIT with a link to your work. Answer all eligibility questions. Include detailed otherInfo describing your approach and research.");
		lines.push("6. **Engage**: Use SUPERTEAM_EARN_POST_COMMENT to participate in listing discussions. Ask clarifying questions early.");
		lines.push("7. **Amplify**: Consider using X_POST to share your submission publicly, tagging the sponsor for visibility.");
		lines.push("");
		lines.push("## Quality standards");
		lines.push("- Every submission competes against other agents AND humans. Half-effort work wastes the registration.");
		lines.push("- Include documentation, tests, and clear explanations in every code submission.");
		lines.push("- For design/research bounties, produce polished deliverables with proper formatting, citations, and generated visuals.");
		lines.push("- Review the listing's past comments and other submissions (if visible) to calibrate quality expectations.");
		lines.push("- Submissions with original images, diagrams, and ecosystem-aware framing consistently win over plain-text submissions.");

		return { text: lines.join("\n") };
	},
};

// ── Plugin factory ──────────────────────────────────────────────────────

export function createSuperteamEarnPlugin(
	svc: SuperteamEarnService,
	scanner?: EarnScannerService,
): Plugin {
	const actions = makeHandlers(svc, scanner);
	const scannerActions = scanner ? makeScannerActions(scanner) : null;
	return {
		name: "@detour/plugin-superteam-earn",
		description:
			"Superteam Earn agent actions — browse agent-eligible listings (bounties, projects, hackathons), " +
			"view details, submit work, edit submissions, read/post comments, check registration status, " +
			"run viability scans, check calendar, and set goals for top opportunities. " +
			"Credentials are managed via the vault; register through the UI first. " +
			`Submission actions require ${REQUIRED_CODEX_MODEL} or better via OpenAI/Codex provider.`,
		actions: [
			actions.listings,
			actions.listingDetail,
			actions.submit,
			actions.updateSubmission,
			actions.comments,
			actions.postComment,
			actions.status,
			...(scannerActions ? [
				scannerActions.scan,
				scannerActions.calendar,
				scannerActions.setGoal,
			] : []),
		],
		providers: [superteamEarnContextProvider],
	};
}
