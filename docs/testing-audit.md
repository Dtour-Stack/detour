# Detour Testing + Eval Audit

Honest assessment of what's real vs what's bullshit across the test
suite and the agent eval harness, with concrete file:line references
and the failure modes that silently slip through today.

**Audited:**
- 60 `*.test.ts` files under `src/bun/` (492 tests total)
- The eval HTTP API (`src/bun/core/api/eval-routes.{ts,test.ts}`)
- The eval suite scripts (`scripts/eval-agent-suite.ts`, `scripts/validate-agent-fixes.ts`)
- The eliza submodule's testing patterns (for comparison)

Audit date: 2026-05-15 (commit shipped just before this doc).

---

## 1. Unit tests — ~70% real

Most tests legitimately import production code and exercise it. Mocks
are usually at the right seam (HTTP `fetch`, `useModel`, runtime
plugins). Sampled 10:

### Real, regression-catching

- **`src/bun/core/dpe-fallback-plugin.test.ts`** — 19 tests. Imports
  `installDpeFallbackPatch` from prod, exercises provider-recovery
  ordering (`:181`), OAuth-paired-without-env-key path (`:243`),
  legacy schema normalization (`:359`). Mocks the
  `runtime.dynamicPromptExecFromState` / `useModel` boundary, which
  is the right cut. Best in class.
- **`src/bun/core/runtime-llm-plugin-priority.test.ts`** — Builds an
  actual `AgentRuntime` from `@elizaos/core` and calls
  `useModel(TEXT_LARGE)` to verify the priority-100 pin works.
  Strongest test in the tree.
- **`src/bun/plugins/codex-chatgpt/index.test.ts`** — Mocks
  `globalThis.fetch` with hand-rolled SSE, runs the real `TEXT_SMALL`
  handler. Sanitizer + TOON parser fed real production output.
- **`src/bun/core/dream-service.test.ts`** — 12 tests with an
  in-memory fake `PensieveMemoryService` and stubbed `useModel`. Plan
  parsing + apply/reject paths are real.
- **`src/bun/core/discord-observation-service.test.ts`** — Pure
  function (`planDiscordObservationWrites`) with production inputs.
  No mocks needed.
- **`src/bun/core/pensieve/memory-service.test.ts`** — Real service
  against a faked `IAgentRuntime`; exercises real query-expansion +
  dedupe.

### Shallow but useful

- **`src/bun/core/channels/gateway.test.ts`** — ONE test. Writes real
  JSONL to a temp dir, asserts `.list()`. Real but trivially shallow
  for a critical service.
- **`src/bun/plugins/vault-tools/index.test.ts`** — Shape tests
  ("action names exist, parameters declared"). Catches
  "I forgot to register" regressions but not behavior regressions.
- **`src/bun/plugins/x-tweets/media-attach.test.ts`** — 6 tests on a
  5-line MIME switch (`mediaCategoryForMime`). Trivial; doesn't
  exercise the chunked upload path that's the actual hard part.

### Tautological / fake

- **`src/bun/core/runtime-dedupe.test.ts`** — Re-implements the
  dedupe logic inline at `:17-33` instead of importing it. The
  comment at `:13` even says so ("We replicate the exact dedupe
  logic… so a refactor here gets caught"). This is **not what the
  comment claims** — if `runtime.ts`'s real dedupe drifts, this passes
  anyway. It only catches refactors of the copy. Worth replacing
  with a test that imports the actual SUT or deleting outright.

### Verdict
- Real coverage: solid for service layer + plugin handlers.
- The one self-tautological file should be fixed or removed.

---

## 2. Integration tests — **none for the turn lifecycle**

The headline invariant of the whole app is:

```
chatSend → runtime.sendMessage → messageService.handleMessage
        → dynamicPromptExecFromState → action dispatch → onDelta
        → chatDelta broadcast → React state
```

`grep "runtime.sendMessage"` across tests returns only
`runtime-dedupe.test.ts` — which doesn't even import runtime.
`grep "broadcaster\.broadcast|chatDelta|chatComplete"` → zero hits.

**There is no test that runs the composition.** Pieces are tested in
isolation (planner-fallback, plugin priorities, dedupe-as-copy) but
their integration with `sendMessage` is not.

The inbox→planner bridge described in CLAUDE.md as the "key invariant"
(Discord/Telegram/iMessage signals driving the agent through the same
pipeline as chat) — also untested. `inbox/index.ts → promptAgent` is
load-bearing for every channel feature; zero test coverage.

---

## 3. Eval harness — real, but small-scale and shallow on grading

### `scripts/eval-agent-suite.ts` (321 lines, 12 prompts)

Genuinely runs real prompts against a live agent via `/api/eval/send`,
pulls `/api/eval/trajectory/:id/simple`, and grades. Real eval — not
just smoke.

**Measures:**
- Action-name match (`:218-224`)
- Reply-substring match (`:227-234`)
- Refusal signal via regex (`:210-213`)
- Per-turn duration (`:309`)
- Trajectory id linkage (`:253`)

**Does NOT measure:**
- **Plan correctness** — the `thought` field of trajectory steps is
  ignored. A plan that says "I will post a tweet" and then doesn't
  call `X_POST` would pass if a substring matches.
- **Tool-arg correctness** — checks action *name* (`GENERATE_IMAGE`)
  but never inspects whether the prompt arg was sensible.
- **Trajectory shape vs. expected** — no expected step count, no
  expected sequence of actions, no plan-vs-execution diff.
- **Token cost** — `TrajectoryDetail.llmCalls` has prompt + completion
  tokens, the eval suite never reads them. Budget regressions don't
  fail.
- **Latency budgets** — duration is reported but never asserted
  against thresholds.
- **Refusal quality** — regex only. "no I won't" matches, but so does
  "no problem, posting it now". Refusal eval is essentially a string
  contains check.
- **Statistical replication** — n=1 per prompt. LLM nondeterminism
  dominates. A single bad sample can pass or fail by luck.
- **Category balance** — Memory / Spawning / Boundary categories have
  ~1 prompt each.

### `scripts/validate-agent-fixes.ts` (208 lines, 7 prompts)

Narrower scope: looks for canned `dpe-fallback` strings and asserts
"at least one real action fired." This is a regression smoke for one
specific bug class. Calling it "validation" is generous.

### `src/bun/core/api/eval-routes.test.ts` (532 lines)

Heavily tests the HTTP surface — auth, 404s, 503s, payload shapes —
with fully mocked `runtime.sendMessage` (`:32-35`). These are
**API-contract tests for a test-driving API**. None of them exercise
the real planner.

### Verdict
Eval-as-real-prompts is in place. Eval-as-rigorous-measurement is not.
With 12 hand-picked prompts, n=1 samples, and grading limited to
action-name + reply substring, the eval would tolerate large regressions
in plan quality.

---

## 4. Eliza submodule — has live-LLM patterns Detour doesn't reuse

- `eliza/packages/core/src/__tests__/` has 10 test files. 7 wire an
  actual `AgentRuntime` + `InMemoryDatabaseAdapter`.
- **`should-respond.live.test.ts`** gates on `ELIZA_RUN_LIVE_TESTS=1`
  and calls real Ollama via `createOllamaModelHandlers` (`:12`). That's
  a legit live eval pattern.
- `eliza/plugins/` has 548 test files across 70+ plugins. The
  `*.live.test.ts` files (openai, openrouter, google-genai,
  wallet/birdeye) hit real APIs gated by env vars.
- **Detour itself imports zero `.live.test.ts` patterns from upstream**
  even though `runtime-llm-plugin-priority.test.ts` shows it's doable.

---

## 5. Gaps — what silently breaks

**Zero coverage on:**

- `runtime.sendMessage` end-to-end (the headline path of the app).
- `broadcaster.broadcast` + `chatDelta`/`chatComplete` wire format.
  If a typo drifts the message name, the UI goes blank silently.
- `inbox/index.ts → promptAgent` — Discord/Telegram/iMessage signals
  to the agent. The CLAUDE.md "key invariant."
- Goal-threading at runtime: `detour-goal/index.test.ts` tests
  wrapping in isolation; no test confirms an actual `CREATE_TASK`
  through `sendMessage` carries the goal.
- The `agent-orchestrator` Proxy that wraps `PTYService.start()`
  failure. `runtime.ts` comments call this "load-bearing"; no test.
- Carrot worker permission scoping (`workerPermissions.ts` → real
  `Bun.WorkerPermissions` mapping).
- The full plugin composition. No test loads the actual Detour plugin
  stack and asserts no two plugins shadow each other's actions.

**Highest silent-break risks:**

1. **Plugin composition order regression.** A new plugin's similes
   could capture an action name another plugin owns; no unit test
   would catch the priority drift. Only the live `eval-agent-suite`
   would, and that's a manual run.
2. **Action dispatch regression.** The agent could regress to
   "always REPLY, never call tools" — `bun test` would pass cleanly.
   The eval suite would catch it but isn't automated.
3. **Dedupe drift.** Per the bullshit test, the prod `runtime.ts`
   dedupe can change and the test won't notice. Real bug: double-emit
   could ship, tests stay green.
4. **Refusal/safety boundary.** ONE prompt in the eval suite, regex-
   graded. Both directions (false positive ↑, false negative ↓) can
   silently pass.
5. **Trajectory recording.** Tests assume `activity.trajectories.list/get`
   returns shaped objects; no test confirms the *writer* actually
   populates them during a real turn.

---

## Concrete priorities (if/when we want to invest)

These are the things that, if they shipped, would raise the trustworthy
baseline of the test setup most:

1. **Replace `runtime-dedupe.test.ts`** with one that imports the
   actual SUT — OR delete it outright if the dedupe is just guarded
   by a flag.
2. **One real `sendMessage` integration test** — build a runtime
   (we already do in `runtime-llm-plugin-priority.test.ts`), wire
   a callback recorder, send a synthetic message, assert action
   dispatch + `onDelta` callbacks fire. Add a couple of canned
   useModel responses for the planner. This single test would catch
   ~half of the silent-break risks listed above.
3. **Trajectory writer test** — assert that a sample
   `sendMessage` invocation actually writes a trajectory the
   `activity` service can read back.
4. **Score the eval suite on plan correctness, not just action name.**
   Extract the `thought` + `actionParams` per step from the
   trajectory; compare structurally to expectations. The infra is
   already there in `TrajectoryDetail`.
5. **Statistical replication.** Run each eval prompt N=3 with the
   same model, report mean + std. A single sample of an LLM is noise.
6. **Token + latency budgets.** Every eval prompt should have a
   `maxLatencyMs` and `maxTokens`. Assert against them. Both are
   trivial to add; both catch real performance regressions today.
7. **Live-LLM smoke** — adopt the `.live.test.ts` + `DETOUR_RUN_LIVE_TESTS=1`
   pattern eliza already uses. One or two prompts hitting the actual
   configured provider on demand. Optional in CI; useful locally.

None of these are mandatory; the current setup ships and works. The
silent-break risks are the honest cost of not investing here.

---

## Closing assessment

Detour's tests are not bullshit but they are **incomplete in load-bearing
places**. The unit-test layer is mostly real. The integration layer for
the headline turn lifecycle is missing. The eval harness is small-scale,
shallow on grading dimensions, and not part of `bun test` — running it
is manual.

The single highest-leverage change is **one real `sendMessage`
integration test**. That alone would protect ~50% of the silent-break
surface listed above.
