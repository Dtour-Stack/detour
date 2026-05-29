// Flow-check ruleset for the `plumber` subagent (.claude/agents/plumber.md).
// Enforces Detour's process + layer boundaries. Tighten `severity: "warn"`
// rules to "error" once the codebase is clean of them.
//
// NOTE: `feature-isolation` uses dependency-cruiser's $1 capture-group
// backreference (the `([^/]+)` from `from.path` is referenced as `$1` in
// `to.pathNot`). Keep the literal `$1` — it means "a DIFFERENT feature".
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Real (runtime) circular deps are rat-tail topology — break the cycle. " +
        "`viaOnly: dependencyTypesNot type-only` scopes this to cycles where EVERY " +
        "edge is a value import; a cycle that relies on an `import type` edge is " +
        "erased by TS at runtime and is NOT a real circular dependency. The " +
        "boundary rules below keep tsPreCompilationDeps=true, so type-only imports " +
        "across layers are still caught — we just don't flag type-only cycles.",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "shared-is-leaf",
      severity: "error",
      comment:
        "src/shared is the wire-type/RPC contract layer (single source of truth). It must not depend on either process.",
      from: { path: "^src/shared/" },
      to: { path: "^src/(bun|main)/" },
    },
    {
      name: "view-not-bun-internals",
      severity: "warn",
      comment:
        "The view (src/main) talks to bun ONLY via typed RPC (src/shared/rpc) + rpc.ts. Type-only peeks into src/bun are tolerated-but-flagged — move shared shapes into src/shared.",
      from: { path: "^src/main/" },
      to: { path: "^src/bun/", pathNot: "^src/shared/" },
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
