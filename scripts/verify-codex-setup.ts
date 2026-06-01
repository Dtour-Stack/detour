import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

type Check = {
	name: string;
	ok: boolean;
	detail?: string;
};

const args = new Set(process.argv.slice(2));
const repoRoot = resolve(import.meta.dir, "..");

function isRecord(value: Json): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(path: string): string {
	return readFileSync(resolve(repoRoot, path), "utf8");
}

function readJson(path: string): Json | null {
	try {
		return JSON.parse(readText(path)) as Json;
	} catch {
		return null;
	}
}

function checkFile(path: string): Check {
	return { name: `${path} exists`, ok: existsSync(resolve(repoRoot, path)) };
}

function checkText(path: string, name: string, needles: string[]): Check {
	try {
		const text = readText(path);
		const missing = needles.filter((needle) => !text.includes(needle));
		return {
			name,
			ok: missing.length === 0,
			detail: missing.length === 0 ? undefined : `missing: ${missing.join(", ")}`,
		};
	} catch (err) {
		return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

function checkJsonArrayContains(path: string, key: string, expected: string[]): Check {
	const json = readJson(path);
	if (!isRecord(json)) return { name: `${path} ${key}`, ok: false, detail: "invalid JSON object" };
	const value = json[key];
	if (!Array.isArray(value)) return { name: `${path} ${key}`, ok: false, detail: "missing array" };
	const actual = value.filter((item): item is string => typeof item === "string");
	const missing = expected.filter((item) => !actual.includes(item));
	return {
		name: `${path} ${key}`,
		ok: missing.length === 0,
		detail: missing.length === 0 ? undefined : `missing: ${missing.join(", ")}`,
	};
}

function checkExecutable(path: string): Check {
	try {
		const mode = statSync(resolve(repoRoot, path)).mode;
		return { name: `${path} executable`, ok: (mode & 0o111) !== 0 };
	} catch (err) {
		return { name: `${path} executable`, ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

function run(command: string, params: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(command, params, {
		cwd: repoRoot,
		encoding: "utf8",
		env: process.env,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function checkGitHooksPath(): Check {
	const result = run("git", ["config", "--get", "core.hooksPath"]);
	const value = result.stdout.trim();
	return {
		name: "git core.hooksPath",
		ok: value === ".githooks" || resolve(repoRoot, value) === resolve(repoRoot, ".githooks"),
		detail: value ? `current: ${value}` : "not set",
	};
}

function checkXhawkSkillStatus(): Check {
	if (args.has("--skip-xh-status")) return { name: "XHawk skill status", ok: true, detail: "skipped" };
	const xh = existsSync("/Users/home/.local/bin/xh") ? "/Users/home/.local/bin/xh" : "xh";
	const result = run(xh, ["skill", "status"]);
	const output = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
	const agents = ["Claude Code", "Codex", "Cursor", "OpenCode"];
	const missing = agents.filter((agent) => !new RegExp(`${agent}\\s+installed`).test(output));
	return {
		name: "XHawk skill status",
		ok: result.status === 0 && missing.length === 0,
		detail: missing.length === 0 ? undefined : `not installed: ${missing.join(", ")}`,
	};
}

const checks: Check[] = [
	checkFile(".xhawk/settings.json"),
	checkJsonArrayContains(".xhawk/settings.json", "agents", ["claude", "codex", "cursor", "opencode", "copilot"]),
	checkText(".codex/config.toml", "Codex local config", ['sandbox_mode = "danger-full-access"', 'approval_policy = "never"']),
	checkText(".codex/hooks.json", "Codex prompt hook", ["UserPromptSubmit", "xh _memory-hook prompt-submit --agent codex"]),
	checkText(".claude/settings.local.json", "Claude hooks", ["xh _memory-hook prompt-submit --agent claude", "xh _memory-hook session-end --agent claude"]),
	checkText(".cursor/hooks.json", "Cursor hooks", ["xh _memory-hook prompt-submit --agent cursor", "xh _memory-hook session-end --agent cursor"]),
	checkText(".opencode/plugins/xh-hooks.js", "OpenCode prompt hook", ["xh _memory-hook prompt-submit", "--agent opencode"]),
	checkFile(".opencode/opencode.json"),
	checkFile(".opencode/antigravity.json"),
	checkExecutable(".githooks/pre-commit"),
	checkExecutable(".githooks/pre-push"),
	checkExecutable(".githooks/post-commit"),
	checkGitHooksPath(),
	checkXhawkSkillStatus(),
];

const failed = checks.filter((check) => !check.ok);

if (!args.has("--hook")) {
	for (const check of checks) {
		const prefix = check.ok ? "ok" : "fail";
		const detail = check.detail ? ` (${check.detail})` : "";
		console.log(`${prefix} ${check.name}${detail}`);
	}
}

if (failed.length > 0) {
	for (const check of failed) {
		const detail = check.detail ? `: ${check.detail}` : "";
		console.error(`agent setup check failed: ${check.name}${detail}`);
	}
	process.exit(1);
}

if (!args.has("--hook")) console.log("Detour agent setup OK");
