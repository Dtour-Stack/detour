# Text-only Re-ingestion Upload Order

This is the safe replacement for the failed binary upload. Your error says the endpoint only accepts text/Markdown/JSON/code, so do **not** upload the `.zip` bundle or `.xlsx` workbook to that endpoint.

## Use this order

### Option A — simplest Markdown-only import
Upload:

1. `agent_reingest_text_only_master.md`

This contains the policy, people/contact table, merge rules, guardrails, and the fixed relationship graph in a fenced JSONL block.

### Option B — structured import
Upload or feed these files in order:

1. `agent_reingest_text_only_memory_records.json`
2. `agent_reingest_text_only_relationships_FIXED.json`

### Option C — streaming / line-by-line import
Upload or feed these files in order:

1. `agent_reingest_text_only_memory_records.jsonl`
2. `agent_reingest_text_only_relationships_FIXED.jsonl`

If your importer limits file size, use these relationship chunks instead of the full relationship file:

- `agent_reingest_text_only_relationships_part_01.jsonl`
- `agent_reingest_text_only_relationships_part_02.jsonl`
- `agent_reingest_text_only_relationships_part_03.jsonl`
- `agent_reingest_text_only_relationships_part_04.jsonl`

## What changed from the previous pack

- Removed all binary container dependency. No ZIP needed.
- Added atomized memory records where each entity has its own text memory plus its relationship edges.
- Added fixed relationship graph files.
- Removed `1` contradictory guardrail edge(s) involving an exact duplicate pair.
- Preserved all 61 entity records and 341 fixed relationship edges.
- Preserved 55 non-system addressable/placeholder records, 5 system records, and the mention-noise summary.

## Ingestion behavior to enforce

- Auto-merge only exact duplicate phone/contact/platform-ID matches.
- Review, but do not auto-merge, candidate cross-platform links.
- Do not ingest `know this`, `how it`, or `this was` as people.
- Keep `Inbox`, `User`, and `Autonomy` isolated from social/contact identity memory.
- Keep homoglyph `shаw` separate from ASCII `shaw`.
