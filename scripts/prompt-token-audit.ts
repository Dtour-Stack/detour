#!/usr/bin/env bun
/**
 * Prompt-token audit — measure the actual size of every per-turn surface
 * in chars + estimated tokens. Run:
 *
 *     bun run scripts/prompt-token-audit.ts
 *
 * Produces a table breaking down:
 *
 *   1. Character anchor pieces (system / lore / topics / styles / examples)
 *      that ride into every turn via composeState.
 *   2. Every Detour-owned prompt template default body (loaded via the
 *      runtime when no override is set in Pensieve).
 *   3. The always-on provider stack (names + the default text each
 *      provider currently renders for a synthetic empty-state).
 *
 * Token estimate uses the conservative 4-chars-per-token rule (OpenAI's
 * own back-of-envelope; matches Anthropic's published ~3.5 ratio within
 * 15%). For exact counts the user runs the LLM with usage reporting on
 * — this script's job is to surface relative cost, not produce a billing
 * invoice.
 */

import { DEFAULT_AGENT_CHARACTER } from "../src/bun/core/agent-character";
import {
	PROMPT_SLOTS,
	DETOUR_GOAL_EXTRACTION_DEFAULT,
	DETOUR_DREAM_CONSOLIDATION_DEFAULT,
	DETOUR_DPE_FALLBACK_DEFAULT,
	DETOUR_CONTINUOUS_IMPROVEMENT_DEFAULT,
} from "../src/bun/core/prompt-templates";

interface Row {
	label: string;
	chars: number;
	tokens: number;
	notes: string;
}

function estimateTokens(chars: number): number {
	// 4 chars ≈ 1 token, rounded to nearest token (Anthropic/OpenAI back-of-envelope).
	return Math.round(chars / 4);
}

function row(label: string, body: string, notes: string): Row {
	const chars = body.length;
	return { label, chars, tokens: estimateTokens(chars), notes };
}

function joinArray(value: string | readonly string[]): string {
	if (typeof value === "string") return value;
	return value.join("\n");
}

function flattenExamples(examples: readonly { name: string; content: { text: string } }[][]): string {
	return examples
		.flat()
		.map((m) => `${m.name}: ${m.content.text}`)
		.join("\n");
}

const character = DEFAULT_AGENT_CHARACTER;

const characterRows: Row[] = [
	row("character.system (rides EVERY turn)", joinArray(character.system), "Highest-leverage knob — every planner call eats this."),
	row("character.bio (sampled by eliza)", joinArray(character.bio), "Eliza samples; not all bio rides every turn."),
	row("character.lore (sampled by eliza)", joinArray(character.lore), "Eliza samples; not all lore rides every turn."),
	row("character.topics (sampled by eliza)", joinArray(character.topics), "Eliza samples ~3-5 topics per turn."),
	row("character.adjectives", joinArray(character.adjectives), "Tiny — used by reflection + post-creation."),
	row("character.style.all (rides every turn)", joinArray(character.style.all), "Always present in style block."),
	row("character.style.chat", joinArray(character.style.chat), "Chat path only."),
	row("character.style.post", joinArray(character.style.post), "Post-creation path only."),
	row("character.messageExamples (sampled)", flattenExamples(character.messageExamples as never), "Eliza samples 2-3 examples per turn — not all 50+."),
	row("character.postExamples (sampled)", joinArray(character.postExamples), "Post-creation path only; samples a subset."),
];

const detourPromptRows: Row[] = [
	row("detourGoalExtractionTemplate (default)", DETOUR_GOAL_EXTRACTION_DEFAULT, "ONE TEXT_SMALL call on first substantive user turn per room."),
	row("detourDreamConsolidationTemplate (default)", DETOUR_DREAM_CONSOLIDATION_DEFAULT, "ONE TEXT_LARGE call every 6h scheduled."),
	row("detourPlainTextReplyTemplate (default)", DETOUR_DPE_FALLBACK_DEFAULT, "Fires ONLY when structured planner errors — degraded path."),
	row("detourContinuousImprovementTemplate (default)", DETOUR_CONTINUOUS_IMPROVEMENT_DEFAULT, "ONE TEXT_SMALL→TEXT_LARGE call every 30min scheduled."),
];

function fmt(n: number): string {
	return n.toLocaleString();
}

function printTable(title: string, rows: Row[]): void {
	console.log(`\n=== ${title} ===`);
	const labelW = Math.max(...rows.map((r) => r.label.length), 8);
	console.log(
		`${"label".padEnd(labelW)}  ${"chars".padStart(8)}  ${"tokens".padStart(7)}   notes`,
	);
	console.log("-".repeat(labelW + 35));
	for (const r of rows) {
		console.log(
			`${r.label.padEnd(labelW)}  ${fmt(r.chars).padStart(8)}  ${fmt(r.tokens).padStart(7)}   ${r.notes}`,
		);
	}
	const totalChars = rows.reduce((acc, r) => acc + r.chars, 0);
	const totalTokens = rows.reduce((acc, r) => acc + r.tokens, 0);
	console.log("-".repeat(labelW + 35));
	console.log(
		`${"TOTAL".padEnd(labelW)}  ${fmt(totalChars).padStart(8)}  ${fmt(totalTokens).padStart(7)}`,
	);
}

console.log("Detour prompt-token audit");
console.log("Estimate: 4 chars ≈ 1 token (OpenAI/Anthropic rule of thumb).");

printTable("Character sheet — what ships every turn (depends on eliza sampling)", characterRows);
printTable("Detour-owned prompt slots — fire only on their specific paths", detourPromptRows);

console.log("\n=== Per-turn worst-case planner call estimate ===");
const systemAlwaysOn = characterRows[0].chars;
const styleAllAlwaysOn = characterRows[5].chars;
const examplesSampled = Math.round(characterRows[8].chars * 0.05); // eliza usually samples ~5% of examples
const otherStaticOverhead = 800; // rough: ADDITIONAL_RESPONSE_STATE_PROVIDERS render blocks (capabilities, goal, etc.)
const perTurnFloor = systemAlwaysOn + styleAllAlwaysOn + examplesSampled + otherStaticOverhead;
console.log(`  system anchor:           ${fmt(systemAlwaysOn).padStart(6)} chars / ~${estimateTokens(systemAlwaysOn)} tokens`);
console.log(`  style.all:               ${fmt(styleAllAlwaysOn).padStart(6)} chars / ~${estimateTokens(styleAllAlwaysOn)} tokens`);
console.log(`  ~5% sample of examples:  ${fmt(examplesSampled).padStart(6)} chars / ~${estimateTokens(examplesSampled)} tokens`);
console.log(`  always-on providers ~:   ${fmt(otherStaticOverhead).padStart(6)} chars / ~${estimateTokens(otherStaticOverhead)} tokens`);
console.log(`  ── per-turn floor:       ${fmt(perTurnFloor).padStart(6)} chars / ~${estimateTokens(perTurnFloor)} tokens`);
console.log("\nUser context, recent messages, and tool definitions add on top of this floor.");

console.log("\n=== Slot registration check ===");
for (const slot of PROMPT_SLOTS) {
	const kindBadge = slot.kind === "detour-owned" ? "[DETOUR]" : "[ELIZA] ";
	const sizeNote =
		slot.defaultBody === null
			? "(eliza default in eliza/packages/core/src/prompts.ts)"
			: `${fmt(slot.defaultBody.length)} chars / ~${estimateTokens(slot.defaultBody.length)} tokens`;
	console.log(`  ${kindBadge} ${slot.name.padEnd(40)} ${sizeNote}`);
}
