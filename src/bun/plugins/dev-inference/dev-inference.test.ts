import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ModelType } from "@elizaos/core";
import {
	DEV_INFERENCE_DEFAULT_API_KEY,
	DEV_INFERENCE_DEFAULT_BASE_URL,
	DEV_INFERENCE_DEFAULT_MODEL,
	DEV_INFERENCE_PRIORITY,
	devInferencePlugin,
	isDevInferenceEnabled,
	resolveDevInferenceConfig,
} from "./index";

/**
 * Unit coverage for the dev-inference config layer — no network. The real
 * endpoint is exercised by dev-inference.smoke.test.ts and
 * dev-inference.integration.test.ts (both skip cleanly when the proxy is
 * unreachable).
 */

const ENV_KEYS = [
	"DETOUR_DEV_INFERENCE",
	"DETOUR_DEV_INFERENCE_URL",
	"DETOUR_DEV_INFERENCE_API_KEY",
	"DETOUR_DEV_INFERENCE_MODEL",
	"DETOUR_DEV_INFERENCE_SMALL_MODEL",
	"DETOUR_DEV_INFERENCE_MEDIUM_MODEL",
	"DETOUR_DEV_INFERENCE_LARGE_MODEL",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe("dev-inference config", () => {
	test("resolveDevInferenceConfig returns baked defaults when no env is set", () => {
		const cfg = resolveDevInferenceConfig();
		expect(cfg.baseUrl).toBe(DEV_INFERENCE_DEFAULT_BASE_URL);
		expect(cfg.apiKey).toBe(DEV_INFERENCE_DEFAULT_API_KEY);
		expect(cfg.smallModel).toBe(DEV_INFERENCE_DEFAULT_MODEL);
		expect(cfg.mediumModel).toBe(DEV_INFERENCE_DEFAULT_MODEL);
		expect(cfg.largeModel).toBe(DEV_INFERENCE_DEFAULT_MODEL);
	});

	test("env overrides win and a trailing slash on the base URL is stripped", () => {
		process.env.DETOUR_DEV_INFERENCE_URL = "https://proxy.example/v1/";
		process.env.DETOUR_DEV_INFERENCE_API_KEY = "key-123";
		process.env.DETOUR_DEV_INFERENCE_MODEL = "house-model";
		const cfg = resolveDevInferenceConfig();
		expect(cfg.baseUrl).toBe("https://proxy.example/v1");
		expect(cfg.apiKey).toBe("key-123");
		expect(cfg.smallModel).toBe("house-model");
		expect(cfg.largeModel).toBe("house-model");
	});

	test("per-tier model overrides fall back to DETOUR_DEV_INFERENCE_MODEL then the default", () => {
		process.env.DETOUR_DEV_INFERENCE_MODEL = "base";
		process.env.DETOUR_DEV_INFERENCE_LARGE_MODEL = "big";
		const cfg = resolveDevInferenceConfig();
		expect(cfg.smallModel).toBe("base"); // inherits DETOUR_DEV_INFERENCE_MODEL
		expect(cfg.mediumModel).toBe("base");
		expect(cfg.largeModel).toBe("big"); // explicit override
	});

	test("isDevInferenceEnabled is false by default and parses truthy values", () => {
		expect(isDevInferenceEnabled()).toBe(false);
		for (const truthy of ["1", "true", "TRUE", "yes", "on"]) {
			process.env.DETOUR_DEV_INFERENCE = truthy;
			expect(isDevInferenceEnabled()).toBe(true);
		}
		process.env.DETOUR_DEV_INFERENCE = "0";
		expect(isDevInferenceEnabled()).toBe(false);
	});
});

describe("dev-inference plugin shape", () => {
	test("registers only the three text tiers — never TEXT_EMBEDDING (embeddings must stay put)", () => {
		const types = Object.keys(devInferencePlugin.models ?? {});
		expect(types.sort()).toEqual(
			[ModelType.TEXT_SMALL, ModelType.TEXT_MEDIUM, ModelType.TEXT_LARGE].sort(),
		);
		expect(types).not.toContain(ModelType.TEXT_EMBEDDING);
	});

	test("priority is 150 when enabled (beats codex/anthropic) and deeply negative when disabled", () => {
		process.env.DETOUR_DEV_INFERENCE = "1";
		expect(devInferencePlugin.priority).toBe(DEV_INFERENCE_PRIORITY);
		expect(DEV_INFERENCE_PRIORITY).toBeGreaterThan(100);

		delete process.env.DETOUR_DEV_INFERENCE;
		expect(devInferencePlugin.priority).toBeLessThan(0);
	});

	test("text handler throws when dev inference is disabled, so the fallback chain continues", async () => {
		delete process.env.DETOUR_DEV_INFERENCE;
		const handler = devInferencePlugin.models?.[ModelType.TEXT_LARGE];
		expect(handler).toBeDefined();
		const fakeRuntime = { getSetting: () => undefined } as never;
		await expect(handler!(fakeRuntime, { prompt: "hi" } as never)).rejects.toThrow(
			/not enabled/,
		);
	});
});
