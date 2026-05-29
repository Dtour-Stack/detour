---
name: plumber-setup
description: >-
  Provision and VALIDATE the repo's flow-check tooling so the `plumber`
  subagent has graph-level evidence instead of returning UNKNOWN. Installs
  dependency-cruiser (+ madge), authors a Detour-tuned `.dependency-cruiser.cjs`
  layering ruleset, wires `check:flow` / `check:cycles` package scripts, runs
  them to prove they work, and writes/refreshes a `.claude/topology.md`
  baseline lane + ownership map. Use when setting plumber up for the first
  time, when plumber reports missing arch-check tooling, or after a major
  topology change (new top-level layer, new app/package, new process boundary).
---

# plumber-setup

Sets up the **flow-check infrastructure** the `plumber` subagent (`.claude/agents/plumber.md`) depends on. Without it, plumber can only reason by hand and must return **UNKNOWN** for graph-level claims (cycles, illegal edges, cross-feature imports). This skill gives plumber a runnable, evidence-producing check.

**Do not invent blind scripts.** Every artifact this skill writes is *validated by running it* before you report success. If a check can't run, fix the config first — do not leave a `check:flow` script that errors.

## Stack assumptions (Detour)

- Runtime: **bun** + **electrobun**; strict **TypeScript** (`tsc --noEmit` is the only existing boundary gate).
- Monorepo: bun workspaces; the **`eliza/` submodule is vendored — always excluded** from checks.
- Layers (the seams plumber enforces):
  - `src/main/**` — view layer (React webview process)
  - `src/shared/**` — wire types + RPC schema (single source of truth; the only legal bridge between processes)
  - `src/bun/core/**` — services + the AgentRuntime; `src/bun/core/rpc/handlers/**` are the RPC boundary adapters
  - `src/bun/features/**` — kernel-registered feature modules
  - `src/bun/kernel/**` — tray / windows / events / view-url (Core ↔ window bridge)
  - `src/bun/plugins/**` — Detour/eliza plugins (adapters)

If the repo layout has changed, adapt the rules below to the real directories before writing them — do not enforce a layout that doesn't exist.

## Steps

### 1. Confirm the layout
`ls src/main src/shared src/bun/core src/bun/features src/bun/kernel src/bun/plugins` — verify the seams above still exist. Note any new top-level layer or app/package; it needs a rule too.

### 2. Install the tooling (dev deps)
```sh
bun add -d dependency-cruiser madge
```

### 3. Author `.dependency-cruiser.cjs`
Write this at the repo root (tuned to Detour's seams; `eliza/` excluded).

> ⚠️ **`$1` gotcha:** the `feature-isolation` rule's `to.pathNot` uses
> dependency-cruiser's capture-group backreference `$1` (the `([^/]+)` captured
> in `from.path` = "the same feature"). If your skill runner does argument
> substitution it may render `$1` as empty (`^src/bun/features//`) — that is
> WRONG. Write the literal `$1` into the file. The committed
> `.dependency-cruiser.cjs` is the source of truth; verify it contains `$1`.

```js
// Flow-check ruleset for the `plumber` subagent. Enforces Detour's process +
// layer boundaries. Tighten `severity: "warn"` rules to "error" once clean.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // `viaOnly: dependencyTypesNot type-only` scopes this to REAL runtime
      // cycles — a cycle that relies on an `import type` edge is erased by TS at
      // runtime and is not a real circular dependency. Boundary rules below keep
      // tsPreCompilationDeps=true, so type-only cross-layer imports are still caught.
      name: "no-circular",
      severity: "error",
      comment: "Real (runtime) circular deps are rat-tail topology — break the cycle.",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "shared-is-leaf",
      severity: "error",
      comment:
        "src/shared is the wire-type/RPC contract layer. It must not depend on either process.",
      from: { path: "^src/shared" },
      to: { path: "^src/(bun|main)" },
    },
    {
      name: "view-not-bun-internals",
      severity: "warn",
      comment:
        "The view (src/main) talks to bun ONLY via typed RPC (src/shared/rpc) + rpc.ts. Type-only peeks into src/bun are tolerated-but-flagged — move shared shapes into src/shared.",
      from: { path: "^src/main" },
      to: { path: "^src/bun", pathNot: "^src/shared" },
    },
    {
      name: "feature-isolation",
      severity: "warn",
      comment:
        "A feature must not import another feature's internals — go via src/shared or the kernel event bus.",
      from: { path: "^src/bun/features/([^/]+)/" },
      to: { path: "^src/bun/features/", pathNot: "^src/bun/features/$1/" },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules(/|$)" },
    exclude: {
      path: [
        "(^|/)node_modules(/|$)",
        "^eliza/",
        "(^|/)(build|artifacts|dist)(/|$)",
        "\\.d\\.ts$",
      ],
    },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true, // include type-only imports (boundary crossings count)
  },
};
```

### 4. Wire package scripts
Add to root `package.json` `scripts` (do not remove existing scripts):
```json
"check:flow": "depcruise src --config .dependency-cruiser.cjs --ignore-known",
"check:flow:all": "depcruise src --config .dependency-cruiser.cjs",
"check:cycles": "madge --circular --extensions ts,tsx src"
```
- `check:flow` is the **ratchet gate** — it ignores the recorded baseline (step 5) so it's green on known debt and red only on NEW violations. This is what plumber runs POST-FLIGHT.
- `check:flow:all` shows the full debt (baseline + new) for audits / burn-down.
- `check:cycles` is an informational cycle list (madge) — it will be red while cycles exist; it is not the gate.

### 5. VALIDATE + baseline (mandatory — do not skip)
A mature repo almost always has pre-existing violations (cycles especially). Don't leave a permanently-red `check:flow`, and don't weaken rule severities to fake green. Instead, **record the existing violations as a baseline ratchet** so the gate passes on known debt and fails on anything new:
```sh
# 1. See the full debt (config must RUN cleanly; violations are expected output)
bun run check:flow:all
# 2. Record the current violations as the baseline
bunx depcruise src --config .dependency-cruiser.cjs --output-type baseline > .dependency-cruiser-known-violations.json
# 3. The gate is now green on the baseline:
bun run check:flow            # expect: "no dependency violations found ... N known violations ignored"
```
- If `depcruise` errors on the **config itself** (bad rule, resolver failure), fix the config and re-run until it executes cleanly *before* baselining.
- **Prove the ratchet** (recommended): create a throwaway file that introduces a new violation (e.g. `src/shared/__probe__.ts` importing from `src/bun`), run `bun run check:flow` (must go red), then delete it (must go green).
- Capture the baseline counts by rule (cycles / shared-is-leaf / view crossings) — these are plumber's burn-down list. **Do not** baseline as a way to ignore violations forever; it is a starting line, not a finish line.

### 6. Write the topology baseline `.claude/topology.md`
So plumber doesn't re-discover the repo every run. Fill from the real layout:
```markdown
# Topology baseline (for the plumber subagent)

## Layers & ownership
- View: src/main/** (webview) — talks to bun ONLY via src/shared/rpc + rpc.ts
- Contract: src/shared/** — wire types + RPC schema (single source of truth)
- RPC boundary: src/bun/core/rpc/handlers/** — adapt transport → core services
- Application/services: src/bun/core/**
- Features: src/bun/features/** (kernel-registered; window/hub opening)
- Kernel: src/bun/kernel/** (tray/windows/events/view-url; Core ↔ window bridge)
- Adapters: src/bun/plugins/** (Detour/eliza plugins)
- Vendored (excluded): eliza/**

## Canonical lane
view (src/main) -> src/shared/rpc -> src/bun/core/rpc/handlers -> src/bun/core service -> src/bun/plugins adapter

## Window-open dispatch (single source of truth)
src/shared/window-targets.ts: WINDOW_OPEN_MESSAGE / WINDOW_OPEN_KERNEL_EVENT.
Do NOT re-derive uiOpen* names anywhere else.

## Known accepted crossings (triage list)
- <fill in from `check:flow` warn output, e.g. src/main/.../GatewayPane.tsx imports a type from src/bun/core/channels/gateway>
```

### 7. Confirm to the lead agent
Report: deps installed, config + `.dependency-cruiser-known-violations.json` baseline written, `check:flow` green (N known ignored), ratchet proven, topology baseline written with the debt broken down by rule. From now on `plumber` runs `bun run check:flow` for graph evidence and reads `.claude/topology.md` instead of returning UNKNOWN.

## Idempotency & safety
- Re-running is safe: overwrite `.dependency-cruiser.cjs` and `.claude/topology.md`; only ADD missing package scripts.
- The baseline (`.dependency-cruiser-known-violations.json`) should SHRINK over time — regenerate it after burning down debt (`... --output-type baseline > .dependency-cruiser-known-violations.json`); never regenerate it just to absorb a fresh violation.
- Never weaken a rule's severity to make output green — use the baseline ratchet (which keeps NEW violations red) instead.
- Never include `eliza/**` (vendored) or `node_modules` in the graph.
