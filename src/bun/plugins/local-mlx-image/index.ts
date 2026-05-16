/**
 * local-mlx-image — Detour eliza plugin that wires the Swift-hosted
 * MLX image service into the eliza `useModel(ModelType.IMAGE, ...)`
 * path. Registered unconditionally with priority 100 so toggling
 * LOCAL_MLX_IMAGE_ENABLED in Settings takes effect WITHOUT a restart;
 * if disabled at call time the handler throws LocalImageDisabledError,
 * which the priority resolver treats as a fall-through to the next
 * registered IMAGE handler (cloud).
 *
 * Architecture:
 *
 *   eliza action GENERATE_IMAGE
 *     └─ runtime.useModel(ModelType.IMAGE, { prompt, size, count })
 *         └─ priority resolver → local-mlx-image handler (always pri 100)
 *             ├─ if disabled       → throw → resolver tries next (cloud)
 *             └─ if enabled        → mlxRpc.generateImage(~/.detour/mlx.sock)
 *                                    └─ Swift MLXImageService (Metal)
 *                                        └─ StableDiffusion → PNG bytes
 *
 * Memory: we pass the bun-side LLM arbiter's usedGB into every
 * generate call so the Swift-side MLXMemoryArbiter sees the COMPLETE
 * unified-memory picture (chat + companion + MLX models), not just
 * what MLX has loaded. This closes the gap where a 14B chat model
 * could OOM the system when we green-lit SDXL on a 16GB Mac.
 *
 * Settings:
 *   - LOCAL_MLX_IMAGE_ENABLED          "1" / "true" / "yes" activates
 *   - LOCAL_MLX_IMAGE_PRESET           preset id (sd-2.1-base, sdxl-turbo,
 *                                      sana-1.6b once vendored)
 *   - LOCAL_MLX_IMAGE_NEGATIVE_PROMPT  default negative prompt (optional)
 */

import {
	ModelType,
	logger,
	type IAgentRuntime,
	type ImageGenerationParams,
	type ImageGenerationResult,
	type JsonValue,
	type Plugin,
} from "@elizaos/core";
import { mlxRpc } from "../../core/mlx-rpc-client";
import { saveGeneratedMediaBytes } from "../../core/generated-media";
import { isLocalPreferredFor } from "../../core/model-routing";

const DEFAULT_PRESET = "sd-2.1-base";
const SETTING_ENABLED = "LOCAL_MLX_IMAGE_ENABLED";
const SETTING_PRESET = "LOCAL_MLX_IMAGE_PRESET";
const SETTING_NEGATIVE = "LOCAL_MLX_IMAGE_NEGATIVE_PROMPT";

export class LocalImageDisabledError extends Error {
	constructor() {
		super("Local MLX image generation is disabled. Set LOCAL_MLX_IMAGE_ENABLED=true to activate.");
		this.name = "LocalImageDisabledError";
	}
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const fromRuntime = runtime.getSetting?.(key);
	if (typeof fromRuntime === "string" && fromRuntime.length > 0) return fromRuntime;
	const fromEnv = process.env[key];
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return undefined;
}

export function localMlxImageEnabled(runtime: IAgentRuntime): boolean {
	// Delegates to model-routing so the per-type provider preference
	// (DETOUR_MODEL_IMAGE_PROVIDER) wins. Falls back to the legacy
	// LOCAL_MLX_IMAGE_ENABLED boolean when no explicit choice is set.
	return isLocalPreferredFor(runtime, "IMAGE");
}

function parseSize(size: string | undefined): { width: number; height: number } | null {
	if (!size) return null;
	const m = size.match(/^\s*(\d+)\s*x\s*(\d+)\s*$/i);
	if (!m) return null;
	const width = Number(m[1]);
	const height = Number(m[2]);
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
	if (width < 64 || height < 64 || width > 4096 || height > 4096) return null;
	return { width, height };
}

/// Read the bun-side LLM memory arbiter snapshot so the Swift-side
/// gate sees chat + companion usage on top of MLX-only state. We
/// access the singleton lazily to avoid a static import cycle.
async function readLlmArbiterUsedGB(): Promise<number | null> {
	try {
		const mod = await import("../../core/llama/memory-arbiter");
		const arbiter = (mod as unknown as { sharedMemoryArbiter?: { inspect: () => { usedGB: number } } }).sharedMemoryArbiter;
		if (!arbiter) return null;
		const snap = arbiter.inspect();
		return typeof snap.usedGB === "number" ? snap.usedGB : null;
	} catch {
		return null;
	}
}

async function handleImage(
	runtime: IAgentRuntime,
	params: ImageGenerationParams,
): Promise<ImageGenerationResult[]> {
	// Live enable check — toggling LOCAL_MLX_IMAGE_ENABLED takes
	// effect immediately because the runtime resolver re-reads it
	// on every useModel(IMAGE) call.
	if (!localMlxImageEnabled(runtime)) {
		throw new LocalImageDisabledError();
	}
	const preset = readSetting(runtime, SETTING_PRESET) ?? DEFAULT_PRESET;
	const negativePrompt = readSetting(runtime, SETTING_NEGATIVE);
	const size = parseSize(params.size ?? undefined);
	const count = Math.max(1, Math.min(4, Math.round(params.count ?? 1)));
	// Tell Swift how much memory bun's LLM stack is already using so
	// it can refuse the load if the combined footprint would exceed
	// unified RAM (would otherwise crash the system on small Macs).
	const llmUsedGB = await readLlmArbiterUsedGB();

	const results: ImageGenerationResult[] = [];
	for (let i = 0; i < count; i++) {
		const generated = await mlxRpc.generateImage({
			presetId: preset,
			prompt: params.prompt,
			negativePrompt,
			width: size?.width,
			height: size?.height,
			// Extension field — picked up by the Swift socket server
			// and added to MLXMemoryArbiter's "alreadyUsed" reading.
			...(typeof llmUsedGB === "number" ? { llmUsedGB } : {}),
		} as unknown as Parameters<typeof mlxRpc.generateImage>[0]);
		const bytes = Uint8Array.from(Buffer.from(generated.base64, "base64"));
		const item = await saveGeneratedMediaBytes({
			kind: "image",
			provider: "local-mlx",
			capability: "image-generation",
			contentType: generated.contentType,
			extension: "png",
			title: `Local MLX (${preset})`,
			prompt: params.prompt,
			model: generated.model,
			bytes,
		});
		const url = item.path
			? `file://${item.path}`
			: `http://127.0.0.1:2138/media/${item.id}`;
		results.push({ url } as ImageGenerationResult);
		logger.info(`[local-mlx-image] generated via ${preset} in ${generated.durationMs}ms → ${url}`);
	}
	return results;
}

/// Always-register: the handler itself checks enabled-ness and throws
/// LocalImageDisabledError when off. The priority resolver falls
/// through to the next IMAGE handler (cloud) on throws, so this is
/// equivalent to "register conditionally" without requiring a restart.
function registerLocalMlxImage(runtime: IAgentRuntime): void {
	runtime.registerModel(
		ModelType.IMAGE,
		async (rt: IAgentRuntime, params: Record<string, JsonValue | object>) => {
			const typed = params as unknown as ImageGenerationParams;
			return handleImage(rt, typed) as unknown as JsonValue | object;
		},
		"local-mlx-image",
		100,
	);
	logger.info("[local-mlx-image] registered ModelType.IMAGE handler (priority 100; runtime-toggle aware)");
}

export const localMlxImagePlugin: Plugin = {
	name: "local-mlx-image",
	description: "Local MLX image generation (Stable Diffusion on Apple Silicon; Sana slot reserved).",
	init: async (_config, runtime) => {
		if (!runtime) return;
		registerLocalMlxImage(runtime);
	},
};

export default localMlxImagePlugin;
