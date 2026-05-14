# Detour Runtime Contract

The flow of a single user turn, end to end. Citations are `file:line` — read
the actual code before changing the contract; this file is a map, not a spec.

## Turn lifecycle: chat path (user types in the tray app)

```
ChatView.tsx:201                user presses Enter
  → rpc.chatSend({convId,text})

rpc/handlers/chat.ts:60-126     bun-side handler
  - acks immediately ({ok:true, traceId})
  - fires async traceScope:
      → runtime.sendMessage(text, onDelta)
  - onDelta → broadcaster.broadcast("chatDelta", ...)
  - after 1.5s idle → broadcast("chatComplete", ...)

runtime.ts:639  sendMessage
  1. getOrBuild()                    runtime.ts:417 — boots or returns cached
  2. rotatePastCapsIfNeeded(state)   runtime.ts:682 — skip past capped credentials
  3. cap precheck                    throws if no uncapped credential remains
  4. maybeCaptureGoal(text)          runtime.ts:690 — FIRE-AND-FORGET (non-blocking)
  5. deliverMessage(state, text)     runtime.ts:714

runtime.ts:714  deliverMessage
  - ensureConnection (room/entity/world exist)
  - native slash command branch?     → renders + recurses
  - build Memory + call messageService.handleMessage(runtime, memory, callback)

eliza messageService                  (provided by @elizaos/plugin-bootstrap)
  → runtime.dynamicPromptExecFromState(args)
      → wrapped by dpe-fallback-plugin.ts:403  installDpeFallbackPatch
          - active-cap short-circuit            → quotaCappedReply (clean cap notice)
          - structured planner call             → returns {actions, text, ...}
          - on null/throw + canFallback         → plain-text fallback prompt
          - else                                → compact-state retry

action dispatch (CREATE_TASK, X_POST, REPLY, ...)
  - detour-goal plugin wraps CREATE_TASK / SPAWN_AGENT / START_CODING_TASK
    handlers, injecting the active goal into:
      message.content.memoryContent
      options.parameters.memoryContent
  - action handler runs, may call back to the user via the callback

reply path
  - text deltas → onDelta → chatDelta broadcast → React state → bubble
  - completion → chatComplete broadcast
```

## Turn lifecycle: inbox path (Discord/Telegram/iMessage/X DM arrives)

```
gateway emits MESSAGE_RECEIVED
inbox/index.ts:235-271            listener
  → inbox.post({prompt:false, ...})
inbox/index.ts:310                post() — dedupe by source, persist InboxItem
  - if shouldPrompt → promptAgent(item)
inbox/index.ts:510                promptAgent
  → messageService.handleMessage(runtime, memory, callback)
  (same planner + DPE-fallback + action dispatch chain as chat path)
```

## Goal capture contract

- Goal capture is FIRE-AND-FORGET in `runtime.sendMessage` (no await).
- First substantive turn: extraction runs in background; turn N+1 sees the goal.
- Chitchat (`hi`, `thanks`, etc.) is gated out by `looksLikeChitchat` —
  no model call.
- `DETOUR_ACTIVE_GOAL` provider (position -90) surfaces the active goal on
  every turn. If absent, it renders an "(none set yet)" notice so the agent
  knows.
- `SET_GOAL` and `CLEAR_GOAL` actions let the agent (or the user via the
  chat banner) override.
- Sub-agent spawn auto-threading: the detour-goal plugin wraps
  `CREATE_TASK` / `SPAWN_AGENT` / `START_CODING_TASK` handlers via:
  1. plugin `init` (best-effort, may run before orchestrator actions register)
  2. `runtime.onAfterBuild` in `core/index.ts` (guaranteed pass)
  Wrapping is idempotent via the `WRAPPED_FOR_GOAL` marker.

## Memory writes — where they happen

| Write                  | Caller                                   | Table |
|------------------------|------------------------------------------|-------|
| Conversation messages  | eliza messageService                     | `messages` |
| Pensieve user write    | PENSIEVE_WRITE action                    | `memories` |
| Goals                  | GoalService.setActiveGoal                | `memories` (type `detour-goal`) |
| Dream manifests        | DreamService.consolidate                 | `memories` (type `detour-dream`) |
| Dream pending diffs    | DreamService.stagePending                | `memories` (type `detour-dream-pending`) |
| Continuous-improvement | ContinuousImprovementService.execute     | `memories` (path `/improvement/reflections`) |
| Discord observations   | DiscordObservationService                | `memories` (path `/observations/discord`) |
| Chronicler observations| PensieveChroniclerService                | `memories` (path `/observations/user-activity`) |
| Facts (Eliza core)     | FACTS evaluator                          | `facts` |
| Relationships          | RELATIONSHIP_EXTRACTION evaluator        | `relationships` |

## Provider order (renders into planner state, lower position first)

```
-100  AGENT_CHARACTER_ANCHOR     identity + tone
 -90  DETOUR_ACTIVE_GOAL         current conversation objective
 -50  AGENT_CAPABILITIES         live plugins/actions/services
 -45  AGENT_SKILL_CATALOG        curated procedures
 -45  AUDIO_GENERATION_STATUS    audio-gen plugin status
 -44  MEDIA_GENERATION_STATUS    media-gen plugin status
 -40  AGENT_CODING_BRIEF         coding-tools framing + sandbox dir
 -35  DESKTOP_USE_STATUS         desktop-control plugin status
 -20  USER_ACTIVITY_CONTEXT      pensieve activity observations
  (dynamic)  FACTS, RELATIONSHIPS  pulled by eliza core
```

If you add a provider with the same position as an existing one, ordering
between them is undefined. Pick a distinct position.

## Cap / quota contract

- `ProviderQuotaService` records `usage_limit_reached` events with the cap's
  reset time and the active credential.
- `rotatePastCapsIfNeeded` walks the user's configured fallback order and
  rebuilds the runtime with capped attempts excluded.
- DPE fallback short-circuits to a clean cap notice when the active credential
  is capped — no retries are attempted on the same exhausted provider.
- Dream consolidation pass skips when `getActiveCap()` is non-null —
  chat is the priority surface; memory hygiene waits for the reset.

## Where the agent's voice comes from (in render order)

1. Character anchor: `agent-character.ts` `system` array
2. Character anchor provider render: `capabilities/index.ts:renderCharacterAnchor`
3. Style: `agent-character.ts` `style.all` + `style.chat` / `style.post`
4. Lore: `agent-character.ts` `lore` (source of voice; not copied verbatim)
5. Examples: `agent-character.ts` `messageExamples` / `postExamples`

If the agent is sounding off, the change goes in `agent-character.ts`. Tools,
capability inventory, and skill registry are runtime-derived — don't list
them in the anchor; the providers do it.

## What NOT to do

- Do not block `sendMessage` on the goal extraction call. It's fire-and-forget.
- Do not add an X_POST simile that overlaps with `X_POST_DETOUR_STATUS` /
  `X_POST_TOKEN_STATUS` / `X_POST_DEXPLOARER_STATUS`. Each has its own intent
  surface; collisions made the action-selector pick randomly.
- Do not duplicate identifying catchphrases across `lore` + `postExamples` +
  `messageExamples`. The lore is the source; examples should illustrate range,
  not echo.
- Do not list specific action names in `system` that would go stale —
  reference the AGENT_CAPABILITIES provider as the source of truth.
- Do not add a provider at the same `position` as an existing one. The
  ordering becomes platform-dependent.
