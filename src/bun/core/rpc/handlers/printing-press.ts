/**
 * Printing Press RPC handlers — 7 endpoints for the Tools pane.
 *
 *   - printingPressCatalog         → full catalog with installed/enabled status
 *   - printingPressToggleCli       → toggle a single CLI on/off
 *   - printingPressToggleCategory  → toggle all CLIs in a category
 *   - printingPressInstallCli      → install a CLI
 *   - printingPressUninstallCli    → uninstall a CLI
 *   - printingPressGetConfig       → load config
 *   - printingPressSetConfig       → save config
 */

import type { RpcDeps } from "../types";
import type {
	PrintingPressConfig,
	PrintingPressCatalogEntry,
	PrintingPressCatalogSnapshot,
} from "../../../../shared/index";

export function printingPressRequests(deps: RpcDeps) {
	return {
		printingPressCatalog: async (
			params: { search?: string; category?: string },
		): Promise<PrintingPressCatalogSnapshot> => {
			const registry = await deps.printingPress.fetchRegistry();
			const config = await deps.config.getPrintingPress();
			const enabledSet = new Set(config.enabledClis);

			// Check installed status
			const installedResult = await deps.printingPress.listInstalled();
			const installedSlugs = new Set<string>();
			if (installedResult.ok) {
				try {
					const parsed = JSON.parse(installedResult.stdout);
					if (Array.isArray(parsed)) {
						for (const item of parsed) {
							const slug = typeof item === "string" ? item : item?.name ?? item?.slug;
							if (typeof slug === "string") installedSlugs.add(slug.replace(/-pp-cli$/, ""));
						}
					}
				} catch { /* non-JSON output, skip */ }
			}

			let entries: PrintingPressCatalogEntry[] = registry.entries.map((e) => ({
				slug: e.name,
				category: e.category,
				api: e.api,
				description: e.description,
				searchTerms: e.search_terms,
				installed: installedSlugs.has(e.name),
				enabled: enabledSet.has(e.name),
				hasMcp: !!e.mcp,
				toolCount: e.mcp?.tool_count ?? 0,
			}));

			// Apply filters
			if (params.search) {
				const q = params.search.toLowerCase();
				entries = entries.filter(
					(e) =>
						e.slug.includes(q) ||
						e.api.toLowerCase().includes(q) ||
						e.description.toLowerCase().includes(q) ||
						e.category.includes(q) ||
						e.searchTerms.some((t) => t.toLowerCase().includes(q)),
				);
			}
			if (params.category) {
				const cat = params.category.toLowerCase();
				entries = entries.filter((e) => e.category === cat);
			}

			// Categories
			const catMap = new Map<string, { count: number; enabledCount: number }>();
			for (const e of registry.entries) {
				const existing = catMap.get(e.category) ?? { count: 0, enabledCount: 0 };
				existing.count++;
				if (enabledSet.has(e.name)) existing.enabledCount++;
				catMap.set(e.category, existing);
			}
			const categories = Array.from(catMap.entries())
				.map(([category, stats]) => ({ category, ...stats }))
				.sort((a, b) => a.category.localeCompare(b.category));

			return {
				entries,
				categories,
				totalInstalled: installedSlugs.size,
				totalEnabled: enabledSet.size,
			};
		},

		printingPressToggleCli: async (
			params: { slug: string; enabled: boolean },
		): Promise<PrintingPressConfig> => {
			const config = await deps.config.getPrintingPress();
			const set = new Set(config.enabledClis);
			if (params.enabled) {
				set.add(params.slug);
			} else {
				set.delete(params.slug);
			}
			return deps.config.setPrintingPress({
				...config,
				enabledClis: [...set],
			});
		},

		printingPressToggleCategory: async (
			params: { category: string; enabled: boolean },
		): Promise<PrintingPressConfig> => {
			const registry = await deps.printingPress.fetchRegistry();
			const config = await deps.config.getPrintingPress();
			const set = new Set(config.enabledClis);
			const categorySlugs = registry.entries
				.filter((e) => e.category === params.category)
				.map((e) => e.name);
			for (const slug of categorySlugs) {
				if (params.enabled) {
					set.add(slug);
				} else {
					set.delete(slug);
				}
			}
			return deps.config.setPrintingPress({
				...config,
				enabledClis: [...set],
			});
		},

		printingPressInstallCli: async (
			params: { slug: string },
		): Promise<{ ok: boolean; output: string }> => {
			const result = await deps.printingPress.installCli(params.slug);
			if (result.ok) {
				// Auto-enable after install
				const config = await deps.config.getPrintingPress();
				const set = new Set(config.enabledClis);
				set.add(params.slug);
				await deps.config.setPrintingPress({
					...config,
					enabledClis: [...set],
				});
			}
			return { ok: result.ok, output: result.stdout || result.stderr };
		},

		printingPressUninstallCli: async (
			params: { slug: string },
		): Promise<{ ok: boolean; output: string }> => {
			const result = await deps.printingPress.uninstallCli(params.slug);
			if (result.ok) {
				// Auto-disable after uninstall
				const config = await deps.config.getPrintingPress();
				const set = new Set(config.enabledClis);
				set.delete(params.slug);
				await deps.config.setPrintingPress({
					...config,
					enabledClis: [...set],
				});
			}
			return { ok: result.ok, output: result.stdout || result.stderr };
		},

		printingPressGetConfig: async (
			_params: Record<string, never>,
		): Promise<PrintingPressConfig> => {
			return deps.config.getPrintingPress();
		},

		printingPressSetConfig: async (
			params: Partial<PrintingPressConfig>,
		): Promise<PrintingPressConfig> => {
			const current = await deps.config.getPrintingPress();
			return deps.config.setPrintingPress({ ...current, ...params });
		},
	};
}
