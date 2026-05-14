import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	computerClickAction,
	computerKeyAction,
	computerObserveAction,
	computerOpenAppAction,
	computerScreenshotAction,
	computerTypeAction,
	desktopControlPlugin,
	desktopUseStatusProvider,
} from "./index";

const ENV_KEYS = ["DETOUR_BROWSER_USE_ENABLED", "DETOUR_COMPUTER_USE_ENABLED", "DETOUR_ELEVATED_CODING"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("desktopControlPlugin", () => {
	test("exports computer-use actions", () => {
		const names = desktopControlPlugin.actions?.map((action) => action.name).sort();
		expect(names).toEqual([
			"COMPUTER_CLICK",
			"COMPUTER_KEY",
			"COMPUTER_OBSERVE",
			"COMPUTER_OPEN_APP",
			"COMPUTER_SCREENSHOT",
			"COMPUTER_TYPE",
		]);
	});

	test("each action declares parameters", () => {
		for (const action of [
			computerObserveAction,
			computerScreenshotAction,
			computerClickAction,
			computerTypeAction,
			computerKeyAction,
			computerOpenAppAction,
		]) {
			expect(Array.isArray((action as { parameters?: unknown[] }).parameters)).toBe(true);
		}
	});

	test("computer-use actions refuse when the desktop toggle is off", async () => {
		const result = await computerScreenshotAction.handler({} as never, {} as never, undefined, {});
		expect(result?.success).toBe(false);
		expect(result?.text).toMatch(/Computer use is disabled/);
	});

	test("desktop status provider reflects browser and computer toggles", async () => {
		process.env.DETOUR_BROWSER_USE_ENABLED = "false";
		process.env.DETOUR_COMPUTER_USE_ENABLED = "true";
		const result = await desktopUseStatusProvider.get({} as never, {} as never, {} as never);
		expect(result.text).toContain("Browser use: disabled");
		expect(result.text).toContain("Computer use: enabled");
	});
});
