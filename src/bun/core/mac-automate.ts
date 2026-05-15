/**
 * Mac automation primitive — run an AppleScript / JXA snippet via
 * `osascript` and return the structured result. The mac-automate
 * plugin and the URL-scheme handler both go through here so error
 * shape + timeout policy are consistent.
 *
 * macOS-only. On non-darwin platforms `runAppleScript` rejects rather
 * than silently no-op'ing — the agent should see a real failure so
 * it doesn't loop on a script that will never work.
 *
 * Permission posture: AppleScript that drives ANOTHER app (Calendar,
 * Mail, etc.) needs the user to grant Automation in TCC. We surface
 * the underlying osascript stderr verbatim so the agent + user can
 * read the prompt that comes back ("Detour wants to control Calendar.app").
 */

import { spawn } from "node:child_process";

export type AppleScriptLang = "applescript" | "jxa";

export interface RunAppleScriptInput {
	readonly script: string;
	readonly lang?: AppleScriptLang;
	readonly timeoutMs?: number;
	/**
	 * Optional command-line args passed to the script (read via `argv`
	 * in JXA, `(item N of argv)` in AppleScript). Lets recipe builders
	 * pass user-controlled strings without string-concatenating them
	 * into the script source — safer against quote injection in titles
	 * or notes that contain `"` characters.
	 */
	readonly args?: ReadonlyArray<string>;
}

export interface RunAppleScriptResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

export function isDarwin(): boolean {
	return process.platform === "darwin";
}

export async function runAppleScript(
	input: RunAppleScriptInput,
): Promise<RunAppleScriptResult> {
	if (!isDarwin()) {
		throw new Error("AppleScript is macOS-only");
	}
	const lang = input.lang ?? "applescript";
	const timeout = clampTimeout(input.timeoutMs);
	const args: string[] = [];
	if (lang === "jxa") args.push("-l", "JavaScript");
	args.push("-e", input.script);
	for (const extra of input.args ?? []) args.push(extra);
	return exec("osascript", args, timeout);
}

function clampTimeout(ms: number | undefined): number {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.min(MAX_TIMEOUT_MS, Math.floor(ms));
}

function exec(
	cmd: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<RunAppleScriptResult> {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn(cmd, [...args], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString("utf8");
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString("utf8");
		});
		child.once("error", (err) => {
			clearTimeout(timer);
			resolve({
				stdout,
				stderr: `${stderr} ${(err as Error).message}`.trim(),
				exitCode: -1,
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({
				stdout: stdout.replace(/\n+$/, ""),
				stderr: stderr.trim(),
				exitCode: code ?? 1,
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		});
	});
}

/**
 * Quote a string for safe interpolation into an AppleScript literal.
 * Use sparingly — prefer passing values via `input.args` and reading
 * them inside the script. Quoting here is a fallback for callers that
 * must inline a value into the AppleScript source.
 */
export function quoteAppleScript(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
