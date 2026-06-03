# Claude — Global CLAUDE.md (captured)

# graphify
- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, invoke the Skill tool with `skill: "graphify"` before doing anything else.

# Google Engineering Practices Adapter

Use the local Google Engineering Practices adapter when review readiness, PR descriptions, or review comments are in scope.

## Skills

- **google-eng-pre-review** (`~/.claude/skills/google-eng-pre-review/SKILL.md`) - pre-review current work for scope, code health, tests, docs, and verification.
- **google-eng-pr-description** (`~/.claude/skills/google-eng-pr-description/SKILL.md`) - draft PR/CL descriptions from the actual diff.
- **google-eng-review-comments** (`~/.claude/skills/google-eng-review-comments/SKILL.md`) - draft or rewrite review comments with severity labels.

## Review Defaults

- Favor changes that improve code health and forward progress; do not block on perfection.
- Block known degradations in correctness, security, maintainability, testability, or user-visible behavior.
- Keep changes self-contained and split broad refactors from behavior changes.
- Prefer facts, repo conventions, runtime evidence, and tests over personal style preference.
- Label review comments as `Required`, `Optional`, `Nit`, or `FYI`.
