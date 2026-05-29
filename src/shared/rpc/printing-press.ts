/**
 * Printing Press RPC — browse, toggle, install/uninstall CLIs, and
 * manage configuration for which CLIs the agent has access to.
 *
 * UI surface: Activity → Tools.
 */

import type {
	PrintingPressConfig,
	PrintingPressCatalogSnapshot,
} from "../index";

export type PrintingPressRequests = {
	printingPressCatalog: {
		params: { search?: string; category?: string };
		response: PrintingPressCatalogSnapshot;
	};
	printingPressToggleCli: {
		params: { slug: string; enabled: boolean };
		response: PrintingPressConfig;
	};
	printingPressToggleCategory: {
		params: { category: string; enabled: boolean };
		response: PrintingPressConfig;
	};
	printingPressInstallCli: {
		params: { slug: string };
		response: { ok: boolean; output: string };
	};
	printingPressUninstallCli: {
		params: { slug: string };
		response: { ok: boolean; output: string };
	};
	printingPressGetConfig: {
		params: Record<string, never>;
		response: PrintingPressConfig;
	};
	printingPressSetConfig: {
		params: Partial<PrintingPressConfig>;
		response: PrintingPressConfig;
	};
};
