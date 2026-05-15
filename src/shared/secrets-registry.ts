/**
 * Env-style values that ConfigService mirrors from the vault into
 * `process.env` at boot — so plugins/services that read `process.env.X`
 * pick up vault-saved values without restart.
 *
 * Convention: vault entry key === env var name (e.g. user sets vault
 * entry `GMGN_API_KEY` via Settings → Vault → Inventory, and we expose
 * it as `process.env.GMGN_API_KEY`). Vault is already the universal
 * editor — no separate "secrets" UI required.
 *
 * `mirroredEnvKeys` is the allowlist of entries the runtime will copy
 * into env. Anything else stored in the vault stays vault-only (which
 * is the correct behavior for non-env config like UI prefs).
 */

export const MIRRORED_ENV_KEYS = [
	"GMGN_API_KEY",
	"GMGN_PRIVATE_KEY",
	"PHANTOM_CONNECT_APP_ID",
	"PHANTOM_CONNECT_REDIRECT_URL",
] as const;

export type MirroredEnvKey = (typeof MIRRORED_ENV_KEYS)[number];

export function isMirroredEnvKey(key: string): key is MirroredEnvKey {
	return (MIRRORED_ENV_KEYS as readonly string[]).includes(key);
}
