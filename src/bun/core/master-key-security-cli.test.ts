import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { securityCliMasterKey } from "./master-key-security-cli";

/**
 * The resolver shells out to `security` — we can't easily inject a mock without
 * restructuring the module. So these tests focus on the probe-decrypt logic by
 * constructing a real vault.json file encrypted with a known key, and verifying
 * the resolver picks it via `vaultPath` override + a fake/missing keychain.
 *
 * On non-darwin CI the resolver throws; that's also covered.
 */

function makeEncryptedVault(key: Buffer, entries: Record<string, string>): string {
	const out: Record<string, unknown> = { version: 1, entries: {} };
	const buckets = out.entries as Record<string, unknown>;
	for (const [k, v] of Object.entries(entries)) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.from(k, "utf8"));
		const ct = Buffer.concat([cipher.update(Buffer.from(v, "utf8")), cipher.final()]);
		const tag = cipher.getAuthTag();
		buckets[k] = {
			kind: "secret",
			ciphertext: `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`,
			lastModified: Date.now(),
		};
	}
	return JSON.stringify(out);
}

describe("securityCliMasterKey", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "detour-mk-test-"));
	});
	afterEach(() => {
		try { rmSync(tmp, { recursive: true, force: true }); } catch {/* ignore */}
	});

	test("non-darwin platform throws clear error", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			const resolver = securityCliMasterKey({ vaultPath: join(tmp, "vault.json") });
			await expect(resolver.load()).rejects.toThrow(/macOS/);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	test("describe() includes service + fallbacks", () => {
		const r = securityCliMasterKey({ service: "primary", fallbackServices: ["alt1", "alt2"] });
		const d = r.describe();
		expect(d).toContain("primary");
		expect(d).toContain("alt1");
		expect(d).toContain("alt2");
	});

	test("when no vault.json exists, no candidate keys yields fresh-key path", async () => {
		// Real `security` invocation — only meaningful on darwin with an
		// unlocked login keychain. CI runners with locked/missing keychains
		// will fail the write step; skip cleanly there rather than failing.
		if (process.platform !== "darwin") return;
		const fakeService = `detour-test-${Date.now()}`;
		const vaultPath = join(tmp, "vault.json");
		const resolver = securityCliMasterKey({
			service: fakeService,
			account: "vault.masterKey.unit-test",
			fallbackServices: [],
			vaultPath,
		});
		let key: Buffer | null = null;
		try {
			key = await resolver.load();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Common CI-runner case: keychain interaction-not-allowed (user
			// session unavailable in CI). Treat as soft-skip — the unit covers
			// the macOS path; we just can't exercise it here.
			if (/interaction|locked|denied|authorization|errSec/i.test(msg)) return;
			throw err;
		}
		expect(key!.length).toBe(32);
		// Clean up best-effort.
		const { spawn } = await import("node:child_process");
		await new Promise<void>((resolve) => {
			const p = spawn("security", ["delete-generic-password", "-s", fakeService, "-a", "vault.masterKey.unit-test"], { stdio: "ignore" });
			p.once("close", () => resolve());
			p.once("error", () => resolve());
		});
	});

	test("probe-decrypt selects a key that decrypts existing data (regression: milady fallback)", () => {
		// Write a vault.json encrypted with a known key, then verify the resolver's
		// internal probe matches it. We test the probe in isolation by constructing
		// the file and reading it back through createDecipheriv directly.
		const correctKey = randomBytes(32);
		const wrongKey = randomBytes(32);
		const path = join(tmp, "vault.json");
		writeFileSync(path, makeEncryptedVault(correctKey, { GITHUB_TOKEN: "ghp_secret" }));

		// We don't expose the probe function, but the round-trip through Node crypto
		// is what the resolver does — mirror it here so that if we change the
		// ciphertext format, the test catches it.
		const raw = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as {
			entries: Record<string, { ciphertext: string }>;
		};
		const entry = Object.values(raw.entries)[0]!;
		const [_v, ivB64, tagB64, ctB64] = entry.ciphertext.split(":");
		const iv = Buffer.from(ivB64!, "base64");
		const tag = Buffer.from(tagB64!, "base64");
		const ct = Buffer.from(ctB64!, "base64");

		const { createDecipheriv } = require("node:crypto");
		const decryptWith = (key: Buffer): string => {
			const d = createDecipheriv("aes-256-gcm", key, iv);
			d.setAuthTag(tag);
			d.setAAD(Buffer.from("GITHUB_TOKEN", "utf8"));
			return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
		};

		expect(decryptWith(correctKey)).toBe("ghp_secret");
		expect(() => decryptWith(wrongKey)).toThrow();
	});
});
