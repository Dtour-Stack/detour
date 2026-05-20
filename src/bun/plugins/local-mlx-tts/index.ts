/**
 * local-mlx-tts — registers ModelType.TEXT_TO_SPEECH pointing at the
 * Swift-hosted MLXSpeechService. Default preset is "avspeech"
 * (AVSpeechSynthesizer + macOS system voices, on-device, zero
 * install). Kokoro-MLX preset is available once vendored.
 *
 * Returns raw audio bytes (AIFF) per the eliza TEXT_TO_SPEECH contract
 * (which expects Buffer | ArrayBuffer | Uint8Array).
 */

import {
	ModelType,
	logger,
	type IAgentRuntime,
	type JsonValue,
	type Plugin,
	type TextToSpeechParams,
} from "@elizaos/core";
import { mlxRpc } from "../../core/mlx-rpc-client";
import { isLocalPreferredFor } from "../../core/model-routing";

const DEFAULT_PRESET = "avspeech";
const SETTING_ENABLED = "LOCAL_MLX_TTS_ENABLED";
const SETTING_PRESET = "LOCAL_MLX_TTS_PRESET";
const SETTING_VOICE = "LOCAL_MLX_TTS_VOICE";

export class LocalTtsDisabledError extends Error {
	constructor() {
		super("Local TTS disabled. Set LOCAL_MLX_TTS_ENABLED=true to activate.");
		this.name = "LocalTtsDisabledError";
	}
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const fromRuntime = runtime.getSetting?.(key);
	if (typeof fromRuntime === "string" && fromRuntime.length > 0) return fromRuntime;
	const fromEnv = process.env[key];
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return undefined;
}

export function localMlxTtsEnabled(runtime: IAgentRuntime): boolean {
	return isLocalPreferredFor(runtime, "TEXT_TO_SPEECH");
}

async function handleSpeech(
	runtime: IAgentRuntime,
	params: TextToSpeechParams | string,
): Promise<Uint8Array> {
	if (!localMlxTtsEnabled(runtime)) throw new LocalTtsDisabledError();
	const text = typeof params === "string" ? params : params.text;
	if (!text || text.length === 0) throw new Error("TextToSpeechParams.text empty");
	const preset = readSetting(runtime, SETTING_PRESET) ?? DEFAULT_PRESET;
	const voice = readSetting(runtime, SETTING_VOICE);
	const result = await mlxRpc.synthesize({
		presetId: preset,
		text,
		voice,
	});
	logger.info(`[local-mlx-tts] ${preset} synthesized ${result.durationSeconds.toFixed(2)}s of audio in ${result.durationMs}ms`);
	return Uint8Array.from(Buffer.from(result.base64, "base64"));
}

export const localMlxTtsPlugin: Plugin = {
	name: "local-mlx-tts",
	description: "Local on-device text-to-speech (AVSpeech + Kokoro-MLX optional).",
	init: async (_config, runtime) => {
		if (!runtime) return;
		runtime.registerModel(
			ModelType.TEXT_TO_SPEECH,
			async (rt: IAgentRuntime, params: Record<string, JsonValue | object>) => {
				const typed = params as unknown as TextToSpeechParams | string;
				return handleSpeech(rt, typed) as unknown as JsonValue | object;
			},
			"local-mlx-tts",
			100,
		);
		logger.info("[local-mlx-tts] registered ModelType.TEXT_TO_SPEECH (priority 100; toggle-aware)");
	},
};

export default localMlxTtsPlugin;
