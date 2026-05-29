/**
 * printing-press-client — HTTP + shell client for the Printing Press Library.
 *
 * Fetches the live catalog from GitHub, caches it in memory, and shells out
 * to `npx @mvanhorn/printing-press-library` for install/uninstall/update and
 * to installed `<slug>-pp-cli` binaries for execution.
 *
 * Also supports creating new CLIs via `cli-printing-press print <api>`.
 */

import { logger } from "@elizaos/core";

// ── Registry types ──────────────────────────────────────────────────────

export interface McpInfo {
	binary: string;
	transports: string[];
	tool_count: number;
	public_tool_count: number;
	auth_type: string;
	env_vars: string[];
	mcp_ready: string;
	spec_format?: string;
}

export interface RegistryEntry {
	name: string;
	category: string;
	api: string;
	description: string;
	search_terms: string[];
	path: string;
	printer: string;
	printer_name: string;
	mcp?: McpInfo;
}

export interface Registry {
	schema_version: number;
	entries: RegistryEntry[];
}

export interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

// ── Constants ───────────────────────────────────────────────────────────

const REGISTRY_URL =
	"https://raw.githubusercontent.com/Dexploarer/printing-press-library/main/registry.json";

const NPX_PKG = "@mvanhorn/printing-press-library";

/** How long to cache the registry in memory (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;

const LOG_SRC = "printing-press";

// ── Helpers ─────────────────────────────────────────────────────────────

async function runShell(
	cmd: string,
	args: string[],
	timeoutMs = 120_000,
): Promise<ShellResult> {
	try {
		const proc = Bun.spawn([cmd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, NO_COLOR: "1" },
		});

		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const exitCode = await proc.exited;
		clearTimeout(timer);

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
	} catch (err) {
		return {
			ok: false,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			exitCode: -1,
		};
	}
}

// ── Client ──────────────────────────────────────────────────────────────

export class PrintingPressClient {
	private cache: { registry: Registry; fetchedAt: number } | null = null;

	// ── Registry ──────────────────────────────────────────────────────

	async fetchRegistry(): Promise<Registry> {
		if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
			return this.cache.registry;
		}
		try {
			const resp = await fetch(REGISTRY_URL);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = (await resp.json()) as Registry;
			this.cache = { registry: data, fetchedAt: Date.now() };
			logger.info({ src: LOG_SRC, entries: data.entries.length }, "registry fetched");
			return data;
		} catch (err) {
			logger.warn({ src: LOG_SRC, err }, "registry fetch failed");
			if (this.cache) return this.cache.registry;
			throw err;
		}
	}

	async searchCatalog(query: string): Promise<RegistryEntry[]> {
		const reg = await this.fetchRegistry();
		const q = query.toLowerCase();
		return reg.entries.filter((e) => {
			if (e.name.includes(q)) return true;
			if (e.api.toLowerCase().includes(q)) return true;
			if (e.description.toLowerCase().includes(q)) return true;
			if (e.category.includes(q)) return true;
			return e.search_terms.some((t) => t.toLowerCase().includes(q));
		});
	}

	async listByCategory(category: string): Promise<RegistryEntry[]> {
		const reg = await this.fetchRegistry();
		const cat = category.toLowerCase();
		return reg.entries.filter((e) => e.category === cat);
	}

	async getCategories(): Promise<{ category: string; count: number }[]> {
		const reg = await this.fetchRegistry();
		const counts = new Map<string, number>();
		for (const e of reg.entries) {
			counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.map(([category, count]) => ({ category, count }))
			.sort((a, b) => a.category.localeCompare(b.category));
	}

	async getDetails(slug: string): Promise<RegistryEntry | null> {
		const reg = await this.fetchRegistry();
		return (
			reg.entries.find(
				(e) =>
					e.name === slug ||
					e.name === slug.replace(/-pp-cli$/, "") ||
					e.api.toLowerCase() === slug.toLowerCase(),
			) ?? null
		);
	}

	// ── Install / Uninstall (via npx) ─────────────────────────────────

	async installCli(slug: string): Promise<ShellResult> {
		logger.info({ src: LOG_SRC, slug }, "installing CLI");
		return runShell("npx", ["-y", NPX_PKG, "install", slug], 300_000);
	}

	async uninstallCli(slug: string): Promise<ShellResult> {
		logger.info({ src: LOG_SRC, slug }, "uninstalling CLI");
		return runShell("npx", ["-y", NPX_PKG, "uninstall", slug, "--yes"]);
	}

	async updateCli(slug: string): Promise<ShellResult> {
		logger.info({ src: LOG_SRC, slug }, "updating CLI");
		return runShell("npx", ["-y", NPX_PKG, "update", slug], 300_000);
	}

	async listInstalled(): Promise<ShellResult> {
		return runShell("npx", ["-y", NPX_PKG, "list", "--installed", "--json"]);
	}

	// ── Run an installed CLI ──────────────────────────────────────────

	async runCli(
		slug: string,
		args: string[],
		timeoutMs = 60_000,
	): Promise<ShellResult> {
		const binary = slug.endsWith("-pp-cli") ? slug : `${slug}-pp-cli`;
		logger.info({ src: LOG_SRC, binary, args }, "running CLI");
		return runShell(binary, [...args, "--json"], timeoutMs);
	}

	// ── Create a new CLI (requires cli-printing-press) ────────────────

	async createCli(apiNameOrUrl: string): Promise<ShellResult> {
		// First check if the generator is installed
		const check = await runShell("which", ["cli-printing-press"], 5_000);
		if (!check.ok) {
			// Try to install it
			logger.info({ src: LOG_SRC }, "installing cli-printing-press generator");
			const install = await runShell(
				"go",
				["install", "github.com/mvanhorn/cli-printing-press/v4/cmd/cli-printing-press@latest"],
				120_000,
			);
			if (!install.ok) {
				return {
					ok: false,
					stdout: "",
					stderr: `Failed to install cli-printing-press: ${install.stderr}`,
					exitCode: -1,
				};
			}
		}

		logger.info({ src: LOG_SRC, api: apiNameOrUrl }, "creating new CLI");
		return runShell("cli-printing-press", ["print", apiNameOrUrl], 600_000);
	}

	// ── Install the generator itself ──────────────────────────────────

	async installGenerator(): Promise<ShellResult> {
		return runShell(
			"go",
			["install", "github.com/mvanhorn/cli-printing-press/v4/cmd/cli-printing-press@latest"],
			120_000,
		);
	}
}
