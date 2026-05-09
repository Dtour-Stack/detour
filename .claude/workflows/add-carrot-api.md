---
description: Add a new host API method that carrots can call from their Bun workers
---

## Add a New Host API for Carrots

Use this when adding a new capability that carrot workers can invoke on the Bunny Ears host.

### 1. Decide: Request-Response or Fire-and-Forget?

- **Request-Response** — Worker needs a return value. Add to `HostRequestMessage.method`.
- **Fire-and-Forget** — Worker just triggers an action. Add to `HostActionMessage.action`.

### 2. Add the Type

In `bunny/ears/src/carrot-runtime/types.ts`, add the new method/action to the appropriate union:

```typescript
// For request-response:
export type HostRequestMessage = {
  // ... existing methods
  | { method: "myNewMethod"; params: MyParams; requestId: string };
};

// For fire-and-forget:
export type HostActionMessage = {
  // ... existing actions
  | { action: "myNewAction"; params: MyParams };
};
```

### 3. Handle It in CarrotInstance

In `bunny/ears/src/bun/index.ts`, find `CarrotInstance.handleHostRequest()` or `handleHostAction()` and add a case:

```typescript
// In handleHostRequest:
case "myNewMethod": {
  const result = await this.doSomething(msg.params);
  this.worker.postMessage({
    type: "host-response",
    requestId: msg.requestId,
    result,
  });
  return;
}

// In handleHostAction:
case "myNewAction": {
  this.doSomething(msg.params);
  return;
}
```

### 4. Expose It in the Carrot SDK

In `bunny/ears/src/carrot-runtime/bun.ts`, add the public API:

```typescript
// For request-response — add to the module exports:
export async function myNewMethod(params: MyParams): Promise<MyResult> {
  return carrotRuntime.requestHost({ method: "myNewMethod", params });
}

// For fire-and-forget — add to the module exports:
export function myNewAction(params: MyParams): void {
  carrotRuntime.sendAction({ action: "myNewAction", params });
}
```

### 5. Add a Test

In `bunny/ears/tests/carrot.integration.test.ts`, add a test case that:
1. Creates a test carrot worker
2. Calls the new API
3. Verifies the expected behavior

### 6. Update the Carrot SDK View (If Needed)

If the new API needs view-side support, add it to `bunny/ears/src/carrot-runtime/view.ts` in the `createCarrotClient()` return value.
