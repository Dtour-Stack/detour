# Detour AppleScript Surface

Drive Detour from AppleScript, JXA, Shortcuts, Raycast, Alfred, or any
macOS automation tool. The canonical interface is the `detour://` URL
scheme; an `.sdef` dictionary stub and a `.applescript` helper library
make this discoverable + ergonomic.

## How it works (today)

```
AppleScript / JXA / Shortcuts
       │  open location "detour://..."
       ▼
macOS LaunchServices → fires "open-url" event on Detour.app
       ▼
src/bun/features/url-scheme/index.ts → routes by host
       ▼
Detour features react (open chat, broadcast UI events, queue agent action)
```

The `detour://` scheme is the cleanest path: it works whether Detour is
running or not (macOS launches it on demand), it works from any
automation tool that can open a URL, and it's already tested by the
Shortcuts pack (`docs/shortcuts-pack.md`).

## Quick start — AppleScript

```applescript
-- 1. Load the helpers (shipped inside Detour.app)
property DetourHelpers : load script POSIX file "/Applications/Detour.app/Contents/Resources/DetourHelpers.applescript"

-- 2. Use them
DetourHelpers's askAgent("What's on my calendar today?")
DetourHelpers's draftPrompt("Email the team about ")
DetourHelpers's pensieveSearch("memory budget arbiter")
DetourHelpers's openWindow("activity")
DetourHelpers's openSetting("configuration:local-ai")
DetourHelpers's runAction("CALENDAR_LIST_TODAY", {})
DetourHelpers's ping()
```

The helpers wrap the URL scheme so you don't have to memorize routes
or worry about escaping. Inspect the source:
`/Applications/Detour.app/Contents/Resources/DetourHelpers.applescript`.

## Quick start — JXA (more concise)

```js
const url = "detour://chat?text=" + encodeURIComponent("hello") + "&submit=1";
Application("System Events").openLocation(url);
```

## Quick start — Shell

```sh
open 'detour://ping'
open 'detour://chat?text=hello&submit=1'
open 'detour://settings?tab=configuration:local-ai'
```

## Quick start — Shortcuts.app

See `docs/shortcuts-pack.md` for ready-made templates. The "Open URL"
action is all you need.

## Reference — `detour://` routes

See `docs/shortcuts-pack.md` for the full table. Summary:

- `detour://chat?text=...&submit=1`
- `detour://settings?tab=<section>:<tab>`
- `detour://window?target=<name>`
- `detour://pensieve/search?q=...`
- `detour://action?name=<ACTION>&<params>`
- `detour://ping`

## Use cases

### "Ask Detour" via Spotlight

Build a Shortcut: Ask for Input → URL (`detour://chat?text=` + input + `&submit=1`)
→ Open URLs. Assign Cmd+Shift+D. Now Cmd+Shift+D → type a prompt → enter.

### Voice control via Siri

Same Shortcut, add a Siri phrase ("Hey Detour"). Say "Hey Siri, Hey
Detour" → Siri shows the input prompt → speak the prompt → it lands
in Detour.

### Driving Detour from a build script

```sh
# After a CI run finishes, ping Detour to summarize
open "detour://chat?text=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("CI passed — summarize the run"))')&submit=1"
```

### Raycast extension

Define a custom Open URL command pointing at `detour://...`. Add
arguments for prompt text. Bind to a hotkey. You now have
Raycast-driven agent invocation.

### Calendar-triggered action

In Calendar.app, add an alarm to an event → Custom → Open file →
DetourHelpers (or a wrapper .applescript that calls `askAgent`). The
agent fires at the alarm time.

## Adding new AppleScript commands

1. Add the route to `src/bun/features/url-scheme/index.ts`.
2. Add a helper handler to `build-assets/applescript/DetourHelpers.applescript`.
3. Add the corresponding `<command>` to `build-assets/applescript/Detour.sdef`.
4. Document in `docs/shortcuts-pack.md` route table.

Keep helpers + sdef aligned with the URL scheme.

## Limitations

- macOS only.
- Detour must be in `/Applications/` for the URL scheme to register.
- The sdef does not yet drive direct `tell application "Detour"`
  invocations — use the helpers (URL scheme) instead.
- `run action` queues through the inbox; not synchronous. There's no
  way today to get a return value from an action via AppleScript.
  Use Pensieve search or the chat path if you need a reply.
