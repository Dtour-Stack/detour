---
description: Debug RPC communication issues between bun and webview in Electrobun apps
---

## Debug RPC Issues

### Symptoms Checklist

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| RPC calls silently fail | Webview is sandboxed | `sandbox: true` disables RPC — remove or set to `false` |
| RPC times out | Webview not ready yet | Wait for `dom-ready` event before making calls |
| Type errors on RPC | Schema mismatch between bun and webview | Ensure shared RPC type is imported by both sides |
| `rpc` is null/undefined | RPC config not passed to BrowserWindow | Pass `rpc` in BrowserWindow options |
| RPC works in CEF but not native | Renderer-specific bridge issue | Check renderer compatibility; prefer `renderer: "cef"` for tests |

### Debugging Steps

1. **Check that the webview loaded correctly:**
   ```typescript
   win.webview.on("dom-ready", () => {
     console.log("Webview DOM ready");
   });
   ```

2. **Verify RPC is available on the webview:**
   ```typescript
   console.log("RPC available:", !!win.webview.rpc);
   ```

3. **Test with a simple echo:**
   ```typescript
   // Bun-side handler:
   requests: { echo: ({ value }) => value }

   // Call from bun:
   const result = await win.webview.rpc?.request.echo({ value: "ping" });
   console.log("Echo result:", result);
   ```

4. **Check the webview console for errors:**
   - Open DevTools if available
   - Or use `win.webview.executeJavascript('console.log("test")')` to verify JS execution

5. **Verify RPC schema types match:**
   - The `RPCSchema` generic must have identical `bun` and `webview` shapes
   - Bun-side `handlers.requests` handles webview→bun calls
   - Webview-side `handlers.requests` handles bun→webview calls

6. **Check for sandbox mode:**
   ```typescript
   // Sandbox mode disables the internal bridge — RPC won't work
   const win = new BrowserWindow({ sandbox: true }); // ← RPC disabled
   ```

### Common RPC Patterns

**Bun calls webview:**
```typescript
const result = await win.webview.rpc?.request.methodName({ params });
```

**Webview calls bun:**
```typescript
const result = await electrobun.rpc.request.methodName({ params });
```

**Bun sends message to webview (no response):**
```typescript
win.webview.rpc?.send.eventName({ data });
```

**Webview sends message to bun (no response):**
```typescript
electrobun.rpc.send.eventName({ data });
```
