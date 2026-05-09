---
description: Create a new Carrot (mini-app) for the Bunny Ears runtime
---

## Create a New Carrot

### 1. Choose the Carrot Mode

- **`window`** — Visible app with a BrowserWindow. Requires `host.windows` permission.
- **`background`** — Tray-driven, hidden controller webview. Requires `host.tray` permission. Auto-started on boot.

### 2. Create the Carrot Directory

```bash
mkdir -p bunny/test-carrots/my-carrot/views
```

### 3. Write `carrot.json`

Create `bunny/test-carrots/my-carrot/carrot.json`:

```json
{
  "id": "my-carrot",
  "name": "My Carrot",
  "version": "0.0.1",
  "description": "What my carrot does",
  "mode": "window",
  "permissions": {
    "host": {
      "windows": true,
      "notifications": true,
      "storage": true
    },
    "bun": {
      "read": true,
      "write": true
    },
    "isolation": "shared-worker"
  },
  "view": {
    "relativePath": "views/index.html",
    "title": "My Carrot",
    "width": 440,
    "height": 520
  },
  "worker": {
    "relativePath": "worker.js"
  }
}
```

For background carrots, add `"hidden": true` to the view and set `"mode": "background"`.

### 4. Write the Worker

Create `bunny/test-carrots/my-carrot/worker.js`:

```javascript
import { app, BrowserWindow, Utils } from "./carrot-runtime/bun";

// Handle messages from the view
app.on("my-action", async (params) => {
  console.log("Received:", params);
  return { ok: true };
});

// Create the main window on boot (window-mode carrots)
app.on("boot", async () => {
  const win = new BrowserWindow({
    title: app.manifest.view.title,
    url: `views://${app.manifest.id}/index.html`,
    width: app.manifest.view.width,
    height: app.manifest.view.height,
  });
});
```

### 5. Write the View

Create `bunny/test-carrots/my-carrot/views/index.html`:

```html
<!DOCTYPE html>
<html>
<head><title>My Carrot</title></head>
<body>
  <h1>My Carrot</h1>
  <script type="module">
    import { createCarrotClient } from "./carrot-runtime/view";
    const client = createCarrotClient();

    client.on("boot", (info) => {
      console.log("Carrot booted:", info.manifest.name);
    });

    // Call worker methods
    const result = await client.invoke("my-action", { data: 123 });
  </script>
</body>
</html>
```

### 6. Register in the Integration Tests (Optional)

Add to `bunny/ears/tests/carrot.integration.test.ts` if you want automated testing.

### 7. Test the Carrot

Start Bunny Ears and install the carrot from the dashboard using the "Install from Disk" option, pointing to your carrot directory.
