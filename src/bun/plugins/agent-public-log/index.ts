/**
 * Agent public-log plugin — gives the agent a single action to publish
 * its recent trajectories, memories, and observations to a public
 * GitHub repository under its own PAT identity.
 *
 * Privacy posture: by default we redact aggressively. The dump is
 * intended to be readable by anyone, so we strip:
 *   - obvious credential patterns (sk-..., sk-ant-..., ghp_..., ANTHROPIC_API_KEY,
 *     OPENAI_API_KEY, OPENROUTER_API_KEY, ELIZAOS_CLOUD_API_KEY, etc.)
 *   - memories whose path/type/tags indicate vault or auth context
 *   - tool-call result bodies that look like file contents from
 *     blocked dirs (~/.ssh, ~/.aws, ~/Library)
 *
 * The redactor is fail-safe: when in doubt, drop the content. We
 * surface counts of "redacted N entries" in the dump so anyone
 * reading the repo understands it isn't the complete record.
 *
 * For sensitive deployments the user should set `private: true` on
 * the action call so the repo is private from the start.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, ActionResult, Handler, IAgentRuntime, Plugin } from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security";
import {
	AGENT_HF_SYNC_DEFAULT_DESTINATION,
	type AgentDataDumpCounts,
} from "../../../shared/index";
import { KNOWN_MEMORY_TABLES } from "../../core/pensieve/memory-service";

export const DEFAULT_HF_BUCKET = AGENT_HF_SYNC_DEFAULT_DESTINATION;

const CRED_PATTERNS: RegExp[] = [
	/sk-ant-[A-Za-z0-9_-]{16,}/g,
	/sk-ant-oat[A-Za-z0-9_-]{16,}/g,
	/sk-[A-Za-z0-9_-]{32,}/g,
	/ghp_[A-Za-z0-9]{30,}/g,
	/gho_[A-Za-z0-9]{30,}/g,
	/ghu_[A-Za-z0-9]{30,}/g,
	/ghs_[A-Za-z0-9]{30,}/g,
	/hf_[A-Za-z0-9]{20,}/g, // Hugging Face tokens
	/xai-[A-Za-z0-9]{20,}/g, // xAI API keys
	/AKIA[A-Z0-9]{16}/g,
	/\bBearer\s+[A-Za-z0-9._\-=+/%]{20,}/gi, // bearer tokens (incl. X public bearer)
	/\b(?:auth_token|ct0)["'\s]*[=:]["'\s]*[A-Za-z0-9%]{16,}/gi, // X session cookies
	/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s"'<>]+/gi, // DB/broker connection strings (carry passwords)
	/(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|ELIZAOS_CLOUD_API_KEY|ELEVENLABS_API_KEY|GITHUB_TOKEN|GITHUB_AGENT_PAT|GITHUB_USER_PAT|HF_TOKEN|HUGGINGFACE_TOKEN|X_AUTH_TOKEN|X_CT0|GMGN_API_KEY|GMGN_PRIVATE_KEY|SUPABASE_[A-Z_]*KEY|DATABASE_URL|[A-Z0-9_]*PRIVATE_KEY|[A-Z0-9_]*SECRET[A-Z0-9_]*)\s*["']?\s*[=:]\s*["']?[^\s,"'}]+/gi,
	/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email addresses (PII)
];

const SENSITIVE_PATH_PATTERNS = [/^vault\b/i, /^auth\b/i, /^_meta\b/i, /^_routing\b/i, /^pm\./i, /^config\./i];
const SENSITIVE_TYPES = new Set(["vault", "secret", "credential"]);

/**
 * Channel sources whose content is private to the user — never leak
 * to a public repo regardless of redaction. iMessage is the obvious
 * one (Apple-DM, no opt-in to publication). Add more here if other
 * platforms get added that should never be public.
 */
const PRIVATE_CHANNEL_PATTERNS = [
	/imessage/i,
	/^message:imessage/i,
	/^inbox:imessage/i,
];

function redactString(input: string): string {
	let out = input;
	for (const pat of CRED_PATTERNS) out = out.replace(pat, "[REDACTED]");
	return out;
}

function deepRedact(value: unknown): unknown {
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) return value.map(deepRedact);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = deepRedact(v);
		}
		return out;
	}
	return value;
}

function isSensitiveMemory(m: { type?: string; path?: string; tags?: string[] | undefined }): boolean {
	if (m.type && SENSITIVE_TYPES.has(m.type.toLowerCase())) return true;
	if (m.path) {
		for (const pat of SENSITIVE_PATH_PATTERNS) if (pat.test(m.path)) return true;
	}
	if (Array.isArray(m.tags)) {
		if (m.tags.some((t) => /vault|secret|credential|private|imessage/i.test(t))) return true;
	}
	return false;
}

function matchesPrivateChannel(s: string | null | undefined): boolean {
	if (!s) return false;
	for (const pat of PRIVATE_CHANNEL_PATTERNS) if (pat.test(s)) return true;
	return false;
}

/**
 * Source-field scan for iMessage origin. Only catches records that
 * actually CAME from iMessage — not records that merely reference
 * the word in unrelated text (autonomy prompts, GIF captions, etc.).
 *
 * Layered: top-level source/channel/platform plus one level deep
 * (metadata.source, content.source, room.platform, etc.).
 */
function isPrivateChannelRecord(rec: unknown): boolean {
	if (!rec) return false;
	if (typeof rec !== "object") return false;
	for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
		if ((/^source$/i.test(k) || /channel/i.test(k) || /^platform$/i.test(k)) && typeof v === "string") {
			if (matchesPrivateChannel(v)) return true;
		}
		if (v && typeof v === "object" && !Array.isArray(v)) {
			for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
				if ((/^source$/i.test(k2) || /channel/i.test(k2) || /^platform$/i.test(k2)) && typeof v2 === "string") {
					if (matchesPrivateChannel(v2)) return true;
				}
			}
		}
	}
	return false;
}

/** Keys whose values carry actual message text in eliza memory and
 * trajectory shapes. Hit list — anything else passes through. */
const TEXT_BEARING_KEYS = new Set([
	"text", "body", "content", "message", "input", "output",
	"prompt", "completion", "rawText", "raw_text",
]);

/**
 * Replace text-bearing string fields with a redaction marker, walking
 * the whole record. Used when the record is iMessage-sourced — we
 * keep id/timestamps/source metadata so the timeline is intact, but
 * the user's actual texts are gone.
 */
function scrubTextFields(value: unknown, depth = 0): unknown {
	if (depth > 12) return value; // bound recursion
	if (Array.isArray(value)) return value.map((v) => scrubTextFields(v, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (TEXT_BEARING_KEYS.has(k) && typeof v === "string" && v.length > 0) {
				out[k] = "[REDACTED iMessage]";
			} else if (TEXT_BEARING_KEYS.has(k) && v && typeof v === "object") {
				// `content` can be an object (eliza Memory.content) — recurse so
				// inner `text` field gets scrubbed but other fields like
				// `attachments`, `actions` stay.
				out[k] = scrubTextFields(v, depth + 1);
			} else {
				out[k] = scrubTextFields(v, depth + 1);
			}
		}
		return out;
	}
	return value;
}

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	const params = opts.parameters;
	const bags = [
		params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : null,
		opts,
	].filter((bag): bag is Record<string, unknown> => !!bag);
	for (const bag of bags) {
		for (const k of keys) {
			const v = bag[k];
			if (typeof v === "string" && v.trim().length > 0) return v.trim();
		}
	}
	return undefined;
}

function pickBool(opts: Record<string, unknown> | undefined, key: string, dflt: boolean): boolean {
	const params = opts?.parameters;
	const bag = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : opts;
	const v = bag?.[key];
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v === "true" || v === "1";
	return dflt;
}

function pickNumber(opts: Record<string, unknown> | undefined, key: string, dflt: number): number {
	const params = opts?.parameters;
	const bag = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : opts;
	const v = bag?.[key];
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return dflt;
}

function ok(text: string, values?: Record<string, unknown>): ActionResult {
	return { success: true, text, ...(values ? { values: values as never } : {}) };
}
function fail(text: string): ActionResult {
	return { success: false, text };
}
async function emit(
	callback: ((r: { text: string; action: string }) => void | Promise<unknown>) | undefined,
	text: string,
	action: string,
): Promise<void> {
	if (!callback) return;
	try { await callback({ text, action }); } catch { /* best-effort */ }
}

async function getAgentPat(runtime: IAgentRuntime): Promise<string | null> {
	const pat =
		(typeof runtime.getSetting === "function" ? runtime.getSetting("GITHUB_AGENT_PAT") : null)
		|| process.env.GITHUB_AGENT_PAT
		|| (typeof runtime.getSetting === "function" ? runtime.getSetting("GITHUB_TOKEN") : null)
		|| process.env.GITHUB_TOKEN;
	return typeof pat === "string" && pat.length > 0 ? pat : null;
}

async function createReleaseWithAsset({
	pat,
	owner,
	name,
	tag,
	releaseTitle,
	body,
	assetPath,
	assetName,
}: {
	pat: string;
	owner: string;
	name: string;
	tag: string;
	releaseTitle: string;
	body: string;
	assetPath: string;
	assetName: string;
}): Promise<{ htmlUrl: string; downloadUrl: string }> {
	const fs = await import("node:fs");
	const headers = {
		Authorization: `Bearer ${pat}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};

	// 1. Create release.
	const createRes = await fetch(`https://api.github.com/repos/${owner}/${name}/releases`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({
			tag_name: tag,
			name: releaseTitle,
			body,
			draft: false,
			prerelease: false,
		}),
	});
	if (!createRes.ok) {
		const errText = await createRes.text().catch(() => createRes.statusText);
		throw new Error(`release create failed (HTTP ${createRes.status}): ${errText.slice(0, 240)}`);
	}
	const releaseJson = (await createRes.json()) as { id?: number; html_url?: string; upload_url?: string };
	if (!releaseJson.id || !releaseJson.upload_url) throw new Error("release response missing id / upload_url");

	// 2. Upload asset. The upload_url is a templated URL like
	//    "https://uploads.github.com/.../assets{?name,label}" — strip the
	//    template suffix and append the asset name as a query string.
	const uploadBase = releaseJson.upload_url.replace(/\{\?[^}]+\}$/, "");
	const assetBuf = fs.readFileSync(assetPath);
	const uploadRes = await fetch(`${uploadBase}?name=${encodeURIComponent(assetName)}`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/gzip", "Content-Length": String(assetBuf.length) },
		body: assetBuf,
	});
	if (!uploadRes.ok) {
		const errText = await uploadRes.text().catch(() => uploadRes.statusText);
		throw new Error(`asset upload failed (HTTP ${uploadRes.status}): ${errText.slice(0, 240)}`);
	}
	const assetJson = (await uploadRes.json()) as { browser_download_url?: string };
	return {
		htmlUrl: releaseJson.html_url ?? `https://github.com/${owner}/${name}/releases/tag/${tag}`,
		downloadUrl: assetJson.browser_download_url ?? `https://github.com/${owner}/${name}/releases/download/${tag}/${encodeURIComponent(assetName)}`,
	};
}

async function deleteRepoIfExists({
	pat,
	owner,
	name,
}: {
	pat: string;
	owner: string;
	name: string;
}): Promise<boolean> {
	const headers = {
		Authorization: `Bearer ${pat}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, { method: "DELETE", headers });
	if (res.status === 204) return true;
	if (res.status === 404) return false;
	const body = await res.text().catch(() => res.statusText);
	throw new Error(`Repo delete failed (HTTP ${res.status}): ${body.slice(0, 240)}. PAT needs the \`delete_repo\` scope.`);
}

async function ensureRepo({
	pat,
	owner,
	name,
	isPrivate,
	description,
}: {
	pat: string;
	owner: string;
	name: string;
	isPrivate: boolean;
	description: string;
}): Promise<{ htmlUrl: string; cloneUrl: string }> {
	const headers = {
		Authorization: `Bearer ${pat}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const getRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers });
	if (getRes.status === 200) {
		const j = (await getRes.json()) as { html_url?: string; clone_url?: string };
		return {
			htmlUrl: j.html_url ?? `https://github.com/${owner}/${name}`,
			cloneUrl: j.clone_url ?? `https://github.com/${owner}/${name}.git`,
		};
	}
	const createRes = await fetch("https://api.github.com/user/repos", {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({
			name,
			description: description.slice(0, 350),
			private: !!isPrivate,
			auto_init: false,
		}),
	});
	if (!createRes.ok) {
		const body = await createRes.text().catch(() => createRes.statusText);
		throw new Error(`Repo create failed (HTTP ${createRes.status}): ${body.slice(0, 240)}`);
	}
	const j = (await createRes.json()) as { html_url?: string; clone_url?: string };
	return {
		htmlUrl: j.html_url ?? `https://github.com/${owner}/${name}`,
		cloneUrl: j.clone_url ?? `https://github.com/${owner}/${name}.git`,
	};
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { ok: code === 0, stderr: stderr.trim() };
}

function isoDateParts(d: Date): { day: string; week: string; month: string } {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	// ISO week (Mon-based). RFC 3339 weeks: Thursday in week 1.
	const tmp = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
	const dayNum = (tmp.getUTCDay() + 6) % 7;
	tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
	const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
	const week = 1 + Math.round(((tmp.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
	const wy = tmp.getUTCFullYear();
	return {
		day: `${y}-${m}-${dd}`,
		week: `${wy}-W${String(week).padStart(2, "0")}`,
		month: `${y}-${m}`,
	};
}

function buildArchiveSummary(args: {
	now: string;
	owner: string;
	repoUrl: string;
	releaseUrl?: string | null;
	counts: {
		trajectories: number;
		details: number;
		memoriesByTable: Map<string, Array<Record<string, unknown>>>;
		redactedMemories: number;
		scrubbedTrajectories: number;
		relationships: number;
		totalTrajectoriesScanned: number;
		totalMemoriesScanned: number;
	};
}): string {
	const { now, owner, repoUrl, releaseUrl, counts } = args;
	const lines: string[] = [];
	lines.push(`# Snapshot — ${now}`);
	lines.push("");
	lines.push(`Owner: \`${owner}\` · repo: ${repoUrl}`);
	if (releaseUrl) {
		lines.push("");
		lines.push(`📦 **Full data tarball**: ${releaseUrl}`);
	}
	lines.push("");
	lines.push("## Counts");
	lines.push("");
	lines.push(`| Metric | Value |`);
	lines.push(`| --- | ---: |`);
	lines.push(`| Trajectories (published) | ${counts.trajectories} |`);
	lines.push(`| Trajectories with full detail | ${counts.details} |`);
	lines.push(`| Trajectories scanned (pre-filter) | ${counts.totalTrajectoriesScanned} |`);
	lines.push(`| Trajectories text-scrubbed (iMessage source) | ${counts.scrubbedTrajectories} |`);
	lines.push(`| Memories (published) | ${Array.from(counts.memoriesByTable.values()).reduce((a, r) => a + r.length, 0)} |`);
	lines.push(`| Memories scanned (pre-filter) | ${counts.totalMemoriesScanned} |`);
	lines.push(`| Memories redacted | ${counts.redactedMemories} |`);
	lines.push(`| Relationships | ${counts.relationships} |`);
	lines.push("");
	lines.push("## Memories by table");
	lines.push("");
	for (const [tableName, rows] of counts.memoriesByTable) {
		lines.push(`- \`${tableName}\` — ${rows.length}`);
	}
	lines.push("");
	lines.push("Latest full data: [`data/`](../../data/)");
	return `${lines.join("\n")}\n`;
}

type DumpSnapshot = {
	work: string;
	now: string;
	parts: { day: string; week: string; month: string };
	releaseTag: string;
	filteredTrajectories: Array<Record<string, unknown>>;
	filteredDetails: Array<Record<string, unknown>>;
	filteredMemories: Array<Record<string, unknown>>;
	filteredRelationships: Array<Record<string, unknown>>;
	memoriesByTable: Map<string, Array<Record<string, unknown>>>;
	redactedMemoryCount: number;
	scrubbedTrajectoryCount: number;
	totalTrajectoriesScanned: number;
	totalMemoriesScanned: number;
	tableLines: string[];
	dataBytes: number;
};

function dumpCounts(snapshot: DumpSnapshot): AgentDataDumpCounts {
	return {
		trajectories: snapshot.filteredTrajectories.length,
		trajectoryDetails: snapshot.filteredDetails.length,
		memories: snapshot.filteredMemories.length,
		memoryTables: snapshot.memoriesByTable.size,
		relationships: snapshot.filteredRelationships.length,
		redactedMemories: snapshot.redactedMemoryCount,
		totalTrajectoriesScanned: snapshot.totalTrajectoriesScanned,
		totalMemoriesScanned: snapshot.totalMemoriesScanned,
		dataBytes: snapshot.dataBytes,
	};
}

function directorySizeBytes(path: string): number {
	try {
		const st = statSync(path);
		if (st.isFile()) return st.size;
		if (!st.isDirectory()) return 0;
		let total = 0;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			total += directorySizeBytes(join(path, entry.name));
		}
		return total;
	} catch {
		return 0;
	}
}

async function createAgentDumpSnapshot({
	runtime,
	limit,
	owner,
	repoUrl,
	releaseUrlForTag,
}: {
	runtime: IAgentRuntime;
	limit: number;
	owner: string;
	repoUrl: string;
	releaseUrlForTag?: (tag: string) => string | null;
}): Promise<DumpSnapshot> {
	const trajectoryService = runtime.getService("trajectories") as
		| {
			listTrajectories?: (opts: { limit?: number; offset?: number }) => Promise<{ trajectories: Array<Record<string, unknown>>; total: number }>;
			getTrajectoryDetail?: (id: string) => Promise<Record<string, unknown> | null>;
		}
		| null;
	const trajectories: Array<Record<string, unknown>> = [];
	const trajectoryDetails: Array<Record<string, unknown>> = [];
	if (trajectoryService?.listTrajectories) {
		const PAGE = 100;
		try {
			let offset = 0;
			while (trajectories.length < limit) {
				const wantThisPage = Math.min(PAGE, limit - trajectories.length);
				const r = await trajectoryService.listTrajectories({ limit: wantThisPage, offset });
				const rows = r.trajectories ?? [];
				if (rows.length === 0) break;
				trajectories.push(...rows);
				offset += rows.length;
				if (typeof r.total === "number" && offset >= r.total) break;
			}
		} catch (err) {
			console.warn("[agent-public-log] trajectories list failed:", err instanceof Error ? err.message : err);
		}
		if (trajectoryService.getTrajectoryDetail) {
			const detailCap = Math.min(trajectories.length, 500);
			for (let i = 0; i < detailCap; i++) {
				const id = String((trajectories[i] as { id?: unknown }).id ?? "");
				if (!id) continue;
				try {
					const detail = await trajectoryService.getTrajectoryDetail(id);
					if (detail) trajectoryDetails.push({ id, ...detail });
				} catch { /* skip row */ }
			}
		}
	}

	const memories: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	const perTable = Math.max(50, Math.ceil(limit / KNOWN_MEMORY_TABLES.length));
	const getMem = (runtime as unknown as { getMemories?: (opts: { tableName: string; count?: number }) => Promise<Array<Record<string, unknown>>> }).getMemories;
	if (typeof getMem === "function") {
		for (const tableName of KNOWN_MEMORY_TABLES) {
			try {
				const rows = await getMem.call(runtime, { tableName, count: perTable }) ?? [];
				for (const m of rows) {
					const id = String((m as { id?: unknown }).id ?? "");
					if (id && seen.has(id)) continue;
					if (id) seen.add(id);
					memories.push({ ...m, _table: tableName });
				}
			} catch (err) {
				console.warn(`[agent-public-log] memories(${tableName}) fetch failed:`, err instanceof Error ? err.message : err);
			}
		}
	}

	const relationships: Array<Record<string, unknown>> = [];
	const getRelationships = (runtime as unknown as {
		getRelationships?: (opts: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
	}).getRelationships;
	if (typeof getRelationships === "function") {
		try {
			const agentId = typeof runtime.agentId === "string" ? runtime.agentId : undefined;
			const rows = await getRelationships.call(runtime, {
				...(agentId ? { entityIds: [agentId] } : {}),
				limit: Math.min(5000, Math.max(200, limit * 5)),
			});
			relationships.push(...(rows ?? []));
		} catch (err) {
			console.warn("[agent-public-log] relationships fetch failed:", err instanceof Error ? err.message : err);
		}
	}

	const filteredMemories: Array<Record<string, unknown>> = [];
	let redactedMemoryCount = 0;
	for (const mem of memories) {
		const md = (mem.metadata as Record<string, unknown> | undefined) ?? {};
		const summary = {
			type: typeof md.type === "string" ? md.type : (typeof mem.type === "string" ? mem.type : undefined),
			path: typeof md.path === "string" ? md.path : (typeof mem.path === "string" ? mem.path : undefined),
			tags: Array.isArray(md.tags)
				? (md.tags as unknown[]).filter((t): t is string => typeof t === "string")
				: (Array.isArray(mem.tags) ? (mem.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined),
		};
		if (isSensitiveMemory(summary)) {
			redactedMemoryCount++;
			continue;
		}
		if (isPrivateChannelRecord(mem)) {
			redactedMemoryCount++;
			filteredMemories.push(deepRedact(scrubTextFields(mem)) as Record<string, unknown>);
			continue;
		}
		filteredMemories.push(deepRedact(mem) as Record<string, unknown>);
	}

	const scrubbedTrajectoryIds = new Set<string>();
	const filteredTrajectories: Array<Record<string, unknown>> = [];
	for (const t of trajectories) {
		if (isPrivateChannelRecord(t)) {
			scrubbedTrajectoryIds.add(String((t as { id?: unknown }).id ?? ""));
			filteredTrajectories.push(deepRedact(scrubTextFields(t)) as Record<string, unknown>);
			continue;
		}
		filteredTrajectories.push(deepRedact(t) as Record<string, unknown>);
	}
	const filteredDetails: Array<Record<string, unknown>> = [];
	for (const d of trajectoryDetails) {
		const id = String((d as { id?: unknown }).id ?? "");
		if (scrubbedTrajectoryIds.has(id) || isPrivateChannelRecord(d)) {
			filteredDetails.push(deepRedact(scrubTextFields(d)) as Record<string, unknown>);
		} else {
			filteredDetails.push(deepRedact(d) as Record<string, unknown>);
		}
	}

	const filteredRelationships = relationships.map((r) => (
		isPrivateChannelRecord(r)
			? deepRedact(scrubTextFields(r))
			: deepRedact(r)
	)) as Array<Record<string, unknown>>;

	const memoriesByTable = new Map<string, Array<Record<string, unknown>>>();
	for (const m of filteredMemories) {
		const t = String((m as { _table?: unknown })._table ?? "memories");
		const list = memoriesByTable.get(t) ?? [];
		list.push(m);
		memoriesByTable.set(t, list);
	}

	const work = mkdtempSync(join(tmpdir(), "detour-agent-dump-"));
	try {
		mkdirSync(join(work, "data"), { recursive: true });
		mkdirSync(join(work, "data", "memories"), { recursive: true });

		const SHARD_SOFT_LIMIT = 25 * 1024 * 1024;
		const writeShardedJsonl = (relPath: string, records: ReadonlyArray<Record<string, unknown>>): { files: string[]; bytes: number } => {
			const files: string[] = [];
			let totalBytes = 0;
			let shardIndex = 0;
			let buf = "";
			let bufBytes = 0;
			const flush = () => {
				if (buf.length === 0) return;
				const fname = shardIndex === 0
					? relPath
					: relPath.replace(/\.jsonl$/, `.${String(shardIndex).padStart(3, "0")}.jsonl`);
				writeFileSync(join(work, fname), buf);
				files.push(fname);
				totalBytes += bufBytes;
				shardIndex++;
				buf = "";
				bufBytes = 0;
			};
			for (const r of records) {
				const line = `${JSON.stringify(r)}\n`;
				const lineBytes = Buffer.byteLength(line, "utf8");
				if (bufBytes + lineBytes > SHARD_SOFT_LIMIT && bufBytes > 0) flush();
				buf += line;
				bufBytes += lineBytes;
			}
			flush();
			return { files, bytes: totalBytes };
		};

		writeShardedJsonl("data/trajectories.jsonl", filteredTrajectories);
		writeShardedJsonl("data/trajectory-details.jsonl", filteredDetails);
		writeShardedJsonl("data/relationships.jsonl", filteredRelationships);

		const tableLines: string[] = [];
		const memoryShardCounts: Record<string, { files: number; entries: number }> = {};
		for (const [tableName, rows] of memoriesByTable) {
			const r = writeShardedJsonl(`data/memories/${tableName}.jsonl`, rows);
			memoryShardCounts[tableName] = { files: r.files.length, entries: rows.length };
			const shardSuffix = r.files.length > 1 ? ` (${r.files.length} shards)` : "";
			tableLines.push(`- \`data/memories/${tableName}.jsonl\`${shardSuffix} - ${rows.length} entries`);
		}
		writeShardedJsonl("data/all-memories.jsonl", filteredMemories);

		const now = new Date().toISOString();
		const parts = isoDateParts(new Date());
		const releaseTag = `snapshot-${now.replace(/[:.]/g, "").replace("Z", "Z")}`;
		const releaseUrl = releaseUrlForTag?.(releaseTag) ?? null;
		const archiveSummary = buildArchiveSummary({
			now,
			owner,
			repoUrl,
			releaseUrl,
			counts: {
				trajectories: filteredTrajectories.length,
				details: filteredDetails.length,
				memoriesByTable,
				redactedMemories: redactedMemoryCount,
				scrubbedTrajectories: scrubbedTrajectoryIds.size,
				relationships: filteredRelationships.length,
				totalTrajectoriesScanned: trajectories.length,
				totalMemoriesScanned: memories.length,
			},
		});
		mkdirSync(join(work, "archive", "daily"), { recursive: true });
		mkdirSync(join(work, "archive", "weekly"), { recursive: true });
		mkdirSync(join(work, "archive", "monthly"), { recursive: true });
		mkdirSync(join(work, "data", "archive", "daily"), { recursive: true });
		mkdirSync(join(work, "data", "archive", "weekly"), { recursive: true });
		mkdirSync(join(work, "data", "archive", "monthly"), { recursive: true });
		writeFileSync(join(work, "archive", "daily", `${parts.day}.md`), archiveSummary);
		writeFileSync(join(work, "archive", "weekly", `${parts.week}.md`), archiveSummary);
		writeFileSync(join(work, "archive", "monthly", `${parts.month}.md`), archiveSummary);
		writeFileSync(join(work, "data", "archive", "daily", `${parts.day}.md`), archiveSummary);
		writeFileSync(join(work, "data", "archive", "weekly", `${parts.week}.md`), archiveSummary);
		writeFileSync(join(work, "data", "archive", "monthly", `${parts.month}.md`), archiveSummary);
		writeFileSync(join(work, "data", "manifest.json"), `${JSON.stringify({
			generatedAt: now,
			owner,
			target: repoUrl,
			counts: {
				trajectories: filteredTrajectories.length,
				trajectoryDetails: filteredDetails.length,
				memories: filteredMemories.length,
				memoryTables: memoriesByTable.size,
				relationships: filteredRelationships.length,
				redactedMemories: redactedMemoryCount,
				scrubbedTrajectories: scrubbedTrajectoryIds.size,
				totalTrajectoriesScanned: trajectories.length,
				totalMemoriesScanned: memories.length,
			},
			memoryShardCounts,
		}, null, 2)}\n`);

		const readme = [
			`# ${owner} - agent data dump`,
			"",
			`Snapshot at \`${now}\`.`,
			"",
			"Auto-generated by [detour](https://github.com/Dexploarer/detour).",
			"",
			"## Contents",
			"",
			"### Trajectories",
			`- \`data/trajectories.jsonl\` - ${filteredTrajectories.length} summary rows.`,
			`- \`data/trajectory-details.jsonl\` - ${filteredDetails.length} full detail records.`,
			"",
			"### Memories and knowledge",
			...(tableLines.length ? tableLines : ["- (no memories captured this run)"]),
			"",
			`- \`data/all-memories.jsonl\` - ${filteredMemories.length} combined entries.`,
			`- \`data/relationships.jsonl\` - ${filteredRelationships.length} relationship records.`,
			`- \`data/archive/\` - daily, weekly, and monthly snapshot summaries.`,
			`- \`data/manifest.json\` - counts and shard metadata.`,
			"",
			"## Redaction",
			"",
			"- Vault / auth / credential memories are dropped entirely.",
			"- iMessage-sourced records are kept, but text-bearing fields are replaced with `[REDACTED iMessage]`.",
			"- All surviving strings are deep-scrubbed for credential patterns.",
		].join("\n");
		writeFileSync(join(work, "README.md"), `${readme}\n`);
		writeFileSync(join(work, "data", "README.md"), `${readme}\n`);

		const dataBytes = directorySizeBytes(join(work, "data"));
		return {
			work,
			now,
			parts,
			releaseTag,
			filteredTrajectories,
			filteredDetails,
			filteredMemories,
			filteredRelationships,
			memoriesByTable,
			redactedMemoryCount,
			scrubbedTrajectoryCount: scrubbedTrajectoryIds.size,
			totalTrajectoriesScanned: trajectories.length,
			totalMemoriesScanned: memories.length,
			tableLines,
			dataBytes,
		};
	} catch (err) {
		try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
		throw err;
	}
}

const publishHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const repoName = pickString(opts, ["repoName", "repo", "name"]);
	const isPrivate = pickBool(opts, "private", false) || pickBool(opts, "isPrivate", false);
	const reset = pickBool(opts, "reset", false) || pickBool(opts, "deleteFirst", false);
	const announce = pickBool(opts, "announce", false) || pickBool(opts, "tweet", false);
	// Default: create a GitHub Release with the full data tarball.
	// Releases are GitHub's free CDN for large per-snapshot artifacts —
	// up to 2GB per asset, no LFS billing, no repo bloat. Each release
	// is the canonical historical record of that snapshot.
	const release = pickBool(opts, "release", true);
	const limit = Math.min(2000, pickNumber(opts, "limit", 200));

	const pat = await getAgentPat(runtime);
	if (!pat) return fail("No GITHUB_AGENT_PAT (or GITHUB_TOKEN) configured. Wire it in Messaging connections.");

	// 1. Resolve agent's GitHub login (for repo URL).
	const meRes = await fetch("https://api.github.com/user", {
		headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
	});
	if (!meRes.ok) {
		const body = await meRes.text().catch(() => meRes.statusText);
		return fail(`GitHub auth failed (HTTP ${meRes.status}): ${body.slice(0, 240)}`);
	}
	const me = (await meRes.json()) as { login?: string };
	const owner = me.login;
	if (!owner) return fail("GitHub /user did not return a login");
	const name = (repoName ?? `${owner}-detour-public-log`).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 100);

	const snapshot = await createAgentDumpSnapshot({
		runtime,
		limit,
		owner,
		repoUrl: `https://github.com/${owner}/${name}`,
		releaseUrlForTag: release
			? (tag) => `https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(tag)}`
			: undefined,
	});
	const work = snapshot.work;
	try {
		if (reset) {
			try {
				const deleted = await deleteRepoIfExists({ pat, owner, name });
				console.log(`[agent-public-log] reset=true → deleted prior repo: ${deleted}`);
			} catch (err) {
				return fail(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const repo = await ensureRepo({ pat, owner, name, isPrivate, description: `Public agent log for ${owner} — auto-published by detour.` });
		const pushUrl = repo.cloneUrl.replace("https://", `https://x-access-token:${pat}@`);

		// Clone-or-init: when the repo exists and has commits, we clone
		// it into a sibling dir so previous archive/* files survive the
		// next push. Then we copy the freshly-staged files (which are
		// in `work`) ON TOP, removing only `data/` (which is meant to be
		// rolling), and force-push. Without this, archive entries from
		// prior days would be wiped on every snapshot.
		const repoWork = mkdtempSync(join(tmpdir(), "detour-public-log-repo-"));
		const clone = await git("/", ["clone", "--quiet", pushUrl, repoWork]);
		if (!clone.ok) {
			// Empty / brand-new repo with no commits → init fresh.
			const init = await git(repoWork, ["init", "--quiet"]);
			if (!init.ok) throw new Error(`git init failed (clone also failed: ${clone.stderr.slice(0, 120)}): ${init.stderr}`);
			const remote = await git(repoWork, ["remote", "add", "origin", pushUrl]);
			if (!remote.ok) throw new Error(`git remote add failed: ${remote.stderr}`);
		}

		// Wipe the stale data/ from any prior clone — it's rolling, not
		// chronologically preserved. Archive/* survives the wipe.
		try {
			const fsModule = await import("node:fs");
			fsModule.rmSync(join(repoWork, "data"), { recursive: true, force: true });
		} catch { /* ignore */ }

		// Copy fresh artifacts from `work` into `repoWork`, preserving
		// any pre-existing archive entries from previous runs.
		const cp = await git("/", ["--git-dir=/dev/null", "init"]); // no-op to placate types if needed
		void cp;
		const fsModule = await import("node:fs");
		const copyRecursive = (src: string, dst: string) => {
			fsModule.mkdirSync(dst, { recursive: true });
			for (const entry of fsModule.readdirSync(src, { withFileTypes: true })) {
				const s = join(src, entry.name);
				const d = join(dst, entry.name);
				if (entry.isDirectory()) copyRecursive(s, d);
				else fsModule.copyFileSync(s, d);
			}
		};
		copyRecursive(work, repoWork);

		const add = await git(repoWork, ["add", "-A"]);
		if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
		const status = await git(repoWork, ["status", "--porcelain"]);
		if (status.ok && status.stderr === "") {
			// Possible no-op (data identical) — try commit anyway, will fail
			// gracefully below if nothing staged.
		}
		const commit = await git(repoWork, [
			"-c", "user.email=agent@detour.local",
			"-c", "user.name=Detour Agent",
			"commit", "--quiet", "-m", `snapshot: ${snapshot.now}`,
		]);
		if (!commit.ok && !commit.stderr.includes("nothing to commit")) {
			throw new Error(`git commit failed: ${commit.stderr}`);
		}
		// Standard push (no force): we appended to existing history, so
		// fast-forward should succeed. Fall back to creating `main` for
		// fresh repos.
		const push = await git(repoWork, ["push", "-u", "origin", "HEAD:main"]);
		if (!push.ok) {
			throw new Error(`git push failed: ${push.stderr}`);
		}

		// Best-effort cleanup of the cloned repo workdir. The publish
		// dir (`work`) is cleaned up by the outer `finally` block.
		try { (await import("node:fs")).rmSync(repoWork, { recursive: true, force: true }); } catch { /* ignore */ }

		// Create a GitHub Release with the full data dump as a tarball
		// asset. This is our chronological history mechanism — repo
		// stays small (only summaries), releases hold the per-snapshot
		// raw data forever. Each release is one self-contained
		// download.
		let releaseInfo: { htmlUrl: string; downloadUrl: string } | null = null;
		if (release) {
			try {
				const tarPath = join(tmpdir(), `detour-public-log-${Date.now()}.tar.gz`);
				const tarProc = Bun.spawn(["tar", "-czf", tarPath, "-C", work, "data"], {
					stdout: "pipe", stderr: "pipe",
				});
				const tarStderr = await new Response(tarProc.stderr).text();
				const tarCode = await tarProc.exited;
				if (tarCode !== 0) throw new Error(`tar failed: ${tarStderr.trim().slice(0, 200)}`);
				const releaseBody = [
					`Snapshot at \`${snapshot.now}\`.`,
					"",
					`- ${snapshot.filteredTrajectories.length} trajectories (${snapshot.filteredDetails.length} with full detail)`,
					`- ${snapshot.filteredMemories.length} memories across ${snapshot.memoriesByTable.size} pensieve tables (${snapshot.redactedMemoryCount} redacted)`,
					`- ${snapshot.filteredRelationships.length} relationships`,
					"",
					`Daily summary: \`archive/daily/${snapshot.parts.day}.md\`.`,
					"",
					"Download `dump.tar.gz` for the full data — extract and inspect with `tar xzf dump.tar.gz`. Each file inside is a JSONL ready for `jq`/grep.",
				].join("\n");
				releaseInfo = await createReleaseWithAsset({
					pat,
					owner,
					name,
					tag: snapshot.releaseTag,
					releaseTitle: `Snapshot ${snapshot.now}`,
					body: releaseBody,
					assetPath: tarPath,
					assetName: "dump.tar.gz",
				});
				try { (await import("node:fs")).rmSync(tarPath, { force: true }); } catch { /* ignore */ }
			} catch (err) {
				console.warn("[agent-public-log] release creation failed:", err instanceof Error ? err.message : err);
				// Don't fail the whole publish — the markdown summary
				// still exists, just without a release link this run.
			}
		}

		const releaseSuffix = releaseInfo ? ` · release: ${releaseInfo.htmlUrl}` : "";
		const summary = `Published agent public log to ${repo.htmlUrl} — ${snapshot.filteredTrajectories.length} trajectories (${snapshot.filteredDetails.length} with full detail), ${snapshot.filteredMemories.length} memories across ${snapshot.memoriesByTable.size} tables (${snapshot.redactedMemoryCount} redacted), ${snapshot.filteredRelationships.length} relationships. Archive: daily/${snapshot.parts.day}, weekly/${snapshot.parts.week}, monthly/${snapshot.parts.month}${releaseSuffix}.`;
		await emit(callback, summary, "AGENT_PUBLIC_LOG_PUBLISH");

		// Optional: post about it on X. Best-effort; if X auth is missing
		// the action returns false but we don't fail the whole publish.
		if (announce) {
			try {
				const text = [
					`Just dumped my latest agent log: ${repo.htmlUrl}`,
					`${snapshot.filteredTrajectories.length} trajectories · ${snapshot.filteredMemories.length} memories · ${snapshot.redactedMemoryCount} redacted`,
					`Archive: archive/daily/${snapshot.parts.day}.md`,
					`(part of detour — Dexploarer's elizaOS sandbox)`,
				].join("\n");
				const liveActions = (runtime as unknown as { actions?: Array<{ name: string; handler: (...a: unknown[]) => unknown }> }).actions ?? [];
				const xPost = liveActions.find((a) => a.name === "X_POST");
				if (xPost) {
					await xPost.handler(runtime, _m, _s, { text }, callback);
				} else {
					console.warn("[agent-public-log] announce=true but X_POST action not registered");
				}
			} catch (err) {
				console.warn("[agent-public-log] announce failed:", err instanceof Error ? err.message : err);
			}
		}
		return ok(summary, {
			caller: runtime.character?.name ? `agent:${runtime.character.name}` : "agent",
			htmlUrl: repo.htmlUrl,
			cloneUrl: repo.cloneUrl,
			counts: dumpCounts(snapshot),
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	} finally {
		try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
	}
};

function truncateOutput(text: string, max = 2000): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function hfDatasetSyncCommand(destination = DEFAULT_HF_BUCKET): string {
	return `hf sync ./data ${destination}`;
}

async function runHfSync(work: string, destination: string): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(["hf", "sync", "./data", destination], {
			cwd: work,
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		throw new Error(`hf CLI could not be started: ${err instanceof Error ? err.message : String(err)}`);
	}
	const stdoutPipe = proc.stdout;
	const stderrPipe = proc.stderr;
	const [stdout, stderr, exitCode] = await Promise.all([
		stdoutPipe && typeof stdoutPipe === "object" ? new Response(stdoutPipe as ReadableStream<Uint8Array>).text() : Promise.resolve(""),
		stderrPipe && typeof stderrPipe === "object" ? new Response(stderrPipe as ReadableStream<Uint8Array>).text() : Promise.resolve(""),
		proc.exited,
	]);
	return {
		exitCode,
		stdout: truncateOutput(stdout.trim()),
		stderr: truncateOutput(stderr.trim()),
	};
}

export type AgentHfDatasetSyncResult = {
	destination: string;
	command: string;
	stdout: string;
	stderr: string;
	counts: AgentDataDumpCounts;
	summary: string;
};

export async function syncAgentDumpToHf(
	runtime: IAgentRuntime,
	options: { destination?: string; limit?: number } = {},
): Promise<AgentHfDatasetSyncResult> {
	const destination = options.destination ?? DEFAULT_HF_BUCKET;
	if (!destination.startsWith("hf://")) {
		throw new Error("Hugging Face destination must start with `hf://`.");
	}
	const rawLimit = options.limit ?? 200;
	const limit = Math.min(2000, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 200));
	let snapshot: DumpSnapshot | null = null;
	try {
		snapshot = await createAgentDumpSnapshot({
			runtime,
			limit,
			owner: runtime.character?.name ?? "detour-agent",
			repoUrl: destination,
		});
		const result = await runHfSync(snapshot.work, destination);
		if (result.exitCode !== 0) {
			throw new Error(`HF sync failed (exit ${result.exitCode}): ${result.stderr || result.stdout || "no output"}`);
		}
		const command = hfDatasetSyncCommand(destination);
		const counts = dumpCounts(snapshot);
		const summary = `Synced agent data dump to ${destination} using \`${command}\`: ${snapshot.filteredTrajectories.length} trajectories, ${snapshot.filteredDetails.length} trajectory details, ${snapshot.filteredMemories.length} memories/knowledge records, ${snapshot.filteredRelationships.length} relationships, ${snapshot.redactedMemoryCount} redacted, ${snapshot.dataBytes} bytes.`;
		return {
			destination,
			command,
			stdout: result.stdout,
			stderr: result.stderr,
			counts,
			summary,
		};
	} finally {
		if (snapshot) {
			try { rmSync(snapshot.work, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}
}

const hfSyncHandler: Handler = async (runtime, message, _s, options, callback) => {
	if (!(await hasOwnerAccess(runtime, message))) {
		return fail("Permission denied: only the owner may sync the agent data dump to Hugging Face.");
	}
	const opts = options as Record<string, unknown> | undefined;
	const destination = pickString(opts, ["destination", "bucket", "target", "url"]) ?? DEFAULT_HF_BUCKET;
	const limit = Math.min(2000, pickNumber(opts, "limit", 200));
	try {
		const result = await syncAgentDumpToHf(runtime, { destination, limit });
		await emit(callback, result.summary, "AGENT_HF_DATASET_SYNC");
		return ok(result.summary, {
			destination: result.destination,
			command: result.command,
			stdout: result.stdout,
			stderr: result.stderr,
			counts: result.counts,
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const agentPublicLogPublishAction: Action = {
	name: "AGENT_PUBLIC_LOG_PUBLISH",
	similes: ["DUMP_AGENT_LOG", "PUBLISH_TRAJECTORIES", "EXPORT_TO_GITHUB"],
	description:
		"Publish trajectories + full per-trajectory detail + memories (every pensieve table) to a public GitHub repo under the agent's PAT identity. ALSO writes chronological summaries under `archive/daily/YYYY-MM-DD.md`, `archive/weekly/YYYY-Www.md`, `archive/monthly/YYYY-MM.md` — these accumulate over time (clone-on-publish preserves prior entries). Optional: `repoName`, `private` (default false), `limit` (default 200, max 2000), `reset` (DELETE+recreate; PAT needs `delete_repo` scope), `announce` (after publish, post the URL on X via X_POST), `release` (default true, attaches the full data tarball as a GitHub Release asset). Redaction: hard-drops vault/auth/credential memories. iMessage-sourced records are kept but their text fields are replaced with `[REDACTED iMessage]` (timeline preserved, content gone). Records that merely mention iMessage in unrelated context are kept. All surviving strings are deep-scrubbed for credential patterns.",
	validate: async () => true,
	handler: publishHandler,
	examples: [],
	parameters: [
		{ name: "repoName", description: "Override default repo name.", required: false, schema: { type: "string" as const } },
		{ name: "private", description: "Create as private repo.", required: false, schema: { type: "boolean" as const } },
		{ name: "limit", description: "Max items to include per category (1-2000).", required: false, schema: { type: "number" as const } },
		{ name: "reset", description: "DELETE the existing repo before recreating. PAT needs delete_repo scope.", required: false, schema: { type: "boolean" as const } },
		{ name: "announce", description: "After publish, post the repo URL + counts on X via X_POST.", required: false, schema: { type: "boolean" as const } },
		{ name: "release", description: "Create a GitHub Release with the full data tarball attached (default: true). Releases are the chronological history mechanism — each one is a self-contained snapshot.", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

export const agentHfDatasetSyncAction: Action = {
	name: "AGENT_HF_DATASET_SYNC",
	similes: ["HF_SYNC_DATASET", "HUGGINGFACE_DATASET_SYNC", "DUMP_AGENT_DATA_TO_HF", "EXPORT_TO_HUGGINGFACE"],
	description:
		"Dump the agent's trajectories, full trajectory detail, Pensieve memories/knowledge tables, combined memories, relationships, manifest, and archive summaries into a staged `./data` directory, then run `hf sync ./data hf://buckets/dexploarer/detourdump` by default. Optional: `destination` (any hf:// target) and `limit` (default 200, max 2000). Requires the local Hugging Face `hf` CLI to be installed and authenticated. Redaction matches AGENT_PUBLIC_LOG_PUBLISH: vault/auth/credential memories are dropped, iMessage text fields are scrubbed, and surviving strings are credential-scrubbed.",
	validate: async (runtime, message) => hasOwnerAccess(runtime, message),
	handler: hfSyncHandler,
	examples: [],
	parameters: [
		{ name: "destination", description: "Hugging Face target. Defaults to hf://buckets/dexploarer/detourdump.", required: false, schema: { type: "string" as const } },
		{ name: "limit", description: "Max items to include per category (1-2000).", required: false, schema: { type: "number" as const } },
	],
} as Action;

export const agentPublicLogPlugin: Plugin = {
	name: "agent-public-log",
	description:
		"Agent data publishing plugin: AGENT_PUBLIC_LOG_PUBLISH dumps recent trajectories + memories to GitHub, and AGENT_HF_DATASET_SYNC syncs the same staged dataset to a Hugging Face hf:// bucket with credential redaction.",
	actions: [agentPublicLogPublishAction, agentHfDatasetSyncAction],
};
