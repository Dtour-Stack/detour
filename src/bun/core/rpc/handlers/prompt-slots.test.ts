import { describe, expect, test } from "bun:test";
import { promptSlotsRequests } from "./prompt-slots";
import type { RpcDeps } from "../types";
import {
	DETOUR_DREAM_CONSOLIDATION_TEMPLATE,
	DETOUR_GOAL_EXTRACTION_TEMPLATE,
	PROMPT_SLOTS,
} from "../../prompt-templates";

interface FakeTemplate {
	id: string;
	name: string;
	body: string;
}

function makeDeps(existingOverrides: FakeTemplate[] = []): RpcDeps {
	const store = new Map<string, FakeTemplate>(existingOverrides.map((t) => [t.id, t]));
	let nextId = 1;
	const templates = {
		async listTemplates() {
			return [...store.values()].map((t) => ({
				id: t.id,
				name: t.name,
				path: `/templates/${t.name}`,
				preview: t.body.slice(0, 200),
				variables: [],
				tags: ["template"],
			}));
		},
		async createTemplate(input: { name: string; body: string }) {
			const id = `tpl-${nextId++}`;
			const slug = input.name.trim().toLowerCase();
			const t = { id, name: slug, body: input.body };
			store.set(id, t);
			return {
				id,
				name: slug,
				path: `/templates/${slug}`,
				preview: input.body.slice(0, 200),
				variables: [],
				tags: ["template"],
			};
		},
	};
	return {
		pensieve: { templates },
	} as unknown as RpcDeps;
}

describe("promptSlotsRequests", () => {
	test("promptSlotsList returns every registered slot with no override flag", async () => {
		const deps = makeDeps();
		const result = await promptSlotsRequests(deps).promptSlotsList();
		expect(result.slots.length).toBe(PROMPT_SLOTS.length);
		for (const s of result.slots) {
			expect(s.overrideTemplateId).toBeNull();
		}
	});

	test("promptSlotsList marks slots with an existing pensieve override", async () => {
		const deps = makeDeps([
			{
				id: "tpl-existing",
				name: DETOUR_GOAL_EXTRACTION_TEMPLATE,
				body: "user-edited body",
			},
		]);
		const result = await promptSlotsRequests(deps).promptSlotsList();
		const goalSlot = result.slots.find((s) => s.name === DETOUR_GOAL_EXTRACTION_TEMPLATE);
		expect(goalSlot?.overrideTemplateId).toBe("tpl-existing");
		const dreamSlot = result.slots.find((s) => s.name === DETOUR_DREAM_CONSOLIDATION_TEMPLATE);
		expect(dreamSlot?.overrideTemplateId).toBeNull();
	});

	test("promptSlotsCreateOverride seeds with default body for detour-owned slot", async () => {
		const deps = makeDeps();
		const handlers = promptSlotsRequests(deps);
		const { templateId } = await handlers.promptSlotsCreateOverride({
			name: DETOUR_GOAL_EXTRACTION_TEMPLATE,
		});
		expect(templateId).not.toBeNull();
		const list = await deps.pensieve.templates.listTemplates();
		expect(list[0]?.preview).toContain("Extract the user's single primary objective");
	});

	test("promptSlotsCreateOverride seeds with caller-provided body when given", async () => {
		const deps = makeDeps();
		const handlers = promptSlotsRequests(deps);
		const { templateId } = await handlers.promptSlotsCreateOverride({
			name: DETOUR_GOAL_EXTRACTION_TEMPLATE,
			body: "MY CUSTOM SEED",
		});
		expect(templateId).not.toBeNull();
		const list = await deps.pensieve.templates.listTemplates();
		expect(list[0]?.preview).toBe("MY CUSTOM SEED");
	});

	test("promptSlotsCreateOverride returns null for unknown slot name", async () => {
		const deps = makeDeps();
		const { templateId } = await promptSlotsRequests(deps).promptSlotsCreateOverride({
			name: "not-a-real-slot",
		});
		expect(templateId).toBeNull();
	});
});
