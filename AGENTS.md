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

## Project Agent Setup

- Local agent session capture is managed by XHawk. Keep `.xhawk/`, `.agents/`, `.codex/`, `.cursor/`, `.gemini/`, and local Claude settings out of commits unless a file is intentionally allowlisted.
- `xh skill install` should report installed for Claude Code, Codex, Gemini CLI, Cursor, and OpenCode. Re-run it after adding a new coding agent on this machine.
- Project Git hooks live in `.githooks/`; this worktree should have `core.hooksPath=.githooks`. Run `bun run verify:agents` after moving or recloning the checkout.
- Swift/macOS setup is checked with `bun run verify:swift`; run `bun run verify:swift:build` after Swift or SwiftPM package changes.
- The Codex prompt-submit hook should remain local in `.codex/hooks.json`; do not move machine-specific auth, hook, or session-capture files into tracked source.

<!-- VERCEL BEST PRACTICES START -->
## Best practices for developing on Vercel

These defaults are optimized for AI coding agents (and humans) working on apps that deploy to Vercel.

- Treat Vercel Functions as stateless + ephemeral (no durable RAM/FS, no background daemons), use Blob or marketplace integrations for preserving state
- Edge Functions (standalone) are deprecated; prefer Vercel Functions
- Don't start new projects on Vercel KV/Postgres (both discontinued); use Marketplace Redis/Postgres instead
- Store secrets in Vercel Env Variables; not in git or `NEXT_PUBLIC_*`
- Provision Marketplace native integrations with `vercel integration add` (CI/agent-friendly)
- Sync env + project settings with `vercel env pull` / `vercel pull` when you need local/offline parity
- Use `waitUntil` for post-response work; avoid the deprecated Function `context` parameter
- Set Function regions near your primary data source; avoid cross-region DB/service roundtrips
- Tune Fluid Compute knobs (e.g., `maxDuration`, memory/CPU) for long I/O-heavy calls (LLMs, APIs)
- Use Runtime Cache for fast **regional** caching + tag invalidation (don't treat it as global KV)
- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET
- Use Vercel Blob for uploads/media; Use Edge Config for small, globally-read config
- If Enable Deployment Protection is enabled, use a bypass secret to directly access them
- Add OpenTelemetry via `@vercel/otel` on Node; don't expect OTEL support on the Edge runtime
- Enable Web Analytics + Speed Insights early
- Use AI Gateway for model routing, set AI_GATEWAY_API_KEY, using a model string (e.g. 'anthropic/claude-sonnet-4.6'), Gateway is already default in AI SDK
  needed. Always curl https://ai-gateway.vercel.sh/v1/models first; never trust model IDs from memory
- For durable agent loops or untrusted code: use Workflow (pause/resume/state) + Sandbox; use Vercel MCP for secure infra access
<!-- VERCEL BEST PRACTICES END -->
