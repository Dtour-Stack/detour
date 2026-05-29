/**
 * EarnScannerService — fetches Superteam Earn listings, ranks viability,
 * persists to Pensieve, extracts calendar events, and creates project
 * directories for high-viability opportunities.
 *
 * Used by:
 *   - Daily cron job (via SUPERTEAM_EARN_SCAN agent action)
 *   - Calendar RPC handler (read-only queries)
 *   - Agent context provider (scan summary)
 */

import { logger } from "@elizaos/core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PensieveMemoryService } from "./pensieve/memory-service";
import type { GoalService } from "./goal-service";
import type {
	EarnCalendarEvent,
	EarnScanSummary,
	EarnViabilityBreakdown,
	EarnViabilityTier,
} from "../../shared/index";

// ── Constants ───────────────────────────────────────────────────────

const BASE_URL = "https://earn.superteam.fun";
const PROJECT_ROOT = join(homedir(), ".detour", "earn-projects");

const COLOR_HIGH = "#22c55e";   // green-500
const COLOR_MEDIUM = "#eab308"; // yellow-500
const COLOR_LOW = "#ef4444";    // red-500

const MEMORY_PATH_LISTINGS = "/earn/listings";
const MEMORY_PATH_CALENDAR = "/earn/calendar";
const MEMORY_PATH_SCANS = "/earn/scans";
const MEMORY_TYPE_LISTING = "earn-listing";
const MEMORY_TYPE_CALENDAR = "earn-calendar";
const MEMORY_TYPE_SCAN = "earn-scan";

// ── API types (from the public Earn API) ────────────────────────────

interface EarnApiListing {
	id: string;
	title: string;
	slug: string;
	type: string;
	status: string;
	rewardAmount: number | null;
	token: string;
	deadline: string | null;
	compensationType: string;
	minRewardAsk: number | null;
	maxRewardAsk: number | null;
	agentAccess: string;
	isFeatured: boolean;
	isPro: boolean;
	isWinnersAnnounced: boolean;
	winnersAnnouncedAt: string | null;
	_count: { Comments: number; Submission: number };
	sponsor: {
		name: string;
		slug: string;
		logo: string;
		isVerified: boolean;
		chapter?: { id: string } | null;
	};
}

interface EarnApiGrant {
	slug: string;
	title: string;
	minReward: number;
	maxReward: number;
	token: string;
	totalApplications: number;
	approvedAmountTotal: number;
	totalPaid: number;
	isPro: boolean;
	isST: boolean;
	logo: string;
	sponsor: {
		id: string;
		name: string;
		slug: string;
		logo: string;
		isVerified: boolean;
	};
}

// ── Skill affinity map ──────────────────────────────────────────────

const AGENT_STRONG_KEYWORDS = [
	"code", "develop", "build", "programming", "smart contract",
	"api", "sdk", "research", "data", "analysis", "report",
	"thread", "twitter", "write", "article", "blog",
	"documentation", "technical",
];
const AGENT_WEAK_KEYWORDS = [
	"video", "film", "record", "photograph", "camera",
	"attend", "in-person", "physical", "irl", "meetup",
];

// ── Service ─────────────────────────────────────────────────────────

export class EarnScannerService {
	private lastScan: EarnScanSummary | null = null;
	private cachedEvents: EarnCalendarEvent[] = [];
	private knownSlugs = new Set<string>();

	constructor(
		private readonly memories: PensieveMemoryService,
		private readonly goalService: GoalService,
	) {}

	// ── Public API ──────────────────────────────────────────────────

	getLastScan(): EarnScanSummary | null {
		return this.lastScan;
	}

	getCachedEvents(): EarnCalendarEvent[] {
		return this.cachedEvents;
	}

	getEventsInRange(start: string, end: string): EarnCalendarEvent[] {
		const s = new Date(start).getTime();
		const e = new Date(end).getTime();
		return this.cachedEvents.filter((ev) => {
			const t = new Date(ev.date).getTime();
			return t >= s && t <= e;
		});
	}

	/**
	 * Full scan: fetch → rank → persist → calendar → project dirs → goals.
	 * This is the entry point for the cron job.
	 */
	async scan(roomId?: string): Promise<EarnScanSummary> {
		logger.info({ src: "earn-scanner" }, "starting Superteam Earn scan");

		const [listings, grants] = await Promise.all([
			this.fetchListings(),
			this.fetchGrants(),
		]);

		const previousSlugs = new Set(this.knownSlugs);
		const newListings: string[] = [];
		const events: EarnCalendarEvent[] = [];
		let highCount = 0;
		let mediumCount = 0;
		let lowCount = 0;
		let goalsSet = 0;
		const urgent: EarnScanSummary["urgentDeadlines"] = [];

		// Process listings
		for (const listing of listings) {
			const viability = this.rankViability(listing);

			if (!previousSlugs.has(listing.slug)) {
				newListings.push(listing.slug);
			}
			this.knownSlugs.add(listing.slug);

			switch (viability.tier) {
				case "high": highCount++; break;
				case "medium": mediumCount++; break;
				case "low": lowCount++; break;
			}

			// Calendar events
			const listingEvents = this.extractCalendarEvents(listing, viability);
			events.push(...listingEvents);

			// Urgent deadlines
			if (listing.deadline) {
				const daysLeft = Math.ceil(
					(new Date(listing.deadline).getTime() - Date.now()) / 86400000,
				);
				if (daysLeft >= 0 && daysLeft <= 3) {
					urgent.push({
						slug: listing.slug,
						title: listing.title,
						deadline: listing.deadline,
						daysLeft,
					});
				}
			}

			// Persist to Pensieve
			await this.persistListing(listing, viability);

			// High viability: create project dir and set goal
			if (viability.tier === "high" && !previousSlugs.has(listing.slug)) {
				this.createProjectDirectory(listing, viability);
				if (roomId) {
					await this.setGoalForListing(listing, viability, roomId);
					goalsSet++;
				}
			}
		}

		// Process grants as calendar events
		for (const grant of grants) {
			events.push({
				id: `grant-${grant.slug}`,
				date: new Date().toISOString(),
				type: "announcement",
				title: grant.title,
				slug: grant.slug,
				listingType: "grant",
				viability: "medium",
				viabilityScore: 50,
				reward: grant.maxReward,
				token: grant.token,
				sponsor: grant.sponsor.name,
				agentAccess: "HUMAN_ONLY",
				submissions: grant.totalApplications,
				hasGoal: false,
				projectDir: null,
				color: COLOR_MEDIUM,
				url: `${BASE_URL}/grants/${grant.slug}/`,
			});
		}

		this.cachedEvents = events;

		// Expired detection
		const expiredCount = previousSlugs.size > 0
			? [...previousSlugs].filter((s) => !listings.some((l) => l.slug === s)).length
			: 0;

		// Build summary
		const summary: EarnScanSummary = {
			scannedAt: new Date().toISOString(),
			totalActive: listings.length,
			newListings: newListings.length,
			expiredListings: expiredCount,
			highViability: highCount,
			mediumViability: mediumCount,
			lowViability: lowCount,
			goalsSet,
			urgentDeadlines: urgent,
		};
		this.lastScan = summary;

		// Persist scan summary to Pensieve
		await this.persistScanSummary(summary);

		logger.info(
			{
				src: "earn-scanner",
				total: listings.length,
				new: newListings.length,
				high: highCount,
				medium: mediumCount,
				low: lowCount,
				goals: goalsSet,
			},
			"Superteam Earn scan complete",
		);

		return summary;
	}

	// ── Viability Ranking ───────────────────────────────────────────

	rankViability(listing: EarnApiListing): EarnViabilityBreakdown {
		let score = 0;
		const reasons: string[] = [];

		// Agent access (25 points)
		if (listing.agentAccess === "AGENT_ALLOWED") {
			score += 25;
			reasons.push("agent-eligible (+25)");
		} else {
			reasons.push("human-only (0)");
		}

		// Reward (20 points)
		const reward = listing.rewardAmount ?? 0;
		if (reward >= 500) {
			score += 20;
			reasons.push(`high reward $${reward} (+20)`);
		} else if (reward >= 100) {
			score += 12;
			reasons.push(`moderate reward $${reward} (+12)`);
		} else {
			score += 5;
			reasons.push(`low reward $${reward} (+5)`);
		}

		// Deadline proximity (15 points)
		if (listing.deadline) {
			const daysLeft = Math.ceil(
				(new Date(listing.deadline).getTime() - Date.now()) / 86400000,
			);
			if (daysLeft >= 7 && daysLeft <= 21) {
				score += 15;
				reasons.push(`good timeline ${daysLeft}d (+15)`);
			} else if ((daysLeft >= 3 && daysLeft < 7) || (daysLeft > 21 && daysLeft <= 30)) {
				score += 10;
				reasons.push(`ok timeline ${daysLeft}d (+10)`);
			} else if (daysLeft < 3) {
				score += 3;
				reasons.push(`urgent ${daysLeft}d (+3)`);
			} else {
				score += 5;
				reasons.push(`long timeline ${daysLeft}d (+5)`);
			}
		} else {
			score += 8;
			reasons.push("no deadline (+8)");
		}

		// Competition (15 points)
		const subs = listing._count.Submission;
		if (subs < 20) {
			score += 15;
			reasons.push(`low competition ${subs} subs (+15)`);
		} else if (subs < 100) {
			score += 8;
			reasons.push(`moderate competition ${subs} subs (+8)`);
		} else {
			score += 2;
			reasons.push(`high competition ${subs} subs (+2)`);
		}

		// Skill fit (15 points)
		const titleLower = listing.title.toLowerCase();
		const hasStrong = AGENT_STRONG_KEYWORDS.some((k) => titleLower.includes(k));
		const hasWeak = AGENT_WEAK_KEYWORDS.some((k) => titleLower.includes(k));
		if (hasStrong && !hasWeak) {
			score += 15;
			reasons.push("strong skill match (+15)");
		} else if (hasStrong) {
			score += 10;
			reasons.push("partial skill match (+10)");
		} else if (!hasWeak) {
			score += 8;
			reasons.push("neutral skill match (+8)");
		} else {
			score += 2;
			reasons.push("weak skill match (+2)");
		}

		// Sponsor verified (10 points)
		if (listing.sponsor.isVerified) {
			score += 10;
			reasons.push("verified sponsor (+10)");
		} else {
			score += 3;
			reasons.push("unverified sponsor (+3)");
		}

		const tier: EarnViabilityTier =
			score >= 70 ? "high" : score >= 40 ? "medium" : "low";

		return { tier, score, reasons };
	}

	// ── Calendar Events ─────────────────────────────────────────────

	private extractCalendarEvents(
		listing: EarnApiListing,
		viability: EarnViabilityBreakdown,
	): EarnCalendarEvent[] {
		const events: EarnCalendarEvent[] = [];
		const color = viability.tier === "high" ? COLOR_HIGH
			: viability.tier === "medium" ? COLOR_MEDIUM
			: COLOR_LOW;

		const base = {
			slug: listing.slug,
			listingType: listing.type as EarnCalendarEvent["listingType"],
			viability: viability.tier,
			viabilityScore: viability.score,
			reward: listing.rewardAmount,
			token: listing.token,
			sponsor: listing.sponsor.name,
			agentAccess: listing.agentAccess,
			submissions: listing._count.Submission,
			hasGoal: false,
			projectDir: this.projectDirFor(listing.slug),
			color,
			url: `${BASE_URL}/listings/${listing.type}/${listing.slug}/`,
		};

		if (listing.deadline) {
			events.push({
				...base,
				id: `deadline-${listing.slug}`,
				date: listing.deadline,
				type: "deadline",
				title: `⏰ Deadline: ${listing.title}`,
			});
		}

		if (listing.winnersAnnouncedAt) {
			events.push({
				...base,
				id: `announce-${listing.slug}`,
				date: listing.winnersAnnouncedAt,
				type: "announcement",
				title: `🏆 Winners: ${listing.title}`,
			});
		}

		return events;
	}

	// ── Pensieve Persistence ────────────────────────────────────────

	private async persistListing(
		listing: EarnApiListing,
		viability: EarnViabilityBreakdown,
	): Promise<void> {
		const text = [
			`[${viability.tier.toUpperCase()}] ${listing.title}`,
			`Type: ${listing.type} | Reward: $${listing.rewardAmount ?? 0} ${listing.token}`,
			`Agent: ${listing.agentAccess} | Subs: ${listing._count.Submission}`,
			`Sponsor: ${listing.sponsor.name}${listing.sponsor.isVerified ? " ✓" : ""}`,
			`Deadline: ${listing.deadline ? new Date(listing.deadline).toLocaleDateString() : "none"}`,
			`Score: ${viability.score}/100 — ${viability.reasons.join(", ")}`,
			`URL: ${BASE_URL}/listings/${listing.type}/${listing.slug}/`,
		].join("\n");

		try {
			await this.memories.create({
				text,
				path: `${MEMORY_PATH_LISTINGS}/${listing.slug}`,
				type: MEMORY_TYPE_LISTING,
				tags: [
					`earn:${listing.type}`,
					`earn:scanned`,
					`viability:${viability.tier}`,
					listing.agentAccess === "AGENT_ALLOWED" ? "earn:agent-eligible" : "earn:human-only",
				],
				extraMetadata: {
					slug: listing.slug,
					listingId: listing.id,
					viabilityScore: viability.score,
					viabilityTier: viability.tier,
					rewardAmount: listing.rewardAmount,
					token: listing.token,
					deadline: listing.deadline,
					agentAccess: listing.agentAccess,
					sponsorName: listing.sponsor.name,
					submissions: listing._count.Submission,
				},
			});
		} catch (err) {
			logger.warn(
				{ src: "earn-scanner", slug: listing.slug, err: err instanceof Error ? err.message : err },
				"failed to persist listing memory",
			);
		}
	}

	private async persistScanSummary(summary: EarnScanSummary): Promise<void> {
		const dateKey = summary.scannedAt.split("T")[0];
		const text = [
			`Earn scan at ${summary.scannedAt}`,
			`Active: ${summary.totalActive} | New: ${summary.newListings} | Expired: ${summary.expiredListings}`,
			`Viability: ${summary.highViability} high, ${summary.mediumViability} medium, ${summary.lowViability} low`,
			`Goals set: ${summary.goalsSet}`,
			summary.urgentDeadlines.length > 0
				? `⚠️ Urgent: ${summary.urgentDeadlines.map((d) => `${d.title} (${d.daysLeft}d)`).join(", ")}`
				: "No urgent deadlines",
		].join("\n");

		try {
			await this.memories.create({
				text,
				path: `${MEMORY_PATH_SCANS}/${dateKey}`,
				type: MEMORY_TYPE_SCAN,
				tags: ["earn:scan", `earn:scan:${dateKey}`],
				extraMetadata: summary as unknown as Record<string, unknown>,
			});
		} catch (err) {
			logger.warn(
				{ src: "earn-scanner", err: err instanceof Error ? err.message : err },
				"failed to persist scan summary",
			);
		}
	}

	// ── Project Directories ─────────────────────────────────────────

	private projectDirFor(slug: string): string | null {
		const dir = join(PROJECT_ROOT, slug);
		return existsSync(dir) ? dir : null;
	}

	createProjectDirectory(
		listing: EarnApiListing,
		viability: EarnViabilityBreakdown,
	): string {
		const dir = join(PROJECT_ROOT, listing.slug);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			mkdirSync(join(dir, "submission"), { recursive: true });
			mkdirSync(join(dir, "references"), { recursive: true });
		}

		const readme = [
			`# ${listing.title}`,
			"",
			`**Type:** ${listing.type}`,
			`**Reward:** $${listing.rewardAmount ?? 0} ${listing.token}`,
			`**Deadline:** ${listing.deadline ? new Date(listing.deadline).toLocaleDateString() : "No deadline"}`,
			`**Agent Access:** ${listing.agentAccess}`,
			`**Sponsor:** ${listing.sponsor.name}${listing.sponsor.isVerified ? " ✓" : ""}`,
			`**Submissions:** ${listing._count.Submission}`,
			"",
			`## Viability: ${viability.tier.toUpperCase()} (${viability.score}/100)`,
			"",
			...viability.reasons.map((r) => `- ${r}`),
			"",
			`## URL`,
			"",
			`${BASE_URL}/listings/${listing.type}/${listing.slug}/`,
			"",
			"## Notes",
			"",
			"_Agent research notes and approach will be added here._",
			"",
			"## Submission",
			"",
			"Work products go in the `submission/` directory.",
		].join("\n");

		writeFileSync(join(dir, "README.md"), readme, "utf-8");

		if (!existsSync(join(dir, "notes.md"))) {
			writeFileSync(join(dir, "notes.md"), `# Research Notes — ${listing.title}\n\n`, "utf-8");
		}

		logger.info({ src: "earn-scanner", slug: listing.slug, dir }, "created project directory");
		return dir;
	}

	// ── Goal Setting ────────────────────────────────────────────────

	private async setGoalForListing(
		listing: EarnApiListing,
		viability: EarnViabilityBreakdown,
		roomId: string,
	): Promise<void> {
		const deadlineStr = listing.deadline
			? ` by ${new Date(listing.deadline).toLocaleDateString()}`
			: "";
		const text = [
			`Complete and submit bounty: ${listing.title}`,
			`($${listing.rewardAmount ?? 0} ${listing.token})${deadlineStr}.`,
			`Viability: ${viability.tier} (${viability.score}/100).`,
			`Approach: Research sponsor, study requirements, build deliverable, submit via SUPERTEAM_EARN_SUBMIT.`,
		].join(" ");

		try {
			await this.goalService.setActiveGoal({
				roomId,
				text,
				source: "agent-set",
				originText: `Auto-generated from Superteam Earn scan — ${listing.slug}`,
			});
		} catch (err) {
			logger.warn(
				{ src: "earn-scanner", slug: listing.slug, err: err instanceof Error ? err.message : err },
				"failed to set goal for listing",
			);
		}
	}

	// ── API Fetchers ────────────────────────────────────────────────

	private async fetchListings(): Promise<EarnApiListing[]> {
		try {
			const resp = await fetch(`${BASE_URL}/api/listings/?take=200`, {
				headers: { "User-Agent": "detour-earn-scanner/1.0" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			return (await resp.json()) as EarnApiListing[];
		} catch (err) {
			logger.warn(
				{ src: "earn-scanner", err: err instanceof Error ? err.message : err },
				"failed to fetch listings",
			);
			return [];
		}
	}

	private async fetchGrants(): Promise<EarnApiGrant[]> {
		try {
			const resp = await fetch(`${BASE_URL}/api/grants/?take=100`, {
				headers: { "User-Agent": "detour-earn-scanner/1.0" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			return (await resp.json()) as EarnApiGrant[];
		} catch (err) {
			logger.warn(
				{ src: "earn-scanner", err: err instanceof Error ? err.message : err },
				"failed to fetch grants",
			);
			return [];
		}
	}
}
