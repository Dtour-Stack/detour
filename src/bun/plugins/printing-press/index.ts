/**
 * Printing Press Agent Plugin — gives the agent permanent access to the
 * Printing Press Library: 181 agent-optimized Go CLIs across 17 categories.
 *
 * The agent gets these actions:
 *   - PRINTING_PRESS_SEARCH     → search the catalog by keyword
 *   - PRINTING_PRESS_LIST       → list CLIs by category
 *   - PRINTING_PRESS_DETAILS    → get full details for a CLI
 *   - PRINTING_PRESS_INSTALL    → install a CLI from the catalog
 *   - PRINTING_PRESS_UNINSTALL  → remove an installed CLI
 *   - PRINTING_PRESS_INSTALLED  → list currently installed CLIs
 *   - PRINTING_PRESS_RUN        → execute an installed CLI with arguments
 *   - PRINTING_PRESS_CREATE     → create a new CLI on the fly from an API name/URL
 *
 * Plus a context provider (PRINTING_PRESS_CONTEXT) that injects catalog
 * awareness and CLI creation guidance into the agent's system prompt.
 */

import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	Plugin,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import type { PrintingPressClient, RegistryEntry, ShellResult } from "../../core/printing-press-client";
import type { ConfigService } from "../../core/config-service";

// ── Helpers ─────────────────────────────────────────────────────────────

function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

function pickString(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function pickNumber(
	opts: Record<string, unknown> | undefined,
	keys: readonly string[],
): number | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	for (const k of keys) {
		const v = bag[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim().length > 0) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim().length > 0) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

function pickStringArray(
	opts: Record<string, unknown> | undefined,
	key: string,
): string[] | undefined {
	if (!opts) return undefined;
	const bag = paramsBag(opts);
	const v = bag[key] ?? opts[key];
	if (Array.isArray(v)) return v.filter((x) => typeof x === "string") as string[];
	if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
	return undefined;
}

async function emit(
	callback: HandlerCallback | undefined,
	text: string,
	actionName: string,
): Promise<void> {
	if (!callback) return;
	try {
		await callback({ text, source: "printing-press" } as never, actionName);
	} catch {
		/* ignore */
	}
}

function fail(reason: string): ActionResult {
	return { success: false, text: reason };
}

function ok(text: string): ActionResult {
	return { success: true, text };
}

function shellToResult(r: ShellResult, actionName: string): ActionResult {
	if (!r.ok) {
		const msg = `${actionName} failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`;
		return fail(msg);
	}
	return ok(r.stdout || "(ok, no output)");
}

function entriesToCompact(entries: RegistryEntry[], limit = 30): string {
	const capped = entries.slice(0, limit);
	const lines = capped.map((e) => {
		const mcp = e.mcp ? ` [MCP: ${e.mcp.tool_count} tools]` : "";
		return `• ${e.name} (${e.category}) — ${e.description.slice(0, 120)}${mcp}`;
	});
	if (entries.length > limit) {
		lines.push(`... and ${entries.length - limit} more. Use a more specific query.`);
	}
	return lines.join("\n");
}

// ── Action Handlers ─────────────────────────────────────────────────────

function makeHandlers(client: PrintingPressClient, config: ConfigService) {
	const alwaysValid: Action["validate"] = async () => true;

	// ── PRINTING_PRESS_SEARCH ───────────────────────────────────────

	const searchHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const query = pickString(opts, ["query", "q", "search", "keyword"]);
		if (!query) return fail("Missing search query (params: query)");
		try {
			const results = await client.searchCatalog(query);
			const text = results.length === 0
				? `No CLIs found matching "${query}". Try a broader keyword.`
				: `Found ${results.length} CLIs matching "${query}":\n\n${entriesToCompact(results)}`;
			await emit(callback, text, "PRINTING_PRESS_SEARCH");
			return ok(text);
		} catch (err) {
			const msg = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
			await emit(callback, msg, "PRINTING_PRESS_SEARCH");
			return fail(msg);
		}
	};

	// ── PRINTING_PRESS_LIST ─────────────────────────────────────────

	const listHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const category = pickString(opts, ["category", "cat", "type"]);
		try {
			if (category) {
				const results = await client.listByCategory(category);
				const text = results.length === 0
					? `No CLIs in category "${category}". Use PRINTING_PRESS_LIST without category to see all categories.`
					: `${results.length} CLIs in "${category}":\n\n${entriesToCompact(results, 50)}`;
				await emit(callback, text, "PRINTING_PRESS_LIST");
				return ok(text);
			}
			const categories = await client.getCategories();
			const text = `Printing Press catalog — ${categories.reduce((s, c) => s + c.count, 0)} CLIs across ${categories.length} categories:\n\n${categories.map((c) => `• ${c.category} (${c.count})`).join("\n")}\n\nUse category param to list CLIs in a specific category.`;
			await emit(callback, text, "PRINTING_PRESS_LIST");
			return ok(text);
		} catch (err) {
			return fail(`List failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// ── PRINTING_PRESS_DETAILS ──────────────────────────────────────

	const detailsHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const slug = pickString(opts, ["slug", "name", "cli", "tool"]);
		if (!slug) return fail("Missing CLI slug (params: slug)");
		try {
			const entry = await client.getDetails(slug);
			if (!entry) return fail(`CLI "${slug}" not found in catalog.`);
			const text = JSON.stringify(entry, null, 2);
			await emit(callback, text, "PRINTING_PRESS_DETAILS");
			return ok(text);
		} catch (err) {
			return fail(`Details failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// ── PRINTING_PRESS_INSTALL ──────────────────────────────────────

	const installHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const slug = pickString(opts, ["slug", "name", "cli", "tool"]);
		if (!slug) return fail("Missing CLI slug (params: slug). Use PRINTING_PRESS_SEARCH to find CLIs.");
		await emit(callback, `Installing ${slug}... this may take a minute.`, "PRINTING_PRESS_INSTALL");
		const result = await client.installCli(slug);
		const res = shellToResult(result, "PRINTING_PRESS_INSTALL");
		await emit(callback, res.text ?? "", "PRINTING_PRESS_INSTALL");
		return res;
	};

	// ── PRINTING_PRESS_UNINSTALL ────────────────────────────────────

	const uninstallHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const slug = pickString(opts, ["slug", "name", "cli", "tool"]);
		if (!slug) return fail("Missing CLI slug (params: slug)");
		const result = await client.uninstallCli(slug);
		const res = shellToResult(result, "PRINTING_PRESS_UNINSTALL");
		await emit(callback, res.text ?? "", "PRINTING_PRESS_UNINSTALL");
		return res;
	};

	// ── PRINTING_PRESS_INSTALLED ────────────────────────────────────

	const installedHandler: Handler = async (_r, _m, _s, _options, callback) => {
		const result = await client.listInstalled();
		const res = shellToResult(result, "PRINTING_PRESS_INSTALLED");
		await emit(callback, res.text ?? "", "PRINTING_PRESS_INSTALLED");
		return res;
	};

	// ── PRINTING_PRESS_RUN ──────────────────────────────────────────

	const runHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const slug = pickString(opts, ["slug", "name", "cli", "binary", "tool"]);
		const argsRaw = pickStringArray(opts, "args") ?? [];
		const command = pickString(opts, ["command", "cmd", "subcommand"]);
		const timeout = pickNumber(opts, ["timeout", "timeoutMs"]) ?? 60_000;
		if (!slug) return fail("Missing CLI slug (params: slug, args?, command?)");

		// Check if this CLI is enabled in config
		const cfg = await config.getPrintingPress();
		const normalizedSlug = slug.replace(/-pp-cli$/, "");
		if (cfg.enabledClis.length > 0 && !cfg.enabledClis.includes(normalizedSlug)) {
			// Auto-install if autoInstall is on
			if (cfg.autoInstall) {
				await emit(callback, `CLI "${normalizedSlug}" not enabled. Auto-enabling and installing...`, "PRINTING_PRESS_RUN");
				const installResult = await client.installCli(normalizedSlug);
				if (!installResult.ok) {
					return fail(`Auto-install of "${normalizedSlug}" failed: ${installResult.stderr}`);
				}
				// Add to enabled list
				const updatedCfg = await config.getPrintingPress();
				const set = new Set(updatedCfg.enabledClis);
				set.add(normalizedSlug);
				await config.setPrintingPress({ ...updatedCfg, enabledClis: [...set] });
			} else {
				return fail(`CLI "${normalizedSlug}" is not enabled. Enable it in Activity → Tools, or set autoInstall to true.`);
			}
		}

		const args = command ? [command, ...argsRaw] : argsRaw;
		await emit(callback, `Running ${slug}-pp-cli ${args.join(" ")}...`, "PRINTING_PRESS_RUN");
		const result = await client.runCli(slug, args, timeout);
		const res = shellToResult(result, "PRINTING_PRESS_RUN");
		await emit(callback, res.text ?? "", "PRINTING_PRESS_RUN");
		return res;
	};

	// ── PRINTING_PRESS_CREATE ───────────────────────────────────────

	const createHandler: Handler = async (_r, _m, _s, options, callback) => {
		const opts = options as Record<string, unknown> | undefined;
		const api = pickString(opts, ["api", "name", "url", "apiName", "target"]);
		if (!api) return fail("Missing API name or URL (params: api). Example: 'Notion', 'https://api.example.com'");

		// Check if CLI creation is allowed
		const cfg = await config.getPrintingPress();
		if (!cfg.allowCreate) {
			return fail("CLI creation is disabled. Enable 'Allow agent to create new CLIs' in Activity → Tools.");
		}

		await emit(callback, `Creating CLI for "${api}"... this will take several minutes.`, "PRINTING_PRESS_CREATE");
		const result = await client.createCli(api);
		const res = shellToResult(result, "PRINTING_PRESS_CREATE");
		await emit(callback, res.text ?? "", "PRINTING_PRESS_CREATE");
		return res;
	};

	// ── Action definitions ──────────────────────────────────────────

	const search: Action = {
		name: "PRINTING_PRESS_SEARCH",
		similes: ["PP_SEARCH", "SEARCH_CLIS", "FIND_CLI_TOOL"],
		description:
			"Printing Press: search the catalog of 181 agent-optimized Go CLIs by keyword. " +
			"Params: query (search term — matches name, API, description, category, search_terms).",
		validate: alwaysValid,
		handler: searchHandler,
	};

	const list: Action = {
		name: "PRINTING_PRESS_LIST",
		similes: ["PP_LIST", "LIST_CLIS", "CLI_CATEGORIES"],
		description:
			"Printing Press: list CLIs by category (17 categories: travel, food-and-dining, developer-tools, etc.). " +
			"Params: category? (if omitted, lists all categories with counts).",
		validate: alwaysValid,
		handler: listHandler,
	};

	const details: Action = {
		name: "PRINTING_PRESS_DETAILS",
		similes: ["PP_DETAILS", "CLI_DETAILS", "CLI_INFO"],
		description:
			"Printing Press: get full details for a CLI — description, search terms, MCP info, auth requirements, printer. " +
			"Params: slug (the CLI name, e.g. 'espn', 'coingecko', 'flight-goat').",
		validate: alwaysValid,
		handler: detailsHandler,
	};

	const install: Action = {
		name: "PRINTING_PRESS_INSTALL",
		similes: ["PP_INSTALL", "INSTALL_CLI"],
		description:
			"Printing Press: install a CLI from the catalog. Installs the Go binary + agent skill. " +
			"Requires Go 1.26+. Params: slug (CLI name or 'starter-pack' for 4 hand-picked CLIs).",
		validate: alwaysValid,
		handler: installHandler,
	};

	const uninstall: Action = {
		name: "PRINTING_PRESS_UNINSTALL",
		similes: ["PP_UNINSTALL", "REMOVE_CLI"],
		description:
			"Printing Press: remove an installed CLI. Params: slug (CLI name).",
		validate: alwaysValid,
		handler: uninstallHandler,
	};

	const installed: Action = {
		name: "PRINTING_PRESS_INSTALLED",
		similes: ["PP_INSTALLED", "LIST_INSTALLED_CLIS"],
		description:
			"Printing Press: list currently installed CLIs from the catalog.",
		validate: alwaysValid,
		handler: installedHandler,
	};

	const run: Action = {
		name: "PRINTING_PRESS_RUN",
		similes: ["PP_RUN", "RUN_CLI", "EXECUTE_CLI"],
		description:
			"Printing Press: execute an installed CLI with arguments. Output is always JSON. " +
			"Params: slug (CLI name, e.g. 'espn'), command? (subcommand), args? (array of args), timeout? (ms, default 60000).",
		validate: alwaysValid,
		handler: runHandler,
	};

	const create: Action = {
		name: "PRINTING_PRESS_CREATE",
		similes: ["PP_CREATE", "CREATE_CLI", "PRINT_CLI", "GENERATE_CLI"],
		description:
			"Printing Press: create a brand new CLI from an API name or URL. " +
			"Can reverse-engineer APIs from websites with no spec. Takes several minutes. " +
			"Params: api (API name like 'Notion' or URL like 'https://api.example.com').",
		validate: alwaysValid,
		handler: createHandler,
	};

	return { search, list, details, install, uninstall, installed, run, create };
}

// ── Context provider ────────────────────────────────────────────────────

function makeContextProvider(client: PrintingPressClient, config: ConfigService): Provider {
	return {
		name: "PRINTING_PRESS_CONTEXT",
		description:
			"Printing Press catalog awareness: injects knowledge of 181 agent-optimized CLIs " +
			"organized by category, with guidance on when to use them, how to chain output, " +
			"and how to create new CLIs on the fly.",
		descriptionCompressed: "Printing Press catalog + CLI creation guidance.",
		position: 55,
		get: async (_runtime: IAgentRuntime, _m: Memory, _s: State): Promise<ProviderResult> => {
			const lines: string[] = [];
			const cfg = await config.getPrintingPress();

			lines.push("# Printing Press — 181 agent-native CLIs");
			lines.push("");

			// Show enabled CLIs so the agent knows what it has access to
			if (cfg.enabledClis.length > 0) {
				lines.push(`## Your enabled CLIs (${cfg.enabledClis.length})`);
				lines.push(cfg.enabledClis.map((s) => `• ${s}`).join("\n"));
				lines.push("");
				lines.push("Use PRINTING_PRESS_RUN with any of the above slugs to execute them.");
				lines.push("");
			} else {
				lines.push("No CLIs are currently enabled. Use Activity → Tools to enable CLIs, or search and install from the catalog.");
				lines.push("");
			}

			lines.push("## Config");
			lines.push(`- Auto-install: ${cfg.autoInstall ? "ON — will install CLIs automatically when you try to use them" : "OFF — must be installed via PRINTING_PRESS_INSTALL first"}`);
			lines.push(`- CLI creation: ${cfg.allowCreate ? "ON — you can create new CLIs with PRINTING_PRESS_CREATE" : "OFF — creation disabled by user"}`);
			lines.push("");

			lines.push("## How to use");
			lines.push("1. **Search**: PRINTING_PRESS_SEARCH to find a CLI for any task (travel, crypto, marketing, food, etc.)");
			lines.push("2. **Details**: PRINTING_PRESS_DETAILS to check auth requirements and capabilities");
			lines.push("3. **Install**: PRINTING_PRESS_INSTALL to install (requires Go 1.26+)");
			lines.push("4. **Run**: PRINTING_PRESS_RUN to execute with --json output");
			lines.push("5. **Create**: PRINTING_PRESS_CREATE to generate a NEW CLI from any API name or URL");
			lines.push("");
			lines.push("## Key CLIs to know");
			lines.push("- **espn** — live sports scores, injuries, lineups (no API key needed, sniffed)");
			lines.push("- **coingecko** — crypto prices, market data (no API key needed)");
			lines.push("- **flight-goat** — Kayak + Google Flights search, two sources one query");
			lines.push("- **company-goat** — startup research across SEC, GitHub, HN, YC, Wikidata");
			lines.push("- **sentry** — local SQLite mirror, cross-org SQL queries");
			lines.push("- **archive-is** — bypass paywalls via archive.today");
			lines.push("- **arxiv** — paper search and metadata");
			lines.push("- **airbnb** — Airbnb + VRBO search with price arbitrage");
			lines.push("- **clickup** — ClickUp project management (v2 + v3 endpoints)");
			lines.push("- **cal-com** — Cal.com scheduling + analytics");
			lines.push("");
			lines.push("## Categories (17)");
			lines.push("cloud, commerce, developer-tools, devices, food-and-dining, marketing, media-and-entertainment, monitoring, other, payments, productivity, project-management, sales-and-crm, social-and-messaging, travel");
			lines.push("");
			lines.push("## CLI output conventions");
			lines.push("- All CLIs auto-JSON when piped. Use --compact for 60-80% fewer tokens.");
			lines.push("- Exit codes: 0=ok, 2=not found, 3=auth error, 4=rate limit, 5=validation, 7=offline");
			lines.push("- Binary names: <slug>-pp-cli (e.g., espn-pp-cli, coingecko-pp-cli)");
			lines.push("");
			lines.push("## Creating new CLIs");
			lines.push("- PRINTING_PRESS_CREATE can generate a CLI for ANY API — official, GraphQL, or reverse-engineered.");
			lines.push("- Point it at a website URL if no API spec exists — it captures traffic and reverse-engineers the API.");
			lines.push("- Each creation produces <api>-pp-cli + <api>-pp-mcp binaries.");
			lines.push("- Use this when a user needs to interact with an API that doesn't have a CLI in the catalog yet.");

			return { text: lines.join("\n") };
		},
	};
}

// ── Plugin factory ──────────────────────────────────────────────────────

export function createPrintingPressPlugin(client: PrintingPressClient, config: ConfigService): Plugin {
	const actions = makeHandlers(client, config);
	const contextProvider = makeContextProvider(client, config);
	return {
		name: "@detour/plugin-printing-press",
		description:
			"Printing Press Library — browse, install, run, and create agent-optimized Go CLIs. " +
			"181 CLIs across 17 categories (travel, crypto, dev-tools, food, marketing, etc.). " +
			"Each CLI has local SQLite, FTS5 search, and agent-native JSON output.",
		actions: [
			actions.search,
			actions.list,
			actions.details,
			actions.install,
			actions.uninstall,
			actions.installed,
			actions.run,
			actions.create,
		],
		providers: [contextProvider],
	};
}
