import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	IAgentRuntime,
	Plugin,
} from "@elizaos/core";

type ProcessRun = {
	command: string;
	args: string[];
	cwd: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
};

type AgentProvider = "acpx" | "codex" | "claude";
type AgentStatus = "running" | "completed" | "failed" | "stopped";

type AgentRecord = {
	id: string;
	provider: AgentProvider;
	agentType: string;
	task: string;
	cwd: string;
	status: AgentStatus;
	command: string;
	args: string[];
	logPath: string;
	previewUrl?: string;
	publicUrl?: string;
	publicUrlProvider?: "ngrok";
	publicUrlPid?: number;
	publicUrlStartedAt?: number;
	publicUrlError?: string;
	startedAt: number;
	pid?: number;
	exitCode?: number | null;
	signal?: string | null;
	endedAt?: number;
	credentialAttempt?: number;
};

type CredentialAttempt = {
	env: NodeJS.ProcessEnv;
	index: number;
	total: number;
};

type CredentialAttempts = [CredentialAttempt, ...CredentialAttempt[]];

type AuditEvent = {
	action: string;
	command?: string;
	args?: string[];
	cwd?: string;
	agentId?: string;
	tunnelId?: string;
	provider?: string;
	agentType?: string;
	publicUrl?: string;
	localUrl?: string;
	exitCode?: number | null;
	signal?: string | null;
	timedOut?: boolean;
	durationMs?: number;
	success: boolean;
	error?: string;
	caller: string;
	ts: number;
};

const DEFAULT_MAX_OUTPUT = 20_000;
const WORKSPACE_AUDIT_FILE = `${homedir()}/.eliza/audit/agent-workspace-actions.jsonl`;
const AGENT_WORKSPACE_ROOT = join(homedir(), ".detour", "workspace");
const AGENT_PROJECTS_DIR = join(AGENT_WORKSPACE_ROOT, "projects");
const AGENT_STATE_DIR = `${homedir()}/.detour/workspace-agents`;
const AGENT_STATE_FILE = join(AGENT_STATE_DIR, "sessions.json");
const AGENT_TMP_DIR = join(AGENT_WORKSPACE_ROOT, ".tmp");
const AGENT_CACHE_DIR = join(AGENT_WORKSPACE_ROOT, ".cache");
const AGENT_BUN_CACHE_DIR = join(AGENT_CACHE_DIR, "bun");
const PREVIEW_URL_PATTERN =
	/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s\\"'<>),\]}]*)?/gi;
const NGROK_URL_PATTERN =
	/https:\/\/[a-z0-9.-]+\.ngrok(?:-free)?\.app(?:\/[^\s\\"'<>),\]}]*)?/i;
const CLAUDE_KEY_LIST_NAMES = ["ANTHROPIC_API_KEYS", "CLAUDE_API_KEYS"] as const;
const CLAUDE_SINGLE_KEY_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] as const;
const CLAUDE_NUMBERED_KEY_PREFIXES = ["ANTHROPIC_API_KEY_", "CLAUDE_API_KEY_"] as const;

function caller(runtime: IAgentRuntime): string {
	return `agent:${runtime.character?.name ?? "unknown"}`;
}

function paramsBag(options: Record<string, unknown> | undefined): Record<string, unknown> {
	const params = options?.parameters;
	return params && typeof params === "object" && !Array.isArray(params)
		? params as Record<string, unknown>
		: {};
}

function stringOption(options: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	const params = paramsBag(options);
	for (const source of [params, options]) {
		if (!source) continue;
		for (const key of keys) {
			const value = source[key];
			if (typeof value === "string" && value.trim().length > 0) return value.trim();
		}
	}
	return undefined;
}

function boolOption(options: Record<string, unknown> | undefined, keys: readonly string[], fallback: boolean): boolean {
	const params = paramsBag(options);
	for (const source of [params, options]) {
		if (!source) continue;
		for (const key of keys) {
			const value = source[key];
			if (typeof value === "boolean") return value;
			if (value === "true") return true;
			if (value === "false") return false;
		}
	}
	return fallback;
}

function numberOption(options: Record<string, unknown> | undefined, keys: readonly string[], fallback: number): number {
	const params = paramsBag(options);
	for (const source of [params, options]) {
		if (!source) continue;
		for (const key of keys) {
			const value = source[key];
			if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
			if (typeof value === "string" && value.trim().length > 0) {
				const parsed = Number.parseInt(value, 10);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
	}
	return fallback;
}

function workspaceRoot(): string {
	const root = process.env.DETOUR_AGENT_WORKSPACE_ROOT;
	const resolved = typeof root === "string" && root.length > 0 && !isAppBundlePath(root)
		? resolve(root)
		: AGENT_PROJECTS_DIR;
	mkdirSync(resolved, { recursive: true });
	return resolved;
}

function isAppBundlePath(value: string): boolean {
	return /\/[^/]+\.app\/Contents(?:\/|$)/.test(resolve(value));
}

function projectSlug(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 56);
	return slug || "project";
}

function defaultProjectName(task: string, id: string): string {
	return `${projectSlug(task).slice(0, 48)}-${id.slice(0, 8)}`;
}

function resolveCwd(cwd: string | undefined, projectSeed: string): string {
	const requested = cwd && !isAppBundlePath(cwd) ? cwd : undefined;
	const resolved = requested
		? isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot(), requested)
		: resolve(workspaceRoot(), projectSlug(projectSeed));
	mkdirSync(resolved, { recursive: true });
	return resolved;
}

function truncateMiddle(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	const head = Math.floor(maxLength * 0.65);
	const tail = Math.max(0, maxLength - head - 80);
	return `${text.slice(0, head)}\n\n[output truncated: ${text.length - maxLength} chars omitted]\n\n${text.slice(text.length - tail)}`;
}

function executablePath(command: string): string | null {
	const checker = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(checker, [command], { encoding: "utf8" });
	if (result.status === 0) return result.stdout.trim().split(/\r?\n/)[0] ?? command;
	for (const root of [workspaceRoot(), resolve(workspaceRoot(), ".."), process.cwd()]) {
		const candidate = join(root, "node_modules", ".bin", process.platform === "win32" ? `${command}.cmd` : command);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function workspaceAgentEnv(): NodeJS.ProcessEnv {
	mkdirSync(AGENT_WORKSPACE_ROOT, { recursive: true });
	mkdirSync(AGENT_PROJECTS_DIR, { recursive: true });
	mkdirSync(AGENT_TMP_DIR, { recursive: true });
	mkdirSync(AGENT_CACHE_DIR, { recursive: true });
	mkdirSync(AGENT_BUN_CACHE_DIR, { recursive: true });
	const githubToken = process.env.GITHUB_AGENT_PAT ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_USER_PAT;
	const ngrokPath = executablePath("ngrok");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		DETOUR_WORKSPACE_ROOT: workspaceRoot(),
		TMPDIR: AGENT_TMP_DIR,
		TMP: AGENT_TMP_DIR,
		TEMP: AGENT_TMP_DIR,
		XDG_CACHE_HOME: AGENT_CACHE_DIR,
		BUN_INSTALL_CACHE_DIR: AGENT_BUN_CACHE_DIR,
	};
	if (ngrokPath) {
		env.NGROK_BIN = ngrokPath;
		env.PATH = `${dirname(ngrokPath)}:${env.PATH ?? ""}`;
	}
	if (githubToken) {
		env.GITHUB_TOKEN = githubToken;
		env.GH_TOKEN = process.env.GH_TOKEN ?? githubToken;
	}
	return env;
}

function parseKeyList(raw: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid Claude key list JSON: ${message}`);
		}
		if (!Array.isArray(parsed)) throw new Error("Claude key list JSON must be an array.");
		return parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
	}
	return trimmed.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function numberedEnvKeyValue(prefix: string, index: number): string | undefined {
	return process.env[`${prefix}${index}`];
}

function claudeApiKeys(): string[] {
	const values: string[] = [];
	for (const key of CLAUDE_SINGLE_KEY_NAMES) {
		const value = process.env[key];
		if (value?.trim()) values.push(value.trim());
	}
	for (const key of CLAUDE_KEY_LIST_NAMES) {
		const value = process.env[key];
		if (value?.trim()) values.push(...parseKeyList(value));
	}
	for (const prefix of CLAUDE_NUMBERED_KEY_PREFIXES) {
		for (let index = 1; index <= 50; index += 1) {
			const value = numberedEnvKeyValue(prefix, index);
			if (value?.trim()) values.push(value.trim());
		}
	}
	return [...new Set(values)];
}

function commandUsesClaude(input: { provider: AgentProvider; agentType: string }): boolean {
	return input.provider === "claude" || input.agentType.toLowerCase() === "claude";
}

function envForCredentialAttempt(base: NodeJS.ProcessEnv, key: string | undefined): NodeJS.ProcessEnv {
	if (!key) return base;
	return {
		...base,
		ANTHROPIC_API_KEY: key,
		CLAUDE_API_KEY: key,
	};
}

function credentialAttempts(input: { provider: AgentProvider; agentType: string }): CredentialAttempts {
	const base = workspaceAgentEnv();
	if (!commandUsesClaude(input)) return [{ env: base, index: 1, total: 1 }];
	const keys = claudeApiKeys();
	if (keys.length === 0) return [{ env: base, index: 1, total: 1 }];
	const [first, ...rest] = keys;
	return [
		{ env: envForCredentialAttempt(base, first), index: 1, total: keys.length },
		...rest.map((key, index) => ({ env: envForCredentialAttempt(base, key), index: index + 2, total: keys.length })),
	];
}

function isCredentialFailure(text: string): boolean {
	return /authentication_error|authentication failed|invalid authentication credentials|invalid api key|credit balance is too low|rate[_ -]?limit|overloaded|quota|429|401/i.test(text);
}

function shouldRetryCredentialFailure(result: ProcessRun, attempts: CredentialAttempts, attemptIndex: number): boolean {
	return result.exitCode !== 0
		&& attemptIndex + 1 < attempts.length
		&& isCredentialFailure(`${result.stderr}\n${result.stdout}`);
}

function writeAudit(event: AuditEvent): void {
	mkdirSync(`${homedir()}/.eliza/audit`, { recursive: true });
	appendFileSync(WORKSPACE_AUDIT_FILE, `${JSON.stringify(event)}\n`);
}

function readAgents(): AgentRecord[] {
	if (!existsSync(AGENT_STATE_FILE)) return [];
	const parsed = JSON.parse(readFileSync(AGENT_STATE_FILE, "utf8")) as { agents?: AgentRecord[] };
	if (!Array.isArray(parsed.agents)) return [];
	return parsed.agents;
}

function writeAgents(agents: AgentRecord[]): void {
	mkdirSync(AGENT_STATE_DIR, { recursive: true });
	writeFileSync(AGENT_STATE_FILE, JSON.stringify({ agents }, null, 2));
}

function upsertAgent(record: AgentRecord): void {
	const agents = readAgents();
	const index = agents.findIndex((agent) => agent.id === record.id);
	if (index >= 0) agents[index] = record;
	else agents.unshift(record);
	writeAgents(agents.slice(0, 200));
}

function updateAgent(id: string, patch: Partial<AgentRecord>): AgentRecord | null {
	const agents = readAgents();
	const index = agents.findIndex((agent) => agent.id === id);
	if (index < 0) return null;
	const updated = { ...agents[index], ...patch };
	agents[index] = updated;
	writeAgents(agents);
	return updated;
}

function pidIsRunning(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function refreshedAgents(): AgentRecord[] {
	const agents = readAgents();
	let changed = false;
	const next = agents.map((agent) => {
		if (agent.status !== "running") return agent;
		if (pidIsRunning(agent.pid)) return agent;
		changed = true;
		return {
			...agent,
			status: "failed" as AgentStatus,
			endedAt: Date.now(),
			signal: agent.signal ?? "missing-process",
		};
	});
	if (changed) writeAgents(next);
	return next;
}

async function emit(callback: HandlerCallback | undefined, text: string, actionName: string): Promise<void> {
	if (!callback) return;
	await callback({ text, source: "workspace-tools" } as never, actionName);
}

function fail(text: string): ActionResult {
	return { success: false, text, error: text };
}

function ok(text: string, values: Record<string, unknown>): ActionResult {
	return { success: true, text, values: values as never };
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = workspaceAgentEnv()): Promise<ProcessRun> {
	const started = Date.now();
	const child = spawn(command, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, timeoutMs);
	return new Promise<ProcessRun>((resolveRun, rejectRun) => {
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			rejectRun(error);
		});
		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			resolveRun({
				command,
				args,
				cwd,
				exitCode,
				signal,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				durationMs: Date.now() - started,
				timedOut,
			});
		});
	});
}

function processSummary(result: ProcessRun, maxOutput: number): string {
	const stdout = truncateMiddle(result.stdout.trim(), maxOutput);
	const stderr = truncateMiddle(result.stderr.trim(), maxOutput);
	return [
		`Command: ${result.command} ${result.args.join(" ")}`,
		`CWD: ${result.cwd}`,
		`Exit: ${result.exitCode}${result.signal ? ` signal=${result.signal}` : ""}${result.timedOut ? " timed_out=true" : ""}`,
		`Duration: ${result.durationMs}ms`,
		stdout ? `STDOUT:\n${stdout}` : "",
		stderr ? `STDERR:\n${stderr}` : "",
	].filter((line) => line.length > 0).join("\n");
}

function messageText(message: { content?: { text?: unknown } } | undefined): string | undefined {
	const text = message?.content?.text;
	return typeof text === "string" && text.trim().length > 0 ? text.trim() : undefined;
}

function providerOption(opts: Record<string, unknown> | undefined): AgentProvider | undefined {
	const value = stringOption(opts, ["provider", "agentProvider", "transport"]);
	if (value === "acpx" || value === "codex" || value === "claude") return value;
	return undefined;
}

function previewUrlOption(opts: Record<string, unknown> | undefined): string | undefined {
	const value = stringOption(opts, ["previewUrl", "previewURL", "preview"]);
	if (!value) return undefined;
	return normalizeHttpUrl(value);
}

function normalizeHttpUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function previewUrlFromLog(logPath: string): string | undefined {
	if (!existsSync(logPath)) return undefined;
	const text = readFileSync(logPath, "utf8");
	for (const match of text.matchAll(PREVIEW_URL_PATTERN)) {
		const url = normalizeHttpUrl(match[0]);
		if (url) return url;
	}
	return undefined;
}

function ngrokUrlFromText(text: string): string | undefined {
	const match = text.match(NGROK_URL_PATTERN);
	return match ? match[0] : undefined;
}

function ngrokTarget(previewUrl: string): string {
	const url = new URL(previewUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Cannot share non-HTTP preview URL: ${previewUrl}`);
	}
	return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

function resolveProvider(opts: Record<string, unknown> | undefined): AgentProvider {
	const requested = providerOption(opts);
	if (requested) return requested;
	if (executablePath("acpx")) return "acpx";
	if (executablePath("codex")) return "codex";
	return "claude";
}

function providerCommand(provider: AgentProvider): string | null {
	return executablePath(provider === "acpx" ? "acpx" : provider);
}

function agentTypeFor(provider: AgentProvider, opts: Record<string, unknown> | undefined): string {
	const explicit = stringOption(opts, ["agentType", "agent", "type"]);
	if (explicit) return explicit;
	if (provider === "claude") return "claude";
	return "codex";
}

function approvalMode(opts: Record<string, unknown> | undefined): string {
	return stringOption(opts, ["approvalPreset", "approval", "permissionMode", "permissions"]) ?? "autonomous";
}

function buildAgentCommand(input: {
	provider: AgentProvider;
	agentType: string;
	task: string;
	cwd: string;
	approval: string;
	sessionId?: string;
}): { command: string; args: string[] } {
	const command = providerCommand(input.provider);
	if (!command) throw new Error(`${input.provider} is not installed or not on PATH.`);
	if (input.provider === "acpx") {
		const permission = input.approval === "read-only" || input.approval === "readonly"
			? "--deny-all"
			: input.approval === "standard"
				? "--approve-reads"
				: "--approve-all";
		const sessionArgs = input.sessionId
			? [input.agentType, "-s", input.sessionId, input.task]
			: [input.agentType, "exec", input.task];
		return { command, args: ["--format", "json", "--cwd", input.cwd, permission, ...sessionArgs] };
	}
	if (input.provider === "claude") {
		const args = ["--print", "--output-format", "stream-json"];
		if (input.approval !== "read-only" && input.approval !== "readonly") {
			args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
		}
		args.push(input.task);
		return { command, args };
	}
	const args = ["exec", "--json", "--cd", input.cwd];
	if (input.approval === "read-only" || input.approval === "readonly") args.push("--sandbox", "read-only");
	else args.push("--dangerously-bypass-approvals-and-sandbox");
	args.push(input.task);
	return { command, args };
}

function spawnAgentAttempt(record: AgentRecord, attempts: CredentialAttempts, attemptIndex: number): AgentRecord {
	mkdirSync(AGENT_STATE_DIR, { recursive: true });
	upsertAgent(record);
	const stream = createWriteStream(record.logPath, { flags: "a" });
	const attempt = attempts[attemptIndex] ?? attempts[0];
	if (attempt.total > 1) stream.write(`\n[credential_attempt] ${attempt.index}/${attempt.total}\n`);
	const child = spawn(record.command, record.args, {
		cwd: record.cwd,
		env: attempt.env,
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	const next: AgentRecord = { ...record, pid: child.pid, credentialAttempt: attempt.index };
	upsertAgent(next);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.stdout.pipe(stream);
	child.stderr.pipe(stream);
	child.on("error", (error) => {
		stream.write(`\n[spawn_error] ${error instanceof Error ? error.message : String(error)}\n`);
		updateAgent(record.id, { status: "failed", endedAt: Date.now(), signal: "spawn-error" });
		stream.end();
	});
	child.on("close", (exitCode, signal) => {
		const stdoutText = Buffer.concat(stdout).toString("utf8");
		const stderrText = Buffer.concat(stderr).toString("utf8");
		const canRetry = exitCode !== 0 && attemptIndex + 1 < attempts.length && isCredentialFailure(`${stderrText}\n${stdoutText}`);
		if (canRetry) {
			stream.write(`\n[credential_retry] ${attempt.index}/${attempt.total} failed; rotating Claude key\n`);
			stream.end();
			spawnAgentAttempt(record, attempts, attemptIndex + 1);
			return;
		}
		updateAgent(record.id, {
			status: exitCode === 0 ? "completed" : "failed",
			exitCode,
			signal,
			endedAt: Date.now(),
			credentialAttempt: attempt.index,
		});
		stream.end();
	});
	return next;
}

function spawnAgentProcess(record: AgentRecord, attempts: CredentialAttempts): AgentRecord {
	return spawnAgentAttempt(record, attempts, 0);
}

function startNgrokShare(agent: AgentRecord, previewUrl: string, timeoutMs: number): Promise<AgentRecord> {
	const command = executablePath("ngrok");
	if (!command) throw new Error("ngrok is not installed or not on PATH.");
	const target = ngrokTarget(previewUrl);
	const logPath = join(AGENT_STATE_DIR, `${agent.id}.ngrok.log`);
	const stream = createWriteStream(logPath, { flags: "a" });
	const child = spawn(command, ["http", target, "--log=stdout", "--log-format=json"], {
		cwd: agent.cwd,
		env: workspaceAgentEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	child.unref();
	const startedAt = Date.now();
	updateAgent(agent.id, {
		publicUrlProvider: "ngrok",
		publicUrlPid: child.pid,
		publicUrlStartedAt: startedAt,
		publicUrlError: undefined,
	});
	return new Promise<AgentRecord>((resolveShare, rejectShare) => {
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const handleData = (chunk: Buffer): void => {
			const text = chunk.toString("utf8");
			stream.write(text);
			const publicUrl = ngrokUrlFromText(text);
			if (!publicUrl) return;
			finish(() => {
				const updated = updateAgent(agent.id, {
					previewUrl,
					publicUrl,
					publicUrlProvider: "ngrok",
					publicUrlPid: child.pid,
					publicUrlStartedAt: startedAt,
					publicUrlError: undefined,
				}) ?? { ...agent, previewUrl, publicUrl, publicUrlProvider: "ngrok", publicUrlPid: child.pid, publicUrlStartedAt: startedAt };
				resolveShare(updated);
			});
		};
		const timer = setTimeout(() => {
			finish(() => {
				const message = `Timed out waiting for ngrok URL for ${previewUrl}.`;
				updateAgent(agent.id, { publicUrlError: message });
				rejectShare(new Error(message));
			});
		}, timeoutMs);
		child.stdout.on("data", handleData);
		child.stderr.on("data", handleData);
		child.on("error", (error) => {
			finish(() => {
				const message = error instanceof Error ? error.message : String(error);
				updateAgent(agent.id, { publicUrlError: message });
				rejectShare(error);
			});
		});
		child.on("close", (exitCode, signal) => {
			stream.end();
			const message = `ngrok exited: code=${exitCode ?? "null"} signal=${signal ?? "null"}`;
			if (settled) {
				updateAgent(agent.id, { publicUrlError: message });
				return;
			}
			updateAgent(agent.id, { publicUrlError: message });
			finish(() => rejectShare(new Error(message)));
		});
	});
}

function formatProcessLog(record: AgentRecord, result: ProcessRun): string {
	return [
		record.credentialAttempt && record.credentialAttempt > 1
			? `[credential_attempt] ${record.credentialAttempt}\n`
			: "",
		`$ ${record.command} ${record.args.join(" ")}\n`,
		result.stdout,
		result.stderr ? `\n[stderr]\n${result.stderr}` : "",
		`\n[exit] code=${result.exitCode ?? "null"} signal=${result.signal ?? "null"} timedOut=${result.timedOut} durationMs=${result.durationMs}\n`,
	].join("");
}

function writeProcessLog(record: AgentRecord, result: ProcessRun): void {
	mkdirSync(AGENT_STATE_DIR, { recursive: true });
	writeFileSync(record.logPath, formatProcessLog(record, result));
}

function writeErrorLog(record: AgentRecord, errorText: string): void {
	mkdirSync(AGENT_STATE_DIR, { recursive: true });
	writeFileSync(
		record.logPath,
		`$ ${record.command} ${record.args.join(" ")}\n[error]\n${errorText}\n`,
	);
}

const spawnAgentHandler: Handler = async (runtime, message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const task = stringOption(opts, ["task", "prompt", "instructions", "text"]) ?? messageText(message);
	if (!task) return fail("SPAWN_AGENT requires `task`.");
	const provider = resolveProvider(opts);
	const agentType = agentTypeFor(provider, opts);
	const id = stringOption(opts, ["id", "sessionId", "session"]) ?? randomUUID();
	const projectName = stringOption(opts, ["project", "projectName", "workspace", "repoName"]);
	const cwd = resolveCwd(stringOption(opts, ["workdir", "cwd", "directory", "dir"]), projectName ?? defaultProjectName(task, id));
	const built = buildAgentCommand({ provider, agentType, task, cwd, approval: approvalMode(opts) });
	const previewUrl = previewUrlOption(opts);
	const attempts = credentialAttempts({ provider, agentType });
	const record = spawnAgentProcess({
		id,
		provider,
		agentType,
		task,
		cwd,
		status: "running",
		command: built.command,
		args: built.args,
		logPath: join(AGENT_STATE_DIR, `${id}.log`),
		...(previewUrl ? { previewUrl } : {}),
		startedAt: Date.now(),
	}, attempts);
	upsertAgent(record);
	writeAudit({
		action: "spawn_agent",
		agentId: id,
		provider,
		agentType,
		command: record.command,
		args: record.args,
		cwd,
		success: true,
		caller: caller(runtime),
		ts: Date.now(),
	});
	const text = `Spawned ${provider}/${agentType} session ${id}. Log: ${record.logPath}`;
	await emit(callback, text, "SPAWN_AGENT");
	return ok(text, { agent: record });
};

const createTaskHandler: Handler = async (runtime, message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const task = stringOption(opts, ["task", "prompt", "instructions", "text"]) ?? messageText(message);
	if (!task) return fail("CREATE_TASK requires `task`.");
	const provider = resolveProvider(opts);
	const agentType = agentTypeFor(provider, opts);
	const timeoutMs = Math.max(1_000, Math.min(30 * 60_000, numberOption(opts, ["timeoutMs", "timeout_ms", "timeout"], 30 * 60_000)));
	const maxOutput = Math.max(1_000, Math.min(200_000, numberOption(opts, ["maxOutput", "max_output", "maxOutputChars"], DEFAULT_MAX_OUTPUT)));
	const id = stringOption(opts, ["id", "taskId", "sessionId", "session"]) ?? randomUUID();
	const projectName = stringOption(opts, ["project", "projectName", "workspace", "repoName"]);
	const cwd = resolveCwd(stringOption(opts, ["workdir", "cwd", "directory", "dir"]), projectName ?? defaultProjectName(task, id));
	const built = buildAgentCommand({ provider, agentType, task, cwd, approval: approvalMode(opts) });
	const previewUrl = previewUrlOption(opts);
	const record: AgentRecord = {
		id,
		provider,
		agentType,
		task,
		cwd,
		status: "running",
		command: built.command,
		args: built.args,
		logPath: join(AGENT_STATE_DIR, `${id}.log`),
		...(previewUrl ? { previewUrl } : {}),
		startedAt: Date.now(),
	};
	upsertAgent(record);
	try {
		const attempts = credentialAttempts({ provider, agentType });
		const logs: string[] = [];
		for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
			const attempt = attempts[attemptIndex] ?? attempts[0];
			const attemptRecord: AgentRecord = { ...record, credentialAttempt: attempt.index };
			upsertAgent(attemptRecord);
			const result = await runProcess(built.command, built.args, cwd, timeoutMs, attempt.env);
			const success = result.exitCode === 0 && !result.timedOut;
			logs.push(formatProcessLog(attemptRecord, result));
			if (shouldRetryCredentialFailure(result, attempts, attemptIndex)) {
				logs.push(`[credential_retry] ${attempt.index}/${attempt.total} failed; rotating Claude key\n`);
				continue;
			}
			writeFileSync(record.logPath, logs.join("\n"));
			upsertAgent({
				...attemptRecord,
				status: success ? "completed" : "failed",
				exitCode: result.exitCode,
				signal: result.signal,
				endedAt: Date.now(),
			});
			writeAudit({
				action: "create_task",
				agentId: id,
				provider,
				agentType,
				command: result.command,
				args: result.args,
				cwd,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				durationMs: result.durationMs,
				success,
				caller: caller(runtime),
				ts: Date.now(),
			});
			const text = processSummary(result, maxOutput);
			await emit(callback, text, "CREATE_TASK");
			return ok(text, { result, provider, agentType, agent: { ...attemptRecord, status: success ? "completed" : "failed" } });
		}
		throw new Error("No credential attempts available.");
	} catch (error) {
		const errorText = error instanceof Error ? error.message : String(error);
		writeErrorLog(record, errorText);
		upsertAgent({
			...record,
			status: "failed",
			signal: "error",
			endedAt: Date.now(),
		});
		writeAudit({
			action: "create_task",
			agentId: id,
			provider,
			agentType,
			command: built.command,
			args: built.args,
			cwd,
			success: false,
			error: errorText,
			caller: caller(runtime),
			ts: Date.now(),
		});
		await emit(callback, `CREATE_TASK failed: ${errorText}`, "CREATE_TASK");
		return fail(`CREATE_TASK failed: ${errorText}`);
	}
};

const listAgentsHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const includeLogs = boolOption(opts, ["includeLogs", "logs"], false);
	const agents = refreshedAgents();
	const rows = agents.map((agent) => {
		const log = includeLogs && existsSync(agent.logPath)
			? `\n${truncateMiddle(readFileSync(agent.logPath, "utf8").trim(), DEFAULT_MAX_OUTPUT)}`
			: "";
		const publicUrl = agent.publicUrl ? ` publicUrl=${agent.publicUrl}` : "";
		return `${agent.id} ${agent.status} ${agent.provider}/${agent.agentType} cwd=${agent.cwd} log=${agent.logPath}${publicUrl}${log}`;
	});
	const text = rows.length > 0 ? rows.join("\n") : "No workspace agents recorded.";
	await emit(callback, text, "LIST_AGENTS");
	return ok(text, { agents });
};

const sendToAgentHandler: Handler = async (runtime, message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const id = stringOption(opts, ["id", "sessionId", "agentId", "agent"]);
	if (!id) return fail("SEND_TO_AGENT requires `id`.");
	const task = stringOption(opts, ["task", "prompt", "instructions", "text"]) ?? messageText(message);
	if (!task) return fail("SEND_TO_AGENT requires `task`.");
	const agents = refreshedAgents();
	const existing = agents.find((agent) => agent.id === id);
	if (!existing) return fail(`No workspace agent found for ${id}.`);
	const built = buildAgentCommand({
		provider: existing.provider,
		agentType: existing.agentType,
		task,
		cwd: existing.cwd,
		approval: approvalMode(opts),
		sessionId: existing.provider === "acpx" ? id : undefined,
	});
	const childId = randomUUID();
	const previewUrl = previewUrlOption(opts) ?? existing.previewUrl;
	const attempts = credentialAttempts({ provider: existing.provider, agentType: existing.agentType });
	const record = spawnAgentProcess({
		id: childId,
		provider: existing.provider,
		agentType: existing.agentType,
		task,
		cwd: existing.cwd,
		status: "running",
		command: built.command,
		args: built.args,
		logPath: join(AGENT_STATE_DIR, `${childId}.log`),
		...(previewUrl ? { previewUrl } : {}),
		...(existing.publicUrl ? { publicUrl: existing.publicUrl } : {}),
		...(existing.publicUrlProvider ? { publicUrlProvider: existing.publicUrlProvider } : {}),
		...(existing.publicUrlPid ? { publicUrlPid: existing.publicUrlPid } : {}),
		...(existing.publicUrlStartedAt ? { publicUrlStartedAt: existing.publicUrlStartedAt } : {}),
		startedAt: Date.now(),
	}, attempts);
	upsertAgent(record);
	writeAudit({
		action: "send_to_agent",
		agentId: childId,
		provider: record.provider,
		agentType: record.agentType,
		command: record.command,
		args: record.args,
		cwd: record.cwd,
		success: true,
		caller: caller(runtime),
		ts: Date.now(),
	});
	const text = `Sent task to ${id}; spawned follow-up ${childId}. Log: ${record.logPath}`;
	await emit(callback, text, "SEND_TO_AGENT");
	return ok(text, { parent: existing, agent: record });
};

const sharePreviewHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const id = stringOption(opts, ["id", "sessionId", "agentId", "agent"]);
	const explicitPreviewUrl = previewUrlOption(opts);
	const timeoutMs = Math.max(5_000, Math.min(60_000, numberOption(opts, ["timeoutMs", "timeout", "waitMs"], 20_000)));
	const agents = refreshedAgents();
	const agent = id
		? agents.find((entry) => entry.id === id)
		: agents.find((entry) => entry.previewUrl || previewUrlFromLog(entry.logPath));
	if (!agent) return fail(id ? `No workspace agent found for ${id}.` : "No workspace agent with a preview URL found.");
	const previewUrl = explicitPreviewUrl ?? agent.previewUrl ?? previewUrlFromLog(agent.logPath);
	if (!previewUrl) return fail(`No preview URL found for workspace agent ${agent.id}.`);
	try {
		const updated = await startNgrokShare(agent, previewUrl, timeoutMs);
		writeAudit({
			action: "share_preview",
			agentId: agent.id,
			provider: agent.provider,
			agentType: agent.agentType,
			cwd: agent.cwd,
			success: true,
			caller: caller(runtime),
			ts: Date.now(),
		});
		const text = `Shared ${previewUrl} through ngrok: ${updated.publicUrl}`;
		await emit(callback, text, "SHARE_PREVIEW");
		return ok(text, { agent: updated, previewUrl, publicUrl: updated.publicUrl });
	} catch (error) {
		const errorText = error instanceof Error ? error.message : String(error);
		writeAudit({
			action: "share_preview",
			agentId: agent.id,
			provider: agent.provider,
			agentType: agent.agentType,
			cwd: agent.cwd,
			success: false,
			error: errorText,
			caller: caller(runtime),
			ts: Date.now(),
		});
		await emit(callback, `SHARE_PREVIEW failed: ${errorText}`, "SHARE_PREVIEW");
		return fail(`SHARE_PREVIEW failed: ${errorText}`);
	}
};

const stopAgentHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const id = stringOption(opts, ["id", "sessionId", "agentId", "agent"]);
	if (!id) return fail("STOP_AGENT requires `id`.");
	const agent = refreshedAgents().find((entry) => entry.id === id);
	if (!agent) return fail(`No workspace agent found for ${id}.`);
	if (agent.pid && pidIsRunning(agent.pid)) process.kill(agent.pid, "SIGTERM");
	if (agent.publicUrlPid && pidIsRunning(agent.publicUrlPid)) process.kill(agent.publicUrlPid, "SIGTERM");
	const updated = updateAgent(id, { status: "stopped", endedAt: Date.now(), signal: "SIGTERM" }) ?? agent;
	writeAudit({
		action: "stop_agent",
		agentId: id,
		provider: agent.provider,
		agentType: agent.agentType,
		cwd: agent.cwd,
		success: true,
		caller: caller(runtime),
		ts: Date.now(),
	});
	const text = `Stopped workspace agent ${id}.`;
	await emit(callback, text, "STOP_AGENT");
	return ok(text, { agent: updated });
};

export const spawnAgentAction: Action = {
	name: "SPAWN_AGENT",
	similes: ["SPAWN_CODING_AGENT", "START_CODING_AGENT", "LAUNCH_CODING_AGENT", "SPAWN_SUB_AGENT", "START_TASK_AGENT"],
	description:
		"Spawn a real background coding subagent for repo work. Uses acpx when available, otherwise Codex or Claude. New projects run in Detour's managed local workspace. Use SHARE_PREVIEW after the agent starts a local web server when a public Discord-visible URL is needed.",
	validate: async () => true,
	handler: spawnAgentHandler,
	examples: [],
	parameters: [
		{ name: "task", description: "Task instructions for the subagent.", required: true, schema: { type: "string" as const } },
		{ name: "workdir", description: "Working directory.", required: false, schema: { type: "string" as const } },
		{ name: "provider", description: "acpx, codex, or claude.", required: false, schema: { type: "string" as const } },
		{ name: "agentType", description: "ACPX agent type, commonly codex or claude.", required: false, schema: { type: "string" as const } },
		{ name: "approvalPreset", description: "read-only, standard, permissive, or autonomous.", required: false, schema: { type: "string" as const } },
	],
};

export const createTaskAction: Action = {
	name: "CREATE_TASK",
	similes: ["START_CODING_TASK", "RUN_CODING_TASK", "RUN_SUBAGENT_TASK", "EXECUTE_AGENT_TASK"],
	description:
		"Run a real coding subagent task and wait for completion. Uses acpx when available, otherwise Codex or Claude. New projects run in Detour's managed local workspace. Use for bounded repo work, tests, code generation, trajectory exports, and status checks.",
	validate: async () => true,
	handler: createTaskHandler,
	examples: [],
	parameters: [
		{ name: "task", description: "Task instructions.", required: true, schema: { type: "string" as const } },
		{ name: "workdir", description: "Working directory.", required: false, schema: { type: "string" as const } },
		{ name: "provider", description: "acpx, codex, or claude.", required: false, schema: { type: "string" as const } },
		{ name: "timeoutMs", description: "Timeout in milliseconds.", required: false, schema: { type: "number" as const } },
	],
};

export const listAgentsAction: Action = {
	name: "LIST_AGENTS",
	similes: ["LIST_CODING_AGENTS", "LIST_TASK_AGENTS", "AGENT_STATUS", "WORKSPACE_AGENT_STATUS"],
	description: "List workspace coding subagent sessions and log paths.",
	validate: async () => true,
	handler: listAgentsHandler,
	examples: [],
	parameters: [
		{ name: "includeLogs", description: "Include log previews.", required: false, schema: { type: "boolean" as const } },
	],
};

export const sendToAgentAction: Action = {
	name: "SEND_TO_AGENT",
	similes: ["SEND_TO_CODING_AGENT", "MESSAGE_TASK_AGENT", "CONTINUE_AGENT_TASK"],
	description: "Send follow-up instructions to a workspace coding subagent session.",
	validate: async () => true,
	handler: sendToAgentHandler,
	examples: [],
	parameters: [
		{ name: "id", description: "Session id from SPAWN_AGENT or LIST_AGENTS.", required: true, schema: { type: "string" as const } },
		{ name: "task", description: "Follow-up instructions.", required: true, schema: { type: "string" as const } },
	],
};

export const sharePreviewAction: Action = {
	name: "SHARE_PREVIEW",
	similes: ["SHARE_AGENT_PREVIEW", "PUBLISH_PREVIEW", "NGROK_PREVIEW", "CREATE_PREVIEW_URL"],
	description:
		"Open an ngrok tunnel for a workspace agent's local web preview and return a public URL that can be sent in Discord or X. Call this after a coding agent starts a local dev server and prints a localhost preview URL.",
	validate: async () => true,
	handler: sharePreviewHandler,
	examples: [],
	parameters: [
		{ name: "id", description: "Workspace agent session id from SPAWN_AGENT or LIST_AGENTS.", required: false, schema: { type: "string" as const } },
		{ name: "previewUrl", description: "Explicit local preview URL, such as http://127.0.0.1:5173/.", required: false, schema: { type: "string" as const } },
		{ name: "timeoutMs", description: "How long to wait for ngrok to publish a URL.", required: false, schema: { type: "number" as const } },
	],
};

export const stopAgentAction: Action = {
	name: "STOP_AGENT",
	similes: ["CANCEL_AGENT", "STOP_TASK_AGENT"],
	description: "Stop a running workspace coding subagent session.",
	validate: async () => true,
	handler: stopAgentHandler,
	examples: [],
	parameters: [
		{ name: "id", description: "Session id from SPAWN_AGENT or LIST_AGENTS.", required: true, schema: { type: "string" as const } },
	],
};

export const cancelTaskAction: Action = {
	...stopAgentAction,
	name: "CANCEL_TASK",
	similes: ["CANCEL_AGENT_TASK", "CANCEL_CODING_TASK"],
};

export const workspaceToolsPlugin: Plugin = {
	name: "workspace-tools",
	description:
		"Agent-side workspace orchestration tools for controlling Codex and Claude subagents on code generation, tests, git, project scaffolding, ACPX, and publishing workflows.",
	actions: [
		spawnAgentAction,
		sendToAgentAction,
		listAgentsAction,
		sharePreviewAction,
		stopAgentAction,
		createTaskAction,
		cancelTaskAction,
	],
};

export default workspaceToolsPlugin;
