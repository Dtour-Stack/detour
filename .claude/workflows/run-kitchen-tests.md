---
description: Run the Electrobun Kitchen Sink integration tests
---

## Run Kitchen Integration Tests

### Prerequisites
- The Electrobun package must be built first: `cd package && bun run build`
- Kitchen app must be configured in `kitchen/electrobun.config.ts`

### Steps

1. Start the kitchen app in dev mode from the package directory:
// turbo
```bash
bun run dev --filter=kitchen
```

2. The test runner window opens automatically. You'll see:
   - All tests grouped by category with status icons
   - "Run All Automated" and "Run Interactive Tests" buttons
   - Build config info (renderer, Chromium version, Bun version)

3. Click **"Run All Automated"** to run all non-interactive tests.
   - Tests run sequentially within each category
   - Results appear in both the UI and the terminal
   - Green ✓ = passed, Red ✗ = failed

4. For interactive tests, click **"Run Interactive Tests"**.
   - Each test shows instructions in a modal
   - Click "Start" to begin, then verify with Pass/Fail/Re-test

### Keyboard Shortcuts
- `Cmd+R` / `Ctrl+R` — Run All Automated
- `Cmd+Shift+R` / `Ctrl+Shift+R` — Run Interactive Tests

### CI / Headless Mode
Set environment variables to skip interactive prompts:
```bash
AUTO_RUN=1 bun run dev --filter=kitchen
```

### Filtering Tests
Use the search box in the test runner UI — fuzzy matches against test name, category, and description.
