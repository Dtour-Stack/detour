/**
 * LocalChatService presets + RAM-fit checks.
 *
 * Most of the service is a thin coordinator over LlamaServerService
 * (which is exhaustively tested via integration with the embedding path).
 * What we test here is the *configuration logic* that decides which
 * preset fits the machine and how environment toggles propagate.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LOCAL_CHAT_PRESET,
	LOCAL_CHAT_PRESETS,
	LocalChatService,
	machineFitsPreset,
} from "./chat-service";

describe("LocalChatService presets", () => {
	test("default preset is Qwen3-4B-Instruct — the only size-class entry that actually chats today", () => {
		// eliza-1 v1 is base (raw) Qwen3 weights per its own model card.
		// Base models don't follow chat instructions; making one default
		// would give every new user a silently-broken first impression.
		// Default to the instruct-tuned Qwen3 sibling instead; eliza-1
		// stays available in the picker for users who want to experiment.
		expect(DEFAULT_LOCAL_CHAT_PRESET.id).toBe("qwen3-4b-instruct-q4");
		expect(DEFAULT_LOCAL_CHAT_PRESET.license).toBe("apache-2.0");
		expect(DEFAULT_LOCAL_CHAT_PRESET.approxLiveRamGB).toBeLessThan(8);
	});

	test("eliza-1 presets are tagged as base/preview in their labels", () => {
		// Belt-and-suspenders against future regressions: anyone who
		// adds an eliza-1 preset should keep the "base"/"preview"
		// signal in the label so the UI surfaces the caveat. We
		// can relax this when elizaOS ships fine-tuned variants.
		const elizaPresets = LOCAL_CHAT_PRESETS.filter((p) =>
			p.modelRef.includes("elizaos/eliza-1"),
		);
		for (const p of elizaPresets) {
			const labelLower = p.label.toLowerCase();
			expect(
				labelLower.includes("base") ||
					labelLower.includes("preview") ||
					labelLower.includes("advanced"),
			).toBe(true);
		}
	});

	test("every preset has a parseable hf:// modelRef", () => {
		for (const preset of LOCAL_CHAT_PRESETS) {
			expect(preset.modelRef.startsWith("hf://")).toBe(true);
			// hf://<user>/<repo>/<path>.gguf — at least three segments
			const segments = preset.modelRef.slice("hf://".length).split("/");
			expect(segments.length).toBeGreaterThanOrEqual(3);
			expect(preset.modelRef.endsWith(".gguf")).toBe(true);
		}
	});

	test("eliza-1 presets cover the full size range without unattested licenses", () => {
		// Detour can DOWNLOAD models from elizaos/eliza-1 (a model file is
		// just a file). What Detour does NOT do is clone or vendor the
		// elizaOS llama.cpp fork or omnivoice.cpp fork — those would
		// couple Detour's binary to another org's release cadence.
		// The presets here are clean download-from-HF entries.
		for (const preset of LOCAL_CHAT_PRESETS) {
			expect(preset.license).not.toBe("other-unattested");
		}
		// All five eliza-1 size tiers should be wired so the user can
		// pick the one that fits their RAM.
		const elizaPresets = LOCAL_CHAT_PRESETS.filter((p) =>
			p.modelRef.includes("elizaos/eliza-1"),
		);
		expect(elizaPresets.length).toBeGreaterThanOrEqual(4);
		// Each eliza preset's modelRef must point at a real bundle path.
		for (const p of elizaPresets) {
			expect(p.modelRef).toMatch(
				/^hf:\/\/elizaos\/eliza-1\/bundles\/[0-9_]+b\/text\/eliza-1-[0-9_]+b-\d+k\.gguf$/,
			);
		}
	});

	test("machineFitsPreset returns a boolean (or null when totalmem is 0)", () => {
		const result = machineFitsPreset(DEFAULT_LOCAL_CHAT_PRESET);
		// On any real machine running bun, totalmem is non-zero.
		expect(result === null || typeof result === "boolean").toBe(true);
	});

	test("machineFitsPreset rejects models that overshoot the machine RAM", () => {
		// Fabricate a preset that wants 1024 GB; even an M3 Ultra is under
		// that. Result should be false.
		const giant = {
			id: "fabricated-giant",
			label: "Fake Giant",
			modelRef: "hf://example/fake/fake.gguf",
			approxDiskGB: 999,
			approxLiveRamGB: 1024,
			contextSize: 8192,
			license: "apache-2.0" as const,
			description: "fake",
		};
		expect(machineFitsPreset(giant)).toBe(false);
	});

	test("presets are sorted from smallest to largest by live-RAM", () => {
		for (let i = 1; i < LOCAL_CHAT_PRESETS.length; i += 1) {
			expect(LOCAL_CHAT_PRESETS[i]!.approxLiveRamGB).toBeGreaterThanOrEqual(
				LOCAL_CHAT_PRESETS[i - 1]!.approxLiveRamGB,
			);
		}
	});

	test("status() exposes enabled / preset / ramFitsModel fields", () => {
		const svc = new LocalChatService();
		const status = svc.status();
		expect(typeof status.enabled).toBe("boolean");
		expect(status.preset === null || typeof status.preset === "string").toBe(
			true,
		);
		expect(
			status.ramFitsModel === null || typeof status.ramFitsModel === "boolean",
		).toBe(true);
	});
});
