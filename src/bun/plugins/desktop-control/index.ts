import {
	type Action,
	type ActionResult,
	type Handler,
	type HandlerCallback,
	type Plugin,
	type Provider,
	type ProviderResult,
} from "@elizaos/core";
import {
	captureScreen,
	clickScreen,
	observeDesktop,
	openApp,
	pressKey,
	type ScreenRegion,
	typeText,
} from "../../core/desktop-control";
import { browserUseEnabled, computerUseEnabled, toolPermissionSnapshot } from "../agent-tool-permissions";

function fail(text: string): ActionResult {
	return { success: false, text, error: text };
}

function ok(text: string, values?: Record<string, unknown>): ActionResult {
	return { success: true, text, ...(values ? { values: values as never, data: values as never } : {}) };
}

async function emit(callback: HandlerCallback | undefined, text: string, actionName: string): Promise<void> {
	if (!callback) return;
	await callback({ text, source: "desktop-control" } as never, actionName);
}

function paramsBag(options: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!options) return {};
	const parameters = options.parameters;
	if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) return parameters as Record<string, unknown>;
	return options;
}

function stringOption(options: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	const params = paramsBag(options);
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function numberOption(options: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
	const params = paramsBag(options);
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim().length > 0) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function modifiersOption(options: Record<string, unknown> | undefined): string[] {
	const params = paramsBag(options);
	const value = params.modifiers;
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function regionOption(options: Record<string, unknown> | undefined): ScreenRegion | undefined {
	const params = paramsBag(options);
	const region = params.region && typeof params.region === "object" ? params.region as Record<string, unknown> : params;
	const x = typeof region.x === "number" ? region.x : undefined;
	const y = typeof region.y === "number" ? region.y : undefined;
	const width = typeof region.width === "number" ? region.width : undefined;
	const height = typeof region.height === "number" ? region.height : undefined;
	if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
	return { x, y, width, height };
}

function requireComputerUse(): ActionResult | null {
	return computerUseEnabled()
		? null
		: fail("Computer use is disabled in Settings → Agent Permissions. Enable it and grant macOS Accessibility/Screen Recording/Automation as needed.");
}

const alwaysValid: Action["validate"] = async () => true;

const observeHandler: Handler = async (_runtime, _message, _state, _options, callback) => {
	const denied = requireComputerUse();
	if (denied) return denied;
	try {
		const observation = await observeDesktop();
		const focused = observation.focusedApp ? `Focused app: ${observation.focusedApp}` : "Focused app: unknown";
		const windows = observation.windows.slice(0, 12).map((win) => {
			const title = win.title ? ` — ${win.title}` : "";
			return `- ${win.focused ? "*" : " "} ${win.app}${title} (${win.x},${win.y} ${win.width}x${win.height})`;
		}).join("\n");
		const text = `${focused}\nWindows:\n${windows || "- none visible"}`;
		await emit(callback, text, "COMPUTER_OBSERVE");
		return ok(text, { observation });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const computerObserveAction: Action = {
	name: "COMPUTER_OBSERVE",
	similes: ["DESKTOP_OBSERVE", "GET_APP_STATE", "SEE_DESKTOP", "LIST_WINDOWS"],
	description:
		"Inspect the user's macOS desktop state: screens, visible windows, focused app, titles, and bounds. Use before clicking or typing into apps.",
	validate: alwaysValid,
	handler: observeHandler,
	examples: [],
	parameters: [],
} as Action;

const screenshotHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const denied = requireComputerUse();
	if (denied) return denied;
	const opts = options as Record<string, unknown> | undefined;
	try {
		const screenshot = await captureScreen({
			label: stringOption(opts, ["label", "name"]) ?? "screen",
			region: regionOption(opts),
			timeoutMs: numberOption(opts, ["timeoutMs", "timeout_ms"]),
		});
		const text = `Computer screenshot saved: ${screenshot.path}`;
		await emit(callback, text, "COMPUTER_SCREENSHOT");
		return ok(text, { screenshot });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const computerScreenshotAction: Action = {
	name: "COMPUTER_SCREENSHOT",
	similes: ["SCREENSHOT_DESKTOP", "CAPTURE_SCREEN", "SEE_SCREEN"],
	description:
		"Take a screenshot of the whole computer screen, or a region when x/y/width/height are provided. Saves a local PNG under ~/.detour/screenshots.",
	validate: alwaysValid,
	handler: screenshotHandler,
	examples: [],
	parameters: [
		{ name: "label", description: "Optional file label.", required: false, schema: { type: "string" as const } },
		{ name: "x", description: "Optional capture-region x coordinate.", required: false, schema: { type: "number" as const } },
		{ name: "y", description: "Optional capture-region y coordinate.", required: false, schema: { type: "number" as const } },
		{ name: "width", description: "Optional capture-region width.", required: false, schema: { type: "number" as const } },
		{ name: "height", description: "Optional capture-region height.", required: false, schema: { type: "number" as const } },
	],
} as Action;

const clickHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const denied = requireComputerUse();
	if (denied) return denied;
	const opts = options as Record<string, unknown> | undefined;
	const x = numberOption(opts, ["x"]);
	const y = numberOption(opts, ["y"]);
	if (x === undefined || y === undefined) return fail("COMPUTER_CLICK requires x and y.");
	try {
		await clickScreen(x, y);
		const text = `Clicked ${Math.round(x)},${Math.round(y)}.`;
		await emit(callback, text, "COMPUTER_CLICK");
		return ok(text);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const computerClickAction: Action = {
	name: "COMPUTER_CLICK",
	similes: ["DESKTOP_CLICK", "CLICK_SCREEN", "CLICK_APP"],
	description:
		"Click a screen coordinate in the user's macOS session. Use COMPUTER_OBSERVE or COMPUTER_SCREENSHOT first to locate the target.",
	validate: alwaysValid,
	handler: clickHandler,
	examples: [],
	parameters: [
		{ name: "x", description: "Screen x coordinate.", required: true, schema: { type: "number" as const } },
		{ name: "y", description: "Screen y coordinate.", required: true, schema: { type: "number" as const } },
	],
} as Action;

const typeHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const denied = requireComputerUse();
	if (denied) return denied;
	const opts = options as Record<string, unknown> | undefined;
	const text = stringOption(opts, ["text", "value", "input"]);
	if (!text) return fail("COMPUTER_TYPE requires text.");
	try {
		await typeText(text);
		const reply = `Typed ${text.length} character${text.length === 1 ? "" : "s"}.`;
		await emit(callback, reply, "COMPUTER_TYPE");
		return ok(reply);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const computerTypeAction: Action = {
	name: "COMPUTER_TYPE",
	similes: ["DESKTOP_TYPE", "TYPE_TEXT", "INPUT_TEXT"],
	description:
		"Type text into the focused macOS app using System Events. Use after observing/clicking the intended field.",
	validate: alwaysValid,
	handler: typeHandler,
	examples: [],
	parameters: [
		{ name: "text", description: "Text to type.", required: true, schema: { type: "string" as const } },
	],
} as Action;

const keyHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const denied = requireComputerUse();
	if (denied) return denied;
	const opts = options as Record<string, unknown> | undefined;
	const key = stringOption(opts, ["key", "code"]);
	if (!key) return fail("COMPUTER_KEY requires key.");
	try {
		await pressKey(key, modifiersOption(opts));
		const text = `Pressed ${key}.`;
		await emit(callback, text, "COMPUTER_KEY");
		return ok(text);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const computerKeyAction: Action = {
	name: "COMPUTER_KEY",
	similes: ["DESKTOP_KEY", "PRESS_KEY", "HOTKEY"],
	description:
		"Press a key or key code in the focused macOS app. Modifiers may include command, shift, option, and control.",
	validate: alwaysValid,
	handler: keyHandler,
	examples: [],
	parameters: [
		{ name: "key", description: "Character key or numeric macOS key code.", required: true, schema: { type: "string" as const } },
		{ name: "modifiers", description: "Optional modifiers: command, shift, option, control.", required: false, schema: { type: "array" as const, items: { type: "string" as const } } },
	],
} as Action;

const openAppHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const denied = requireComputerUse();
	if (denied) return denied;
	const opts = options as Record<string, unknown> | undefined;
	const target = stringOption(opts, ["target", "app", "path", "url"]);
	if (!target) return fail("COMPUTER_OPEN_APP requires target.");
	try {
		await openApp(target);
		const text = `Opened ${target}.`;
		await emit(callback, text, "COMPUTER_OPEN_APP");
		return ok(text);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const computerOpenAppAction: Action = {
	name: "COMPUTER_OPEN_APP",
	similes: ["OPEN_APP", "OPEN_APPLICATION", "OPEN_DESKTOP_TARGET"],
	description:
		"Open a macOS app by name, or open a local path/file URL/http URL using the user's default handler.",
	validate: alwaysValid,
	handler: openAppHandler,
	examples: [],
	parameters: [
		{ name: "target", description: "App name, path, file URL, or web URL.", required: true, schema: { type: "string" as const } },
	],
} as Action;

export const desktopUseStatusProvider: Provider = {
	name: "DESKTOP_USE_STATUS",
	description:
		"Current browser-use and computer-use permission status for user-level desktop automation.",
	descriptionCompressed: "browser/computer-use permission status.",
	position: -35,
	get: async (): Promise<ProviderResult> => {
		const snapshot = toolPermissionSnapshot();
		const lines = [
			"# Desktop tool permissions",
			`- User-level machine access: ${snapshot.userLevelAccess ? "available as the logged-in macOS user" : "unavailable"}.`,
			`- Browser use: ${browserUseEnabled() ? "enabled" : "disabled"}; actions include BROWSER_OPEN, BROWSER_INSPECT, BROWSER_SCRIPT, BROWSER_SCREENSHOT, and BROWSER_FILL_LOGIN.`,
			`- Computer use: ${computerUseEnabled() ? "enabled" : "disabled"}; actions include COMPUTER_OBSERVE, COMPUTER_SCREENSHOT, COMPUTER_CLICK, COMPUTER_TYPE, COMPUTER_KEY, and COMPUTER_OPEN_APP.`,
			"- macOS grants still control the floor: Screen Recording for screenshots, Accessibility for clicks/typing/window observation, and Automation for System Events.",
		];
		return { text: lines.join("\n"), values: snapshot as never, data: snapshot as never };
	},
};

export const desktopControlPlugin: Plugin = {
	name: "desktop-control",
	description:
		"User-level macOS computer-use actions: observe windows, capture browser/desktop screenshots, click, type, press keys, and open apps when enabled in Agent Permissions.",
	actions: [
		computerObserveAction,
		computerScreenshotAction,
		computerClickAction,
		computerTypeAction,
		computerKeyAction,
		computerOpenAppAction,
	],
	providers: [desktopUseStatusProvider],
};

export default desktopControlPlugin;
