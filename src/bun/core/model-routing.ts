/**
 * model-routing — SINGLE source of truth for which provider serves
 * every model modality in Detour. Local or cloud, generative or
 * analytical, eliza-registered ModelType handler or standalone action.
 *
 * Surface this module exposes:
 *
 *   - `RoutedType`           one id per modality (image, video, tts, etc.)
 *   - `ROUTING_CATALOG`      every modality's options + default + which
 *                            store backs its selection
 *   - `getProviderFor(rt,t)` resolves the active provider id for type
 *   - `setProviderFor(rt,t)` persists a user pick to the right store
 *   - `isLocalPreferredFor(rt,t)` legacy gate the local-mlx-* plugins use
 *   - `ROUTING_SETTING_KEYS` allowlist of env keys the settings.set RPC
 *                            is permitted to write
 *
 * The blast-radius design notes:
 *
 * (1) Chat ("TEXT") was historically a different mechanism — vault key
 *     `trayapp.activeProvider`. We expose it as just another RoutedType
 *     here so the UI is uniform; under the hood we still read/write that
 *     vault key for chat because the rest of the runtime keys on it.
 *
 * (2) VIDEO_GENERATION had ZERO `runtime.registerModel` calls before
 *     this consolidation — UI advertised it but `useModel` would throw.
 *     We register cloud handlers (elizacloud, openrouter) inside the
 *     model-router plugin so `useModel(VIDEO_GENERATION, ...)` works.
 *     Local video stays unsupported (no working MLX-Swift port; the
 *     SDXL-frame-stitch experiment froze 16GB Macs).
 *
 * (3) ElevenLabs sub-modalities (TTS / music / SFX / voice design / dub)
 *     stay as plain actions for now — they're discrete one-shot APIs
 *     with their own param shapes, not drop-in TEXT_TO_SPEECH replacements.
 *     But the UI catalogs them so the user sees ONE place that lists
 *     every audio modality. ElevenLabs config is "API key in vault" —
 *     unchanged.
 *
 * (4) Legacy `LOCAL_MLX_<TYPE>_ENABLED` booleans are still honored as a
 *     fallback so existing user setups don't break. Setting any new
 *     provider via `setProviderFor` migrates the user off the legacy
 *     toggle on next save.
 */

import type { IAgentRuntime } from "@elizaos/core";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/// Every modality the user can route. Order here drives UI display
/// order. The "TEXT" entry covers all chat/planner traffic — every
/// `useModel(TEXT_*)` call resolves through this row.
export type RoutedType =
	| "TEXT"
	| "IMAGE"
	| "IMAGE_DESCRIPTION"
	| "TRANSCRIPTION"
	| "TEXT_TO_SPEECH"
	| "VIDEO_GENERATION"
	| "MUSIC"
	| "SOUND_EFFECT"
	| "VOICE_DESIGN"
	| "TEXT_EMBEDDING";

export interface RoutingOption {
	id: string;            // "anthropic", "local-mlx-image", "elizacloud", etc.
	label: string;         // human-readable
	kind: "local" | "cloud";
	/** Set at snapshot time based on whether the relevant API key /
	 * local socket / plan is reachable. UI greys out unavailable opts. */
	available?: boolean;
	/** UX hint: short note shown under the option ("requires API key",
	 * "Apple Silicon only", "Pro plan", "16GB+ free RAM"). */
	hint?: string;
}

export interface RoutingCatalogEntry {
	type: RoutedType;
	label: string;
	/** One-sentence description shown in the UI under the modality name. */
	help: string;
	/** Default provider when nothing is explicitly selected. */
	default: string | null;
	options: ReadonlyArray<Omit<RoutingOption, "available">>;
	/** Where this modality's selection is persisted. `vault` = the
	 * existing `trayapp.activeProvider` key (chat only); `env` = the
	 * `DETOUR_MODEL_<TYPE>_PROVIDER` env var via settings.set. */
	store: "vault" | "env";
}

// ──────────────────────────────────────────────────────────────────────
// Catalog — every modality, every provider
// ──────────────────────────────────────────────────────────────────────

export const ROUTING_CATALOG: ReadonlyArray<RoutingCatalogEntry> = [
	{
		type: "TEXT",
		label: "Chat / planner",
		help: "Drives every conversation, action plan, and reflection. The single most-used modality.",
		default: "anthropic",
		store: "vault",
		options: [
			{ id: "anthropic", label: "Anthropic (Claude)", kind: "cloud", hint: "Pro/Max subscription or API key" },
			{ id: "openai", label: "OpenAI", kind: "cloud", hint: "Codex subscription or API key" },
			{ id: "openrouter", label: "OpenRouter", kind: "cloud", hint: "Single API key, multi-model router" },
			{ id: "elizacloud", label: "ElizaCloud", kind: "cloud", hint: "First-party hosted models" },
			{ id: "codex-chatgpt", label: "ChatGPT (Codex)", kind: "cloud", hint: "Free with Codex CLI auth" },
			{ id: "local-chat", label: "Local (llama.cpp/MLX-LM)", kind: "local", hint: "16GB+ free RAM recommended" },
		],
	},
	{
		type: "IMAGE",
		label: "Image generation",
		help: "Text-to-image. Used by GENERATE_IMAGE, media-generation, and any agent action that produces visuals.",
		default: "elizacloud",
		store: "env",
		options: [
			{ id: "local-mlx-image", label: "Local MLX (SDXL Turbo)", kind: "local", hint: "Apple Silicon, ~7GB disk" },
			{ id: "elizacloud", label: "ElizaCloud (Gemini Flash Image)", kind: "cloud" },
			{ id: "openrouter", label: "OpenRouter", kind: "cloud" },
			{ id: "codex-chatgpt", label: "ChatGPT image", kind: "cloud", hint: "via Codex subscription" },
		],
	},
	{
		type: "IMAGE_DESCRIPTION",
		label: "Vision (describe / OCR)",
		help: "Image → text. Powers reading screenshots, captioning photos, and tool calls that look at images.",
		default: "anthropic",
		store: "env",
		options: [
			{ id: "local-mlx-vision", label: "Local MLX (Apple Vision + Qwen3-VL)", kind: "local", hint: "OCR ships; Qwen3-VL pending vendor" },
			{ id: "anthropic", label: "Anthropic Claude (vision)", kind: "cloud" },
			{ id: "openai", label: "OpenAI GPT-4 (vision)", kind: "cloud" },
			{ id: "openrouter", label: "OpenRouter", kind: "cloud" },
		],
	},
	{
		type: "TRANSCRIPTION",
		label: "Speech-to-text",
		help: "Audio → text. Used by mic dictation, voice memos, and the agent's TRANSCRIBE_MEDIA action.",
		default: "local-mlx-stt",
		store: "env",
		options: [
			{ id: "local-mlx-stt", label: "Local MLX (Apple Speech)", kind: "local", hint: "On-device, offline" },
			{ id: "openai", label: "OpenAI Whisper API", kind: "cloud" },
			{ id: "elizacloud", label: "ElizaCloud Whisper", kind: "cloud" },
			{ id: "elevenlabs", label: "ElevenLabs Transcribe", kind: "cloud", hint: "Highest quality, paid" },
		],
	},
	{
		type: "TEXT_TO_SPEECH",
		label: "Text-to-speech",
		help: "Agent voice output. Picks the engine when the agent speaks back to you.",
		default: "local-mlx-tts",
		store: "env",
		options: [
			{ id: "local-mlx-tts", label: "Local (AVSpeech)", kind: "local", hint: "Free, on-device" },
			{ id: "openai", label: "OpenAI TTS", kind: "cloud" },
			{ id: "elizacloud", label: "ElizaCloud TTS", kind: "cloud" },
			{ id: "elevenlabs", label: "ElevenLabs", kind: "cloud", hint: "Studio-grade voices, paid" },
		],
	},
	{
		type: "VIDEO_GENERATION",
		label: "Video generation",
		help: "Text-to-video / image-to-video. Used by GENERATE_VIDEO, X media attach, and Detour Gallery.",
		default: "elizacloud",
		store: "env",
		options: [
			// No local — no working MLX-Swift video model fits in 16GB
			// budget on Apple Silicon. SDXL-frame-stitch was tried and
			// removed (froze main thread).
			{ id: "elizacloud", label: "ElizaCloud (Veo3)", kind: "cloud", hint: "Pro plan" },
			{ id: "openrouter", label: "OpenRouter (Veo)", kind: "cloud" },
		],
	},
	{
		type: "MUSIC",
		label: "Music generation",
		help: "Full-track music. Currently only ElevenLabs Music supports this for Detour.",
		default: "elevenlabs",
		store: "env",
		options: [
			{ id: "elevenlabs", label: "ElevenLabs Music", kind: "cloud", hint: "Paid" },
		],
	},
	{
		type: "SOUND_EFFECT",
		label: "Sound effects",
		help: "Short SFX from a text description. ElevenLabs only today.",
		default: "elevenlabs",
		store: "env",
		options: [
			{ id: "elevenlabs", label: "ElevenLabs SFX", kind: "cloud", hint: "Paid" },
		],
	},
	{
		type: "VOICE_DESIGN",
		label: "Voice design",
		help: "Synthesize a custom voice from a prompt + save to library.",
		default: "elevenlabs",
		store: "env",
		options: [
			{ id: "elevenlabs", label: "ElevenLabs Voice Design", kind: "cloud", hint: "Paid" },
		],
	},
	{
		type: "TEXT_EMBEDDING",
		label: "Embeddings",
		help: "Vector embeddings for Pensieve search + RAG. Falls back to local bge-small when no API key.",
		default: "local-bge",
		store: "env",
		options: [
			{ id: "local-bge", label: "Local bge-small (llama.cpp)", kind: "local", hint: "On-device, 384-dim" },
			{ id: "openai", label: "OpenAI Embeddings", kind: "cloud" },
			{ id: "openrouter", label: "OpenRouter Embeddings", kind: "cloud" },
		],
	},
];

// Local-provider IDs by RoutedType — used by isLocalPreferredFor() for
// the legacy plugin gate. Modalities with no local provider map to a
// sentinel that no provider id will ever equal.
const LOCAL_PROVIDER_ID: Partial<Record<RoutedType, string>> = {
	TEXT: "local-chat",
	IMAGE: "local-mlx-image",
	IMAGE_DESCRIPTION: "local-mlx-vision",
	TRANSCRIPTION: "local-mlx-stt",
	TEXT_TO_SPEECH: "local-mlx-tts",
	TEXT_EMBEDDING: "local-bge",
};

const LEGACY_LOCAL_ENABLED_KEY: Partial<Record<RoutedType, string>> = {
	IMAGE: "LOCAL_MLX_IMAGE_ENABLED",
	IMAGE_DESCRIPTION: "LOCAL_MLX_VISION_ENABLED",
	TRANSCRIPTION: "LOCAL_MLX_STT_ENABLED",
	TEXT_TO_SPEECH: "LOCAL_MLX_TTS_ENABLED",
};

// ──────────────────────────────────────────────────────────────────────
// Key / store helpers
// ──────────────────────────────────────────────────────────────────────

/** Env/setting key the `env`-store modalities use. */
export function routingEnvKey(type: RoutedType): string {
	return `DETOUR_MODEL_${type}_PROVIDER`;
}

/** Vault key the `vault`-store modalities use (currently only TEXT
 * uses this — it reuses the existing chat-provider selector). */
export function routingVaultKey(type: RoutedType): string {
	if (type === "TEXT") return "trayapp.activeProvider";
	return `trayapp.routing.${type.toLowerCase()}`;
}

function readSetting(runtime: IAgentRuntime | null, key: string): string | undefined {
	if (runtime) {
		const v = runtime.getSetting?.(key);
		if (typeof v === "string" && v.length > 0) return v;
	}
	const env = process.env[key];
	if (typeof env === "string" && env.length > 0) return env;
	return undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/** Catalog entry for a given type, or undefined. */
export function catalogFor(type: RoutedType): RoutingCatalogEntry | undefined {
	return ROUTING_CATALOG.find((c) => c.type === type);
}

/** Get the user-selected provider id, or `null` if unset. Caller
 * should fall back to `catalogFor(type).default` when this is null. */
export function getProviderFor(runtime: IAgentRuntime | null, type: RoutedType): string | null {
	const entry = catalogFor(type);
	if (!entry) return null;
	// env-backed: check the env var first.
	const envVal = readSetting(runtime, routingEnvKey(type));
	if (envVal) return envVal;
	// vault-backed: chat reuses the existing setting. We don't read the
	// vault directly here — the trayStateBuilder + chat handlers do.
	// For non-chat vault entries (none today, reserved for future) we
	// also fall back to env.
	return null;
}

/** True when the local-mlx-* (or local-chat / local-bge) plugin should
 * actually handle a request for this type. Honors the new
 * DETOUR_MODEL_<TYPE>_PROVIDER setting if present; otherwise falls back
 * to the legacy LOCAL_MLX_<TYPE>_ENABLED boolean. */
export function isLocalPreferredFor(runtime: IAgentRuntime, type: RoutedType): boolean {
	const explicit = getProviderFor(runtime, type);
	if (explicit !== null) {
		const localId = LOCAL_PROVIDER_ID[type];
		return localId !== undefined && explicit === localId;
	}
	const legacy = LEGACY_LOCAL_ENABLED_KEY[type];
	if (!legacy) return false;
	const raw = (readSetting(runtime, legacy) ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** The list of allowed routing setting keys for the settings.set RPC
 * allowlist. Includes every env-backed routed type. Vault-backed types
 * have their own RPC path (vault.set / providers.setActive). */
export const ROUTING_SETTING_KEYS: ReadonlyArray<string> = ROUTING_CATALOG
	.filter((c) => c.store === "env")
	.map((c) => routingEnvKey(c.type));

/** Human-readable type labels — kept for compat with older callers
 * that imported ROUTED_TYPE_LABELS directly. */
export const ROUTED_TYPE_LABELS: Record<RoutedType, string> = ROUTING_CATALOG.reduce(
	(acc, c) => {
		acc[c.type] = c.label;
		return acc;
	},
	{} as Record<RoutedType, string>,
);
