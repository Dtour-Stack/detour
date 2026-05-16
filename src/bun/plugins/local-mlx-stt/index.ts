/**
 * local-mlx-stt — registers ModelType.TRANSCRIPTION pointing at the
 * Swift-hosted MLXTranscriptionService. Default preset is
 * "apple-speech" (SFSpeechRecognizer, on-device, zero install).
 * Whisper-MLX preset is available once vendored.
 *
 * Pattern mirrors local-mlx-image: always-register at priority 100,
 * check enable-state in the handler so toggles take effect without
 * restart. Throws LocalSttDisabledError when off so the resolver
 * falls through to any cloud TRANSCRIPTION handler.
 */

import {
	ModelType,
	logger,
	type IAgentRuntime,
	type JsonValue,
	type Plugin,
	type TranscriptionParams,
} from "@elizaos/core";
import { mlxRpc } from "../../core/mlx-rpc-client";
import { isLocalPreferredFor } from "../../core/model-routing";

const DEFAULT_PRESET = "apple-speech";
const SETTING_ENABLED = "LOCAL_MLX_STT_ENABLED";
const SETTING_PRESET = "LOCAL_MLX_STT_PRESET";
const SETTING_LANG = "LOCAL_MLX_STT_LANGUAGE";

export class LocalSttDisabledError extends Error {
	constructor() {
		super("Local STT disabled. Set LOCAL_MLX_STT_ENABLED=true to activate.");
		this.name = "LocalSttDisabledError";
	}
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const fromRuntime = runtime.getSetting?.(key);
	if (typeof fromRuntime === "string" && fromRuntime.length > 0) return fromRuntime;
	const fromEnv = process.env[key];
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return undefined;
}

export function localMlxSttEnabled(runtime: IAgentRuntime): boolean {
	return isLocalPreferredFor(runtime, "TRANSCRIPTION");
}

/// Best-effort coerce TranscriptionParams' audioUrl into base64.
/// eliza's TRANSCRIPTION model takes `{ audioUrl: string }` or `Buffer`
/// or `string` (raw base64). We normalise to base64 here.
async function loadAudioBase64(input: TranscriptionParams | Buffer | string): Promise<{ base64: string; mime?: string }> {
	if (Buffer.isBuffer(input)) {
		return { base64: input.toString("base64"), mime: "audio/wav" };
	}
	if (typeof input === "string") {
		// Could be a data URL, a path, or raw base64.
		if (input.startsWith("data:")) {
			const m = input.match(/^data:([^;]+);base64,(.+)$/);
			if (!m) throw new Error("invalid data URL");
			return { base64: m[2], mime: m[1] };
		}
		if (input.startsWith("file://") || input.startsWith("/")) {
			const path = input.startsWith("file://") ? input.slice(7) : input;
			const file = Bun.file(path);
			const buf = Buffer.from(await file.arrayBuffer());
			return { base64: buf.toString("base64"), mime: file.type || undefined };
		}
		// Assume raw base64.
		return { base64: input };
	}
	const url = input.audioUrl;
	if (!url) throw new Error("TranscriptionParams.audioUrl missing");
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
		if (!resp.ok) throw new Error(`fetch audio HTTP ${resp.status}`);
		const buf = Buffer.from(await resp.arrayBuffer());
		return { base64: buf.toString("base64"), mime: resp.headers.get("content-type") ?? undefined };
	}
	// Assume already base64.
	return { base64: url };
}

async function handleTranscription(
	runtime: IAgentRuntime,
	params: TranscriptionParams | Buffer | string,
): Promise<string> {
	if (!localMlxSttEnabled(runtime)) throw new LocalSttDisabledError();
	const preset = readSetting(runtime, SETTING_PRESET) ?? DEFAULT_PRESET;
	const language = readSetting(runtime, SETTING_LANG);
	const { base64, mime } = await loadAudioBase64(params);
	const result = await mlxRpc.transcribe({
		presetId: preset,
		audioBase64: base64,
		mimeType: mime,
		languageCode: language,
	});
	logger.info(`[local-mlx-stt] ${preset} transcribed ${result.text.length} chars in ${result.durationMs}ms (${result.language})`);
	return result.text;
}

export const localMlxSttPlugin: Plugin = {
	name: "local-mlx-stt",
	description: "Local on-device speech-to-text (Apple Speech + Whisper-MLX optional).",
	init: async (_config, runtime) => {
		if (!runtime) return;
		runtime.registerModel(
			ModelType.TRANSCRIPTION,
			async (rt: IAgentRuntime, params: Record<string, JsonValue | object>) => {
				const typed = params as unknown as TranscriptionParams | Buffer | string;
				return handleTranscription(rt, typed) as unknown as JsonValue | object;
			},
			"local-mlx-stt",
			100,
		);
		logger.info("[local-mlx-stt] registered ModelType.TRANSCRIPTION (priority 100; toggle-aware)");
	},
};

export default localMlxSttPlugin;
