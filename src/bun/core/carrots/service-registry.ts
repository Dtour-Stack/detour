/**
 * Service registry — which Detour core services are exposed to carrots, and
 * which methods on each are callable. This is the security boundary: a carrot
 * with `service:cron` permission can only invoke methods listed here, no
 * matter what arbitrary string it sends.
 *
 * Add a service: import its handle in `core/index.ts`'s startCore, register
 * it via CarrotHost.registerService(), and add the method allowlist below.
 */

import type { DetourCarrotPermission } from "./types";

export type ServiceMethodAllowlist = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * Per-permission method allowlist. A worker calling
 * `service.invoke("cron", "createJob", [...])` is allowed iff:
 *  1. The carrot manifest declared `service:cron`.
 *  2. "createJob" appears in the cron list below.
 */
export const SERVICE_METHODS: ServiceMethodAllowlist = {
	cron: ["listJobs", "getJob", "createJob", "updateJob", "deleteJob"],
	vault: [
		// Read-only by default; write methods require explicit additional gate.
		"hasMasterKey",
		"listSecretIds",
		"getSecret",
	],
	pensieve: [
		"listMemories",
		"getMemory",
		"createMemory",
		"deleteMemory",
		"listTemplates",
		"getTemplate",
	],
	channels: ["listChannels", "getChannelStatus"],
	llama: ["status", "ensureRunning"],
};

export function permissionForService(service: string): DetourCarrotPermission | null {
	switch (service) {
		case "cron":
			return "service:cron";
		case "vault":
			return "service:vault";
		case "pensieve":
			return "service:pensieve";
		case "channels":
			return "service:channels";
		case "llama":
			return "service:llama";
		default:
			return null;
	}
}

export function isMethodAllowed(service: string, method: string): boolean {
	return SERVICE_METHODS[service]?.includes(method) ?? false;
}
