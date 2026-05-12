/**
 * Regression coverage for `ADDITIONAL_RESPONSE_STATE_PROVIDERS` — the
 * runtime-level hook that lets a host pull extra providers into the
 * first-pass response state. Pre-fix, `composeResponseState` was hardcoded
 * to `composeState(..., onlyInclude=true)` with just the 5 CORE provider
 * names, which silently dropped every Detour-installed "always-on"
 * provider (character anchor, capabilities snapshot, coding brief, skill
 * catalog, pensieve chronicler) from the prompt every single turn. This
 * test pins the parse rules so we don't regress on:
 *   - missing/empty setting → no extras (vanilla eliza behavior preserved)
 *   - comma-separated string → parsed into trimmed names
 *   - whitespace / empty fragments → ignored, not propagated
 *   - non-string return value → defensively returns []
 */

import { describe, expect, it } from "vitest";
import { getAdditionalResponseStateProviders } from "../services/message.ts";
import type { IAgentRuntime } from "../types";

function runtimeWith(value: unknown): IAgentRuntime {
	return {
		getSetting: (key: string) =>
			key === "ADDITIONAL_RESPONSE_STATE_PROVIDERS"
				? (value as string | number | boolean | null)
				: null,
	} as unknown as IAgentRuntime;
}

describe("getAdditionalResponseStateProviders", () => {
	it("returns [] when the setting is missing", () => {
		const rt = {
			getSetting: () => null,
		} as unknown as IAgentRuntime;
		expect(getAdditionalResponseStateProviders(rt)).toEqual([]);
	});

	it("returns [] when the setting is an empty string", () => {
		expect(getAdditionalResponseStateProviders(runtimeWith(""))).toEqual([]);
	});

	it("parses a single name", () => {
		expect(
			getAdditionalResponseStateProviders(runtimeWith("AGENT_CHARACTER_ANCHOR")),
		).toEqual(["AGENT_CHARACTER_ANCHOR"]);
	});

	it("parses a comma-separated list and trims whitespace", () => {
		expect(
			getAdditionalResponseStateProviders(
				runtimeWith(
					"AGENT_CHARACTER_ANCHOR, AGENT_CAPABILITIES ,AGENT_CODING_BRIEF",
				),
			),
		).toEqual([
			"AGENT_CHARACTER_ANCHOR",
			"AGENT_CAPABILITIES",
			"AGENT_CODING_BRIEF",
		]);
	});

	it("ignores empty fragments from leading / trailing / double commas", () => {
		expect(
			getAdditionalResponseStateProviders(
				runtimeWith(",AGENT_CHARACTER_ANCHOR,,AGENT_CAPABILITIES,"),
			),
		).toEqual(["AGENT_CHARACTER_ANCHOR", "AGENT_CAPABILITIES"]);
	});

	it("returns [] when the setting is a non-string value", () => {
		// `runtime.getSetting` is typed `string | boolean | number | null`,
		// so a host could legitimately stash a number/bool under the same
		// key by accident. Don't blow up — just no-op.
		expect(getAdditionalResponseStateProviders(runtimeWith(42))).toEqual([]);
		expect(getAdditionalResponseStateProviders(runtimeWith(true))).toEqual([]);
		expect(getAdditionalResponseStateProviders(runtimeWith(null))).toEqual([]);
	});

	it("tolerates a runtime without getSetting at all", () => {
		const rt = {} as unknown as IAgentRuntime;
		expect(getAdditionalResponseStateProviders(rt)).toEqual([]);
	});
});
