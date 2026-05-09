import { spawn } from "node:child_process";
import {
	BACKEND_INSTALL_SPECS,
	buildInstallCommand,
	categorizeKey,
	currentPlatform,
	detectPackageManagers,
	inferProviderId,
	listVaultInventory,
	readEntryMeta,
	resolveRunnableMethods,
} from "../../vault";
import type { InstallableBackendId } from "../../backend-ops";
import type {
	BackendInstall,
	BackendStatus,
	OpDiagnostic,
	RevealedLogin,
	SavedLoginsListResult,
	SignInBackendBody,
	SigninResult,
	VaultInventoryItem,
	VaultKeyResult,
	VaultStats,
	BackendId,
} from "../../../../shared/index";
import type { RpcDeps } from "../types";

/**
 * Canonical handler factory pattern.
 *
 *   1. One file per feature group.
 *   2. Functions receive `deps` (RpcDeps) — no service singletons.
 *   3. Each function returns a typed bag of handlers; registry
 *      composes them.
 *   4. Server-push messages flow through `deps.broadcaster.broadcast(...)`
 *      OR via the WS→RPC bridge in registry.ts (which translates legacy
 *      `api.publish({kind: ...})` calls to typed RPC pushes — that's the
 *      transitional layer until HTTP/WS is fully removed).
 */

const VALID_BACKEND_IDS = new Set<BackendId>([
	"in-house",
	"1password",
	"protonpass",
	"bitwarden",
]);

function parseBackendIds(values: string[]): BackendId[] | null {
	const enabled: BackendId[] = [];
	for (const value of values) {
		if (!VALID_BACKEND_IDS.has(value as BackendId)) return null;
		enabled.push(value as BackendId);
	}
	return enabled;
}

/**
 * Read 1Password item metadata via `op item get` when the underlying
 * `revealSavedLogin` throws "no password field" — covers passkeys, SSO/
 * social logins, and identity items mis-categorized as Login. Mirrors
 * the helper inlined into `src/bun/core/api/server.ts`.
 */
async function readOnePasswordItemMetadata(externalId: string): Promise<{
	username: string | null;
	domain: string | null;
	totp: string | null;
	note: string;
}> {
	const out = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
		const child = spawn("op", ["item", "get", externalId, "--format=json"], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
	});
	if (out.code !== 0) {
		return {
			username: null,
			domain: null,
			totp: null,
			note: `op item get failed: ${out.stderr.trim() || "unknown error"}`,
		};
	}
	try {
		const item = JSON.parse(out.stdout) as {
			category?: string;
			urls?: Array<{ href?: string; primary?: boolean }>;
			fields?: Array<{
				id?: string;
				label?: string;
				purpose?: string;
				value?: string;
				type?: string;
			}>;
		};
		const username =
			item.fields?.find((f) => f.purpose === "USERNAME" && typeof f.value === "string")?.value ??
			item.fields?.find((f) => f.label?.toLowerCase() === "username")?.value ??
			null;
		const totp =
			item.fields?.find((f) => f.type?.toUpperCase() === "OTP")?.value ??
			item.fields?.find((f) => f.label?.toLowerCase().includes("one-time"))?.value ??
			null;
		const url = item.urls?.find((u) => u.primary)?.href ?? item.urls?.[0]?.href ?? null;
		const domain = url
			? (() => {
					try {
						return new URL(url.includes("://") ? url : `https://${url}`).hostname;
					} catch {
						return null;
					}
				})()
			: null;
		const noteParts: string[] = [];
		noteParts.push(`Item type: ${item.category ?? "unknown"}.`);
		const hasPasskey = item.fields?.some((f) => f.type?.toUpperCase() === "PASSKEY");
		if (hasPasskey) {
			noteParts.push("This is a passkey — passwordless. Use the 1Password app to sign in.");
		} else {
			noteParts.push("This item has no password field (likely SSO / social-login).");
		}
		return { username, domain, totp, note: noteParts.join(" ") };
	} catch (err) {
		return {
			username: null,
			domain: null,
			totp: null,
			note: `Could not parse op item: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export function vaultRequests(deps: RpcDeps) {
	return {
		vaultListBackends: async (_params: Record<string, never>): Promise<BackendStatus[]> => {
			const manager = await deps.vault.manager();
			// detectBackends returns readonly; the RPC wire shape is a
			// fresh mutable array (JSON parse on the receiving side
			// would produce one anyway).
			return [...await manager.detectBackends()];
		},

		// --- enabled backends ---
		vaultGetEnabledBackends: async (
			_params: Record<string, never>,
		): Promise<{ enabled: string[] }> => {
			const manager = await deps.vault.manager();
			const prefs = await manager.getPreferences();
			return { enabled: [...prefs.enabled] };
		},

		vaultSetEnabledBackends: async (
			params: { enabled: string[] },
		): Promise<{ ok: true }> => {
			const enabled = parseBackendIds(params.enabled);
			if (!enabled) throw new Error("invalid backend id");
			const manager = await deps.vault.manager();
			const prefs = await manager.getPreferences();
			await manager.setPreferences({ ...prefs, enabled });
			return { ok: true };
		},

		// --- install metadata ---
		vaultGetInstall: async (_params: Record<string, never>): Promise<BackendInstall> => {
			const platform = currentPlatform();
			const pms = await detectPackageManagers();
			const specs = await Promise.all(
				Object.values(BACKEND_INSTALL_SPECS).map(async (spec) => {
					const runnable = await resolveRunnableMethods(spec.id as Exclude<BackendId, "in-house">, platform);
					const commands = runnable.map((m) => buildInstallCommand(m));
					return { id: spec.id, methods: [...runnable], commands };
				}),
			);
			return { platform, packageManagers: pms, specs };
		},

		// --- backend ops: diagnose / signin / signout ---
		vaultDiagnose1password: async (
			_params: Record<string, never>,
		): Promise<OpDiagnostic> => {
			return await deps.backendOps.diagnoseOnePassword();
		},

		vaultSigninBackend: async (
			params: { id: "1password" | "bitwarden" } & SignInBackendBody,
		): Promise<SigninResult> => {
			const { id, ...body } = params;
			const result = await deps.backendOps.signIn({
				backendId: id as InstallableBackendId,
				email: body.email,
				masterPassword: body.masterPassword,
				secretKey: body.secretKey,
				signInAddress: body.signInAddress,
				bitwardenClientId: body.bitwardenClientId,
				bitwardenClientSecret: body.bitwardenClientSecret,
			});
			deps.broadcaster.broadcast("backendChanged", { backendId: id });
			return result;
		},

		vaultSignoutBackend: async (
			params: { id: "1password" | "bitwarden" },
		): Promise<{ ok: true }> => {
			await deps.backendOps.signOut(params.id as InstallableBackendId);
			deps.broadcaster.broadcast("backendChanged", { backendId: params.id });
			return { ok: true };
		},

		// --- generic vault inventory + per-key CRUD ---
		vaultInventory: async (_params: Record<string, never>): Promise<VaultInventoryItem[]> => {
			const manager = await deps.vault.manager();
			const items = await listVaultInventory(manager.vault);
			const enriched = await Promise.all(
				items.map(async (item) => ({
					...item,
					category: categorizeKey(item.key),
					provider: inferProviderId(item.key) ?? null,
					meta: (await readEntryMeta(manager.vault, item.key).catch(() => null)) as
						| Record<string, unknown>
						| null,
				})),
			);
			return enriched as VaultInventoryItem[];
		},

		vaultStats: async (_params: Record<string, never>): Promise<VaultStats> => {
			const v = await deps.vault.vault();
			return await v.stats();
		},

		vaultGetKey: async (
			params: { key: string; reveal?: boolean },
		): Promise<VaultKeyResult> => {
			const v = await deps.vault.vault();
			const manager = await deps.vault.manager();
			const exists = await manager.has(params.key);
			if (!exists) throw new Error("not found");
			const desc = await v.describe(params.key);
			if (!params.reveal) return { key: params.key, descriptor: desc };
			const value = await v.reveal(params.key, "tray-app:vault-ui");
			return { key: params.key, descriptor: desc, value };
		},

		vaultSetKey: async (
			params: { key: string; value: string; sensitive?: boolean },
		): Promise<{ ok: true }> => {
			const manager = await deps.vault.manager();
			await manager.set(params.key, params.value, {
				sensitive: params.sensitive ?? true,
			});
			return { ok: true };
		},

		vaultRemoveKey: async (
			params: { key: string },
		): Promise<{ ok: true }> => {
			const manager = await deps.vault.manager();
			await manager.remove(params.key);
			return { ok: true };
		},

		// --- saved logins ---
		savedLoginsList: async (
			_params: Record<string, never>,
		): Promise<SavedLoginsListResult> => {
			const manager = await deps.vault.manager();
			return (await manager.listAllSavedLogins()) as SavedLoginsListResult;
		},

		savedLoginsReveal: async (params: {
			source: "in-house" | "1password" | "bitwarden";
			identifier: string;
		}): Promise<RevealedLogin> => {
			const manager = await deps.vault.manager();
			try {
				return (await manager.revealSavedLogin(
					params.source,
					params.identifier,
				)) as RevealedLogin;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// 1Password items without a `password` field (passkeys,
				// SSO/social logins, identity items mis-categorized as
				// Login) trip the hard error in eliza. Fall back to
				// `op item get` and surface the metadata we can read
				// instead of failing the whole request.
				if (params.source === "1password" && /no password field/i.test(msg)) {
					const fallback = await readOnePasswordItemMetadata(params.identifier);
					return {
						source: "1password",
						identifier: params.identifier,
						username: fallback.username ?? "",
						password: "",
						domain: fallback.domain ?? null,
						...(fallback.totp ? { totp: fallback.totp } : {}),
						note: fallback.note,
					};
				}
				throw err;
			}
		},
	};
}
