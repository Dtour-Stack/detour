import type {
	BrowserCommand,
	BrowserCommandResult,
} from "../index";

export type BrowserRequests = {
	// GET /api/browser/commands?after&since → { commands: BrowserCommand[] }
	browserCommandsList: {
		params: { after?: string; since?: number };
		response: { commands: BrowserCommand[] };
	};
	// POST /api/browser/commands/<id>/result → { result: BrowserCommandResult }
	browserCommandReport: {
		params: {
			commandId: string;
			result: Omit<BrowserCommandResult, "time">;
		};
		response: { result: BrowserCommandResult };
	};
};

export type BrowserMessages = {
	// Replaces ws `ui:open-browser`. Fired when the bun side wants the
	// browser surface revealed (e.g. an agent enqueued an open command).
	uiOpenBrowser: Record<string, never>;
	// Replaces ws `browser:command`. Fired whenever a new browser command
	// is enqueued so the BrowserView component can pick it up live.
	browserCommand: { command: BrowserCommand };
};
