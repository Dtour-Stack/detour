/**
 * local-mlx-vision — registers ModelType.IMAGE_DESCRIPTION pointing
 * at the Swift-hosted MLXVisionService. Default preset is
 * "apple-vision" (Vision framework OCR + classification, on-device,
 * zero install, milliseconds). Qwen3-VL preset is available once
 * vendored.
 */

import {
	ModelType,
	logger,
	type IAgentRuntime,
	type ImageDescriptionParams,
	type ImageDescriptionResult,
	type JsonValue,
	type Plugin,
} from "@elizaos/core";
import { mlxRpc } from "../../core/mlx-rpc-client";
import { isLocalPreferredFor } from "../../core/model-routing";

const DEFAULT_PRESET = "apple-vision";
const SETTING_ENABLED = "LOCAL_MLX_VISION_ENABLED";
const SETTING_PRESET = "LOCAL_MLX_VISION_PRESET";

export class LocalVisionDisabledError extends Error {
	constructor() {
		super("Local vision disabled. Set LOCAL_MLX_VISION_ENABLED=true to activate.");
		this.name = "LocalVisionDisabledError";
	}
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const fromRuntime = runtime.getSetting?.(key);
	if (typeof fromRuntime === "string" && fromRuntime.length > 0) return fromRuntime;
	const fromEnv = process.env[key];
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return undefined;
}

export function localMlxVisionEnabled(runtime: IAgentRuntime): boolean {
	return isLocalPreferredFor(runtime, "IMAGE_DESCRIPTION");
}

async function loadImageBase64(input: ImageDescriptionParams | string): Promise<{ base64: string; mime?: string }> {
	const url = typeof input === "string" ? input : input.imageUrl;
	if (!url) throw new Error("ImageDescriptionParams.imageUrl missing");
	if (url.startsWith("data:")) {
		const m = url.match(/^data:([^;]+);base64,(.+)$/);
		if (!m) throw new Error("invalid data URL");
		return { base64: m[2], mime: m[1] };
	}
	if (url.startsWith("file://") || url.startsWith("/")) {
		const path = url.startsWith("file://") ? url.slice(7) : url;
		const file = Bun.file(path);
		const buf = Buffer.from(await file.arrayBuffer());
		return { base64: buf.toString("base64"), mime: file.type || undefined };
	}
	if (/^https?:/i.test(url)) {
		const resp = await fetch(url);
		if (!resp.ok) throw new Error(`fetch image HTTP ${resp.status}`);
		const buf = Buffer.from(await resp.arrayBuffer());
		return { base64: buf.toString("base64"), mime: resp.headers.get("content-type") ?? undefined };
	}
	return { base64: url };
}

async function handleVision(
	runtime: IAgentRuntime,
	params: ImageDescriptionParams | string,
): Promise<ImageDescriptionResult> {
	if (!localMlxVisionEnabled(runtime)) throw new LocalVisionDisabledError();
	const preset = readSetting(runtime, SETTING_PRESET) ?? DEFAULT_PRESET;
	const prompt = typeof params === "string" ? undefined : params.prompt;
	const { base64, mime } = await loadImageBase64(params);
	const result = await mlxRpc.describeImage({
		presetId: preset,
		imageBase64: base64,
		mimeType: mime,
		prompt,
	});
	logger.info(`[local-mlx-vision] ${preset} described image in ${result.durationMs}ms`);
	return { title: result.title, description: result.description };
}

export const localMlxVisionPlugin: Plugin = {
	name: "local-mlx-vision",
	description: "Local on-device image description (Apple Vision + Qwen3-VL optional).",
	init: async (_config, runtime) => {
		if (!runtime) return;
		runtime.registerModel(
			ModelType.IMAGE_DESCRIPTION,
			async (rt: IAgentRuntime, params: Record<string, JsonValue | object>) => {
				const typed = params as unknown as ImageDescriptionParams | string;
				return handleVision(rt, typed) as unknown as JsonValue | object;
			},
			"local-mlx-vision",
			100,
		);
		logger.info("[local-mlx-vision] registered ModelType.IMAGE_DESCRIPTION (priority 100; toggle-aware)");
	},
};

export default localMlxVisionPlugin;
