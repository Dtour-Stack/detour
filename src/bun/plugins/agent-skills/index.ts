/**
 * Agent-skills plugin — gives the agent access to the @elizaos/skills
 * library of curated procedural references.
 *
 * Skills shipped with this plugin (from `eliza/packages/skills/skills/`):
 *   - elizaos                    : runtime concepts overview
 *   - eliza-app-development      : building elizaOS-based apps
 *   - build-monetized-app        : monetization patterns
 *   - coding-agent               : driving Codex/Claude/OpenCode CLIs via PTY
 *   - eliza-cloud-buy-domain     : domain registration through Eliza Cloud
 *   - eliza-cloud-manage-domain  : DNS / domain ops via Eliza Cloud
 *
 * Wire model:
 *   - Provider AGENT_SKILL_CATALOG (position -45) renders a one-line
 *     name+description for each enabled skill on every turn. Total
 *     budget is small (~6 lines for ~6 skills) so the planner sees
 *     them without blowing token spend.
 *   - Action SKILL_LOAD takes a skill name and returns the full
 *     markdown body, so the agent reads detailed steps on demand
 *     instead of carrying every word on every turn.
 *
 * Adding a new skill: drop it under `eliza/packages/skills/skills/`
 * and add its name to ENABLED_SKILLS below. The loader auto-validates
 * frontmatter + name match.
 */

import { readFileSync } from "node:fs";
import type { Action, ActionResult, Handler, IAgentRuntime, Plugin, Provider, ProviderResult, State, Memory } from "@elizaos/core";
import { getSkillsDir, loadSkillsFromDir, stripFrontmatter, type Skill } from "@elizaos/skills";

/** Names of skills the detour agent should expose. Matches dir name
 * under `<skillsRoot>/skills/<name>/SKILL.md`. */
const ENABLED_SKILLS = [
	"elizaos",
	"eliza-app-development",
	"build-monetized-app",
	"coding-agent",
	"eliza-cloud-buy-domain",
	"eliza-cloud-manage-domain",
] as const;

type SkillName = typeof ENABLED_SKILLS[number] | string;

let cachedSkills: Map<string, Skill> | null = null;

function loadCatalog(): Map<string, Skill> {
	if (cachedSkills) return cachedSkills;
	const out = new Map<string, Skill>();
	try {
		// getSkillsDir() is the bundled skills root (…/packages/skills/skills),
		// not the package root — do not append "/skills" again.
		const skillsDir = getSkillsDir();
		const result = loadSkillsFromDir({ dir: skillsDir, source: "bundled" });
		for (const skill of result.skills) {
			if (ENABLED_SKILLS.includes(skill.name as typeof ENABLED_SKILLS[number])) {
				out.set(skill.name, skill);
			}
		}
		if (out.size === 0 && result.diagnostics.length > 0) {
			const summary = result.diagnostics.slice(0, 3).map((d) => `${d.type}: ${d.message}`).join("; ");
			console.warn(`[agent-skills] no enabled skills loaded; ${result.diagnostics.length} diagnostic(s): ${summary}`);
		}
	} catch (err) {
		console.warn(`[agent-skills] loadSkillsFromDir failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	cachedSkills = out;
	return out;
}

function trimDesc(s: string | undefined | null, max = 180): string {
	if (!s) return "";
	const single = s.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

// ── AGENT_SKILL_CATALOG provider ───────────────────────────────────────

function renderCatalog(skills: Map<string, Skill>): string {
	if (skills.size === 0) return "";
	const lines: string[] = [];
	lines.push("# Skills available");
	lines.push("");
	lines.push("Curated procedural references. Each is a step-by-step guide for a specific task. To read a skill in full before acting on it, call SKILL_LOAD with its name.");
	lines.push("");
	const ordered = Array.from(skills.values()).sort((a, b) => a.name.localeCompare(b.name));
	for (const s of ordered) {
		lines.push(`- **${s.name}** — ${trimDesc(s.description)}`);
	}
	return lines.join("\n");
}

export const skillCatalogProvider: Provider = {
	name: "AGENT_SKILL_CATALOG",
	description: "List of curated procedural skills the agent can load on demand via SKILL_LOAD.",
	descriptionCompressed: "skill catalog (load on demand).",
	position: -45,
	get: async (_runtime: IAgentRuntime, _m: Memory, _s: State): Promise<ProviderResult> => {
		const skills = loadCatalog();
		return {
			text: renderCatalog(skills),
			values: { skillCount: skills.size },
		};
	},
};

// ── SKILL_LOAD action ──────────────────────────────────────────────────

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
	}
	return undefined;
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

function caller(runtime: IAgentRuntime): string {
	return runtime.character?.name ? `agent:${runtime.character.name}` : "agent";
}

const skillLoadHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const name = pickString(opts, ["name", "skill", "id"]);
	if (!name) return fail("SKILL_LOAD requires `name` (e.g. \"coding-agent\", \"elizaos\").");
	const skills = loadCatalog();
	const skill = skills.get(name);
	if (!skill) {
		const available = Array.from(skills.keys()).join(", ");
		return fail(`Skill "${name}" not found. Available: ${available || "(none)"}`);
	}
	let body = skill.instructions ?? "";
	if (!body && skill.filePath) {
		try {
			body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
		} catch (err) {
			return fail(`Failed to read skill file: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const summary = `# ${skill.name}\n\n${body}`;
	await emit(callback, `Loaded skill "${skill.name}".`, "SKILL_LOAD");
	return ok(summary, {
		caller: caller(runtime),
		name: skill.name,
		body,
		description: skill.description,
	});
};

export const skillLoadAction: Action = {
	name: "SKILL_LOAD",
	similes: ["LOAD_SKILL", "READ_SKILL", "FETCH_SKILL"],
	description:
		"Load the full body of a curated skill so you can read detailed steps before acting. Required: `name` (must match one of the entries in AGENT_SKILL_CATALOG — e.g. \"coding-agent\", \"elizaos\", \"eliza-cloud-buy-domain\"). Returns the full markdown. Use BEFORE attempting a domain-specific multi-step task: load the skill, then follow its instructions.",
	validate: async () => true,
	handler: skillLoadHandler,
	examples: [],
	parameters: [
		{ name: "name", description: "Skill name (kebab-case, must match catalog entry).", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── Plugin export ──────────────────────────────────────────────────────

export const agentSkillsPlugin: Plugin = {
	name: "agent-skills",
	description:
		"Curated procedural skills from @elizaos/skills. Provider AGENT_SKILL_CATALOG lists names + descriptions on every turn; action SKILL_LOAD fetches the full body of a named skill on demand. Enabled skills: elizaos (runtime concepts), eliza-app-development (building eliza apps), build-monetized-app (monetization patterns), coding-agent (driving Codex/Claude/OpenCode/Pi CLIs via PTY), eliza-cloud-buy-domain, eliza-cloud-manage-domain.",
	providers: [skillCatalogProvider],
	actions: [skillLoadAction],
};
