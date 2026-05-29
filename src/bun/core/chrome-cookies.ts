/**
 * Reads x.com auth cookies from the user's real macOS Google Chrome.
 *
 * The X plugin authenticates with cookie auth (auth_token + ct0). Rather than
 * forcing the user to export those into the vault, Detour can source them
 * directly from a logged-in Chrome profile — so "which X account the agent is"
 * follows whichever account that Chrome profile is signed into.
 *
 * Chrome on macOS stores cookie values AES-128-CBC encrypted; the key is
 * PBKDF2(HMAC-SHA1) of the "Chrome Safe Storage" password held in the login
 * keychain. The first read triggers a one-time macOS keychain prompt.
 *
 * Leaf module: built-ins only, no Detour-layer imports, never logs cookie values.
 */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_BASE = join(homedir(), "Library/Application Support/Google/Chrome");
const SALT = "saltysalt";
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, 0x20); // 16 spaces, per Chromium's oscrypt

export type XChromeCookies = { authToken: string; ct0: string };

let cachedKey: Buffer | null = null;

function safeStorageKey(): Buffer | null {
	if (cachedKey) return cachedKey;
	try {
		const pw = execFileSync("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 20000, // don't hang runtime boot on an unattended keychain prompt
		}).trim();
		if (!pw) return null;
		cachedKey = pbkdf2Sync(pw, SALT, ITERATIONS, KEY_LENGTH, "sha1");
		return cachedKey;
	} catch {
		return null;
	}
}

/** Resolve a profile arg (a dir name like "Default" or an account email) to its profile directory. */
function resolveProfileDir(profile: string): string | null {
	if (existsSync(join(CHROME_BASE, profile))) return profile;
	try {
		const localState = JSON.parse(readFileSync(join(CHROME_BASE, "Local State"), "utf8")) as {
			profile?: { info_cache?: Record<string, { user_name?: string }> };
		};
		const cache = localState.profile?.info_cache ?? {};
		const wanted = profile.toLowerCase();
		for (const [dir, info] of Object.entries(cache)) {
			if (info?.user_name?.toLowerCase() === wanted) return dir;
		}
	} catch {
		// fall through
	}
	return null;
}

function cookiesDbPath(profileDir: string): string | null {
	for (const candidate of [
		join(CHROME_BASE, profileDir, "Network", "Cookies"),
		join(CHROME_BASE, profileDir, "Cookies"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function printableAscii(buf: Buffer): string | null {
	const s = buf.toString("utf8");
	return /^[\x20-\x7e]+$/.test(s) ? s : null;
}

function decryptValue(encrypted: Buffer, key: Buffer): string | null {
	if (encrypted.length < 3) return null;
	const prefix = encrypted.subarray(0, 3).toString("latin1");
	if (prefix !== "v10" && prefix !== "v11") return printableAscii(encrypted); // legacy plaintext
	try {
		const decipher = createDecipheriv("aes-128-cbc", key, IV);
		decipher.setAutoPadding(false);
		let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
		const pad = plain[plain.length - 1];
		if (pad > 0 && pad <= 16) plain = plain.subarray(0, plain.length - pad);
		// Chrome >=130 prepends a 32-byte SHA-256 of the domain to the plaintext;
		// prefer the post-prefix slice, fall back to the whole value for older builds.
		return printableAscii(plain.subarray(32)) ?? printableAscii(plain);
	} catch {
		return null;
	}
}

/**
 * Returns the x.com auth_token + ct0 from the given Chrome profile, or null if
 * unavailable (non-macOS, profile/db/keychain missing, or cookies absent).
 * Reads a temp copy of the cookie DB so a running Chrome's lock doesn't block us.
 */
export function readChromeXCookies(profile: string): XChromeCookies | null {
	if (process.platform !== "darwin" || !profile) return null;
	const profileDir = resolveProfileDir(profile);
	if (!profileDir) return null;
	const dbPath = cookiesDbPath(profileDir);
	if (!dbPath) return null;
	const key = safeStorageKey();
	if (!key) return null;

	const work = mkdtempSync(join(tmpdir(), "dx-cc-"));
	const tmpDb = join(work, "Cookies");
	let db: Database | null = null;
	try {
		copyFileSync(dbPath, tmpDb);
		for (const suffix of ["-wal", "-shm"]) {
			if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, tmpDb + suffix);
		}
		db = new Database(tmpDb, { readonly: true });
		const rows = db
			.query("select name, encrypted_value from cookies where host_key like '%x.com' and name in ('auth_token','ct0')")
			.all() as Array<{ name: string; encrypted_value: Uint8Array }>;
		let authToken = "";
		let ct0 = "";
		for (const row of rows) {
			const value = decryptValue(Buffer.from(row.encrypted_value), key);
			if (!value) continue;
			if (row.name === "auth_token") authToken = value;
			else if (row.name === "ct0") ct0 = value;
		}
		return authToken && ct0 ? { authToken, ct0 } : null;
	} catch {
		return null;
	} finally {
		db?.close();
		rmSync(work, { recursive: true, force: true });
	}
}
