/**
 * mac-automate plugin contract tests. Verify shape + recipe construction.
 * Recipe execution itself is tested in src/bun/core/mac-automate.test.ts
 * via real osascript on darwin.
 */
import { describe, expect, test } from "bun:test";
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
} from "./recipes";
import {
	calendarCreateEventAction,
	calendarListTodayAction,
	finderRevealAction,
	macAutomatePlugin,
	mailDraftAction,
	musicNowPlayingAction,
	musicPlayPauseAction,
	notesCreateAction,
	remindersAddAction,
	runAppleScriptAction,
	safariGetFrontTabAction,
} from "./index";

describe("plugin shape", () => {
	test("exports a plugin with name + all 10 actions", () => {
		expect(macAutomatePlugin.name).toBe("mac-automate");
		expect(macAutomatePlugin.actions?.length).toBe(10);
		const names = (macAutomatePlugin.actions ?? []).map((a) => a.name).sort();
		expect(names).toEqual(
			[
				"CALENDAR_CREATE_EVENT",
				"CALENDAR_LIST_TODAY",
				"FINDER_REVEAL",
				"MAIL_DRAFT",
				"MUSIC_NOW_PLAYING",
				"MUSIC_PLAY_PAUSE",
				"NOTES_CREATE",
				"REMINDERS_ADD",
				"RUN_APPLESCRIPT",
				"SAFARI_GET_FRONT_TAB",
			].sort(),
		);
	});

	test("each action carries a description that mentions macOS or AppleScript", () => {
		for (const action of macAutomatePlugin.actions ?? []) {
			expect(action.description?.toLowerCase() ?? "").toMatch(/macos|applescript/);
		}
	});

	test("each action exports as a named symbol from the plugin module", () => {
		expect(runAppleScriptAction.name).toBe("RUN_APPLESCRIPT");
		expect(calendarListTodayAction.name).toBe("CALENDAR_LIST_TODAY");
		expect(calendarCreateEventAction.name).toBe("CALENDAR_CREATE_EVENT");
		expect(remindersAddAction.name).toBe("REMINDERS_ADD");
		expect(mailDraftAction.name).toBe("MAIL_DRAFT");
		expect(notesCreateAction.name).toBe("NOTES_CREATE");
		expect(musicPlayPauseAction.name).toBe("MUSIC_PLAY_PAUSE");
		expect(musicNowPlayingAction.name).toBe("MUSIC_NOW_PLAYING");
		expect(safariGetFrontTabAction.name).toBe("SAFARI_GET_FRONT_TAB");
		expect(finderRevealAction.name).toBe("FINDER_REVEAL");
	});
});

describe("recipe construction (no osascript call)", () => {
	test("calendarListToday is a JXA recipe", () => {
		const r = calendarListToday();
		expect(r.lang).toBe("jxa");
		expect(r.args).toEqual([]);
		expect(r.script).toContain("Calendar");
	});

	test("calendarCreateEvent passes title/start/end as args, not interpolated", () => {
		const r = calendarCreateEvent({
			title: 'meeting with "Quote" person',
			startIso: "2026-05-15T10:00:00Z",
			endIso: "2026-05-15T11:00:00Z",
			notes: "agenda",
			location: "Zoom",
			calendarName: "Work",
		});
		expect(r.lang).toBe("jxa");
		expect(r.args).toEqual([
			'meeting with "Quote" person',
			"2026-05-15T10:00:00Z",
			"2026-05-15T11:00:00Z",
			"agenda",
			"Zoom",
			"Work",
		]);
		// The script itself must NOT contain the user's title — that
		// would mean we interpolated it (quote-injection risk).
		expect(r.script).not.toContain('meeting with "Quote" person');
	});

	test("remindersAdd defaults empty optional args to empty strings", () => {
		const r = remindersAdd({ text: "buy milk" });
		expect(r.args).toEqual(["buy milk", "", "", ""]);
	});

	test("mailDraft normalizes string[] recipients to comma-separated", () => {
		const r = mailDraft({
			to: ["a@example.com", "b@example.com"],
			subject: "hi",
			body: "test",
		});
		expect(r.args[0]).toBe("a@example.com, b@example.com");
	});

	test("notesCreate accepts a folder name", () => {
		const r = notesCreate({ title: "T", body: "B", folderName: "Inbox" });
		expect(r.args).toEqual(["T", "B", "Inbox"]);
	});

	test("musicPlayPause is a plain AppleScript one-liner", () => {
		const r = musicPlayPause();
		expect(r.lang).toBe("applescript");
		expect(r.script).toMatch(/tell application "Music" to playpause/);
	});

	test("musicNowPlaying returns JSON via JXA", () => {
		const r = musicNowPlaying();
		expect(r.lang).toBe("jxa");
		expect(r.script).toContain("playerState");
	});

	test("safariGetFrontTab returns JSON via JXA", () => {
		const r = safariGetFrontTab();
		expect(r.lang).toBe("jxa");
		expect(r.script).toContain("Safari");
	});

	test("finderReveal embeds the path safely as a POSIX file literal", () => {
		const r = finderReveal('/Users/me/Documents/with "quotes".pdf');
		expect(r.lang).toBe("applescript");
		// quote-injection guard: the literal must be escaped, not raw.
		expect(r.script).toContain('\\"quotes\\"');
	});
});
