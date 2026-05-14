import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_CHARACTER } from "../src/bun/core/agent-character";
import {
	DETOUR_GOAL_EXTRACTION_DEFAULT,
	DETOUR_DREAM_CONSOLIDATION_DEFAULT,
	DETOUR_DPE_FALLBACK_DEFAULT,
	DETOUR_CONTINUOUS_IMPROVEMENT_DEFAULT,
	PROMPT_SLOTS,
} from "../src/bun/core/prompt-templates";

/**
 * Budget guards on every-turn prompt cost.
 *
 * The system block + style.all ship into EVERY planner call. If they
 * balloon we burn tokens linearly with usage. These thresholds are
 * intentionally generous (allow ~30% growth headroom) but they will
 * fail loudly if anyone adds a 5-line "let me also remind you that..."
 * block to the character without thinking about it.
 *
 * If you need to grow past these limits: change the constant AND leave
 * a note explaining why the per-turn cost increase is worth it.
 */

const MAX_SYSTEM_CHARS = 4500; // currently ~3,257
const MAX_STYLE_ALL_CHARS = 800; // currently ~411
const MAX_ADJECTIVES_CHARS = 800; // currently ~328
const MAX_DETOUR_GOAL_EXTRACTION_CHARS = 700; // currently ~366
const MAX_DETOUR_DREAM_CHARS = 2500; // currently ~1573
const MAX_DETOUR_FALLBACK_CHARS = 1500; // currently ~1008
const MAX_DETOUR_IMPROVEMENT_CHARS = 1800; // currently ~1268

describe("prompt-token budget guards", () => {
	test("character.system stays under per-turn budget", () => {
		const len = (DEFAULT_AGENT_CHARACTER.system as string).length;
		expect(len).toBeLessThanOrEqual(MAX_SYSTEM_CHARS);
		// Tokens estimate: 4 chars per token
		const tokens = Math.round(len / 4);
		expect(tokens).toBeLessThanOrEqual(Math.ceil(MAX_SYSTEM_CHARS / 4));
	});

	test("character.style.all stays under budget", () => {
		const len = DEFAULT_AGENT_CHARACTER.style.all.join("\n").length;
		expect(len).toBeLessThanOrEqual(MAX_STYLE_ALL_CHARS);
	});

	test("character.adjectives stays under budget", () => {
		const len = DEFAULT_AGENT_CHARACTER.adjectives.join(", ").length;
		expect(len).toBeLessThanOrEqual(MAX_ADJECTIVES_CHARS);
	});

	test("Detour goal extraction prompt under budget", () => {
		expect(DETOUR_GOAL_EXTRACTION_DEFAULT.length).toBeLessThanOrEqual(MAX_DETOUR_GOAL_EXTRACTION_CHARS);
	});

	test("Detour dream consolidation prompt under budget", () => {
		expect(DETOUR_DREAM_CONSOLIDATION_DEFAULT.length).toBeLessThanOrEqual(MAX_DETOUR_DREAM_CHARS);
	});

	test("Detour DPE fallback prompt under budget", () => {
		expect(DETOUR_DPE_FALLBACK_DEFAULT.length).toBeLessThanOrEqual(MAX_DETOUR_FALLBACK_CHARS);
	});

	test("Detour continuous-improvement prompt under budget", () => {
		expect(DETOUR_CONTINUOUS_IMPROVEMENT_DEFAULT.length).toBeLessThanOrEqual(MAX_DETOUR_IMPROVEMENT_CHARS);
	});

	test("every Detour-owned PROMPT_SLOTS default body is under 2.5KB", () => {
		// Catches new Detour slot additions that bloat by accident.
		for (const slot of PROMPT_SLOTS) {
			if (slot.kind !== "detour-owned") continue;
			expect(slot.defaultBody).not.toBeNull();
			expect((slot.defaultBody as string).length).toBeLessThanOrEqual(2500);
		}
	});

	test("character.system mentions GENERATE_IMAGE + GENERATE_VIDEO so planner picks them up", () => {
		const sys = DEFAULT_AGENT_CHARACTER.system as string;
		expect(sys).toContain("GENERATE_IMAGE");
		expect(sys).toContain("GENERATE_VIDEO");
	});

	test("character.system mentions audio tools so planner can pick voice/music/SFX", () => {
		const sys = DEFAULT_AGENT_CHARACTER.system as string;
		expect(sys).toContain("ELEVENLABS_TEXT_TO_SPEECH");
		expect(sys).toContain("ELEVENLABS_MUSIC");
		expect(sys).toContain("ELEVENLABS_SOUND_EFFECT");
	});

	test("character.system mentions VISION ON IMAGES + STAY CURRENT rules", () => {
		const sys = DEFAULT_AGENT_CHARACTER.system as string;
		expect(sys).toContain("VISION ON IMAGES");
		expect(sys).toContain("STAY CURRENT");
	});

	test("character.system references AGENT_CAPABILITIES as authoritative tool list", () => {
		const sys = DEFAULT_AGENT_CHARACTER.system as string;
		expect(sys).toContain("AGENT_CAPABILITIES");
	});
});
