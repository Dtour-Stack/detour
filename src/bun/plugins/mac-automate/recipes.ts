/**
 * Pre-baked AppleScript / JXA recipes for the mac-automate skill pack.
 *
 * Each recipe is a pure (params → { script, lang, args }) builder. The
 * plugin's action handlers compose these into agent-callable actions
 * with names like CALENDAR_LIST_TODAY, REMINDERS_ADD, etc.
 *
 * Why JXA over classic AppleScript for some recipes: JXA returns
 * native JSON via `JSON.stringify(...)`, which is much easier to parse
 * back into structured data than AppleScript's record literal syntax.
 * Recipes that just need to "do a thing" (play music, draft mail) use
 * plain AppleScript — shorter, more obvious.
 *
 * Values that come from user / agent input are passed via `args` and
 * read inside the script (`$.NSProcessInfo.processInfo.arguments` in
 * JXA, `item N of argv` in AppleScript) so titles / notes / URLs
 * containing quotes don't have to be sanitized at the template layer.
 */

import {
	quoteAppleScript,
	type AppleScriptLang,
	type RunAppleScriptInput,
} from "../../core/mac-automate";

export type Recipe = Required<Omit<RunAppleScriptInput, "timeoutMs">> & {
	timeoutMs?: number;
};

// ── Calendar ────────────────────────────────────────────────────────

/**
 * Today's events from the default calendar. Returns JSON array of
 * `{ summary, startDate (ISO), endDate (ISO), allDay, calendarName }`.
 */
export function calendarListToday(): Recipe {
	const script = `
ObjC.import("Foundation");
const Calendar = Application("Calendar");
const startOfDay = $.NSCalendar.currentCalendar.startOfDayForDate($.NSDate.date);
const endOfDay = $.NSCalendar.currentCalendar.dateByAddingUnitValueToDateOptions(
	$.NSCalendarUnitDay, 1, startOfDay, 0,
);
const start = ObjC.unwrap($.NSDate.dateWithTimeInterval(0, startOfDay));
const end = ObjC.unwrap($.NSDate.dateWithTimeInterval(0, endOfDay));
const out = [];
Calendar.calendars().forEach((cal) => {
	cal.events.whose({
		_and: [
			{ startDate: { _greaterThanEquals: start } },
			{ startDate: { _lessThan: end } },
		],
	})().forEach((evt) => {
		out.push({
			summary: evt.summary(),
			startDate: evt.startDate().toISOString(),
			endDate: evt.endDate().toISOString(),
			allDay: evt.alldayEvent(),
			calendarName: cal.name(),
		});
	});
});
JSON.stringify(out);
`;
	return { script, lang: "jxa", args: [], timeoutMs: 20_000 };
}

/**
 * Create a new event on the user's default calendar.
 */
export function calendarCreateEvent(input: {
	title: string;
	startIso: string;
	endIso: string;
	notes?: string;
	location?: string;
	calendarName?: string;
}): Recipe {
	const script = `
const args = $.NSProcessInfo.processInfo.arguments;
const title = ObjC.unwrap(args.objectAtIndex(5));
const startIso = ObjC.unwrap(args.objectAtIndex(6));
const endIso = ObjC.unwrap(args.objectAtIndex(7));
const notes = ObjC.unwrap(args.objectAtIndex(8));
const location = ObjC.unwrap(args.objectAtIndex(9));
const calendarName = ObjC.unwrap(args.objectAtIndex(10));
const Calendar = Application("Calendar");
const targetCalendar = calendarName
	? Calendar.calendars.whose({ name: calendarName })[0]
	: Calendar.defaultCalendar
		|| Calendar.calendars[0];
const event = Calendar.Event({
	summary: title,
	startDate: new Date(startIso),
	endDate: new Date(endIso),
	description: notes || undefined,
	location: location || undefined,
});
targetCalendar.events.push(event);
JSON.stringify({ ok: true, eventId: event.uid() });
`;
	return {
		script,
		lang: "jxa",
		args: [
			input.title,
			input.startIso,
			input.endIso,
			input.notes ?? "",
			input.location ?? "",
			input.calendarName ?? "",
		],
		timeoutMs: 15_000,
	};
}

// ── Reminders ───────────────────────────────────────────────────────

/**
 * Add a reminder to the user's default list (or a named list).
 */
export function remindersAdd(input: {
	text: string;
	dueIso?: string;
	listName?: string;
	body?: string;
}): Recipe {
	const script = `
const args = $.NSProcessInfo.processInfo.arguments;
const text = ObjC.unwrap(args.objectAtIndex(5));
const dueIso = ObjC.unwrap(args.objectAtIndex(6));
const listName = ObjC.unwrap(args.objectAtIndex(7));
const body = ObjC.unwrap(args.objectAtIndex(8));
const Reminders = Application("Reminders");
const targetList = listName
	? Reminders.lists.whose({ name: listName })[0]
	: Reminders.defaultList()
		|| Reminders.lists[0];
const props = { name: text };
if (dueIso) props.dueDate = new Date(dueIso);
if (body) props.body = body;
const reminder = Reminders.Reminder(props);
targetList.reminders.push(reminder);
JSON.stringify({ ok: true, id: reminder.id() });
`;
	return {
		script,
		lang: "jxa",
		args: [
			input.text,
			input.dueIso ?? "",
			input.listName ?? "",
			input.body ?? "",
		],
		timeoutMs: 10_000,
	};
}

// ── Mail ────────────────────────────────────────────────────────────

/**
 * Open a draft in Mail with the supplied fields. The user still has
 * to hit send — drafts only, never auto-send (safety).
 */
export function mailDraft(input: {
	to: string | string[];
	subject: string;
	body: string;
	cc?: string | string[];
	bcc?: string | string[];
}): Recipe {
	const to = Array.isArray(input.to) ? input.to.join(", ") : input.to;
	const cc = input.cc
		? Array.isArray(input.cc)
			? input.cc.join(", ")
			: input.cc
		: "";
	const bcc = input.bcc
		? Array.isArray(input.bcc)
			? input.bcc.join(", ")
			: input.bcc
		: "";
	const script = `
const args = $.NSProcessInfo.processInfo.arguments;
const to = ObjC.unwrap(args.objectAtIndex(5));
const subject = ObjC.unwrap(args.objectAtIndex(6));
const body = ObjC.unwrap(args.objectAtIndex(7));
const cc = ObjC.unwrap(args.objectAtIndex(8));
const bcc = ObjC.unwrap(args.objectAtIndex(9));
const Mail = Application("Mail");
const msg = Mail.OutgoingMessage({
	subject: subject,
	content: body,
	visible: true,
});
Mail.outgoingMessages.push(msg);
to.split(/\\s*,\\s*/).filter(Boolean).forEach((addr) => {
	msg.toRecipients.push(Mail.ToRecipient({ address: addr }));
});
if (cc) cc.split(/\\s*,\\s*/).filter(Boolean).forEach((addr) => {
	msg.ccRecipients.push(Mail.CcRecipient({ address: addr }));
});
if (bcc) bcc.split(/\\s*,\\s*/).filter(Boolean).forEach((addr) => {
	msg.bccRecipients.push(Mail.BccRecipient({ address: addr }));
});
JSON.stringify({ ok: true, opened: true });
`;
	return {
		script,
		lang: "jxa",
		args: [to, input.subject, input.body, cc, bcc],
		timeoutMs: 15_000,
	};
}

// ── Notes ───────────────────────────────────────────────────────────

/**
 * Create a new note in the "Notes" account's default folder, or the
 * named folder.
 */
export function notesCreate(input: {
	title: string;
	body: string;
	folderName?: string;
}): Recipe {
	const script = `
const args = $.NSProcessInfo.processInfo.arguments;
const title = ObjC.unwrap(args.objectAtIndex(5));
const body = ObjC.unwrap(args.objectAtIndex(6));
const folderName = ObjC.unwrap(args.objectAtIndex(7));
const Notes = Application("Notes");
// Notes uses HTML for body; wrap a simple structure.
const html = "<div><h1>" + title.replace(/</g, "&lt;") + "</h1><p>" +
	body.replace(/</g, "&lt;").replace(/\\n/g, "<br/>") + "</p></div>";
const account = Notes.defaultAccount();
const folder = folderName
	? account.folders.whose({ name: folderName })[0]
	: account.defaultFolder() || account.folders[0];
const note = Notes.Note({ body: html });
folder.notes.push(note);
JSON.stringify({ ok: true, id: note.id() });
`;
	return {
		script,
		lang: "jxa",
		args: [input.title, input.body, input.folderName ?? ""],
		timeoutMs: 10_000,
	};
}

// ── Music ───────────────────────────────────────────────────────────

/**
 * Toggle play / pause on the system Music app. Use sparingly — if
 * Spotify is running this won't affect it (different app).
 */
export function musicPlayPause(): Recipe {
	return {
		script: `tell application "Music" to playpause`,
		lang: "applescript",
		args: [],
		timeoutMs: 5_000,
	};
}

/**
 * Get the now-playing track from Music.app. Returns
 * `{ playerState, name, artist, album, position, duration }` or
 * `{ playerState: "stopped" }` when nothing is playing.
 */
export function musicNowPlaying(): Recipe {
	const script = `
const Music = Application("Music");
if (!Music.running()) {
	JSON.stringify({ playerState: "stopped", reason: "not running" });
} else {
	const state = Music.playerState();
	if (state === "stopped") {
		JSON.stringify({ playerState: "stopped" });
	} else {
		const track = Music.currentTrack();
		JSON.stringify({
			playerState: state,
			name: track.name(),
			artist: track.artist(),
			album: track.album(),
			position: Music.playerPosition(),
			duration: track.duration(),
		});
	}
}
`;
	return { script, lang: "jxa", args: [], timeoutMs: 5_000 };
}

// ── Safari ──────────────────────────────────────────────────────────

/**
 * URL + title of the frontmost Safari tab. Empty `url` means Safari
 * isn't running or has no open windows.
 */
export function safariGetFrontTab(): Recipe {
	const script = `
const Safari = Application("Safari");
if (!Safari.running() || Safari.windows.length === 0) {
	JSON.stringify({ url: "", title: "" });
} else {
	const win = Safari.windows[0];
	const tab = win.currentTab();
	JSON.stringify({ url: tab.url(), title: tab.name() });
}
`;
	return { script, lang: "jxa", args: [], timeoutMs: 5_000 };
}

// ── Finder ──────────────────────────────────────────────────────────

/**
 * Reveal a path in Finder (the same as Cmd+R / "Show in Finder").
 */
export function finderReveal(path: string): Recipe {
	const escaped = quoteAppleScript(path);
	return {
		script: `tell application "Finder" to reveal POSIX file ${escaped}\nactivate application "Finder"`,
		lang: "applescript",
		args: [],
		timeoutMs: 5_000,
	};
}

export const ALL_RECIPES = {
	calendarListToday,
	calendarCreateEvent,
	remindersAdd,
	mailDraft,
	notesCreate,
	musicPlayPause,
	musicNowPlaying,
	safariGetFrontTab,
	finderReveal,
} as const;

export type RecipeName = keyof typeof ALL_RECIPES;

export function isJxa(lang: AppleScriptLang | undefined): boolean {
	return lang === "jxa";
}
