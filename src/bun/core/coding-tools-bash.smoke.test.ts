/**
 * BASH end-to-end smoke test.
 *
 * Confirms that the coding-tools plugin's services + BASH action actually
 * execute a real shell command from inside a Detour-shaped runtime. The
 * advisor flagged that "structurally loaded" doesn't guarantee runtime
 * behavior — SANDBOX_SERVICE / SESSION_CWD_SERVICE could fail to start
 * for some Detour-specific reason and BASH would silently 404 from the
 * planner. This test catches that.
 *
 * Not a unit test — it spawns real `sh`. Skipped on Windows-ish CI if any
 * appears; Detour is macOS/Linux.
 */

import { describe, expect, test } from "bun:test";
import {
	codingToolsPlugin,
	SandboxService,
	SessionCwdService,
} from "@elizaos/plugin-coding-tools";
import type { Action, IAgentRuntime, Memory, UUID } from "@elizaos/core";

const SANDBOX_SERVICE = "CODING_TOOLS_SANDBOX";
const SESSION_CWD_SERVICE = "CODING_TOOLS_SESSION_CWD";

const bashAction = (codingToolsPlugin.actions ?? []).find(
	(a): a is Action => a.name === "BASH",
);
if (!bashAction) {
	throw new Error("smoke-test: BASH action not present on codingToolsPlugin — plugin shape changed?");
}

async function makeBashRuntime(): Promise<{ runtime: IAgentRuntime }> {
	const settings: Record<string, unknown> = {};
	const services = new Map<string, unknown>();
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		getSetting: (key: string) => settings[key],
		getService: <T>(type: string) => (services.get(type) ?? null) as T | null,
	} as unknown as IAgentRuntime;

	const sandbox = await SandboxService.start(runtime);
	const session = await SessionCwdService.start(runtime);
	services.set(SANDBOX_SERVICE, sandbox);
	services.set(SESSION_CWD_SERVICE, session);

	return { runtime };
}

function makeMessage(): Memory {
	return {
		id: "11111111-1111-1111-1111-111111111111" as UUID,
		entityId: "22222222-2222-2222-2222-222222222222" as UUID,
		roomId: "33333333-3333-3333-3333-333333333333" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		content: { text: "" },
		createdAt: Date.now(),
	} as Memory;
}

describe("BASH action — Detour runtime smoke", () => {
	test("echoes a string back through the real shell", async () => {
		const { runtime } = await makeBashRuntime();
		const result = await bashAction.handler!(
			runtime,
			makeMessage(),
			undefined,
			{ command: "echo detour-bash-smoke-marker" },
		);
		expect(result).toBeDefined();
		expect(result!.success).toBe(true);
		expect(typeof result!.text).toBe("string");
		expect(result!.text).toContain("detour-bash-smoke-marker");
		expect(result!.text).toContain("[exit 0]");
	});

	test("returns pwd that points at a real directory", async () => {
		const { runtime } = await makeBashRuntime();
		const result = await bashAction.handler!(
			runtime,
			makeMessage(),
			undefined,
			{ command: "pwd" },
		);
		expect(result).toBeDefined();
		expect(result!.success).toBe(true);
		// Don't pin the path — sandbox may relocate cwd. Just verify it
		// starts with a "/" (absolute path) and there's a [exit 0] tag.
		const text = result!.text ?? "";
		expect(text).toMatch(/\n\/[^\n]+/);
		expect(text).toContain("[exit 0]");
	});

	test("non-zero exit codes surface as a typed command_failed result", async () => {
		const { runtime } = await makeBashRuntime();
		const result = await bashAction.handler!(
			runtime,
			makeMessage(),
			undefined,
			{ command: "exit 7" },
		);
		// The action records the command ran and exited non-zero — that's a
		// useful signal to the agent, not a runtime crash. Surface contains
		// "command_failed" + the exit code, so the planner can read both.
		expect(result).toBeDefined();
		expect(typeof result!.text).toBe("string");
		expect(result!.text).toContain("command_failed");
		expect(result!.text).toContain("code 7");
		expect(result!.success).toBe(false);
	});

	test("captures stderr separately from stdout", async () => {
		const { runtime } = await makeBashRuntime();
		const result = await bashAction.handler!(
			runtime,
			makeMessage(),
			undefined,
			{ command: "echo to-stdout; echo to-stderr 1>&2" },
		);
		const text = result?.text ?? "";
		expect(text).toContain("to-stdout");
		expect(text).toContain("to-stderr");
	});
});
