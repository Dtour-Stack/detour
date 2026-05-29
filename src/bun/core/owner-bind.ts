/**
 * Owner-binding service — wires up eliza's `/eliza_pair` (Telegram) and
 * `/eliza-pair` (Discord) slash commands so the user can prove "this Telegram /
 * Discord account is me, the owner of this Detour install".
 *
 * Flow:
 *   1. User clicks "Pair Telegram" in the tray (or hits POST /api/owner-bind/code)
 *   2. We mint a 6-digit code with a 5-minute TTL, return it to the UI
 *   3. User opens their Telegram chat with @detour_squrriel_bot, types
 *      `/eliza_pair 123456`
 *   4. eliza's TelegramOwnerPairingService extracts the code and calls our
 *      `verifyOwnerBindFromConnector({connector, externalId, displayHandle, code})`
 *   5. We compare against the active code, persist owner identity to vault,
 *      return success
 *
 * Fail-closed: if no code is active we return success=false. Codes are
 * single-use and per-connector — minting a Telegram code doesn't pair Discord.
 *
 * Why not use a proper service-registry contract: eliza's pairing service
 * looks for a service with type "OWNER_BIND_VERIFY" by string key, so we
 * register a minimal plugin that exposes one. No subclassing of eliza Service
 * required (Service base class has weird lifecycle hooks we don't need).
 */

import { logger, Service, type IAgentRuntime, type Plugin } from "@elizaos/core";
import type { VaultService } from "./vault";
// Defined in the shared RPC contract (single source of truth — shared is a
// leaf); re-exported so existing bun-side consumers keep importing it here.
import type { OwnerConnector } from "../../shared/rpc/owner-bind";
export type { OwnerConnector };

export interface VerifyOwnerBindParams {
	connector: OwnerConnector;
	externalId: string;
	displayHandle: string;
	code: string;
}

export interface VerifyOwnerBindResult {
	success: boolean;
	error?: string;
}

interface PendingCode {
	code: string;
	connector: OwnerConnector;
	createdAt: number;
	expiresAt: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_LENGTH = 6;

function mintCode(): string {
	const buf = new Uint8Array(8);
	crypto.getRandomValues(buf);
	let n = 0;
	for (const b of buf) n = (n * 256 + b) % 1_000_000;
	return n.toString().padStart(CODE_LENGTH, "0");
}

export class OwnerBindService {
	private pending = new Map<OwnerConnector, PendingCode>();

	constructor(private readonly vault: VaultService) {}

	/**
	 * Generate a 6-digit pair code for the given connector. Replaces any
	 * earlier pending code for the same connector. Returns the code so the UI
	 * can show it to the user.
	 */
	generateCode(connector: OwnerConnector): { code: string; expiresAt: number } {
		const code = mintCode();
		const now = Date.now();
		const entry: PendingCode = { code, connector, createdAt: now, expiresAt: now + CODE_TTL_MS };
		this.pending.set(connector, entry);
		logger.info({ src: "owner-bind", connector, expiresAt: entry.expiresAt }, "issued pair code");
		return { code, expiresAt: entry.expiresAt };
	}

	/** What's the currently-bound owner identity for this connector, if any? */
	async getOwner(connector: OwnerConnector): Promise<{ externalId: string; displayHandle: string } | null> {
		try {
			const v = await this.vault.vault();
			const idKey = `owner.${connector}.externalId`;
			const handleKey = `owner.${connector}.displayHandle`;
			if (!(await v.has(idKey))) return null;
			const externalId = (await v.get(idKey)) as string;
			const displayHandle = (await v.has(handleKey))
				? ((await v.get(handleKey)) as string)
				: externalId;
			return { externalId, displayHandle };
		} catch {
			return null;
		}
	}

	async unbind(connector: OwnerConnector): Promise<void> {
		const v = await this.vault.vault();
		await v.remove(`owner.${connector}.externalId`).catch(() => {});
		await v.remove(`owner.${connector}.displayHandle`).catch(() => {});
		this.pending.delete(connector);
		logger.info({ src: "owner-bind", connector }, "unbound owner");
	}

	/**
	 * Eliza-side entrypoint. Telegram's pairing service looks up
	 * `runtime.getService("OWNER_BIND_VERIFY")` and calls this method.
	 * We expose it as a proper IAgentRuntime service via the plugin below.
	 */
	async verifyOwnerBindFromConnector(params: VerifyOwnerBindParams): Promise<VerifyOwnerBindResult> {
		const pending = this.pending.get(params.connector);
		if (!pending) {
			logger.warn({ src: "owner-bind", connector: params.connector }, "no pending pair code");
			return { success: false, error: "No pair code is active. Generate one in Detour first." };
		}
		if (Date.now() > pending.expiresAt) {
			this.pending.delete(params.connector);
			return { success: false, error: "Pair code expired. Generate a new one." };
		}
		if (params.code.trim() !== pending.code) {
			return { success: false, error: "Pair code did not match." };
		}
		// Match — persist owner identity, drop the code (single-use).
		try {
			const v = await this.vault.vault();
			await v.set(`owner.${params.connector}.externalId`, params.externalId);
			await v.set(`owner.${params.connector}.displayHandle`, params.displayHandle);
			this.pending.delete(params.connector);
			logger.info(
				{ src: "owner-bind", connector: params.connector, displayHandle: params.displayHandle },
				"owner bound",
			);
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
}

/**
 * Tiny plugin that registers OwnerBindService into the agent runtime under
 * serviceType "OWNER_BIND_VERIFY" so eliza's TelegramOwnerPairingService
 * (and the equivalent Discord one) can find it via runtime.getService(...).
 *
 * The host (core/index.ts) constructs OwnerBindService once and passes it
 * here when assembling the runtime's plugin list, so the same instance backs
 * both the HTTP API surface and the in-runtime service lookup.
 */
export function makeOwnerBindPlugin(svc: OwnerBindService): Plugin {
	class OwnerBindVerifyService extends Service {
		static override serviceType = "OWNER_BIND_VERIFY" as const;
		override capabilityDescription = "Verifies owner-bind pair codes from messaging connectors";
		static override async start(runtime: IAgentRuntime): Promise<OwnerBindVerifyService> {
			return new OwnerBindVerifyService(runtime);
		}
		override async stop(): Promise<void> {
			// nothing to clean up — OwnerBindService is owned by the host
		}
		async verifyOwnerBindFromConnector(params: VerifyOwnerBindParams): Promise<VerifyOwnerBindResult> {
			return svc.verifyOwnerBindFromConnector(params);
		}
	}

	return {
		name: "owner-bind-verify",
		description:
			"Backend verification service for eliza's /eliza_pair and /eliza-pair owner-binding flow. " +
			"Reads pair codes minted by OwnerBindService and persists confirmed owner identity to the vault.",
		services: [OwnerBindVerifyService],
		// Eliza registers services LAZILY — `runtime.getService("OWNER_BIND_VERIFY")`
		// returns null until someone awaits `getServiceLoadPromise(...)` to
		// trigger start(). Telegram + Discord owner-pairing services use the
		// sync getService at THEIR start time, which races us. Force-start
		// here in init() so OWNER_BIND_VERIFY is live before any pairing
		// service comes up.
	};
}
