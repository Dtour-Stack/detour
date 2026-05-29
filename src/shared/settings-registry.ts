export type SettingGroup =
	| "agent"
	| "audio"
	| "embedding"
	| "media-generation"
	| "mirrored-env"
	| "routing"
	| "x";

export type SettingSource = "config" | "env" | "runtime" | "vault";

export type SettingDefinition = {
	key: string;
	group: SettingGroup;
	source: SettingSource;
	sensitive: boolean;
	mirrorToEnv?: boolean;
	evalWritable?: boolean;
	label?: string;
	placeholder?: string;
	wide?: boolean;
};

function defineSettings<const T extends readonly SettingDefinition[]>(settings: T): T {
	return settings;
}

export const AUDIO_SETTING_DEFINITIONS = defineSettings([
	{ key: "ELEVENLABS_API_KEY", group: "audio", source: "vault", sensitive: true, mirrorToEnv: true, label: "API key", placeholder: "Paste ElevenLabs API key" },
	{ key: "ELEVENLABS_VOICE_ID", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "Voice ID", placeholder: "JBFqnCBsd6RMkjVDRZzb" },
	{ key: "ELEVENLABS_MODEL_ID", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "TTS model", placeholder: "eleven_multilingual_v2" },
	{ key: "ELEVENLABS_STS_MODEL_ID", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "Voice changer model", placeholder: "eleven_multilingual_sts_v2" },
	{ key: "ELEVENLABS_STT_MODEL_ID", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "Speech-to-text model", placeholder: "scribe_v1" },
	{ key: "ELEVENLABS_SOUND_MODEL_ID", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "Sound model", placeholder: "eleven_text_to_sound_v2" },
	{ key: "ELEVENLABS_MUSIC_MODEL_ID", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "Music model", placeholder: "music_v1" },
	{ key: "ELEVENLABS_OUTPUT_FORMAT", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "Output format", placeholder: "mp3_44100_128" },
	{ key: "ELEVENLABS_MUSIC_OUTPUT_FORMAT", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "Music output", placeholder: "mp3_44100_128" },
	{ key: "ELEVENLABS_BASE_URL", group: "audio", source: "vault", sensitive: false, mirrorToEnv: true, label: "Base URL", placeholder: "https://api.elevenlabs.io/v1", wide: true },
] as const);

export type AudioRuntimeSettingKey = (typeof AUDIO_SETTING_DEFINITIONS)[number]["key"];

export const AUDIO_RUNTIME_SETTING_KEYS = AUDIO_SETTING_DEFINITIONS.map((setting) => setting.key) as readonly AudioRuntimeSettingKey[];

export const MEDIA_GENERATION_SETTING_KEYS = [
	"OPENROUTER_MODEL_VIDEO",
	"ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL",
	"ELIZAOS_CLOUD_VIDEO_GENERATION_MODEL",
] as const;

export type MediaGenerationSettingKey = (typeof MEDIA_GENERATION_SETTING_KEYS)[number];

export const EMBEDDING_RUNTIME_SETTING_KEYS = [
	"OPENAI_EMBEDDING_URL",
	"OPENAI_EMBEDDING_API_KEY",
	"OPENAI_EMBEDDING_MODEL",
	"OPENAI_EMBEDDING_DIMENSIONS",
	"OPENAI_EMBEDDING_MAX_CHARS",
] as const;

export type EmbeddingRuntimeSettingKey = (typeof EMBEDDING_RUNTIME_SETTING_KEYS)[number];

export const X_RUNTIME_SETTING_KEYS = [
	"X_AUTH_TOKEN",
	"X_CT0",
	"X_USER_AGENT",
	"X_CHROME_PROFILE",
	"X_AUTONOMY_ENABLED",
	"X_AUTONOMY_WRITE",
	"X_AUTONOMY_POST_STATUS_ENABLED",
	"X_AUTONOMY_DISCOVERY_ENABLED",
	"X_AUTONOMY_PROACTIVE_ENGAGEMENT_ENABLED",
	"X_AUTONOMY_FOLLOW_ENABLED",
	"X_AUTONOMY_INTERVAL_MS",
	"X_AUTONOMY_STATUS_INTERVAL_MS",
	"X_AUTONOMY_DISCOVERY_INTERVAL_MS",
	"X_AUTONOMY_MAX_REPLIES_PER_TICK",
	"X_AUTONOMY_MAX_DISCOVERY_PER_TICK",
	"X_AUTONOMY_DISCOVERY_QUERIES",
] as const;

export type XRuntimeSettingKey = (typeof X_RUNTIME_SETTING_KEYS)[number];

export const MODEL_ROUTING_SETTING_KEYS = [
	"DETOUR_MODEL_IMAGE_PROVIDER",
	"DETOUR_MODEL_IMAGE_DESCRIPTION_PROVIDER",
	"DETOUR_MODEL_TRANSCRIPTION_PROVIDER",
	"DETOUR_MODEL_TEXT_TO_SPEECH_PROVIDER",
	"DETOUR_MODEL_VIDEO_GENERATION_PROVIDER",
	"DETOUR_MODEL_MUSIC_PROVIDER",
	"DETOUR_MODEL_SOUND_EFFECT_PROVIDER",
	"DETOUR_MODEL_VOICE_DESIGN_PROVIDER",
	"DETOUR_MODEL_TEXT_EMBEDDING_PROVIDER",
] as const;

export type ModelRoutingSettingKey = (typeof MODEL_ROUTING_SETTING_KEYS)[number];

export const MIRRORED_ENV_KEYS = [
	"GMGN_API_KEY",
	"GMGN_PRIVATE_KEY",
	"PHANTOM_CONNECT_APP_ID",
	"PHANTOM_CONNECT_REDIRECT_URL",
	"AGENTMAIL_API_KEY",
	"SUPERTEAM_EARN_API_KEY",
	// Web search (plugin-web-search): inert until a Tavily key is present.
	"TAVILY_API_KEY",
	// MCP (plugin-mcp): JSON `{ "servers": { … } }` (or just the servers map).
	// Inert until set; piped into character.settings.mcp at runtime build.
	"MCP_SERVERS",
	// Recap loop: email address the nightly open-questions recap is sent to
	// (via the agentmail channel). Settable in Settings → Vault → Inventory.
	"RECAP_EMAIL",
	// Toggle for the Phase 2 trajectory-learning loop (default on).
	"DETOUR_TRAJECTORY_LEARNING_ENABLED",
] as const;

export type MirroredEnvKey = (typeof MIRRORED_ENV_KEYS)[number];

const SETTINGS_WITHOUT_AUDIO: readonly SettingDefinition[] = [
	...MEDIA_GENERATION_SETTING_KEYS.map((key) => ({ key, group: "media-generation" as const, source: "vault" as const, sensitive: false, mirrorToEnv: true })),
	...EMBEDDING_RUNTIME_SETTING_KEYS.map((key) => ({ key, group: "embedding" as const, source: "runtime" as const, sensitive: key.endsWith("_API_KEY"), mirrorToEnv: true })),
	...X_RUNTIME_SETTING_KEYS.map((key) => ({ key, group: "x" as const, source: "vault" as const, sensitive: key === "X_AUTH_TOKEN" || key === "X_CT0", mirrorToEnv: true })),
	...MODEL_ROUTING_SETTING_KEYS.map((key) => ({ key, group: "routing" as const, source: "env" as const, sensitive: false, evalWritable: true })),
	...MIRRORED_ENV_KEYS.map((key) => ({ key, group: "mirrored-env" as const, source: "vault" as const, sensitive: key.endsWith("_KEY"), mirrorToEnv: true })),
	{ key: "DETOUR_AGENT_SANDBOX", group: "agent", source: "config", sensitive: false, mirrorToEnv: true },
	{ key: "DETOUR_ELEVATED_CODING", group: "agent", source: "config", sensitive: false, mirrorToEnv: true },
] as const;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
	...AUDIO_SETTING_DEFINITIONS,
	...SETTINGS_WITHOUT_AUDIO,
] as const;

export type DetourSettingKey =
	| AudioRuntimeSettingKey
	| MediaGenerationSettingKey
	| EmbeddingRuntimeSettingKey
	| XRuntimeSettingKey
	| ModelRoutingSettingKey
	| MirroredEnvKey
	| "DETOUR_AGENT_SANDBOX"
	| "DETOUR_ELEVATED_CODING";

export const EVAL_WRITABLE_SETTING_KEYS = MODEL_ROUTING_SETTING_KEYS;

export function settingDefinitionsByGroup(group: SettingGroup): readonly SettingDefinition[] {
	return SETTING_DEFINITIONS.filter((setting) => setting.group === group);
}

export function settingKeysByGroup(group: SettingGroup): readonly string[] {
	return settingDefinitionsByGroup(group).map((setting) => setting.key);
}

export function settingDefinition(key: string): SettingDefinition | undefined {
	return SETTING_DEFINITIONS.find((setting) => setting.key === key);
}

export function isMirroredEnvKey(key: string): key is MirroredEnvKey {
	return (MIRRORED_ENV_KEYS as readonly string[]).includes(key);
}
