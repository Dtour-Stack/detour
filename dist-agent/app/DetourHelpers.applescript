-- DetourHelpers — AppleScript handlers that drive Detour via the
-- detour:// URL scheme. Drop this into any of your own scripts via:
--
--     property DetourHelpers : load script POSIX file "/Applications/Detour.app/Contents/Resources/DetourHelpers.applescript"
--
-- or copy individual handlers inline.
--
-- Every call goes through `open location` → macOS launches Detour (or
-- focuses it if already running) and fires `open-url` → the bun-side
-- URL handler dispatches the request.
--
-- Detour must be installed in /Applications/ for the scheme to be
-- registered globally. See docs/applescript.md for setup + caveats.

-- Open Detour's chat window with an optional prompt that auto-sends.
on askAgent(prompt)
	set u to "detour://chat?text=" & urlEncode(prompt) & "&submit=1"
	tell application "System Events" to open location u
end askAgent

-- Open Detour's chat composer with the prompt prefilled (no auto-send).
on draftPrompt(prompt)
	set u to "detour://chat?text=" & urlEncode(prompt)
	tell application "System Events" to open location u
end draftPrompt

-- Open a Detour window by name. Valid: "chat", "settings", "pensieve",
-- "activity", "browser", "agents", "pet", "gallery", "portless",
-- "workspace", "command-palette".
on openWindow(target)
	set u to "detour://window?target=" & target
	tell application "System Events" to open location u
end openWindow

-- Open Settings → a specific tab. Format: "configuration:local-ai".
on openSetting(tabPath)
	set u to "detour://settings?tab=" & tabPath
	tell application "System Events" to open location u
end openSetting

-- Search Pensieve (memory store).
on pensieveSearch(query)
	set u to "detour://pensieve/search?q=" & urlEncode(query)
	tell application "System Events" to open location u
end pensieveSearch

-- Run an agent action by name. `params` is a record like {due:"2026-06-01"}.
-- Pass {} for no params.
on runAction(name, params)
	set u to "detour://action?name=" & name
	repeat with k in (every item of (current application's NSArray's arrayWithArray:(params as list)) as list)
		-- AppleScript records can't be iterated by key directly — pass
		-- them as a list of "k=v" pairs for simplicity, or use JXA. The
		-- bun side accepts any extra ?k=v pairs as action params.
	end repeat
	tell application "System Events" to open location u
end runAction

-- Health check. The bun side logs "ping → ok"; if Detour isn't running
-- it'll launch and process the ping anyway. Useful for smoke tests.
on ping()
	tell application "System Events" to open location "detour://ping"
end ping

-- URL-encode helper. AppleScript has no native escape; shell out to
-- python which is on every Mac.
on urlEncode(s)
	return do shell script "python3 -c 'import urllib.parse,sys; sys.stdout.write(urllib.parse.quote(sys.argv[1]))' " & quoted form of (s as text)
end urlEncode
