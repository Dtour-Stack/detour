/**
 * Named prompt-template registry.
 *
 * Every slot the agent reads through this module can be overridden by
 * creating a Pensieve template with the matching name (Pensieve → Templates
 * pane). The override flows through `PensieveTemplatesService.applyTemplatesToRuntime`
 * which copies the body onto `runtime.character.templates[<name>]`.
 *
 * Three kinds of slots are registered:
 *
 *   1. **Eliza built-ins** — names that `@elizaos/core` reads via
 *      `runtime.character.templates?.<name>` with its own default fallback.
 *      Detour does NOT supply defaults for these; eliza does, and we just
 *      list them so users see them as editable slots in the UI.
 *
 *   2. **Detour-owned** — prompts that live in Detour's own services
 *      (goal extraction, dream consolidation, DPE plain-text fallback,
 *      continuous improvement). Defaults are provided here AND the service
 *      uses `getPromptTemplate(runtime, name)` to read with fallback.
 *
 *   3. **Variables** — token-substituted via `{{var}}` syntax inside the
 *      template body (handled by PensieveTemplatesService.renderTemplate).
 */

import type { IAgentRuntime } from "@elizaos/core";

export type PromptSlotKind = "eliza-builtin" | "detour-owned";

export interface PromptSlotSpec {
	/** Slot name; also the key in `character.templates[...]`. */
	name: string;
	kind: PromptSlotKind;
	/** Short user-facing label. */
	label: string;
	/** What this slot does — shown in the UI as a hint. */
	description: string;
	/**
	 * Default body for Detour-owned slots; null for eliza built-ins
	 * (eliza supplies its own default if no override is registered).
	 */
	defaultBody: string | null;
	/** Where the slot is read in code, for "find where this is used" UI. */
	usedIn: string;
	/** Known variable tokens recognised by the slot (helps the UI). */
	variables: string[];
}

export const DETOUR_GOAL_EXTRACTION_TEMPLATE = "detourGoalExtractionTemplate";
export const DETOUR_DREAM_CONSOLIDATION_TEMPLATE = "detourDreamConsolidationTemplate";
export const DETOUR_DPE_FALLBACK_TEMPLATE = "detourPlainTextReplyTemplate";
export const DETOUR_CONTINUOUS_IMPROVEMENT_TEMPLATE = "detourContinuousImprovementTemplate";

export const DETOUR_GOAL_EXTRACTION_DEFAULT = [
	"Extract the user's single primary objective from the message below.",
	"Return ONLY one declarative sentence in imperative form (\"Build X\", \"Fix Y\", \"Find Z\").",
	"No prefix, no quotes, no markdown, no \"the user wants\" wrapper.",
	"Cap at 200 characters. If the message is pure chitchat with no objective, return the literal word: NONE",
	"",
	"User message:",
	"{{userMessage}}",
	"",
	"Objective:",
].join("\n");

export const DETOUR_DREAM_CONSOLIDATION_DEFAULT = [
	"You are Detour's memory consolidation pass (\"dream\").",
	"Your job: review the user's interaction history and propose a DIFF over the existing memory store.",
	"You do NOT mutate memories directly — you propose changes; the user (or auto-apply) decides.",
	"",
	"# Operating instructions",
	"{{instructions}}",
	"",
	"# Rules",
	"- Be conservative. Better to skip than corrupt the store.",
	"- Never propose deleting an entry you cannot replace with something better, unless it's clearly contradicted.",
	"- For merges: pick one id as the canonical keepId and list the rest in collapseIds.",
	"- For additions: only surface patterns that recur across MULTIPLE sessions, not one-off events.",
	"- Never include secrets, tokens, message-content quotes, or PII in additions.",
	"- All memory ids must come from the provided memory list.",
	"",
	"# Current memory store snapshot (id → preview)",
	"{{memoriesBlock}}",
	"",
	"# Recent session transcripts (sources, actions, prompt previews)",
	"{{trajectoriesBlock}}",
	"",
	"# Output format",
	"Return a single JSON object (no markdown fence required) with this shape:",
	"{",
	'  "additions":    [ { "text": "...", "path": "/preferences/style", "tags": ["dream","preference"], "category": "...", "reason": "..." } ],',
	'  "merges":       [ { "keepId": "<id>", "collapseIds": ["<id>","<id>"], "canonicalText": "...", "reason": "..." } ],',
	'  "replacements": [ { "staleId": "<id>", "newText": "...", "reason": "..." } ],',
	'  "deletions":    [ { "id": "<id>", "reason": "..." } ],',
	'  "notes":        "one-sentence summary of what you found"',
	"}",
	"Return an empty array for any category with nothing to propose. Do not include extra keys.",
].join("\n");

export const DETOUR_DPE_FALLBACK_DEFAULT = [
	"You are {{agentName}}. Reply to the latest user message in plain text.",
	"Return only the message to send. No labels, no JSON, no TOON, no markdown fence, no hidden reasoning.",
	"",
	"Reply policy:",
	"- This is a degraded fallback path — structured action planning failed. You CANNOT invoke tools from here.",
	"- If the request needed a tool (build/code/run/post/search/fetch): explain in ONE concise message that the structured planner failed for this turn, what you would normally do, and that the user can re-send or that a retry will run on the next turn. Do not pretend you did the work.",
	"- If the request was conversational: answer normally in your voice. Do not fake action.",
	"- Blockers must be CONCRETE: name the failed component (planner, provider, credential), what you would have done, and the unblock action. No vague \"I had trouble.\"",
	"- Never apologize beyond one short \"my bad\". Never moralize. Never disclaim. Stay in voice.",
	"",
	"{{characterContext}}",
	"",
	"{{memoryContext}}",
	"",
	"Recent conversation:",
	"{{conversation}}",
	"",
	"Reply:",
].join("\n");

export const DETOUR_CONTINUOUS_IMPROVEMENT_DEFAULT = [
	"You are Detour's continuous-improvement loop.",
	"Use the Hermes Agent pattern: bounded curated memory, skill creation after non-trivial workflows, session search for recall, tool orchestration, evaluation traces, and human-reviewed self-evolution.",
	"Your job is to extract one durable improvement from recent activity. Do not rewrite code, alter prompts, or claim a change has been made. Save only useful, non-secret, non-ephemeral learning.",
	"",
	"Save when there is:",
	"- a user preference, correction, repeated frustration, or workflow habit",
	"- a project convention, tool quirk, integration failure pattern, or working recovery path",
	"- a candidate skill/procedure the agent should reuse later",
	"- a measurable guardrail/eval idea for future self-evolution",
	"",
	"Skip trivial observations, raw logs, secrets, tokens, private message contents, one-off stack traces, or anything already obvious from AGENTS.md.",
	"",
	"Recent logs:",
	"{{logs}}",
	"",
	"Recent memories:",
	"{{memories}}",
	"",
	"Output TOON only:",
	"should_write: true | false",
	"category: user-preference | workflow | tool-quirk | skill-candidate | eval-guardrail | skip",
	"memory: <one compact durable memory, required when should_write is true>",
	"user_profile: <optional compact user preference>",
	"skill_candidate: <optional reusable workflow idea>",
	"reason: <brief>",
].join("\n");

/**
 * Slots Detour owns + slots eliza reads. The UI shows all of these as
 * "known" prompt slots so users can override them.
 *
 * Eliza-built-in entries have `defaultBody: null` — eliza's source code
 * has the actual default; we don't duplicate it here, we just give users
 * a labelled slot they can write into.
 */
export const PROMPT_SLOTS: PromptSlotSpec[] = [
	{
		name: DETOUR_GOAL_EXTRACTION_TEMPLATE,
		kind: "detour-owned",
		label: "Goal extraction",
		description:
			"Used on the first substantive user turn to extract the conversation's primary objective. Single TEXT_SMALL call, runs in the background. Variables: {{userMessage}}.",
		defaultBody: DETOUR_GOAL_EXTRACTION_DEFAULT,
		usedIn: "src/bun/core/goal-service.ts (GoalService.extractAndSet)",
		variables: ["userMessage"],
	},
	{
		name: DETOUR_DREAM_CONSOLIDATION_TEMPLATE,
		kind: "detour-owned",
		label: "Dream consolidation",
		description:
			"Scheduled memory-consolidation pass. Reads memories + trajectories, proposes a structured diff. Variables: {{instructions}}, {{memoriesBlock}}, {{trajectoriesBlock}}.",
		defaultBody: DETOUR_DREAM_CONSOLIDATION_DEFAULT,
		usedIn: "src/bun/core/dream-service.ts (DreamService.consolidate)",
		variables: ["instructions", "memoriesBlock", "trajectoriesBlock"],
	},
	{
		name: DETOUR_DPE_FALLBACK_TEMPLATE,
		kind: "detour-owned",
		label: "Plain-text fallback reply",
		description:
			"Used when the structured planner fails or returns null. The agent must explain what it would have done — never fake an action. Variables: {{agentName}}, {{characterContext}}, {{memoryContext}}, {{conversation}}.",
		defaultBody: DETOUR_DPE_FALLBACK_DEFAULT,
		usedIn: "src/bun/core/dpe-fallback-plugin.ts (plainTextReplyPrompt)",
		variables: ["agentName", "characterContext", "memoryContext", "conversation"],
	},
	{
		name: DETOUR_CONTINUOUS_IMPROVEMENT_TEMPLATE,
		kind: "detour-owned",
		label: "Continuous improvement",
		description:
			"Periodic reflection over recent logs + memories. Extracts one durable improvement per tick. Variables: {{logs}}, {{memories}}.",
		defaultBody: DETOUR_CONTINUOUS_IMPROVEMENT_DEFAULT,
		usedIn: "src/bun/core/continuous-improvement-service.ts (decideImprovement)",
		variables: ["logs", "memories"],
	},
	// === Eliza built-in slots (defaults live in eliza/packages/core/src) ===
	{
		name: "messageHandlerTemplate",
		kind: "eliza-builtin",
		label: "Message handler (planner)",
		description:
			"Eliza's primary structured-response planner template. Selects actions + composes the reply. Most influential prompt in the whole loop.",
		defaultBody: null,
		usedIn: "@elizaos/core message handler",
		variables: [],
	},
	{
		name: "replyTemplate",
		kind: "eliza-builtin",
		label: "Reply",
		description: "Eliza's reply-action template. Used when the planner picks REPLY as the action.",
		defaultBody: null,
		usedIn: "@elizaos/core reply action",
		variables: [],
	},
	{
		name: "shouldRespondTemplate",
		kind: "eliza-builtin",
		label: "Should respond",
		description:
			"Decides whether the agent should respond at all on a given turn. Critical for unaddressed channel messages.",
		defaultBody: null,
		usedIn: "@elizaos/core message service",
		variables: [],
	},
	{
		name: "thinkTemplate",
		kind: "eliza-builtin",
		label: "Think",
		description:
			"Used by the THINK action when the agent wants to reason in a step before acting.",
		defaultBody: null,
		usedIn: "@elizaos/core think action",
		variables: [],
	},
	{
		name: "reflectionTemplate",
		kind: "eliza-builtin",
		label: "Reflection",
		description: "Eliza's reflection evaluator — runs after a turn to extract durable observations.",
		defaultBody: null,
		usedIn: "@elizaos/core reflection evaluator",
		variables: [],
	},
	{
		name: "postCreationTemplate",
		kind: "eliza-builtin",
		label: "Post creation",
		description: "Used when the agent writes a new social post (X, Discord, etc.).",
		defaultBody: null,
		usedIn: "@elizaos/core post-creation action",
		variables: [],
	},
	{
		name: "imageGenerationTemplate",
		kind: "eliza-builtin",
		label: "Image generation",
		description: "Used by GENERATE_IMAGE actions to expand the user's request into a generation prompt.",
		defaultBody: null,
		usedIn: "@elizaos/core image-generation action",
		variables: [],
	},
];

/**
 * Look up a prompt body from `runtime.character.templates` (set by
 * PensieveTemplatesService.applyTemplatesToRuntime) and substitute
 * `{{key}}` tokens from the provided variables map. Falls back to the
 * default body when the user hasn't overridden the slot.
 *
 * Substitution is intentionally minimal — no Handlebars helpers, no
 * conditionals, no escaping. A token that isn't in the variables map is
 * left as `{{key}}` so debugging is easy.
 */
export function renderPromptTemplate(
	runtime: IAgentRuntime,
	slot: string,
	variables: Record<string, string>,
	defaultBody: string,
): string {
	const character = (runtime as unknown as { character?: { templates?: Record<string, string> } }).character;
	const override = character?.templates?.[slot];
	const body = typeof override === "string" && override.length > 0 ? override : defaultBody;
	return body.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (match, key: string) => {
		if (Object.prototype.hasOwnProperty.call(variables, key)) {
			return variables[key] ?? "";
		}
		return match;
	});
}

/**
 * Get the registered slot spec — used by the UI to render labels +
 * descriptions next to user-editable bodies.
 */
export function getPromptSlot(name: string): PromptSlotSpec | null {
	return PROMPT_SLOTS.find((s) => s.name === name) ?? null;
}
