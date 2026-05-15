/**
 * mac-automate plugin — generic AppleScript escape hatch + a small
 * library of pre-baked recipes for the obvious macOS apps.
 *
 * Why this exists: Detour has clicks/keystrokes via desktop-control,
 * but driving native Mac apps (Calendar / Reminders / Mail / Notes /
 * Music / Safari / Finder) through clicks is brittle. AppleScript +
 * JXA give us first-class scripting interfaces — every one of those
 * apps has a rich `.sdef` already.
 *
 * Permission posture: AppleScript that drives another app needs
 * Automation TCC permission. First call to any recipe will trigger
 * a macOS prompt ("Detour wants to control Calendar.app"). After the
 * user approves once, subsequent calls run silently.
 *
 * Safety:
 *   - Mail recipe opens a DRAFT only — never auto-sends.
 *   - RUN_APPLESCRIPT is gated behind Computer Use (same gate as
 *     desktop-control) so the agent can't run arbitrary scripts when
 *     the user hasn't opted in.
 *   - All recipes have a timeout; stuck scripts get SIGKILL'd.
 */

import {
	type Action,
	type ActionResult,
	type Handler,
	type HandlerCallback,
	type Plugin,
} from "@elizaos/core";
import {
	isDarwin,
	runAppleScript,
	type RunAppleScriptResult,
} from "../../core/mac-automate";
import {
	calendarCreateEvent,
	calendarListToday,
	finderReveal,
	mailDraft,
	musicNowPlaying,
	musicPlayPause,
	notesCreate,
	remindersAdd,
	safariGetFrontTab,
	type Recipe,
} from "./recipes";
import { computerUseEnabled } from "../agent-tool-permissions";

function fail(text: string): ActionResult {
	return { success: false, text, error: text };
}

function ok(text: string, values?: Record<string, unknown>): ActionResult {
	return {
		success: true,
		text,
		...(values ? { values: values as never, data: values as never } : {}),
	};
}

async function emit(
	callback: HandlerCallback | undefined,
	text: string,
	actionName: string,
): Promise<void> {
	if (!callback) return;
	await callback({ text, source: "mac-automate" } as never, actionName);
}

function paramsBag(options: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!options) return {};
	const parameters = options.parameters;
	if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
		return parameters as Record<string, unknown>;
	}
	return options;
}

function strParam(
	options: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	const params = paramsBag(options);
	for (const key of keys) {
		const v = params[key];
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
	}
	return undefined;
}

function requireDarwin(): ActionResult | null {
	return isDarwin()
		? null
		: fail("This action is macOS-only.");
}

function requireComputerUse(): ActionResult | null {
	return computerUseEnabled()
		? null
		: fail(
			"Computer Use is disabled in Settings → Agent Permissions. Enable it before running AppleScript.",
		);
}

async function runAndReport(
	recipe: Recipe,
	actionName: string,
	callback: HandlerCallback | undefined,
	successText: (result: RunAppleScriptResult) => string,
): Promise<ActionResult> {
	const result = await runAppleScript(recipe);
	if (result.exitCode !== 0) {
		const detail = result.timedOut
			? "timed out"
			: result.stderr || `exit ${result.exitCode}`;
		const msg = `${actionName} failed: ${detail}`;
		await emit(callback, msg, actionName);
		return fail(msg);
	}
	const text = successText(result);
	await emit(callback, text, actionName);
	return ok(text, {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
	});
}

const alwaysValid: Action["validate"] = async () => true;

// ── Generic escape hatch ────────────────────────────────────────────

const runAppleScriptHandler: Handler = async (_runtime, _message, _state, options, callback) => {
	const env = requireDarwin();
	if (env) return env;
	const gated = requireComputerUse();
	if (gated) return gated;
	const params = paramsBag(options);
	const script = strParam(params, ["script", "code", "src"]);
	if (!script) return fail("RUN_APPLESCRIPT requires `script`.");
	const langRaw = strParam(params, ["lang", "language"]);
	const lang: "applescript" | "jxa" =
		langRaw === "jxa" || langRaw === "javascript" || langRaw === "js"
			? "jxa"
			: "applescript";
	const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
	const argsRaw = params.args;
	const args = Array.isArray(argsRaw)
		? argsRaw.filter((x): x is string => typeof x === "string")
		: [];
	const result = await runAppleScript({
		script,
		lang,
		args,
		...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
	});
	const text = result.exitCode === 0
		? `RUN_APPLESCRIPT ok (${result.durationMs}ms): ${result.stdout.slice(0, 200)}`
		: `RUN_APPLESCRIPT failed (${result.exitCode}): ${(result.stderr || "no stderr").slice(0, 200)}`;
	await emit(callback, text, "RUN_APPLESCRIPT");
	const values = {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		timedOut: result.timedOut,
	};
	return result.exitCode === 0
		? ok(text, values)
		: { ...fail(text), values: values as never, data: values as never };
};

export const runAppleScriptAction: Action = {
	name: "RUN_APPLESCRIPT",
	similes: ["OSASCRIPT", "RUN_JXA", "MACOS_SCRIPT", "APPLESCRIPT"],
	description:
		"Run an arbitrary AppleScript or JXA snippet via osascript. Use this for native macOS app automation that doesn't have a dedicated action (Calendar/Reminders/Mail/Notes/Music/Safari/Finder DO have dedicated actions — prefer those). Params: { script, lang? = 'applescript' | 'jxa', timeoutMs?, args? = string[] }. Returns stdout/stderr/exitCode.",
	validate: alwaysValid,
	handler: runAppleScriptHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Calendar ────────────────────────────────────────────────────────

const calendarListTodayHandler: Handler = async (_r, _m, _s, _o, callback) => {
	const env = requireDarwin();
	if (env) return env;
	return runAndReport(calendarListToday(), "CALENDAR_LIST_TODAY", callback, (r) => {
		try {
			const events = JSON.parse(r.stdout) as Array<{
				summary: string;
				startDate: string;
				endDate: string;
				allDay: boolean;
				calendarName: string;
			}>;
			if (events.length === 0) return "No events on the calendar today.";
			const lines = events
				.slice(0, 10)
				.map((e) =>
					`- ${e.allDay ? "all-day" : new Date(e.startDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${e.summary} (${e.calendarName})`,
				)
				.join("\n");
			return `Today's calendar:\n${lines}`;
		} catch {
			return `Calendar query ok (${r.durationMs}ms)`;
		}
	});
};

export const calendarListTodayAction: Action = {
	name: "CALENDAR_LIST_TODAY",
	similes: ["LIST_TODAY_EVENTS", "GET_TODAY_CALENDAR", "WHATS_ON_MY_CALENDAR"],
	description:
		"List today's events from macOS Calendar.app across every calendar. Returns event summaries with start times. No params.",
	validate: alwaysValid,
	handler: calendarListTodayHandler,
	examples: [],
	parameters: [],
} as Action;

const calendarCreateEventHandler: Handler = async (_r, _m, _s, options, callback) => {
	const env = requireDarwin();
	if (env) return env;
	const params = paramsBag(options);
	const title = strParam(params, ["title", "summary", "name"]);
	const startIso = strParam(params, ["startIso", "start", "startDate"]);
	const endIso = strParam(params, ["endIso", "end", "endDate"]);
	if (!title || !startIso || !endIso) {
		return fail("CALENDAR_CREATE_EVENT requires title, startIso, endIso.");
	}
	const recipe = calendarCreateEvent({
		title,
		startIso,
		endIso,
		...(strParam(params, ["notes", "description"]) ? { notes: strParam(params, ["notes", "description"])! } : {}),
		...(strParam(params, ["location"]) ? { location: strParam(params, ["location"])! } : {}),
		...(strParam(params, ["calendarName", "calendar"]) ? { calendarName: strParam(params, ["calendarName", "calendar"])! } : {}),
	});
	return runAndReport(recipe, "CALENDAR_CREATE_EVENT", callback,
		(r) => `Created event "${title}" (${startIso} → ${endIso}). ${r.stdout}`);
};

export const calendarCreateEventAction: Action = {
	name: "CALENDAR_CREATE_EVENT",
	similes: ["ADD_CALENDAR_EVENT", "SCHEDULE_EVENT", "CREATE_MEETING"],
	description:
		"Create a new event in macOS Calendar.app. Params: { title, startIso (ISO 8601), endIso, notes?, location?, calendarName? = use default }.",
	validate: alwaysValid,
	handler: calendarCreateEventHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Reminders ───────────────────────────────────────────────────────

const remindersAddHandler: Handler = async (_r, _m, _s, options, callback) => {
	const env = requireDarwin();
	if (env) return env;
	const params = paramsBag(options);
	const text = strParam(params, ["text", "title", "name"]);
	if (!text) return fail("REMINDERS_ADD requires text.");
	const recipe = remindersAdd({
		text,
		...(strParam(params, ["dueIso", "due", "dueDate"]) ? { dueIso: strParam(params, ["dueIso", "due", "dueDate"])! } : {}),
		...(strParam(params, ["listName", "list"]) ? { listName: strParam(params, ["listName", "list"])! } : {}),
		...(strParam(params, ["body", "notes"]) ? { body: strParam(params, ["body", "notes"])! } : {}),
	});
	return runAndReport(recipe, "REMINDERS_ADD", callback,
		() => `Added reminder "${text}".`);
};

export const remindersAddAction: Action = {
	name: "REMINDERS_ADD",
	similes: ["ADD_REMINDER", "CREATE_REMINDER", "TODO_ADD"],
	description:
		"Add a reminder to macOS Reminders.app. Params: { text, dueIso?, listName? = default list, body? }.",
	validate: alwaysValid,
	handler: remindersAddHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Mail ────────────────────────────────────────────────────────────

const mailDraftHandler: Handler = async (_r, _m, _s, options, callback) => {
	const env = requireDarwin();
	if (env) return env;
	const params = paramsBag(options);
	const to = strParam(params, ["to", "recipient", "recipients"]);
	const subject = strParam(params, ["subject"]);
	const body = strParam(params, ["body", "content", "text"]);
	if (!to || !subject || body === undefined) {
		return fail("MAIL_DRAFT requires to, subject, body.");
	}
	const recipe = mailDraft({
		to,
		subject,
		body,
		...(strParam(params, ["cc"]) ? { cc: strParam(params, ["cc"])! } : {}),
		...(strParam(params, ["bcc"]) ? { bcc: strParam(params, ["bcc"])! } : {}),
	});
	return runAndReport(recipe, "MAIL_DRAFT", callback,
		() => `Opened a Mail draft to ${to}: "${subject}". Review + send manually.`);
};

export const mailDraftAction: Action = {
	name: "MAIL_DRAFT",
	similes: ["DRAFT_EMAIL", "COMPOSE_MAIL", "EMAIL_DRAFT"],
	description:
		"Open a draft in macOS Mail.app. Never auto-sends — user must review + click Send. Params: { to (comma-separated), subject, body, cc?, bcc? }.",
	validate: alwaysValid,
	handler: mailDraftHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Notes ───────────────────────────────────────────────────────────

const notesCreateHandler: Handler = async (_r, _m, _s, options, callback) => {
	const env = requireDarwin();
	if (env) return env;
	const params = paramsBag(options);
	const title = strParam(params, ["title", "name"]);
	const body = strParam(params, ["body", "content", "text"]);
	if (!title || body === undefined) {
		return fail("NOTES_CREATE requires title and body.");
	}
	const recipe = notesCreate({
		title,
		body,
		...(strParam(params, ["folderName", "folder"]) ? { folderName: strParam(params, ["folderName", "folder"])! } : {}),
	});
	return runAndReport(recipe, "NOTES_CREATE", callback,
		() => `Created note "${title}" in Notes.app.`);
};

export const notesCreateAction: Action = {
	name: "NOTES_CREATE",
	similes: ["ADD_NOTE", "CREATE_NOTE", "NEW_NOTE"],
	description:
		"Create a new note in macOS Notes.app. Body supports basic line breaks. Params: { title, body, folderName? = default folder }.",
	validate: alwaysValid,
	handler: notesCreateHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Music ───────────────────────────────────────────────────────────

const musicPlayPauseHandler: Handler = async (_r, _m, _s, _o, callback) => {
	const env = requireDarwin();
	if (env) return env;
	return runAndReport(musicPlayPause(), "MUSIC_PLAY_PAUSE", callback,
		() => "Toggled Music.app play/pause.");
};

export const musicPlayPauseAction: Action = {
	name: "MUSIC_PLAY_PAUSE",
	similes: ["TOGGLE_MUSIC", "PLAY_PAUSE_MUSIC"],
	description:
		"Toggle play/pause on macOS Music.app. Does NOT affect Spotify or other players. No params.",
	validate: alwaysValid,
	handler: musicPlayPauseHandler,
	examples: [],
	parameters: [],
} as Action;

const musicNowPlayingHandler: Handler = async (_r, _m, _s, _o, callback) => {
	const env = requireDarwin();
	if (env) return env;
	return runAndReport(musicNowPlaying(), "MUSIC_NOW_PLAYING", callback, (r) => {
		try {
			const np = JSON.parse(r.stdout) as {
				playerState?: string;
				name?: string;
				artist?: string;
				album?: string;
			};
			if (!np.name) return `Music: ${np.playerState ?? "stopped"}`;
			return `Music ${np.playerState}: ${np.artist} — ${np.name} (${np.album})`;
		} catch {
			return "Music query ok.";
		}
	});
};

export const musicNowPlayingAction: Action = {
	name: "MUSIC_NOW_PLAYING",
	similes: ["WHAT_IS_PLAYING", "CURRENT_TRACK"],
	description:
		"Get the currently-playing track from macOS Music.app. No params. Returns name/artist/album/position when playing.",
	validate: alwaysValid,
	handler: musicNowPlayingHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Safari ──────────────────────────────────────────────────────────

const safariGetTabHandler: Handler = async (_r, _m, _s, _o, callback) => {
	const env = requireDarwin();
	if (env) return env;
	return runAndReport(safariGetFrontTab(), "SAFARI_GET_FRONT_TAB", callback, (r) => {
		try {
			const tab = JSON.parse(r.stdout) as { url?: string; title?: string };
			if (!tab.url) return "Safari has no open tabs (or isn't running).";
			return `Safari front tab: ${tab.title || "(no title)"} — ${tab.url}`;
		} catch {
			return "Safari query ok.";
		}
	});
};

export const safariGetFrontTabAction: Action = {
	name: "SAFARI_GET_FRONT_TAB",
	similes: ["SAFARI_CURRENT_URL", "GET_BROWSER_TAB"],
	description:
		"Get the URL + title of the frontmost macOS Safari tab via AppleScript. No params. Empty when Safari isn't running.",
	validate: alwaysValid,
	handler: safariGetTabHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Finder ──────────────────────────────────────────────────────────

const finderRevealHandler: Handler = async (_r, _m, _s, options, callback) => {
	const env = requireDarwin();
	if (env) return env;
	const path = strParam(paramsBag(options), ["path", "file", "location"]);
	if (!path) return fail("FINDER_REVEAL requires a path.");
	return runAndReport(finderReveal(path), "FINDER_REVEAL", callback,
		() => `Revealed ${path} in Finder.`);
};

export const finderRevealAction: Action = {
	name: "FINDER_REVEAL",
	similes: ["SHOW_IN_FINDER", "OPEN_FINDER"],
	description:
		"Reveal a file or directory in macOS Finder (focuses Finder window on it). Params: { path }.",
	validate: alwaysValid,
	handler: finderRevealHandler,
	examples: [],
	parameters: [],
} as Action;

// ── Plugin ──────────────────────────────────────────────────────────

export const macAutomatePlugin: Plugin = {
	name: "mac-automate",
	description:
		"macOS automation skill pack: RUN_APPLESCRIPT (generic) plus pre-baked actions for Calendar, Reminders, Mail, Notes, Music, Safari, Finder. All actions require Automation TCC permission (first call triggers the macOS prompt).",
	actions: [
		runAppleScriptAction,
		calendarListTodayAction,
		calendarCreateEventAction,
		remindersAddAction,
		mailDraftAction,
		notesCreateAction,
		musicPlayPauseAction,
		musicNowPlayingAction,
		safariGetFrontTabAction,
		finderRevealAction,
	],
};

export default macAutomatePlugin;
