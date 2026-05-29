---
name: plumber-setup
description: >-
  Provision and VALIDATE a repo's flow-check tooling so the `plumber` subagent
  has graph-level evidence instead of returning UNKNOWN. Detects the stack +
  layer layout, installs the right architecture-check tool (dependency-cruiser
  +madge for JS/TS, import-linter for Python, etc.), authors a layering ruleset
  derived from the repo's REAL seams, records a known-violations baseline so the
  gate ratchets (green on existing debt, red on new), wires `check:flow` /
  `check:cycles`, runs them to prove they work, and writes a `.claude/topology.md`
  baseline. Use when setting `plumber` up for the first time, when it reports
  missing arch-check tooling, or after a major topology change.
---

# plumber-setup

Sets up the **flow-check infrastructure** the `plumber` subagent depends on. Without it, `plumber` can only reason by hand and must return **UNKNOWN** for graph-level claims (cycles, illegal edges, cross-boundary imports). This skill gives it a runnable, evidence-producing check.

All outputs are written into the **current repo** (the working directory where you run this), never relative to the plugin. Do not invent blind scripts — every artifact is **validated by running it** before you report success.

## 1. Detect the stack + layout
- **Stack** — look for: `package.json` + `tsconfig.json` → JS/TS; `pyproject.toml`/`requirements.txt` → Python; `go.mod` → Go; `Cargo.toml` → Rust; `*.csproj` → .NET; `build.gradle`/`pom.xml` → JVM.
- **Layout / seams** — map the real top-level structure and the architectural layers. Look for: a monorepo (`apps/`, `packages/`, workspaces in `package.json`/`pnpm-workspace.yaml`/`go.work`), feature/module folders, a process or UI↔server split, a `shared`/`contracts` layer, and any `ports`/`adapters`/`domain`/`application` seams. Read `CLAUDE.md`/`AGENTS.md`/`README` for the intended architecture.
- Write the discovered layers down — you'll encode them as rules and into `.claude/topology.md`.

## 2. Install the tool for the stack
- **JS/TS**: `<pm> add -D dependency-cruiser madge` (`<pm>` = bun / pnpm / npm / yarn — match the lockfile).
- **Python**: `pip install import-linter` (or add to dev deps).
- **Go**: no install — use `go list` / a small import-guard script.
- **Rust / JVM / .NET**: `cargo metadata` / ArchUnit / NetArchTest respectively.

The rest of this skill details the **JS/TS** path concretely; for other stacks, apply the same shape (rules from real seams → run → baseline ratchet → topology doc) with the tool above.

## 3. Author the layering config (JS/TS → `.dependency-cruiser.cjs`)
Write rules **derived from the seams you discovered in step 1**, not a fixed template. Typical rules:
- `no-circular` (severity `error`) — always.
- Contract/shared layer is a **leaf**: it must not import any process/app layer.
- UI/surface must not import server/persistence internals (only the shared contract).
- Feature A must not import feature B's internals (use the `$1` capture-group backreference — see the gotcha below).
- Exclude vendored/generated dirs (`node_modules`, any vendored submodule, `build`/`dist`/`artifacts`, `*.d.ts`).

> ⚠️ **`$1` gotcha:** the cross-feature rule's `to.pathNot` uses dependency-cruiser's capture-group backreference `$1` (`from.path` captures `([^/]+)` = "this feature"). If a skill runner does argument substitution it may render `$1` as empty — write the literal `$1` into the file and verify it's present.

Skeleton (adapt paths to the real layout):
```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // Scope no-circular to REAL runtime cycles: a cycle relying on an `import
    // type` edge is erased by TS at runtime and isn't a real circular dep.
    // (Boundary rules keep tsPreCompilationDeps=true, so type-only cross-layer
    // imports are still caught.)
    { name: "no-circular", severity: "error", from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } } },
    { name: "shared-is-leaf", severity: "error",
      from: { path: "^<SHARED>/" }, to: { path: "^<NOT-SHARED>/" } },
    { name: "surface-not-internals", severity: "warn",
      from: { path: "^<UI>/" }, to: { path: "^<SERVER>/", pathNot: "^<SHARED>/" } },
    { name: "feature-isolation", severity: "warn",
      from: { path: "^<FEATURES>/([^/]+)/" },
      to: { path: "^<FEATURES>/", pathNot: "^<FEATURES>/$1/" } },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules(/|$)" },
    exclude: { path: ["(^|/)node_modules(/|$)", "(^|/)(build|dist|artifacts)(/|$)", "\\.d\\.ts$"] },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
```

## 4. Wire scripts (project manifest)
```json
"check:flow": "depcruise <SRC> --config .dependency-cruiser.cjs --ignore-known",
"check:flow:all": "depcruise <SRC> --config .dependency-cruiser.cjs",
"check:cycles": "madge --circular --extensions ts,tsx <SRC>"
```
- `check:flow` is the **ratchet gate** (ignores the recorded baseline → green on known debt, red on NEW). This is what `plumber` runs POST-FLIGHT.
- `check:flow:all` shows the full debt for audits / burn-down. `check:cycles` is an informational cycle list.

## 5. Validate + baseline (mandatory)
A mature repo almost always has pre-existing violations. Don't leave a permanently-red gate and don't weaken rule severities to fake green — **record the existing violations as a baseline ratchet**:
```sh
<pm> run check:flow:all      # config must RUN cleanly; violations are expected output
bunx depcruise <SRC> --config .dependency-cruiser.cjs --output-type baseline > .dependency-cruiser-known-violations.json
<pm> run check:flow          # expect: "no dependency violations found ... N known ignored"
```
- If `depcruise` errors on the **config itself**, fix it before baselining.
- **Prove the ratchet**: drop a throwaway file introducing a new violation, confirm `check:flow` goes red, delete it, confirm green.
- Capture the baseline counts by rule — that's `plumber`'s burn-down list. The baseline is a starting line, not a license to ignore violations forever.

## 6. Write `.claude/topology.md`
So `plumber` doesn't re-discover the repo each run. Include: the discovered layers + ownership, the canonical lane (arrows), any single-source-of-truth modules, the commands (`check:flow` / `check:flow:all` / `check:cycles`), and the baseline debt broken down by rule (with burn-down priorities).

## 7. Confirm
Report: stack + layout detected, tool installed, config + `.dependency-cruiser-known-violations.json` written, `check:flow` green (N known ignored), ratchet proven, `.claude/topology.md` written. From now on `plumber` runs `check:flow` for evidence and reads `.claude/topology.md` instead of returning UNKNOWN.

## Idempotency & safety
- Re-running is safe: overwrite the config + `.claude/topology.md`; only ADD missing scripts.
- The baseline should SHRINK over time — regenerate it after burning down debt; never regenerate it just to absorb a fresh violation.
- Never weaken a rule's severity to make output green — use the ratchet (which keeps NEW violations red).
- Never include vendored submodules or `node_modules` in the graph.
