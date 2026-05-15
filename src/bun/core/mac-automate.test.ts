/**
 * mac-automate core: runAppleScript + quoteAppleScript.
 *
 * Tests use a trivial `osascript -e 'return "ok"'` which works on any
 * macOS without permission prompts — and are skipped on non-darwin so
 * Linux/CI without macOS won't fail the suite.
 */
import { describe, expect, test } from "bun:test";
import { isDarwin, quoteAppleScript, runAppleScript } from "./mac-automate";

const darwinOnly = isDarwin() ? describe : describe.skip;

darwinOnly("runAppleScript", () => {
	test("returns stdout on a simple script", async () => {
		const r = await runAppleScript({ script: 'return "hello"' });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("hello");
		expect(r.stderr).toBe("");
		expect(r.timedOut).toBe(false);
		expect(r.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("JXA mode runs JavaScript and returns stdout", async () => {
		const r = await runAppleScript({
			script: 'JSON.stringify({ ok: true, sum: 2 + 3 });',
			lang: "jxa",
		});
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ ok: true, sum: 5 });
	});

	test("returns non-zero exit + stderr on syntax error", async () => {
		const r = await runAppleScript({
			script: "this is not valid applescript at all",
		});
		expect(r.exitCode).not.toBe(0);
		expect(r.stderr.length).toBeGreaterThan(0);
	});

	test("times out a runaway script and reports timedOut", async () => {
		const r = await runAppleScript({
			script: "delay 30",
			timeoutMs: 200,
		});
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).not.toBe(0);
	});

	test("passes args[] into the script via process.argv (JXA)", async () => {
		// osascript JXA arg layout for `osascript -l JavaScript -e SCRIPT args...`:
		// argv[0]=osascript, [1]=-l, [2]=JavaScript, [3]=-e, [4]=<script source>,
		// [5+] = user args. Recipes in mac-automate/recipes.ts read from index 5.
		const r = await runAppleScript({
			script: `const args = $.NSProcessInfo.processInfo.arguments;
				const a = ObjC.unwrap(args.objectAtIndex(5));
				const b = ObjC.unwrap(args.objectAtIndex(6));
				a + "|" + b`,
			lang: "jxa",
			args: ["first", 'sec"ond'],
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe('first|sec"ond');
	});
});

describe("quoteAppleScript", () => {
	test("wraps a plain string in double quotes", () => {
		expect(quoteAppleScript("hello")).toBe('"hello"');
	});

	test("escapes embedded quotes", () => {
		expect(quoteAppleScript('he said "hi"')).toBe('"he said \\"hi\\""');
	});

	test("escapes backslashes before quotes (so the result re-parses)", () => {
		expect(quoteAppleScript("a\\b")).toBe('"a\\\\b"');
	});
});
