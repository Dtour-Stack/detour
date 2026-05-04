/**
 * Backend operations: diagnose / sign-in / sign-out for password-manager
 * backends. Ported from @elizaos/app-core's secrets-manager-installer to avoid
 * pulling in app-core's React/three/capacitor dep tree just for these ~150
 * lines of subprocess orchestration.
 *
 * Sign-in writes the session token to vault under `pm.<backend>.session`.
 * Sign-out clears it. Diagnostics return raw stdout/stderr/exitCode so the
 * UI can show the actual `op` failure rather than a generic "signed out".
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { VaultService } from "./vault";

export type InstallableBackendId = "1password" | "bitwarden" | "protonpass";

export interface SigninRequest {
	readonly backendId: InstallableBackendId;
	readonly email?: string;
	readonly masterPassword: string;
	readonly secretKey?: string;
	readonly signInAddress?: string;
	readonly bitwardenClientId?: string;
	readonly bitwardenClientSecret?: string;
}

export interface SigninResult {
	readonly backendId: InstallableBackendId;
	readonly sessionStored: boolean;
	readonly message: string;
}

export interface OpDiagnostic {
	readonly platform: string;
	readonly opPath: string | null;
	readonly opVersion: string | null;
	readonly accountList: { exitCode: number; stdout: string; stderr: string };
	readonly vaultList: {
		account: string | null;
		exitCode: number;
		stdout: string;
		stderr: string;
	} | null;
	readonly desktopIntegrationDetected: boolean;
	readonly sessionTokenStored: boolean;
	readonly hint: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const SHORT_TIMEOUT_MS = 5_000;

function sessionKey(backendId: InstallableBackendId): string {
	return `pm.${backendId}.session`;
}

interface CapturedExec {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

function spawnCapture(
	command: string,
	args: readonly string[],
	stdin: string | null,
	env?: NodeJS.ProcessEnv,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CapturedExec> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(command, [...args], {
			stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
			shell: false,
			env: env ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
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
		if (stdin !== null && child.stdin) {
			child.stdin.end(stdin);
		}
	});
}

function truncate(message: string, max = 800): string {
	const clean = message.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

async function which(cmd: string): Promise<string | null> {
	try {
		const probe = await spawnCapture(
			process.platform === "win32" ? "where.exe" : "which",
			[cmd],
			null,
			process.env,
			SHORT_TIMEOUT_MS,
		);
		const path = probe.stdout.trim().split(/\r?\n/)[0] ?? "";
		return path.length > 0 ? path : null;
	} catch {
		return null;
	}
}

export class BackendOps {
	constructor(private readonly vault: VaultService) {}

	/**
	 * Run all the `op` probes detectOnePassword does, but capture raw output
	 * so the UI can show what's actually failing instead of "signed out".
	 */
	async diagnoseOnePassword(): Promise<OpDiagnostic> {
		const opPath = await which("op");
		if (!opPath) {
			return {
				platform: process.platform,
				opPath: null,
				opVersion: null,
				accountList: { exitCode: -1, stdout: "", stderr: "`op` not on PATH" },
				vaultList: null,
				desktopIntegrationDetected: false,
				sessionTokenStored: false,
				hint: "Install the 1Password CLI: brew install --cask 1password-cli",
			};
		}

		let opVersion: string | null = null;
		try {
			const v = await spawnCapture("op", ["--version"], null, process.env, SHORT_TIMEOUT_MS);
			opVersion = v.stdout.trim() || null;
		} catch {
			opVersion = null;
		}

		const accountList = await spawnCapture(
			"op",
			["account", "list", "--format=json"],
			null,
			process.env,
			SHORT_TIMEOUT_MS,
		).catch((err) => ({
			exitCode: -1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
		}));

		// Pick first account shorthand (or derive from URL host)
		let shorthand: string | null = null;
		if (accountList.exitCode === 0 && accountList.stdout.trim()) {
			try {
				const accounts = JSON.parse(accountList.stdout) as Array<{
					shorthand?: string;
					url?: string;
				}>;
				for (const a of accounts) {
					if (typeof a.shorthand === "string" && a.shorthand.length > 0) {
						shorthand = a.shorthand;
						break;
					}
					if (typeof a.url === "string") {
						const sub = a.url.split(".")[0];
						if (sub) {
							shorthand = sub;
							break;
						}
					}
				}
			} catch {
				// JSON parse failure — leave shorthand null
			}
		}

		let vaultList:
			| { account: string | null; exitCode: number; stdout: string; stderr: string }
			| null = null;
		let desktopIntegrationDetected = false;
		if (shorthand) {
			const v = await spawnCapture(
				"op",
				[`--account=${shorthand}`, "vault", "list", "--format=json"],
				null,
				process.env,
				SHORT_TIMEOUT_MS,
			).catch((err) => ({
				exitCode: -1,
				stdout: "",
				stderr: err instanceof Error ? err.message : String(err),
			}));
			vaultList = { account: shorthand, ...v };
			desktopIntegrationDetected = v.exitCode === 0;
		}

		const v = await this.vault.vault();
		const sessionTokenStored = await v.has(sessionKey("1password"));

		let hint: string;
		if (accountList.exitCode !== 0) {
			hint = `op account list failed. Run \`op account add\` from a terminal first, then come back.`;
		} else if (!shorthand) {
			hint = `op is installed but no 1Password accounts are registered. Run \`op account add\` (or sign in via the form below).`;
		} else if (!desktopIntegrationDetected && !sessionTokenStored) {
			hint = `Account "${shorthand}" registered but no auth path. Either enable 1Password 8 desktop CLI integration (1Password → Settings → Developer → Integrate with 1Password CLI) or sign in via the form below.`;
		} else if (desktopIntegrationDetected) {
			hint = `Authenticated via 1Password desktop app integration (account "${shorthand}").`;
		} else {
			hint = `Authenticated via stored session token (account "${shorthand}").`;
		}

		return {
			platform: process.platform,
			opPath,
			opVersion,
			accountList,
			vaultList,
			desktopIntegrationDetected,
			sessionTokenStored,
			hint,
		};
	}

	/**
	 * Run vendor's non-interactive sign-in and persist the session token.
	 * 1Password: `op account add ... --signin --raw` with master password on stdin.
	 * Bitwarden: `bw login --apikey` then `bw unlock --raw --passwordenv`.
	 */
	async signIn(request: SigninRequest): Promise<SigninResult> {
		if (request.backendId === "1password") return this.signInOnePassword(request);
		if (request.backendId === "bitwarden") return this.signInBitwarden(request);
		throw new Error(
			`Sign-in for "${request.backendId}" is not supported (vendor CLI is unstable).`,
		);
	}

	private async signInOnePassword(request: SigninRequest): Promise<SigninResult> {
		if (!request.email) throw new Error("1Password sign-in requires `email`");
		if (!request.secretKey)
			throw new Error("1Password sign-in requires `secretKey` (the 34-char Secret Key)");
		if (!request.masterPassword)
			throw new Error("1Password sign-in requires `masterPassword`");

		const signInAddress = request.signInAddress?.trim() || "my.1password.com";

		const add = await spawnCapture(
			"op",
			[
				"account",
				"add",
				"--address",
				signInAddress,
				"--email",
				request.email,
				"--secret-key",
				request.secretKey,
				"--signin",
				"--raw",
			],
			request.masterPassword,
		);

		let sessionToken = add.stdout.trim();
		if (!sessionToken) {
			const signin = await spawnCapture(
				"op",
				["signin", "--account", signInAddress, "--raw"],
				request.masterPassword,
			);
			if (signin.exitCode !== 0 || !signin.stdout.trim()) {
				throw new Error(
					truncate(
						`op signin failed (exit ${signin.exitCode}): ${signin.stderr || signin.stdout}`,
					),
				);
			}
			sessionToken = signin.stdout.trim();
		}

		if (add.exitCode !== 0 && !sessionToken) {
			throw new Error(
				truncate(
					`op account add failed (exit ${add.exitCode}): ${add.stderr || add.stdout}`,
				),
			);
		}

		const v = await this.vault.vault();
		await v.set(sessionKey("1password"), sessionToken, {
			sensitive: true,
			caller: "tray-app:backend-ops",
		});

		return {
			backendId: "1password",
			sessionStored: true,
			message: `Signed in as ${request.email} at ${signInAddress}`,
		};
	}

	private async signInBitwarden(request: SigninRequest): Promise<SigninResult> {
		if (!request.bitwardenClientId)
			throw new Error("Bitwarden sign-in requires `bitwardenClientId` (BW_CLIENTID)");
		if (!request.bitwardenClientSecret)
			throw new Error("Bitwarden sign-in requires `bitwardenClientSecret` (BW_CLIENTSECRET)");
		if (!request.masterPassword)
			throw new Error("Bitwarden sign-in requires `masterPassword`");

		const env = {
			...process.env,
			BW_CLIENTID: request.bitwardenClientId,
			BW_CLIENTSECRET: request.bitwardenClientSecret,
		};
		const login = await spawnCapture("bw", ["login", "--apikey"], null, env);
		const alreadyLoggedIn =
			login.exitCode !== 0 &&
			/already logged in/i.test(login.stderr + login.stdout);
		if (login.exitCode !== 0 && !alreadyLoggedIn) {
			throw new Error(
				truncate(`bw login failed (exit ${login.exitCode}): ${login.stderr || login.stdout}`),
			);
		}

		const unlock = await spawnCapture(
			"bw",
			["unlock", "--raw", "--passwordenv", "BW_PASSWORD"],
			null,
			{ ...env, BW_PASSWORD: request.masterPassword },
		);
		const sessionToken = unlock.stdout.trim();
		if (unlock.exitCode !== 0 || !sessionToken) {
			throw new Error(
				truncate(
					`bw unlock failed (exit ${unlock.exitCode}): ${unlock.stderr || unlock.stdout}`,
				),
			);
		}

		const v = await this.vault.vault();
		await v.set(sessionKey("bitwarden"), sessionToken, {
			sensitive: true,
			caller: "tray-app:backend-ops",
		});

		return {
			backendId: "bitwarden",
			sessionStored: true,
			message: alreadyLoggedIn ? "Already logged in; vault unlocked" : "Signed in via API key; vault unlocked",
		};
	}

	async signOut(backendId: InstallableBackendId): Promise<void> {
		const v = await this.vault.vault();
		const key = sessionKey(backendId);
		if (await v.has(key)) await v.remove(key);
	}
}
