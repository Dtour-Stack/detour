import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	Plugin,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import { saveGeneratedMediaBytes } from "../../core/generated-media";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_TTS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

const AUDIO_RUNTIME_SETTING_KEYS = [
	"ELEVENLABS_API_KEY",
	"ELEVENLABS_BASE_URL",
	"ELEVENLABS_VOICE_ID",
	"ELEVENLABS_MODEL_ID",
	"ELEVENLABS_STS_MODEL_ID",
	"ELEVENLABS_STT_MODEL_ID",
	"ELEVENLABS_SOUND_MODEL_ID",
	"ELEVENLABS_MUSIC_MODEL_ID",
	"ELEVENLABS_OUTPUT_FORMAT",
	"ELEVENLABS_MUSIC_OUTPUT_FORMAT",
] as const;

type AudioRuntimeSettingKey = typeof AUDIO_RUNTIME_SETTING_KEYS[number];

type AudioParams = Record<string, unknown>;

type BinaryResult = {
	bytes: Uint8Array;
	contentType: string;
	requestId?: string;
	songId?: string;
};

type SavedAudio = {
	path: string;
	url: string;
	contentType: string;
	bytes: number;
	galleryId: string;
	requestId?: string;
	songId?: string;
};

export function audioSettingKeys(): readonly AudioRuntimeSettingKey[] {
	return AUDIO_RUNTIME_SETTING_KEYS;
}

export function normalizeAudioBaseUrl(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	const base = trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : fallback;
	return base.replace(/\/+$/, "");
}

export function extensionForOutputFormat(outputFormat: string | undefined, contentType?: string): string {
	const fmt = outputFormat?.toLowerCase() ?? "";
	if (fmt.startsWith("mp3")) return "mp3";
	if (fmt.startsWith("pcm")) return "pcm";
	if (fmt.startsWith("ulaw")) return "ulaw";
	if (fmt.startsWith("alaw")) return "alaw";
	if (fmt.startsWith("opus")) return "opus";
	if (contentType?.includes("wav")) return "wav";
	if (contentType?.includes("mpeg") || contentType?.includes("mp3")) return "mp3";
	return "bin";
}

function getSetting(runtime: IAgentRuntime, key: AudioRuntimeSettingKey, fallback?: string): string | undefined {
	const raw = runtime.getSetting?.(key);
	const runtimeValue = raw === null || raw === undefined ? undefined : String(raw);
	const envValue = typeof process.env[key] === "string" ? process.env[key] : undefined;
	return runtimeValue ?? envValue ?? fallback;
}

function requireSetting(runtime: IAgentRuntime, key: AudioRuntimeSettingKey): string {
	const value = getSetting(runtime, key);
	if (!value) throw new Error(`${key} is not configured. Add it in Settings -> Configuration -> Audio.`);
	return value;
}

function paramsFrom(message: Memory, options?: Record<string, unknown>): AudioParams {
	const content = message.content && typeof message.content === "object"
		? message.content as Record<string, unknown>
		: {};
	const parameters = options?.parameters && typeof options.parameters === "object" && !Array.isArray(options.parameters)
		? options.parameters as Record<string, unknown>
		: {};
	return { ...content, ...(options ?? {}), ...parameters };
}

function firstString(params: AudioParams, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function firstNumber(params: AudioParams, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim().length > 0) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function firstBool(params: AudioParams, keys: readonly string[], fallback = false): boolean {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "boolean") return value;
		if (typeof value === "string") {
			const lower = value.toLowerCase();
			if (lower === "true" || lower === "1" || lower === "yes") return true;
			if (lower === "false" || lower === "0" || lower === "no") return false;
		}
	}
	return fallback;
}

function promptFrom(message: Memory, params: AudioParams): string {
	const explicit = firstString(params, ["prompt", "text", "description"]);
	if (explicit) return explicit;
	const text = typeof message.content?.text === "string" ? message.content.text.trim() : "";
	if (!text) throw new Error("A prompt or text value is required.");
	return text;
}

function audioSourceFrom(params: AudioParams): string {
	const source = firstString(params, ["audioPath", "audio_path", "path", "audioUrl", "audio_url", "url"]);
	if (!source) throw new Error("An audioPath or audioUrl is required.");
	return source;
}

async function saveAudio(
	runtime: IAgentRuntime,
	provider: string,
	prefix: string,
	result: BinaryResult,
	outputFormat?: string,
): Promise<SavedAudio> {
	const ext = extensionForOutputFormat(outputFormat, result.contentType);
	const media = await saveGeneratedMediaBytes({
		kind: "audio",
		provider,
		capability: prefix,
		title: prefix,
		prompt: prefix,
		bytes: result.bytes,
		contentType: result.contentType,
		extension: ext,
	});
	return {
		path: media.path,
		url: media.url,
		contentType: result.contentType,
		bytes: result.bytes.byteLength,
		galleryId: media.id,
		requestId: result.requestId,
		songId: result.songId,
	};
}

async function binaryResponse(response: Response): Promise<BinaryResult> {
	if (!response.ok) throw new Error(await responseError(response));
	const contentType = response.headers.get("content-type") ?? "application/octet-stream";
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0) throw new Error("Provider returned an empty audio payload.");
	return {
		bytes,
		contentType,
		requestId: response.headers.get("request-id") ?? undefined,
		songId: response.headers.get("song-id") ?? undefined,
	};
}

async function jsonResponse(response: Response): Promise<unknown> {
	if (!response.ok) throw new Error(await responseError(response));
	return await response.json() as unknown;
}

async function responseError(response: Response): Promise<string> {
	const text = await response.text().catch(() => response.statusText);
	return `HTTP ${response.status}: ${text.slice(0, 500)}`;
}

function elevenlabsUrl(runtime: IAgentRuntime, path: string, query?: Record<string, string | undefined>): string {
	const base = normalizeAudioBaseUrl(getSetting(runtime, "ELEVENLABS_BASE_URL"), ELEVENLABS_BASE_URL);
	const root = base.replace(/\/v1$/, "");
	const url = new URL(`${path.startsWith("/v2/") ? root : base}${path}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value) url.searchParams.set(key, value);
		}
	}
	return url.toString();
}

async function getElevenlabsJson(
	runtime: IAgentRuntime,
	path: string,
	query?: Record<string, string | undefined>,
): Promise<unknown> {
	const apiKey = requireSetting(runtime, "ELEVENLABS_API_KEY");
	const response = await fetch(elevenlabsUrl(runtime, path, query), {
		headers: { "xi-api-key": apiKey },
	});
	return jsonResponse(response);
}

async function getElevenlabsBinary(
	runtime: IAgentRuntime,
	path: string,
	query?: Record<string, string | undefined>,
): Promise<BinaryResult> {
	const apiKey = requireSetting(runtime, "ELEVENLABS_API_KEY");
	const response = await fetch(elevenlabsUrl(runtime, path, query), {
		headers: { "xi-api-key": apiKey },
	});
	return binaryResponse(response);
}

async function postElevenlabsJson(
	runtime: IAgentRuntime,
	path: string,
	body: Record<string, unknown>,
	query?: Record<string, string | undefined>,
): Promise<BinaryResult> {
	const apiKey = requireSetting(runtime, "ELEVENLABS_API_KEY");
	const response = await fetch(elevenlabsUrl(runtime, path, query), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"xi-api-key": apiKey,
		},
		body: JSON.stringify(body),
	});
	return binaryResponse(response);
}

async function postElevenlabsJsonResponse(
	runtime: IAgentRuntime,
	path: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const apiKey = requireSetting(runtime, "ELEVENLABS_API_KEY");
	const response = await fetch(elevenlabsUrl(runtime, path), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"xi-api-key": apiKey,
		},
		body: JSON.stringify(body),
	});
	return jsonResponse(response);
}

async function postElevenlabsForm(
	runtime: IAgentRuntime,
	path: string,
	form: FormData,
	query?: Record<string, string | undefined>,
): Promise<BinaryResult> {
	const apiKey = requireSetting(runtime, "ELEVENLABS_API_KEY");
	const response = await fetch(elevenlabsUrl(runtime, path, query), {
		method: "POST",
		headers: { "xi-api-key": apiKey },
		body: form,
	});
	return binaryResponse(response);
}

async function postElevenlabsFormJson(
	runtime: IAgentRuntime,
	path: string,
	form: FormData,
): Promise<unknown> {
	const apiKey = requireSetting(runtime, "ELEVENLABS_API_KEY");
	const response = await fetch(elevenlabsUrl(runtime, path), {
		method: "POST",
		headers: { "xi-api-key": apiKey },
		body: form,
	});
	return jsonResponse(response);
}

function contentTypeForPath(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".wav") return "audio/wav";
	if (ext === ".mp3") return "audio/mpeg";
	if (ext === ".m4a") return "audio/mp4";
	if (ext === ".ogg") return "audio/ogg";
	if (ext === ".flac") return "audio/flac";
	return "application/octet-stream";
}

function expandPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

async function audioBlob(source: string): Promise<{ blob: Blob; filename: string }> {
	if (/^https?:\/\//i.test(source)) {
		const response = await fetch(source);
		if (!response.ok) throw new Error(`Could not fetch audio source: ${await responseError(response)}`);
		const blob = await response.blob();
		return { blob, filename: basename(new URL(source).pathname) || "audio" };
	}
	const path = resolve(expandPath(source));
	const bytes = await readFile(path);
	return {
		blob: new Blob([new Uint8Array(bytes)], { type: contentTypeForPath(path) }),
		filename: basename(path),
	};
}

async function emit(callback: HandlerCallback | undefined, text: string, content?: unknown): Promise<void> {
	if (!callback) return;
	await callback({ text, content } as never);
}

function ok(text: string, values?: Record<string, unknown>): ActionResult {
	return { success: true, text, ...(values ? { values: values as never, data: values as never } : {}) };
}

function fail(text: string): ActionResult {
	return { success: false, text, error: text };
}

function actionValidate(pattern: RegExp): Action["validate"] {
	return async (_runtime, message) => pattern.test((message.content?.text ?? "").toLowerCase());
}

export const elevenlabsTextToSpeechAction: Action = {
	name: "ELEVENLABS_TEXT_TO_SPEECH",
	similes: ["GENERATE_VOICE", "CREATE_VOICEOVER", "TEXT_TO_SPEECH", "TTS"],
	description:
		"Generate spoken audio with ElevenLabs text-to-speech. Returns the saved local audio path.",
	descriptionCompressed: "Generate ElevenLabs speech audio from text and save the file locally.",
	parameters: [
		{ name: "text", description: "Text to speak.", required: true, schema: { type: "string" } },
		{ name: "voiceId", description: "ElevenLabs voice id.", required: false, schema: { type: "string" } },
		{ name: "modelId", description: "TTS model id.", required: false, schema: { type: "string" } },
		{ name: "outputFormat", description: "Audio output format.", required: false, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(voice|voiceover|narrat|speak|speech|tts|text to speech)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const text = promptFrom(message, params);
			const voiceId = firstString(params, ["voiceId", "voice_id"]) ?? getSetting(runtime, "ELEVENLABS_VOICE_ID", DEFAULT_TTS_VOICE_ID)!;
			const modelId = firstString(params, ["modelId", "model_id"]) ?? getSetting(runtime, "ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")!;
			const outputFormat = firstString(params, ["outputFormat", "output_format"]) ?? getSetting(runtime, "ELEVENLABS_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT)!;
			const result = await postElevenlabsJson(
				runtime,
				`/text-to-speech/${encodeURIComponent(voiceId)}`,
				{ text, model_id: modelId },
				{ output_format: outputFormat },
			);
			const saved = await saveAudio(runtime, "elevenlabs", text, result, outputFormat);
			const reply = `Generated ElevenLabs speech: ${saved.path}`;
			await emit(callback, reply, saved);
			return ok(reply, { audio: saved, provider: "elevenlabs", capability: "text-to-speech" });
		} catch (err) {
			const text = `ElevenLabs text-to-speech failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsVoiceChangeAction: Action = {
	name: "ELEVENLABS_VOICE_CHANGE",
	similes: ["VOICE_CHANGER", "SPEECH_TO_SPEECH", "CHANGE_VOICE", "VOICE_CONVERSION"],
	description:
		"Transform an audio file or URL into another ElevenLabs voice while preserving delivery.",
	descriptionCompressed: "Run ElevenLabs voice changer on an audio path or URL.",
	parameters: [
		{ name: "audioPath", description: "Local audio path, or use audioUrl.", required: true, schema: { type: "string" } },
		{ name: "voiceId", description: "Output ElevenLabs voice id.", required: false, schema: { type: "string" } },
		{ name: "removeBackgroundNoise", description: "Use audio isolation before conversion.", required: false, schema: { type: "boolean" } },
	],
	validate: actionValidate(/\b(voice changer|change voice|speech to speech|convert voice|voice conversion)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const source = audioSourceFrom(params);
			const voiceId = firstString(params, ["voiceId", "voice_id"]) ?? getSetting(runtime, "ELEVENLABS_VOICE_ID", DEFAULT_TTS_VOICE_ID);
			if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID is not configured.");
			const modelId = firstString(params, ["modelId", "model_id"]) ?? getSetting(runtime, "ELEVENLABS_STS_MODEL_ID", "eleven_multilingual_sts_v2")!;
			const outputFormat = firstString(params, ["outputFormat", "output_format"]) ?? getSetting(runtime, "ELEVENLABS_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT)!;
			const audio = await audioBlob(source);
			const form = new FormData();
			form.append("audio", audio.blob, audio.filename);
			form.append("model_id", modelId);
			if (firstBool(params, ["removeBackgroundNoise", "remove_background_noise"], false)) {
				form.append("remove_background_noise", "true");
			}
			const result = await postElevenlabsForm(
				runtime,
				`/speech-to-speech/${encodeURIComponent(voiceId)}`,
				form,
				{ output_format: outputFormat },
			);
			const saved = await saveAudio(runtime, "elevenlabs", `voice-change-${audio.filename}`, result, outputFormat);
			const reply = `Generated ElevenLabs voice-change audio: ${saved.path}`;
			await emit(callback, reply, saved);
			return ok(reply, { audio: saved, provider: "elevenlabs", capability: "voice-changer" });
		} catch (err) {
			const text = `ElevenLabs voice changer failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsTranscribeAction: Action = {
	name: "ELEVENLABS_TRANSCRIBE",
	similes: ["SPEECH_TO_TEXT", "TRANSCRIBE_AUDIO", "STT"],
	description:
		"Transcribe an audio file or URL with ElevenLabs speech-to-text.",
	descriptionCompressed: "Transcribe audio through ElevenLabs speech-to-text.",
	parameters: [
		{ name: "audioPath", description: "Local audio path, or use audioUrl.", required: true, schema: { type: "string" } },
		{ name: "modelId", description: "Speech-to-text model id.", required: false, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(transcribe|speech to text|stt|caption audio)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const source = audioSourceFrom(params);
			const modelId = firstString(params, ["modelId", "model_id"]) ?? getSetting(runtime, "ELEVENLABS_STT_MODEL_ID", "scribe_v1")!;
			const audio = await audioBlob(source);
			const form = new FormData();
			form.append("file", audio.blob, audio.filename);
			form.append("model_id", modelId);
			const response = await postElevenlabsFormJson(runtime, "/speech-to-text", form);
			const transcript = transcriptFrom(response);
			const reply = transcript ? `Transcript:\n${transcript}` : "Transcription completed.";
			await emit(callback, reply, response);
			return ok(reply, { transcript, response, provider: "elevenlabs", capability: "speech-to-text" });
		} catch (err) {
			const text = `ElevenLabs transcription failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

function transcriptFrom(response: unknown): string {
	if (!response || typeof response !== "object") return "";
	const record = response as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	const transcripts = record.transcripts;
	if (Array.isArray(transcripts)) {
		return transcripts
			.map((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string"
				? (entry as Record<string, unknown>).text
				: "")
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function parseDialogueInputs(value: unknown, defaultVoiceId: string): Array<{ text: string; voice_id: string }> {
	let raw = value;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
			raw = JSON.parse(trimmed) as unknown;
		} else {
			raw = [{ text: trimmed, voice_id: defaultVoiceId }];
		}
	}
	if (!Array.isArray(raw)) throw new Error("inputs must be an array of dialogue turns.");
	const inputs = raw.flatMap((entry): Array<{ text: string; voice_id: string }> => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as Record<string, unknown>;
		const text = typeof record.text === "string" ? record.text.trim() : "";
		const voiceId = typeof record.voice_id === "string"
			? record.voice_id
			: typeof record.voiceId === "string"
				? record.voiceId
				: defaultVoiceId;
		return text ? [{ text, voice_id: voiceId }] : [];
	});
	if (inputs.length === 0) throw new Error("inputs must include at least one dialogue turn.");
	return inputs;
}

function jsonSummary(value: unknown, maxLength = 2_000): string {
	const text = JSON.stringify(value, null, 2);
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function decodeBase64Audio(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, "base64"));
}

export const elevenlabsVoicesSearchAction: Action = {
	name: "ELEVENLABS_VOICES_SEARCH",
	similes: ["LIST_ELEVENLABS_VOICES", "SEARCH_VOICES", "FIND_VOICE_ID"],
	description:
		"Search/list ElevenLabs voices so the agent can pick voice IDs for TTS, dialogue, and voice changer.",
	descriptionCompressed: "Search/list ElevenLabs voices and return voice IDs.",
	parameters: [
		{ name: "search", description: "Voice search term.", required: false, schema: { type: "string" } },
		{ name: "pageSize", description: "Number of voices to return.", required: false, schema: { type: "number" } },
	],
	validate: actionValidate(/\b(elevenlabs).{0,40}\b(voice list|voices|voice id|search voices|find voice)\b|\b(search voices|voice ids?)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const pageSize = Math.min(100, Math.max(1, Math.round(firstNumber(params, ["pageSize", "page_size", "limit"]) ?? 10)));
			const response = await getElevenlabsJson(runtime, "/v2/voices", {
				search: firstString(params, ["search", "query"]),
				page_size: String(pageSize),
				voice_type: firstString(params, ["voiceType", "voice_type"]),
			});
			const reply = `ElevenLabs voices:\n${voiceListSummary(response)}`;
			await emit(callback, reply, response);
			return ok(reply, { response, provider: "elevenlabs", capability: "voices" });
		} catch (err) {
			const text = `ElevenLabs voice search failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

function voiceListSummary(response: unknown): string {
	if (!response || typeof response !== "object") return jsonSummary(response);
	const voices = (response as Record<string, unknown>).voices;
	if (!Array.isArray(voices)) return jsonSummary(response);
	const lines = voices.slice(0, 20).flatMap((voice): string[] => {
		if (!voice || typeof voice !== "object") return [];
		const record = voice as Record<string, unknown>;
		const id = typeof record.voice_id === "string" ? record.voice_id : "";
		const name = typeof record.name === "string" ? record.name : "(unnamed)";
		const desc = typeof record.description === "string" && record.description.length > 0
			? ` - ${record.description.slice(0, 120)}`
			: "";
		return id ? [`- ${name}: ${id}${desc}`] : [];
	});
	return lines.length > 0 ? lines.join("\n") : jsonSummary(response);
}

export const elevenlabsTextToDialogueAction: Action = {
	name: "ELEVENLABS_TEXT_TO_DIALOGUE",
	similes: ["CREATE_DIALOGUE", "GENERATE_DIALOGUE_AUDIO", "MULTI_SPEAKER_TTS"],
	description:
		"Generate multi-speaker dialogue audio with ElevenLabs Text to Dialogue.",
	descriptionCompressed: "Generate ElevenLabs multi-speaker dialogue audio.",
	parameters: [
		{ name: "inputs", description: "Array of { text, voice_id } dialogue turns.", required: true, schema: { type: "array" } },
		{ name: "modelId", description: "Dialogue model id.", required: false, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(dialogue|dialog|multi speaker|conversation audio|two voices)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const defaultVoiceId = getSetting(runtime, "ELEVENLABS_VOICE_ID", DEFAULT_TTS_VOICE_ID)!;
			const inputs = parseDialogueInputs(params.inputs ?? params.dialogue ?? params.turns, defaultVoiceId);
			const outputFormat = firstString(params, ["outputFormat", "output_format"]) ?? getSetting(runtime, "ELEVENLABS_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT)!;
			const result = await postElevenlabsJson(
				runtime,
				"/text-to-dialogue",
				{
					inputs,
					model_id: firstString(params, ["modelId", "model_id"]) ?? "eleven_v3",
				},
				{ output_format: outputFormat },
			);
			const saved = await saveAudio(runtime, "elevenlabs", "dialogue", result, outputFormat);
			const reply = `Generated ElevenLabs dialogue audio: ${saved.path}`;
			await emit(callback, reply, saved);
			return ok(reply, { audio: saved, provider: "elevenlabs", capability: "text-to-dialogue" });
		} catch (err) {
			const text = `ElevenLabs dialogue generation failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsVoiceDesignAction: Action = {
	name: "ELEVENLABS_VOICE_DESIGN",
	similes: ["DESIGN_ELEVENLABS_VOICE", "GENERATE_VOICE_PREVIEW", "TEXT_TO_VOICE_DESIGN"],
	description:
		"Design a new ElevenLabs voice from a text description and save returned preview audio.",
	descriptionCompressed: "Design an ElevenLabs voice and return preview generated_voice_id values.",
	parameters: [
		{ name: "voiceDescription", description: "Description of the desired voice.", required: true, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(design voice|generate voice preview|text to voice|new voice)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const voiceDescription = firstString(params, ["voiceDescription", "voice_description", "description", "prompt"]) ?? promptFrom(message, params);
			const response = await postElevenlabsJsonResponse(runtime, "/text-to-voice/design", {
				voice_description: voiceDescription,
			});
			const previews = await saveVoicePreviews(runtime, voiceDescription, response);
			const reply = `Designed ElevenLabs voice previews:\n${previews.join("\n")}`;
			await emit(callback, reply, response);
			return ok(reply, { response, previews, provider: "elevenlabs", capability: "voice-design" });
		} catch (err) {
			const text = `ElevenLabs voice design failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

async function saveVoicePreviews(runtime: IAgentRuntime, description: string, response: unknown): Promise<string[]> {
	if (!response || typeof response !== "object") return [jsonSummary(response)];
	const previews = (response as Record<string, unknown>).previews;
	if (!Array.isArray(previews)) return [jsonSummary(response)];
	const lines: string[] = [];
	for (const preview of previews) {
		if (!preview || typeof preview !== "object") continue;
		const record = preview as Record<string, unknown>;
		const id = typeof record.generated_voice_id === "string" ? record.generated_voice_id : "";
		const b64 = typeof record.audio_base_64 === "string" ? record.audio_base_64 : "";
		if (!id || !b64) continue;
		const bytes = decodeBase64Audio(b64);
		const saved = await saveAudio(
			runtime,
			"elevenlabs",
			`voice-preview-${description}`,
			{ bytes, contentType: typeof record.media_type === "string" ? record.media_type : "audio/mpeg" },
			"mp3_44100_128",
		);
		lines.push(`- ${id}: ${saved.path}`);
	}
	return lines.length > 0 ? lines : [jsonSummary(response)];
}

export const elevenlabsVoiceCreateAction: Action = {
	name: "ELEVENLABS_VOICE_CREATE",
	similes: ["CREATE_ELEVENLABS_VOICE", "SAVE_DESIGNED_VOICE"],
	description:
		"Create/save an ElevenLabs voice from a generated_voice_id returned by ELEVENLABS_VOICE_DESIGN.",
	descriptionCompressed: "Create an ElevenLabs voice from a generated_voice_id.",
	parameters: [
		{ name: "generatedVoiceId", description: "generated_voice_id from voice design/remix.", required: true, schema: { type: "string" } },
		{ name: "voiceName", description: "Name for the new voice.", required: true, schema: { type: "string" } },
		{ name: "voiceDescription", description: "Voice description.", required: true, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(create voice|save designed voice|generated voice id)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const generatedVoiceId = firstString(params, ["generatedVoiceId", "generated_voice_id"]);
			const voiceName = firstString(params, ["voiceName", "voice_name", "name"]);
			const voiceDescription = firstString(params, ["voiceDescription", "voice_description", "description"]);
			if (!generatedVoiceId || !voiceName || !voiceDescription) {
				throw new Error("generatedVoiceId, voiceName, and voiceDescription are required.");
			}
			const response = await postElevenlabsJsonResponse(runtime, "/text-to-voice", {
				generated_voice_id: generatedVoiceId,
				voice_name: voiceName,
				voice_description: voiceDescription,
			});
			const reply = `Created ElevenLabs voice:\n${jsonSummary(response)}`;
			await emit(callback, reply, response);
			return ok(reply, { response, provider: "elevenlabs", capability: "voice-create" });
		} catch (err) {
			const text = `ElevenLabs voice create failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsVoiceIsolateAction: Action = {
	name: "ELEVENLABS_VOICE_ISOLATE",
	similes: ["AUDIO_ISOLATION", "ISOLATE_VOICE", "REMOVE_BACKGROUND_NOISE"],
	description:
		"Isolate speech from background noise in an audio file or URL with ElevenLabs audio isolation.",
	descriptionCompressed: "Run ElevenLabs audio isolation and save the cleaned audio.",
	parameters: [
		{ name: "audioPath", description: "Local audio path, or use audioUrl.", required: true, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(isolate voice|audio isolation|remove background noise|clean audio)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const source = audioSourceFrom(params);
			const audio = await audioBlob(source);
			const form = new FormData();
			form.append("audio", audio.blob, audio.filename);
			const result = await postElevenlabsForm(runtime, "/audio-isolation", form);
			const saved = await saveAudio(runtime, "elevenlabs", `isolated-${audio.filename}`, result, "mp3_44100_128");
			const reply = `Generated isolated ElevenLabs audio: ${saved.path}`;
			await emit(callback, reply, saved);
			return ok(reply, { audio: saved, provider: "elevenlabs", capability: "audio-isolation" });
		} catch (err) {
			const text = `ElevenLabs audio isolation failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsSoundEffectAction: Action = {
	name: "ELEVENLABS_SOUND_EFFECT",
	similes: ["GENERATE_SOUND_EFFECT", "CREATE_SFX", "TEXT_TO_SOUND_EFFECTS", "SFX"],
	description:
		"Generate a sound effect with ElevenLabs text-to-sound-effects. Returns the saved local audio path.",
	descriptionCompressed: "Generate ElevenLabs sound effects from text and save the file locally.",
	parameters: [
		{ name: "prompt", description: "Sound effect description.", required: true, schema: { type: "string" } },
		{ name: "durationSeconds", description: "Optional 0.5-30 second duration.", required: false, schema: { type: "number" } },
		{ name: "loop", description: "Generate a seamless looping effect.", required: false, schema: { type: "boolean" } },
	],
	validate: actionValidate(/\b(sound effect|sfx|foley|ambience|ambient sound|text to sound)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const text = promptFrom(message, params);
			const outputFormat = firstString(params, ["outputFormat", "output_format"]) ?? getSetting(runtime, "ELEVENLABS_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT)!;
			const body: Record<string, unknown> = {
				text,
				loop: firstBool(params, ["loop"], false),
				model_id: firstString(params, ["modelId", "model_id"]) ?? getSetting(runtime, "ELEVENLABS_SOUND_MODEL_ID", "eleven_text_to_sound_v2"),
			};
			const duration = firstNumber(params, ["durationSeconds", "duration_seconds", "duration"]);
			if (duration !== undefined) body.duration_seconds = duration;
			const promptInfluence = firstNumber(params, ["promptInfluence", "prompt_influence"]);
			if (promptInfluence !== undefined) body.prompt_influence = promptInfluence;
			const result = await postElevenlabsJson(runtime, "/sound-generation", body, { output_format: outputFormat });
			const saved = await saveAudio(runtime, "elevenlabs", text, result, outputFormat);
			const reply = `Generated ElevenLabs sound effect: ${saved.path}`;
			await emit(callback, reply, saved);
			return ok(reply, { audio: saved, provider: "elevenlabs", capability: "sound-effects" });
		} catch (err) {
			const text = `ElevenLabs sound effect failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsMusicAction: Action = {
	name: "ELEVENLABS_MUSIC",
	similes: ["ELEVEN_MUSIC", "GENERATE_MUSIC", "COMPOSE_MUSIC", "CREATE_SONG"],
	description:
		"Generate a full music track with ElevenLabs Music API. Returns the saved local audio path.",
	descriptionCompressed: "Generate ElevenLabs Music API tracks and save the file locally.",
	parameters: [
		{ name: "prompt", description: "Music prompt.", required: true, schema: { type: "string" } },
		{ name: "durationSeconds", description: "Optional track length in seconds.", required: false, schema: { type: "number" } },
		{ name: "forceInstrumental", description: "Guarantee instrumental output.", required: false, schema: { type: "boolean" } },
	],
	validate: actionValidate(/\b(eleven music|music api|generate music|compose music|create song|make a song|track)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const prompt = promptFrom(message, params);
			const outputFormat = firstString(params, ["outputFormat", "output_format"]) ?? getSetting(runtime, "ELEVENLABS_MUSIC_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT)!;
			const durationSeconds = firstNumber(params, ["durationSeconds", "duration_seconds", "duration"]);
			const body: Record<string, unknown> = {
				prompt,
				model_id: firstString(params, ["modelId", "model_id"]) ?? getSetting(runtime, "ELEVENLABS_MUSIC_MODEL_ID", "music_v1"),
				force_instrumental: firstBool(params, ["forceInstrumental", "force_instrumental", "instrumental"], false),
			};
			if (durationSeconds !== undefined) body.music_length_ms = Math.round(durationSeconds * 1000);
			const result = await postElevenlabsJson(runtime, "/music", body, { output_format: outputFormat });
			const saved = await saveAudio(runtime, "elevenlabs", prompt, result, outputFormat);
			const reply = `Generated ElevenLabs music: ${saved.path}`;
			await emit(callback, reply, saved);
			return ok(reply, { audio: saved, provider: "elevenlabs", capability: "music" });
		} catch (err) {
			const text = `ElevenLabs music generation failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsDubbingCreateAction: Action = {
	name: "ELEVENLABS_DUB_CREATE",
	similes: ["CREATE_DUBBING", "DUB_AUDIO", "DUB_VIDEO", "TRANSLATE_AUDIO"],
	description:
		"Create an ElevenLabs dubbing job from an audio/video file path or source URL.",
	descriptionCompressed: "Create an ElevenLabs dubbing job and return dubbing_id.",
	parameters: [
		{ name: "targetLang", description: "Target language code.", required: true, schema: { type: "string" } },
		{ name: "sourceUrl", description: "Source audio/video URL.", required: false, schema: { type: "string" } },
		{ name: "audioPath", description: "Local audio/video path.", required: false, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(dub|dubbing|translate audio|translate video|localize audio)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const targetLang = firstString(params, ["targetLang", "target_lang", "language"]);
			if (!targetLang) throw new Error("targetLang is required.");
			const form = new FormData();
			form.append("target_lang", targetLang);
			const name = firstString(params, ["name"]);
			if (name) form.append("name", name);
			const sourceLang = firstString(params, ["sourceLang", "source_lang"]);
			if (sourceLang) form.append("source_lang", sourceLang);
			const sourceUrl = firstString(params, ["sourceUrl", "source_url", "url"]);
			if (sourceUrl) {
				form.append("source_url", sourceUrl);
			} else {
				const source = audioSourceFrom(params);
				const audio = await audioBlob(source);
				form.append("file", audio.blob, audio.filename);
			}
			form.append("disable_voice_cloning", String(firstBool(params, ["disableVoiceCloning", "disable_voice_cloning"], true)));
			form.append("drop_background_audio", String(firstBool(params, ["dropBackgroundAudio", "drop_background_audio"], false)));
			form.append("watermark", String(firstBool(params, ["watermark"], false)));
			const response = await postElevenlabsFormJson(runtime, "/dubbing", form);
			const reply = `Created ElevenLabs dubbing job:\n${jsonSummary(response)}`;
			await emit(callback, reply, response);
			return ok(reply, { response, provider: "elevenlabs", capability: "dubbing" });
		} catch (err) {
			const text = `ElevenLabs dubbing create failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsDubbingStatusAction: Action = {
	name: "ELEVENLABS_DUB_STATUS",
	similes: ["GET_DUBBING", "DUBBING_STATUS", "CHECK_DUB_STATUS"],
	description:
		"Get status/metadata for an ElevenLabs dubbing job.",
	descriptionCompressed: "Check ElevenLabs dubbing job status by dubbing_id.",
	parameters: [
		{ name: "dubbingId", description: "Dubbing job id.", required: true, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(dub|dubbing).{0,40}\b(status|ready|done|metadata|check)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const dubbingId = firstString(params, ["dubbingId", "dubbing_id", "id"]);
			if (!dubbingId) throw new Error("dubbingId is required.");
			const response = await getElevenlabsJson(runtime, `/dubbing/${encodeURIComponent(dubbingId)}`);
			const reply = `ElevenLabs dubbing status:\n${jsonSummary(response)}`;
			await emit(callback, reply, response);
			return ok(reply, { response, provider: "elevenlabs", capability: "dubbing-status" });
		} catch (err) {
			const text = `ElevenLabs dubbing status failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const elevenlabsDubbingDownloadAction: Action = {
	name: "ELEVENLABS_DUB_DOWNLOAD",
	similes: ["DOWNLOAD_DUBBING", "GET_DUBBED_AUDIO", "DUB_AUDIO_DOWNLOAD"],
	description:
		"Download generated dubbed audio/video for an ElevenLabs dubbing job.",
	descriptionCompressed: "Download ElevenLabs dubbed media by dubbing_id and language code.",
	parameters: [
		{ name: "dubbingId", description: "Dubbing job id.", required: true, schema: { type: "string" } },
		{ name: "languageCode", description: "Target language code.", required: true, schema: { type: "string" } },
	],
	validate: actionValidate(/\b(dub|dubbing).{0,40}\b(download|get audio|get media)\b/),
	handler: async (runtime, message, _state, options, callback) => {
		try {
			const params = paramsFrom(message, options);
			const dubbingId = firstString(params, ["dubbingId", "dubbing_id", "id"]);
			const languageCode = firstString(params, ["languageCode", "language_code", "lang"]);
			if (!dubbingId || !languageCode) throw new Error("dubbingId and languageCode are required.");
			const result = await getElevenlabsBinary(
				runtime,
				`/dubbing/${encodeURIComponent(dubbingId)}/audio/${encodeURIComponent(languageCode)}`,
			);
			const saved = await saveAudio(runtime, "elevenlabs", `dub-${dubbingId}-${languageCode}`, result, undefined);
			const reply = `Downloaded ElevenLabs dubbed media: ${saved.path}`;
			await emit(callback, reply, saved);
			return ok(reply, { audio: saved, provider: "elevenlabs", capability: "dubbing-download" });
		} catch (err) {
			const text = `ElevenLabs dubbing download failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, text);
			return fail(text);
		}
	},
};

export const audioGenerationStatusProvider: Provider = {
	name: "AUDIO_GENERATION_STATUS",
	description:
		"Configured audio-generation providers and their available actions.",
	descriptionCompressed: "audio generation provider status.",
	position: -45,
	get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
		const elevenlabsConfigured = Boolean(getSetting(runtime, "ELEVENLABS_API_KEY"));
		return {
			text: [
				"# Audio generation status",
				`ElevenLabs: ${elevenlabsConfigured ? "configured" : "missing ELEVENLABS_API_KEY"}`,
				"Gallery: generated speech, dialogue, sound effects, music, and downloaded dubbing media are saved to Detour Gallery.",
				"Actions: ELEVENLABS_TEXT_TO_SPEECH, ELEVENLABS_VOICE_CHANGE, ELEVENLABS_TRANSCRIBE, ELEVENLABS_VOICES_SEARCH, ELEVENLABS_TEXT_TO_DIALOGUE, ELEVENLABS_VOICE_DESIGN, ELEVENLABS_VOICE_CREATE, ELEVENLABS_VOICE_ISOLATE, ELEVENLABS_SOUND_EFFECT, ELEVENLABS_MUSIC, ELEVENLABS_DUB_CREATE, ELEVENLABS_DUB_STATUS, ELEVENLABS_DUB_DOWNLOAD.",
			].join("\n"),
			values: { elevenlabsConfigured },
		};
	},
};

export const audioGenerationPlugin: Plugin = {
	name: "audio-generation",
	description:
		"ElevenLabs voice, speech, dubbing, sound effects, and music generation.",
	actions: [
		elevenlabsTextToSpeechAction,
		elevenlabsVoiceChangeAction,
		elevenlabsTranscribeAction,
		elevenlabsVoicesSearchAction,
		elevenlabsTextToDialogueAction,
		elevenlabsVoiceDesignAction,
		elevenlabsVoiceCreateAction,
		elevenlabsVoiceIsolateAction,
		elevenlabsSoundEffectAction,
		elevenlabsMusicAction,
		elevenlabsDubbingCreateAction,
		elevenlabsDubbingStatusAction,
		elevenlabsDubbingDownloadAction,
	],
	providers: [audioGenerationStatusProvider],
};

export default audioGenerationPlugin;
