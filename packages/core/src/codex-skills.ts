import {
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	Plugin,
	Provider,
} from "@elizaos/core";
import type { ChatCommandInfo } from "@detour/shared";

export type CodexSkillSummary = {
	name: string;
	command: string;
	aliases: string[];
	description: string;
	filePath: string;
	source: "codex" | "agents";
};

type SkillFrontmatter = {
	name?: string;
	description?: string;
	userInvocable?: boolean;
	disableModelInvocation?: boolean;
};

const ACTION_SKILLS_LIST = "CODEX_SKILLS_LIST";
const ACTION_SKILL_READ = "CODEX_SKILL_READ";
const MAX_SKILL_PROMPT_CHARS = 36_000;
const RESERVED_COMMANDS = new Set([
	"help",
	"commands",
	"skills",
	"skill",
	"browser",
	"open",
	"web",
	"internet",
	"logins",
	"passwords",
	"inspect",
	"read-page",
	"script",
	"js",
	"login",
	"fill-login",
	"1password",
	"op",
	"pet",
	"hatch",
]);

function codexHome(): string {
	const value = process.env.CODEX_HOME?.trim();
	return value ? resolve(value) : join(homedir(), ".codex");
}

function skillRoots(): Array<{ dir: string; source: CodexSkillSummary["source"] }> {
	return [
		{ dir: join(codexHome(), "skills"), source: "codex" },
		{ dir: join(homedir(), ".agents", "skills"), source: "agents" },
	];
}

function findSkillFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findSkillFiles(path));
		} else if (entry.isFile() && entry.name === "SKILL.md") {
			out.push(path);
		}
	}
	return out;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function readFrontmatter(raw: string): SkillFrontmatter {
	if (!raw.startsWith("---")) return {};
	const end = raw.indexOf("\n---", 3);
	if (end < 0) return {};
	const block = raw.slice(3, end).trim();
	const frontmatter: SkillFrontmatter = {};
	for (const line of block.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1]?.trim().toLowerCase();
		const value = unquote(match[2] ?? "");
		if (key === "name" && value) frontmatter.name = value;
		if (key === "description" && value) frontmatter.description = value;
		if (key === "user-invocable" || key === "user_invocable") {
			frontmatter.userInvocable = value.toLowerCase() !== "false";
		}
		if (key === "disable-model-invocation" || key === "disable_model_invocation") {
			frontmatter.disableModelInvocation = value.toLowerCase() === "true";
		}
	}
	return frontmatter;
}

function fallbackDescription(raw: string, path: string): string {
	const withoutFrontmatter = raw.startsWith("---")
		? raw.slice(Math.max(0, raw.indexOf("\n---", 3) + 4))
		: raw;
	const first = withoutFrontmatter
		.split(/\r?\n/)
		.map((line) => line.replace(/^#+\s*/, "").trim())
		.find((line) => line.length > 0);
	return first ?? basename(dirname(path));
}

function commandName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_ -]+/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function underscoredCommand(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
}

function uniqueCommand(base: string, used: Set<string>): string {
	const clean = base || "skill";
	if (!used.has(clean)) return clean;
	for (let index = 2; index < 1000; index += 1) {
		const suffix = `-${index}`;
		const candidate = `${clean.slice(0, 64 - suffix.length)}${suffix}`;
		if (!used.has(candidate)) return candidate;
	}
	return `${clean.slice(0, 62)}-x`;
}

function readSkill(path: string, source: CodexSkillSummary["source"]): CodexSkillSummary | null {
	const raw = readFileSync(path, "utf8");
	const frontmatter = readFrontmatter(raw);
	if (frontmatter.userInvocable === false) return null;
	const fallbackName = basename(dirname(path));
	const name = frontmatter.name?.trim() || fallbackName;
	const primary = commandName(name);
	const underscore = underscoredCommand(name);
	const aliases = [underscore, name.toLowerCase()].filter(
		(alias, index, values) =>
			alias.length > 0 && alias !== primary && values.indexOf(alias) === index,
	);
	return {
		name,
		command: primary,
		aliases,
		description: frontmatter.description?.trim() || fallbackDescription(raw, path),
		filePath: path,
		source,
	};
}

export function listCodexSkills(): CodexSkillSummary[] {
	const byName = new Map<string, CodexSkillSummary>();
	const usedCommands = new Set(RESERVED_COMMANDS);
	for (const root of skillRoots()) {
		for (const path of findSkillFiles(root.dir)) {
			if (!statSync(path).isFile()) continue;
			const skill = readSkill(path, root.source);
			if (!skill) continue;
			const key = skill.name.toLowerCase();
			if (byName.has(key)) continue;
			const command = uniqueCommand(skill.command, usedCommands);
			usedCommands.add(command);
			byName.set(key, { ...skill, command });
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findCodexSkill(commandOrName: string): CodexSkillSummary | null {
	const target = commandOrName.trim().replace(/^\//, "").toLowerCase();
	if (!target) return null;
	return listCodexSkills().find((skill) => {
		const names = [skill.command, skill.name.toLowerCase(), ...skill.aliases];
		return names.some((name) => name.toLowerCase() === target);
	}) ?? null;
}

export function codexSkillChatCommands(): ChatCommandInfo[] {
	return [
		{
			name: "/skills",
			usage: "/skills",
			description: "List available Codex skills.",
			insert: "/skills",
			source: "native",
		},
		{
			name: "/skill",
			usage: "/skill <name> <task>",
			description: "Invoke a Codex skill by name.",
			insert: "/skill ",
			source: "native",
		},
		...listCodexSkills().map((skill): ChatCommandInfo => ({
			name: `/${skill.command}`,
			usage: `/${skill.command} <task>`,
			description: skill.description,
			insert: `/${skill.command} `,
			aliases: skill.aliases.map((alias) => `/${alias}`),
			source: "skill",
		})),
	];
}

export function codexSkillsListText(): string {
	const skills = listCodexSkills();
	if (skills.length === 0) return "No Codex skills found.";
	return [
		`Available Codex skills (${skills.length}):`,
		...skills.map((skill) => `/${skill.command} - ${skill.description}`),
	].join("\n");
}

function skillBody(skill: CodexSkillSummary): string {
	const raw = readFileSync(skill.filePath, "utf8");
	if (raw.length <= MAX_SKILL_PROMPT_CHARS) return raw;
	return `${raw.slice(0, MAX_SKILL_PROMPT_CHARS)}\n\n[Skill file truncated. Continue by reading ${skill.filePath} before applying later sections.]`;
}

export function codexSkillInvocationPrompt(skill: CodexSkillSummary, request: string): string {
	const task = request.trim() || "Apply this skill to the current request.";
	return [
		`The user invoked the Codex skill /${skill.command}.`,
		`Skill name: ${skill.name}`,
		`Skill path: ${skill.filePath}`,
		`User task: ${task}`,
		"",
		"Follow this SKILL.md exactly for this turn. If it references relative files, resolve them from the skill directory.",
		"",
		"```markdown",
		skillBody(skill),
		"```",
	].join("\n");
}

function optionString(options: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	const params = options?.parameters;
	const sources = [
		params && typeof params === "object" && !Array.isArray(params)
			? params as Record<string, unknown>
			: undefined,
		options,
	];
	for (const source of sources) {
		if (!source) continue;
		for (const key of keys) {
			const value = source[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return undefined;
}

async function emit(callback: HandlerCallback | undefined, text: string, actionName: string): Promise<void> {
	if (!callback) return;
	await callback({ text, action: actionName }, actionName);
}

function ok(text: string, data?: Record<string, string | number>): ActionResult {
	return { success: true, text, ...(data ? { data } : {}) };
}

function fail(text: string): ActionResult {
	return { success: false, text, error: text };
}

const skillsListHandler: Handler = async (_runtime, _message, _state, _options, callback) => {
	const text = codexSkillsListText();
	await emit(callback, text, ACTION_SKILLS_LIST);
	return ok(text, { skillCount: listCodexSkills().length });
};

const skillReadHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const name = optionString(opts, ["name", "skill", "command"]);
	if (!name) {
		const text = "CODEX_SKILL_READ requires a skill name.";
		await emit(callback, text, ACTION_SKILL_READ);
		return fail(text);
	}
	const skill = findCodexSkill(name);
	if (!skill) {
		const text = `No Codex skill matched "${name}".`;
		await emit(callback, text, ACTION_SKILL_READ);
		return fail(text);
	}
	const text = codexSkillInvocationPrompt(skill, optionString(opts, ["task", "request", "prompt"]) ?? "");
	await emit(callback, text, ACTION_SKILL_READ);
	return ok(text, { skill: skill.name, path: skill.filePath });
};

export const codexSkillsProvider: Provider = {
	name: "CODEX_SKILLS",
	description: "Available Codex SKILL.md workflows and slash invocations.",
	dynamic: true,
	position: -15,
	get: async () => {
		const skills = listCodexSkills();
		const text = skills.length === 0
			? ""
			: [
					"# Codex Skills",
					"Users may invoke skills with /skill-name, /skill <name>, or by asking for a task matching a skill description.",
					"For a matching skill, call CODEX_SKILL_READ with the skill name and user task, then follow the loaded SKILL.md.",
					...skills.map((skill) => `- /${skill.command}: ${skill.description} (${skill.filePath})`),
				].join("\n");
		return {
			text,
			values: { codexSkillCount: skills.length },
			data: { skills },
		};
	},
};

export const codexSkillsListAction: Action = {
	name: ACTION_SKILLS_LIST,
	similes: ["SKILLS", "/skills", "LIST_CODEX_SKILLS", "SHOW_CODEX_SKILLS"],
	description: "List available Codex SKILL.md workflows and their slash commands.",
	validate: async () => true,
	handler: skillsListHandler,
	suppressPostActionContinuation: true,
	examples: [],
	parameters: [],
};

export const codexSkillReadAction: Action = {
	name: ACTION_SKILL_READ,
	similes: ["SKILL", "/skill", "READ_CODEX_SKILL", "LOAD_CODEX_SKILL", "USE_CODEX_SKILL"],
	description: "Load a Codex SKILL.md workflow by name before following it for a user task.",
	validate: async () => true,
	handler: skillReadHandler,
	examples: [],
	parameters: [
		{
			name: "name",
			description: "Codex skill name or slash command.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "task",
			description: "User task to apply the skill to.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	contexts: ["general"],
};

export const codexSkillsPlugin: Plugin = {
	name: "codex-skills",
	description: "Loads Codex SKILL.md workflows and exposes them as agent skills plus slash commands.",
	actions: [codexSkillsListAction, codexSkillReadAction],
	providers: [codexSkillsProvider],
};
