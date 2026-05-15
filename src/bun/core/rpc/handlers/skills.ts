/**
 * Skills RPC handler — surfaces the agent's skill catalog to the UI.
 *
 * The agent runtime (plugin-agent-skills) owns load/enable/install
 * lifecycle. This handler only reads via `@elizaos/skills:loadSkills()`,
 * which already enumerates every search path (bundled / managed /
 * curated / project) and parses SKILL.md frontmatter. Mutating actions
 * stay inside the agent loop.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Utils } from "electrobun/bun";
import { loadSkills, getSkillsDir, parseFrontmatter } from "@elizaos/skills";
import type { Skill } from "@elizaos/skills";
import type { SkillsListResponse, SkillSourceTag, SkillSummary } from "../../../../shared/rpc/skills";
import type { RpcDeps } from "../types";

function pickEmojiFromFrontmatter(raw: unknown): string | null {
	if (!raw || typeof raw !== "object") return null;
	const metadata = (raw as { metadata?: unknown }).metadata;
	if (!metadata || typeof metadata !== "object") return null;
	const otto = (metadata as { otto?: unknown }).otto;
	if (!otto || typeof otto !== "object") return null;
	const emoji = (otto as { emoji?: unknown }).emoji;
	return typeof emoji === "string" && emoji.length > 0 ? emoji : null;
}

/** SKILL.md emoji isn't kept on the loaded Skill object — re-read the file for it. */
function readEmoji(filePath: string | undefined): string | null {
	if (!filePath || !existsSync(filePath)) return null;
	try {
		const raw = readFileSync(filePath, "utf8");
		const { frontmatter } = parseFrontmatter(raw);
		return pickEmojiFromFrontmatter(frontmatter);
	} catch {
		return null;
	}
}

function asSource(raw: string | undefined): SkillSourceTag {
	if (raw === "bundled" || raw === "managed" || raw === "curated" || raw === "project") return raw;
	return "unknown";
}

function toSummary(skill: Skill): SkillSummary {
	return {
		name: skill.name,
		description: skill.description ?? "",
		source: asSource(skill.source),
		filePath: skill.filePath ?? null,
		baseDir: skill.baseDir ?? null,
		emoji: readEmoji(skill.filePath),
	};
}

/**
 * Reject paths that escape the known skill roots — we don't want a
 * compromised view to pass `/etc/passwd` and have us reveal it in Finder.
 */
function isAllowedSkillPath(path: string): boolean {
	const target = resolve(path);
	if (!existsSync(target)) return false;
	const stats = statSync(target);
	if (!stats.isDirectory() && !stats.isFile()) return false;
	const bundled = getSkillsDir();
	const roots = [
		bundled,
		// agent-skills storage roots (mirror plugin-agent-skills/src/storage.ts)
		process.env.ELIZAOS_BUNDLED_SKILLS_DIR ?? "",
		process.env.HOME ? `${process.env.HOME}/.elizaos` : "",
		process.env.ELIZA_STATE_DIR ?? "",
	].filter(Boolean);
	return roots.some((root) => {
		const resolved = resolve(root);
		return target === resolved || target.startsWith(`${resolved}/`);
	});
}

export function skillsRequests(_deps: RpcDeps) {
	return {
		skillsList: async (): Promise<SkillsListResponse> => {
			let bundledDir: string | null = null;
			try {
				bundledDir = getSkillsDir();
			} catch {
				bundledDir = null;
			}
			let result;
			try {
				result = loadSkills();
			} catch (err) {
				console.warn("[skills-rpc] loadSkills failed:", err instanceof Error ? err.message : err);
				return { bundledDir, skills: [] };
			}
			const skills = (result.skills as Skill[])
				.map(toSummary)
				.sort((a, b) => a.name.localeCompare(b.name));
			return { bundledDir, skills };
		},

		skillsOpenDir: async (params: { path: string }): Promise<{ ok: true }> => {
			if (typeof params.path !== "string" || !isAllowedSkillPath(params.path)) {
				throw new Error("path is not inside a known skills root");
			}
			Utils.openPath(params.path);
			return { ok: true };
		},
	};
}
