#!/usr/bin/env bun
/**
 * superteam-earn-cli — User-side CLI for Superteam Earn.
 *
 * Browse bounties, hackathons, projects, and grants from earn.superteam.fun.
 * Local SQLite cache for offline search, deadline tracking, and reward analysis.
 *
 * Usage:
 *   bun run src/bun/tools/superteam-earn-cli/index.ts bounties
 *   bun run src/bun/tools/superteam-earn-cli/index.ts bounties --agent-only
 *   bun run src/bun/tools/superteam-earn-cli/index.ts details <slug>
 *   bun run src/bun/tools/superteam-earn-cli/index.ts grants
 *   bun run src/bun/tools/superteam-earn-cli/index.ts search <keyword>
 *   bun run src/bun/tools/superteam-earn-cli/index.ts top --by reward
 *   bun run src/bun/tools/superteam-earn-cli/index.ts deadlines
 *   bun run src/bun/tools/superteam-earn-cli/index.ts sync
 *   bun run src/bun/tools/superteam-earn-cli/index.ts stats
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────

const BASE_URL = "https://earn.superteam.fun";
const DATA_DIR = join(homedir(), ".superteam-earn-cli");
const DB_PATH = join(DATA_DIR, "cache.sqlite");
const isJSON = !process.stdout.isTTY || process.argv.includes("--json");
const isCompact = process.argv.includes("--compact");

// ── Types ───────────────────────────────────────────────────────────────

interface Listing {
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

interface ListingDetail extends Listing {
	description: string;
	skills: { skills: string; subskills: string[] }[];
	rewards: Record<string, number>;
	eligibility: unknown[];
	region: string;
	pocSocials: string | null;
	publishedAt: string;
	requirements: string | null;
	usdValue: number | null;
	applicationLink: string | null;
	maxBonusSpots: number | null;
	hackathonId: string | null;
	commitmentDate: string | null;
}

interface Grant {
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

// ── Database ────────────────────────────────────────────────────────────

function initDb(): Database {
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
	const db = new Database(DB_PATH);
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS listings (
			id TEXT PRIMARY KEY,
			slug TEXT UNIQUE,
			title TEXT,
			type TEXT,
			status TEXT,
			reward_amount REAL,
			token TEXT,
			deadline TEXT,
			compensation_type TEXT,
			min_reward_ask REAL,
			max_reward_ask REAL,
			agent_access TEXT,
			is_featured INTEGER,
			is_pro INTEGER,
			submissions INTEGER,
			comments INTEGER,
			sponsor_name TEXT,
			sponsor_slug TEXT,
			sponsor_verified INTEGER,
			synced_at TEXT DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS grants (
			slug TEXT PRIMARY KEY,
			title TEXT,
			min_reward REAL,
			max_reward REAL,
			token TEXT,
			total_applications INTEGER,
			approved_amount_total REAL,
			total_paid REAL,
			sponsor_name TEXT,
			sponsor_slug TEXT,
			synced_at TEXT DEFAULT (datetime('now'))
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5(
			title, slug, type, sponsor_name, agent_access,
			content='listings',
			content_rowid='rowid'
		);
	`);
	return db;
}

// ── API Helpers ─────────────────────────────────────────────────────────

async function fetchJSON<T>(path: string): Promise<T> {
	const url = `${BASE_URL}${path}`;
	const resp = await fetch(url, {
		headers: { "User-Agent": "superteam-earn-cli/1.0" },
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
	return resp.json() as Promise<T>;
}

async function fetchListings(opts: {
	take?: number;
	type?: string;
	agentOnly?: boolean;
}): Promise<Listing[]> {
	const params = new URLSearchParams();
	params.set("take", String(opts.take ?? 50));
	if (opts.type) params.set("type", opts.type);
	const listings = await fetchJSON<Listing[]>(`/api/listings/?${params}`);
	if (opts.agentOnly) {
		return listings.filter((l) => l.agentAccess === "AGENT_ALLOWED");
	}
	return listings;
}

async function fetchDetails(slug: string): Promise<ListingDetail> {
	return fetchJSON<ListingDetail>(`/api/listings/details/${slug}`);
}

async function fetchGrants(take = 50): Promise<Grant[]> {
	return fetchJSON<Grant[]>(`/api/grants/?take=${take}`);
}

// ── Sync ────────────────────────────────────────────────────────────────

async function syncListings(db: Database): Promise<number> {
	const listings = await fetchListings({ take: 200 });
	const stmt = db.prepare(`
		INSERT OR REPLACE INTO listings
		(id, slug, title, type, status, reward_amount, token, deadline,
		 compensation_type, min_reward_ask, max_reward_ask, agent_access,
		 is_featured, is_pro, submissions, comments, sponsor_name, sponsor_slug,
		 sponsor_verified, synced_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
	`);
	const tx = db.transaction(() => {
		for (const l of listings) {
			stmt.run(
				l.id, l.slug, l.title, l.type, l.status,
				l.rewardAmount, l.token, l.deadline,
				l.compensationType, l.minRewardAsk, l.maxRewardAsk,
				l.agentAccess, l.isFeatured ? 1 : 0, l.isPro ? 1 : 0,
				l._count.Submission, l._count.Comments,
				l.sponsor.name, l.sponsor.slug, l.sponsor.isVerified ? 1 : 0,
			);
		}
	});
	tx();

	// Rebuild FTS — drop+recreate avoids SQLITE_CORRUPT_VTAB on content sync
	db.exec("DROP TABLE IF EXISTS listings_fts;");
	db.exec(`
		CREATE VIRTUAL TABLE listings_fts USING fts5(
			title, slug, type, sponsor_name, agent_access,
			content='listings',
			content_rowid='rowid'
		);
	`);
	db.exec(`
		INSERT INTO listings_fts(rowid, title, slug, type, sponsor_name, agent_access)
		SELECT rowid, title, slug, type, sponsor_name, agent_access FROM listings;
	`);

	// Grants
	const grants = await fetchGrants(100);
	const gStmt = db.prepare(`
		INSERT OR REPLACE INTO grants
		(slug, title, min_reward, max_reward, token, total_applications,
		 approved_amount_total, total_paid, sponsor_name, sponsor_slug, synced_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
	`);
	const gTx = db.transaction(() => {
		for (const g of grants) {
			gStmt.run(
				g.slug, g.title, g.minReward, g.maxReward, g.token,
				g.totalApplications, g.approvedAmountTotal, g.totalPaid,
				g.sponsor.name, g.sponsor.slug,
			);
		}
	});
	gTx();

	return listings.length;
}

// ── Output Helpers ──────────────────────────────────────────────────────

function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatUsd(n: number | null | undefined): string {
	if (n == null) return "—";
	return `$${n.toLocaleString()}`;
}

function daysUntil(deadline: string | null): string {
	if (!deadline) return "—";
	const d = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000);
	if (d < 0) return "expired";
	if (d === 0) return "today";
	if (d === 1) return "tomorrow";
	return `${d}d`;
}

function outputJSON(data: unknown): void {
	console.log(JSON.stringify(data, null, isCompact ? 0 : 2));
}

function listingToCompact(l: Listing) {
	return {
		slug: l.slug,
		title: l.title,
		type: l.type,
		reward: formatUsd(l.rewardAmount),
		token: l.token,
		deadline: daysUntil(l.deadline),
		submissions: l._count.Submission,
		sponsor: l.sponsor.name,
		agentAccess: l.agentAccess,
	};
}

function printListingTable(listings: Listing[]): void {
	if (isJSON) {
		outputJSON(isCompact ? listings.map(listingToCompact) : listings);
		return;
	}
	console.log(`\n  📋 ${listings.length} listings\n`);
	console.log(
		"  " +
			"Title".padEnd(55) +
			"Reward".padEnd(12) +
			"Deadline".padEnd(12) +
			"Subs".padEnd(6) +
			"Agent".padEnd(15) +
			"Sponsor",
	);
	console.log("  " + "─".repeat(120));
	for (const l of listings) {
		const title = l.title.length > 52 ? l.title.slice(0, 49) + "..." : l.title;
		const agent = l.agentAccess === "AGENT_ALLOWED" ? "✅ allowed" : "❌ human";
		console.log(
			"  " +
				title.padEnd(55) +
				formatUsd(l.rewardAmount).padEnd(12) +
				daysUntil(l.deadline).padEnd(12) +
				String(l._count.Submission).padEnd(6) +
				agent.padEnd(15) +
				l.sponsor.name,
		);
	}
	console.log();
}

// ── Commands ────────────────────────────────────────────────────────────

const [, , command, ...args] = process.argv;
const flags = args.filter((a) => a.startsWith("--"));
const positionals = args.filter((a) => !a.startsWith("--"));
const hasFlag = (f: string) => flags.includes(`--${f}`);

const db = initDb();

try {
	switch (command) {
		// ── bounties / projects / hackathons ───────────────────────────
		case "bounties":
		case "projects":
		case "hackathons":
		case "listings": {
			const type = command === "listings" ? undefined : command.replace(/s$/, "");
			const agentOnly = hasFlag("agent-only") || hasFlag("agent");
			const take = (() => {
				const t = args.find((a) => a.startsWith("--take="));
				return t ? Number.parseInt(t.split("=")[1]) : 50;
			})();
			const listings = await fetchListings({ take, type: type === "hackathon" ? undefined : type, agentOnly });
			printListingTable(listings);
			break;
		}

		// ── details ───────────────────────────────────────────────────
		case "details":
		case "detail":
		case "info": {
			const slug = positionals[0];
			if (!slug) {
				console.error("Usage: superteam-earn-cli details <slug>");
				process.exit(5);
			}
			const detail = await fetchDetails(slug);
			if (isJSON) {
				outputJSON(detail);
			} else {
				console.log(`\n  🏷️  ${detail.title}`);
				console.log(`  ${"─".repeat(60)}`);
				console.log(`  Type:       ${detail.type}`);
				console.log(`  Status:     ${detail.status}`);
				console.log(`  Reward:     ${formatUsd(detail.rewardAmount)} ${detail.token}`);
				console.log(`  USD Value:  ${formatUsd(detail.usdValue)}`);
				console.log(`  Deadline:   ${detail.deadline ? new Date(detail.deadline).toLocaleDateString() : "—"} (${daysUntil(detail.deadline)})`);
				console.log(`  Agent:      ${detail.agentAccess === "AGENT_ALLOWED" ? "✅ Agent-eligible" : "❌ Human only"}`);
				console.log(`  Sponsor:    ${detail.sponsor.name}${detail.sponsor.isVerified ? " ✓" : ""}`);
				console.log(`  Region:     ${detail.region}`);
				console.log(`  Submissions: ${detail._count?.Submission ?? "—"}`);
				console.log(`  Published:  ${detail.publishedAt ? new Date(detail.publishedAt).toLocaleDateString() : "—"}`);
				if (detail.skills?.length) {
					console.log(`  Skills:     ${detail.skills.map((s) => `${s.skills} (${s.subskills.join(", ")})`).join("; ")}`);
				}
				if (detail.rewards && Object.keys(detail.rewards).length) {
					console.log(`  Prizes:`);
					for (const [place, amount] of Object.entries(detail.rewards)) {
						const label = place === "99" ? "bonus" : `#${place}`;
						console.log(`    ${label}: ${formatUsd(amount)} ${detail.token}`);
					}
				}
				if (detail.pocSocials) {
					console.log(`  Contact:    ${detail.pocSocials}`);
				}
				console.log(`\n  📝 Description:`);
				console.log(`  ${stripHtml(detail.description).slice(0, 500)}...`);
				console.log(`\n  🔗 https://earn.superteam.fun/listings/${detail.type}/${detail.slug}/\n`);
			}
			break;
		}

		// ── grants ───────────────────────────────────────────────────
		case "grants": {
			const grants = await fetchGrants(100);
			if (isJSON) {
				outputJSON(isCompact ? grants.map((g) => ({
					slug: g.slug,
					title: g.title,
					range: `${formatUsd(g.minReward)}-${formatUsd(g.maxReward)}`,
					approved: formatUsd(g.approvedAmountTotal),
					applications: g.totalApplications,
					sponsor: g.sponsor.name,
				})) : grants);
			} else {
				console.log(`\n  💰 ${grants.length} grants\n`);
				console.log(
					"  " +
						"Title".padEnd(50) +
						"Range".padEnd(20) +
						"Approved".padEnd(15) +
						"Apps".padEnd(6) +
						"Sponsor",
				);
				console.log("  " + "─".repeat(110));
				for (const g of grants) {
					const title = g.title.length > 47 ? g.title.slice(0, 44) + "..." : g.title;
					const range = `${formatUsd(g.minReward)}-${formatUsd(g.maxReward)}`;
					console.log(
						"  " +
							title.padEnd(50) +
							range.padEnd(20) +
							formatUsd(Math.round(g.approvedAmountTotal)).padEnd(15) +
							String(g.totalApplications).padEnd(6) +
							g.sponsor.name,
					);
				}
				console.log();
			}
			break;
		}

		// ── search (FTS on local cache) ──────────────────────────────
		case "search":
		case "find": {
			const query = positionals.join(" ");
			if (!query) {
				console.error("Usage: superteam-earn-cli search <keyword>");
				process.exit(5);
			}
			// Try local FTS first
			const rows = db
				.query(
					`SELECT l.* FROM listings l
					 JOIN listings_fts f ON f.rowid = l.rowid
					 WHERE listings_fts MATCH ?
					 ORDER BY l.reward_amount DESC`,
				)
				.all(query) as Array<Record<string, unknown>>;

			if (rows.length === 0) {
				// Fallback: live search via title match
				const all = await fetchListings({ take: 200 });
				const q = query.toLowerCase();
				const matched = all.filter(
					(l) =>
						l.title.toLowerCase().includes(q) ||
						l.sponsor.name.toLowerCase().includes(q) ||
						l.slug.includes(q),
				);
				printListingTable(matched);
			} else if (isJSON) {
				outputJSON(rows);
			} else {
				console.log(`\n  🔍 ${rows.length} results for "${query}" (from local cache)\n`);
				for (const r of rows) {
					const agent = r.agent_access === "AGENT_ALLOWED" ? "✅" : "❌";
					console.log(
						`  ${agent} ${(r.title as string).padEnd(55)} ${formatUsd(r.reward_amount as number).padEnd(12)} ${r.sponsor_name}`,
					);
				}
				console.log("\n  Tip: run 'sync' first for fresh results.\n");
			}
			break;
		}

		// ── top (sort by reward, submissions, etc.) ──────────────────
		case "top":
		case "best": {
			const by = (() => {
				const b = args.find((a) => a.startsWith("--by="));
				return b ? b.split("=")[1] : "reward";
			})();
			const listings = await fetchListings({ take: 100 });
			const sorted = listings.sort((a, b) => {
				if (by === "submissions") return (b._count.Submission ?? 0) - (a._count.Submission ?? 0);
				if (by === "deadline") {
					const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
					const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
					return da - db;
				}
				return (b.rewardAmount ?? 0) - (a.rewardAmount ?? 0);
			});
			printListingTable(sorted.slice(0, 20));
			break;
		}

		// ── deadlines (upcoming, soonest first) ──────────────────────
		case "deadlines":
		case "urgent": {
			const listings = await fetchListings({ take: 100 });
			const withDeadlines = listings
				.filter((l) => l.deadline && new Date(l.deadline) > new Date())
				.sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());
			printListingTable(withDeadlines);
			break;
		}

		// ── sync (populate local SQLite) ─────────────────────────────
		case "sync":
		case "pull": {
			const count = await syncListings(db);
			if (isJSON) {
				outputJSON({ synced: count, dbPath: DB_PATH });
			} else {
				console.log(`\n  ✅ Synced ${count} listings + grants to ${DB_PATH}\n`);
			}
			break;
		}

		// ── stats (overview) ─────────────────────────────────────────
		case "stats":
		case "overview": {
			const listings = await fetchListings({ take: 200 });
			const bounties = listings.filter((l) => l.type === "bounty");
			const projects = listings.filter((l) => l.type === "project");
			const agentEligible = listings.filter((l) => l.agentAccess === "AGENT_ALLOWED");
			const totalReward = listings.reduce((s, l) => s + (l.rewardAmount ?? 0), 0);
			const agentReward = agentEligible.reduce((s, l) => s + (l.rewardAmount ?? 0), 0);
			const topSponsors = new Map<string, number>();
			for (const l of listings) {
				topSponsors.set(l.sponsor.name, (topSponsors.get(l.sponsor.name) ?? 0) + (l.rewardAmount ?? 0));
			}
			const sorted = Array.from(topSponsors.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);

			if (isJSON) {
				outputJSON({
					total: listings.length,
					bounties: bounties.length,
					projects: projects.length,
					agentEligible: agentEligible.length,
					totalReward,
					agentReward,
					topSponsors: sorted.map(([name, amount]) => ({ name, amount })),
				});
			} else {
				console.log("\n  📊 Superteam Earn Overview\n");
				console.log(`  Open listings:    ${listings.length}`);
				console.log(`  Bounties:         ${bounties.length}`);
				console.log(`  Projects:         ${projects.length}`);
				console.log(`  Agent-eligible:   ${agentEligible.length} (${formatUsd(agentReward)} available)`);
				console.log(`  Total rewards:    ${formatUsd(totalReward)}`);
				console.log(`\n  🏆 Top sponsors by reward:`);
				for (const [name, amount] of sorted) {
					console.log(`    ${name.padEnd(35)} ${formatUsd(amount)}`);
				}
				console.log();
			}
			break;
		}

		// ── agent-opportunities (focused agent view) ─────────────────
		case "agent":
		case "agent-opportunities": {
			const listings = await fetchListings({ take: 200, agentOnly: true });
			if (listings.length === 0) {
				console.log("\n  No agent-eligible listings found.\n");
			} else {
				if (!isJSON) {
					const totalReward = listings.reduce((s, l) => s + (l.rewardAmount ?? 0), 0);
					console.log(`\n  🤖 ${listings.length} agent-eligible listings — ${formatUsd(totalReward)} total\n`);
				}
				printListingTable(listings);
			}
			break;
		}

		// ── help ─────────────────────────────────────────────────────
		case "help":
		case "--help":
		case "-h":
		default:
			console.log(`
  superteam-earn-cli — Browse Superteam Earn bounties, projects, grants

  COMMANDS
    bounties                  List open bounties
    projects                  List open projects
    listings                  List all open listings
    agent                     List agent-eligible opportunities only
    details <slug>            Full details for a listing
    grants                    List available grants
    search <keyword>          Full-text search (local cache)
    top [--by=reward|submissions|deadline]   Top listings sorted
    deadlines                 Upcoming deadlines, soonest first
    sync                      Sync listings + grants to local SQLite
    stats                     Overview: counts, rewards, top sponsors

  FLAGS
    --json                    Force JSON output
    --compact                 Compact JSON (fewer tokens)
    --agent-only              Filter to agent-eligible listings
    --take=N                  Number of results (default 50)

  EXAMPLES
    superteam-earn-cli bounties --agent-only
    superteam-earn-cli details write-a-twitter-thread-on-kimia-protocol
    superteam-earn-cli top --by=reward --json
    superteam-earn-cli sync && superteam-earn-cli search solana
    superteam-earn-cli stats --json
`);
			if (!command || command === "help" || command === "--help" || command === "-h") {
				process.exit(0);
			} else {
				console.error(`  Unknown command: ${command}`);
				process.exit(5);
			}
	}
} finally {
	db.close();
}
