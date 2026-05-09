---
description: Add a new permission type to the Bunny Ears carrot permission system
---

## Add a New Permission

### 1. Add to the Permission Union

In `bunny/ears/src/carrot-runtime/types.ts`:

```typescript
// For host-level permissions (windows, tray, notifications, storage):
export type HostPermission = "windows" | "tray" | "notifications" | "storage" | "myNewPerm";

// For bun-level permissions (read, write, env, run, ffi, addons, worker):
export type BunPermission = "read" | "write" | "env" | "run" | "ffi" | "addons" | "worker" | "myNewPerm";
```

### 2. Add to Display Order

In `bunny/ears/src/bun/carrotConsent.ts`:

```typescript
const HOST_PERMISSION_ORDER: HostPermission[] = [
  "windows", "tray", "notifications", "storage", "myNewPerm",
];
const BUN_PERMISSION_ORDER: BunPermission[] = [
  "read", "write", "env", "run", "ffi", "addons", "worker", "myNewPerm",
];
```

### 3. Add to Flatten Function

In `bunny/ears/src/carrot-runtime/types.ts`, update `flattenCarrotPermissions()` to include the new permission tag.

### 4. Add to Worker Permissions (Bun Permissions Only)

In `bunny/ears/src/bun/workerPermissions.ts`:

```typescript
export function toBunWorkerPermissions(permissions: CarrotPermissionGrant): Bun.WorkerPermissions {
  return {
    // ... existing
    myNewPerm: hasBunPermission(permissions, "myNewPerm"),
  };
}
```

### 5. Add Display Label

In `bunny/ears/src/mainview/index.ts`, add a human-readable label in `formatPermissionValue()`.

### 6. Add a Test

In `bunny/ears/tests/carrot.integration.test.ts`, add test cases for:
- Normalizing the new permission from legacy array format
- Flattening it to a tag
- Building consent requests that include it
- Converting it to worker permissions
