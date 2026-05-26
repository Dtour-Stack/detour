# Detour Shortcuts Pack

A library of macOS Shortcuts that drive Detour via the `detour://` URL
scheme. Build them once, run them from anywhere on the Mac — Spotlight,
Siri, Focus modes, global hotkeys, the Shortcuts widget, the menu bar.

## Prerequisites

1. **Detour.app must be in `/Applications/`.** macOS only registers URL
   schemes for apps living in `/Applications/` (or `~/Applications/`).
   Move the app, then run it once so the system registers the
   `detour://` scheme.

2. **First call may prompt.** macOS asks the user once whether to allow
   `detour://` to open Detour. Approve it.

3. **Test the scheme** with one of these commands from Terminal:
   ```sh
   open 'detour://ping'              # health check; see Detour's logs
   open 'detour://chat?text=hello'   # opens chat with prefilled text
   ```

## Route reference

The bun-side handler lives at `src/bun/features/url-scheme/index.ts`.
Add new routes there + update this table.

| Route | Params | Effect |
|---|---|---|
| `detour://ping` | — | Logs "ok" on the bun side. Smoke test. |
| `detour://chat` | `text` (optional), `submit=1` (optional) | Open chat; inject text into composer; auto-send if submit=1. |
| `detour://settings` | `tab=<section>:<tab>` (optional) | Open Settings drawer; deep-link to a specific tab. Same format as command palette. |
| `detour://window` | `target=<name>` | Open / focus a named window. Targets: chat, settings, pensieve, activity, browser, agents, pet, gallery, portless, command-palette. |
| `detour://pensieve/search` | `q=<query>` | Open Pensieve scoped to a memory search. |
| `detour://action` | `name=<ACTION>`, plus any action-specific keys | Queue an agent action via the inbox pipeline. The agent picks it up + dispatches like any external task. |

## Building the Shortcuts library

Shortcuts.app doesn't have a public file format I can write by hand —
each Shortcut is a binary plist with hashed signatures. Two options:

### Option A — Build in Shortcuts.app (recommended)

Open Shortcuts.app, click `+`, and assemble each shortcut with the
**Open URL** action. Templates:

#### "Ask Detour"
1. Add action: **Ask for Input** (`Text`, prompt: "Ask Detour")
2. Add action: **URL** → `detour://chat?text=` + `[Provided Input]` URL-encoded + `&submit=1`
3. Add action: **Open URLs**
4. Optional: assign a Siri phrase ("Hey Detour") and a global keyboard shortcut.

#### "Add to Pensieve"
1. **Ask for Input** ("What to remember?")
2. **URL** → `detour://action?name=PENSIEVE_ADD_NOTE&text=` + encoded input
3. **Open URLs**

#### "Show today's calendar via Detour"
Pure passthrough — Detour reads Calendar.app via the new mac-automate
plugin, so the shortcut just opens chat with a prompt:
1. **URL** → `detour://chat?text=What's%20on%20my%20calendar%20today%3F&submit=1`
2. **Open URLs**

#### "Open Pensieve search"
1. **Ask for Input** ("Search memory")
2. **URL** → `detour://pensieve/search?q=` + encoded input
3. **Open URLs**

#### "Jump to Settings → Local AI"
1. **URL** → `detour://settings?tab=configuration:local-ai`
2. **Open URLs**

#### "Open Activity"
1. **URL** → `detour://window?target=activity`
2. **Open URLs**

#### "Run a Detour action by name"
1. **Ask for Input** ("Action name", e.g. `CALENDAR_LIST_TODAY`)
2. **URL** → `detour://action?name=` + encoded input
3. **Open URLs**

#### "Toggle Music play/pause"
Goes through the agent so it can choose how to respond:
1. **URL** → `detour://action?name=MUSIC_PLAY_PAUSE`
2. **Open URLs**

Once built, each Shortcut shows up in:
- Spotlight (`Cmd+Space → "Ask Detour"`)
- Siri ("Hey Siri, Ask Detour")
- Menu Bar (Shortcuts → "Show in Menu Bar" toggle)
- Global hotkey (Shortcuts → ⓘ → Details → Add Keyboard Shortcut)

### Option B — Share .shortcut files

Once you've built a shortcut, right-click → **Share** → **Save to Files**.
The resulting `.shortcut` file can be checked into this repo under
`docs/shortcuts/` and distributed to other Macs (double-click to install).

I'd recommend doing this for the "Ask Detour" shortcut at minimum —
it's the most useful one and gates discovery for the rest.

## Programmatic invocation

Beyond Shortcuts.app, the URL scheme works anywhere on macOS that
can open a URL:

```sh
# Terminal
open 'detour://chat?text=hi&submit=1'

# AppleScript
tell application "System Events" to open location "detour://settings?tab=configuration:local-ai"

# Raycast / Alfred — define a custom action that runs `open detour://...`

# Browser (paste in address bar)
detour://ping
```

## Troubleshooting

- **Nothing happens** → check Detour is in `/Applications/` and has been
  launched at least once. Run `lsregister -dump | grep detour` to see
  whether macOS has registered the scheme.
- **Query string contains special characters** → URL-encode everything
  past the `?`. Shortcuts.app does this automatically via the
  `URL Encoded` text transformer; in shell scripts use `python3 -c
  'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$X"`.
- **Action route doesn't dispatch** → check Detour's logs:
  `tail -f ~/.detour/logs/detour.log | grep url-scheme`. The handler
  logs every parsed route.

## Adding a new route

1. Edit `src/bun/features/url-scheme/index.ts` — add a `case` to
   `handleRoute`.
2. Update the route reference table above.
3. (Optional) Build a Shortcut that wraps it.

The handler signature is intentionally tiny so new routes are short
to add. Avoid adding routes that mutate state without an audit trail —
prefer routing through `inbox.post(...)` so the agent's normal pipeline
catches the request.
