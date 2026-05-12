## Learned User Preferences

- When a subagent’s result is already visible in the client, do not re-summarize it unless asked; a short third-person completion line is enough, and avoid repeating the same confirmation every turn.
- Embedded Phantom wallet work should support **Solana and EVM**, not Solana-only.
- **Phantom in Detour:** WKWebView shell → **embedded** Connect + Portal **`PHANTOM_CONNECT_APP_ID`**. Bun **`phantomGetPortalConfig`** returns **`portalAllowedOrigins`** and **`portalRedirectUrls`** — paste those into Portal (Allowed Origins / Redirect URLs). Optional **`PHANTOM_CONNECT_REDIRECT_URL`**, or derive from **`DETOUR_DEV_URL`** (public tunnel = real redirect) + **portless** + **`PHANTOM_PORTLESS_FQDN`**; see `src/bun/core/rpc/handlers/phantom.ts`.
- When inference or logs look wrong, treat **Bun/runtime shared state** and **model-provider switching** as high-priority suspects alongside UI-layer bugs.
- Structured product reviews for this repo used **Detour at MVP**, **builders / power users**, and **Pensieve (memory / relationships continuity)** as the primary core use case.

## Learned Workspace Facts

- Detour is an **Electrobun** macOS tray/desktop app with a **Bun** core and **ElizaOS-related** packages; **Pensieve** (PGlite-backed memory, relationships, multi-channel surfaces) is a major product area.
- The in-app **agent browser** webview uses the Electrobun partition **`detour-agent-browser`** (`src/main/browser/BrowserView.tsx`).
- The Bun runtime exposes in-process **HTTP + WebSocket on `127.0.0.1:2138`** per the root README architecture section.
- **Phantom Connect** embedded flows should live on **first-party** surfaces (main React shell or a dedicated allowlisted wallet webview with its own partition), not on arbitrary HTTPS pages loaded in the general agent browser, because Portal **allowed origins** must match the page origin exactly.
- `.superstack/idea-context.md` and `.superstack/build-context.md` are often **missing** in this workspace; skills that expect them should fall back to repo inspection without assuming those files exist.
