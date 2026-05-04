/**
 * Master key resolver that uses macOS `security` CLI instead of @napi-rs/keyring.
 *
 * Why: when bundled by Electrobun's bundler, the @napi-rs/keyring native binding
 * fails to load (`requireNative()` returns null) so the in-house vault can't read
 * its master key — every sensitive read fails.
 *
 * Eliza-family forks (eliza, milady, etc.) all write to `~/.eliza/vault.json`
 * but use different keychain SERVICE names for the master-key entry. To pick
 * up existing data transparently, we scan a list of candidate services, read
 * each key, try it against the first encrypted entry in vault.json, and use
 * whichever one decrypts. If vault.json is empty/absent, we fall through to
 * the primary service and create a fresh entry.
 */

import { spawn } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY_BYTES = 32;
const TIMEOUT_MS = 5_000;

export class SecurityCliMasterKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecurityCliMasterKeyError";
	}
}

export interface SecurityCliResolverOptions {
	/** Primary service for reading + writing. */
	readonly service?: string;
	readonly account?: string;
	/**
	 * Additional candidate services to try when no key matches under the primary.
	 * Read-only — we never write under a fallback. Defaults to ["milady"] so
	 * vault.json originally written by milady's fork is auto-recovered.
	 */
	readonly fallbackServices?: readonly string[];
	/** Override the vault path used to probe-decrypt. Defaults to ~/.eliza/vault.json. */
	readonly vaultPath?: string;
}

export type MasterKeyResolver = {
	load(): Promise<Buffer>;
	describe(): string;
};

interface CapturedExec {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawnCapture(
	command: string,
	args: readonly string[],
	stdin: string | null = null,
	timeoutMs = TIMEOUT_MS,
): Promise<CapturedExec> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
		if (stdin !== null && child.stdin) child.stdin.end(stdin);
	});
}

async function readKeychainKey(
	service: string,
	account: string,
): Promise<Buffer | null> {
	const out = await spawnCapture("security", [
		"find-generic-password",
		"-s",
		service,
		"-a",
		account,
		"-w",
	]);
	if (out.exitCode !== 0) return null;
	const raw = out.stdout.trim();
	if (raw.length === 0) return null;
	const buf = Buffer.from(raw, "base64");
	return buf.length === KEY_BYTES ? buf : null;
}

async function writeKeychainKey(
	service: string,
	account: string,
	key: Buffer,
): Promise<void> {
	const b64 = key.toString("base64");
	const write = await spawnCapture("security", [
		"add-generic-password",
		"-s",
		service,
		"-a",
		account,
		"-w",
		b64,
		"-T",
		"",
		"-U", // update if exists
	]);
	if (write.exitCode !== 0) {
		throw new SecurityCliMasterKeyError(
			`security add-generic-password failed (exit ${write.exitCode}): ${write.stderr.trim() || write.stdout.trim() || "unknown"}`,
		);
	}
}

/**
 * Probe-decrypt the first sensitive entry in vault.json with `key`.
 * Returns true if it works (or if vault.json doesn't exist / has no entries).
 */
function probeKey(key: Buffer, vaultPath: string): boolean {
	if (!existsSync(vaultPath)) return true; // empty store — any key is fine
	let parsed: { entries?: Record<string, { kind?: string; ciphertext?: string }> };
	try {
		parsed = JSON.parse(readFileSync(vaultPath, "utf8"));
	} catch {
		return true; // can't parse — let downstream handle it
	}
	const entries = parsed.entries ?? {};
	const firstSecret = Object.entries(entries).find(
		([, v]) => v.kind === "secret" && typeof v.ciphertext === "string",
	);
	if (!firstSecret) return true;
	const [keyName, entry] = firstSecret;
	const ct = entry.ciphertext!;
	const parts = ct.split(":");
	if (parts.length !== 4 || parts[0] !== "v1") return true; // unknown format — skip
	try {
		const iv = Buffer.from(parts[1]!, "base64");
		const tag = Buffer.from(parts[2]!, "base64");
		const ciphertext = Buffer.from(parts[3]!, "base64");
		const d = createDecipheriv("aes-256-gcm", key, iv);
		d.setAuthTag(tag);
		d.setAAD(Buffer.from(keyName, "utf8"));
		d.update(ciphertext);
		d.final();
		return true;
	} catch {
		return false;
	}
}

export function securityCliMasterKey(
	opts: SecurityCliResolverOptions = {},
): MasterKeyResolver {
	const service = opts.service ?? "eliza";
	const account = opts.account ?? "vault.masterKey";
	const fallbacks = opts.fallbackServices ?? ["milady"];
	const vaultPath = opts.vaultPath ?? join(homedir(), ".eliza", "vault.json");

	return {
		async load(): Promise<Buffer> {
			if (process.platform !== "darwin") {
				throw new SecurityCliMasterKeyError(
					`securityCliMasterKey: only supported on macOS (got ${process.platform})`,
				);
			}

			const candidates: Array<{ svc: string; key: Buffer }> = [];
			const primary = await readKeychainKey(service, account);
			if (primary) candidates.push({ svc: service, key: primary });
			for (const fb of fallbacks) {
				const k = await readKeychainKey(fb, account);
				if (k) candidates.push({ svc: fb, key: k });
			}

			if (candidates.length > 0) {
				for (const c of candidates) {
					if (probeKey(c.key, vaultPath)) {
						console.log(`[vault] master key resolved via security://${c.svc}/${account}`);
						return c.key;
					}
				}
				// No candidate decrypted existing data — fall through to fresh-key path?
				// Don't: that would silently hide the real problem. Throw.
				throw new SecurityCliMasterKeyError(
					`vault data exists at ${vaultPath} but none of the master keys (${candidates
						.map((c) => c.svc)
						.join(", ")}) decrypt it. The keychain entries may have been rotated independently of the encrypted data. Restore the original key or wipe vault.json to reinitialize.`,
				);
			}

			// No keys exist at all — create a fresh one under the primary service.
			const fresh = randomBytes(KEY_BYTES);
			await writeKeychainKey(service, account, fresh);
			console.log(`[vault] created fresh master key at security://${service}/${account}`);
			return fresh;
		},
		describe(): string {
			return `security-cli://${service}/${account}` + (fallbacks.length ? ` (+fallbacks: ${fallbacks.join(",")})` : "");
		},
	};
}
