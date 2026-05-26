export const X_AUTONOMY_TASK_NAME = "X_AUTONOMY";
export const X_AUTONOMY_TASK_TAGS = ["queue", "repeat", "x-autonomy"] as const;

export const X_AUTONOMY_LIMITS = {
	intervalMs: { default: 60_000, min: 30_000, max: 30 * 60_000 },
	statusIntervalMs: { default: 30 * 60_000, min: 15 * 60_000, max: 24 * 60 * 60_000 },
	discoveryIntervalMs: { default: 10 * 60_000, min: 5 * 60_000, max: 24 * 60 * 60_000 },
	maxRepliesPerTick: { default: 2, min: 1, max: 5 },
	maxDiscoveryPerTick: { default: 2, min: 0, max: 8 },
	seenIds: { max: 500 },
	discoveryQueries: { max: 12 },
} as const;

export const X_AUTONOMY_DEFAULT_DISCOVERY_QUERIES = [
	"elizaOS",
	"Dexploarer",
	"Dexploarer scam",
	"Dexploarer sucks",
	"Dexploarer broken",
	"Dexploarer token",
	"Detour Squirrel token",
	"Detour Squirrel CA",
	"Detour Squirrel",
	"MiladyAI elizaOS",
	"Eliza Cloud agents",
	"ai agents",
	"autonomous agents",
	"agent framework",
	"personal AI",
	"developer tools",
] as const;

export const X_AUTONOMY_INTERVAL_PRESETS_MS = [
	5_000,
	15_000,
	X_AUTONOMY_LIMITS.intervalMs.min,
	X_AUTONOMY_LIMITS.intervalMs.default,
	300_000,
] as const;

export type XAutonomyNumberField =
	| "intervalMs"
	| "statusIntervalMs"
	| "discoveryIntervalMs"
	| "maxRepliesPerTick"
	| "maxDiscoveryPerTick";

export const X_AUTONOMY_NUMBER_FIELDS: readonly {
	key: XAutonomyNumberField;
	min: number;
	max: number;
}[] = [
	{ key: "intervalMs", min: X_AUTONOMY_LIMITS.intervalMs.min, max: X_AUTONOMY_LIMITS.intervalMs.max },
	{ key: "statusIntervalMs", min: X_AUTONOMY_LIMITS.statusIntervalMs.min, max: X_AUTONOMY_LIMITS.statusIntervalMs.max },
	{ key: "discoveryIntervalMs", min: X_AUTONOMY_LIMITS.discoveryIntervalMs.min, max: X_AUTONOMY_LIMITS.discoveryIntervalMs.max },
	{ key: "maxRepliesPerTick", min: X_AUTONOMY_LIMITS.maxRepliesPerTick.min, max: X_AUTONOMY_LIMITS.maxRepliesPerTick.max },
	{ key: "maxDiscoveryPerTick", min: X_AUTONOMY_LIMITS.maxDiscoveryPerTick.min, max: X_AUTONOMY_LIMITS.maxDiscoveryPerTick.max },
] as const;
