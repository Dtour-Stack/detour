# Detour Live Landing Page

Static landing page artifact for the Detour public agent workbench.

## Files

| File | Description |
|------|-------------|
| `index.html` | Self-contained landing page — all CSS inlined, zero external deps |
| `manifest.json` | Project metadata and feature list |
| `README.md` | This file |

## What's in the page

- **Hero** — headline, badge showing live status, CTA buttons
- **Workbench mockup** — macOS window with:
  - Sidebar agent roster (Detour host, Codex, Claude, Browser) with live status badges
  - Terminal pane streaming Detour → Codex → Claude agent dialogue, typecheck errors, fixes, and test results
  - Code diff pane showing a real `auth.ts` patch with green/red diff lines and syntax highlighting
  - Live preview pane showing a rendered component card
- **Feature grid** — 6 capability cards
- **Architecture diagram** — Detour dispatch → Codex + Claude fork → merged output
- **CTA section** and footer

## Deployment

Drop `index.html` anywhere that serves static files:

```bash
# local preview
open exports/detour-live-landing/index.html

# Vercel / Netlify — just point root to this directory
# GitHub Pages — push exports/detour-live-landing/ as the gh-pages root
```

No build step, no npm install, no bundler required.

## Customization

All tokens are CSS custom properties on `:root` in the `<style>` block. To change the accent color:

```css
--accent: #your-color;
--accent2: #your-lighter-variant;
```

The terminal animation delays are sequential `animation-delay` values on `.t-block` children — extend the list to add more lines.
