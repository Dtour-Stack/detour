export type AgentToolPermissionSnapshot = {
	browserUse: boolean;
	computerUse: boolean;
	elevatedCoding: boolean;
	userLevelAccess: boolean;
};

function boolEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function browserUseEnabled(): boolean {
	return boolEnv("DETOUR_BROWSER_USE_ENABLED", true);
}

export function computerUseEnabled(): boolean {
	return boolEnv("DETOUR_COMPUTER_USE_ENABLED", false);
}

export function elevatedCodingEnabled(): boolean {
	return boolEnv("DETOUR_ELEVATED_CODING", false);
}

export function toolPermissionSnapshot(): AgentToolPermissionSnapshot {
	return {
		browserUse: browserUseEnabled(),
		computerUse: computerUseEnabled(),
		elevatedCoding: elevatedCodingEnabled(),
		userLevelAccess: true,
	};
}
