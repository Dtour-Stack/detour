/**
 * Prompt-slot RPC handlers.
 *
 *   - promptSlotsList: returns every registered slot (Detour-owned +
 *     eliza-builtin), each annotated with the matching pensieve template
 *     id when an override exists.
 *   - promptSlotsCreateOverride: seeds a pensieve template under the
 *     slot's name slug, so the user can start editing immediately. For
 *     Detour-owned slots, seeds with the default body so the user sees
 *     the actual prompt to tweak. For eliza built-ins (where we don't
 *     have the default text), seeds with an empty body or the caller's
 *     provided one.
 */

import type { RpcDeps } from "../types";
import type { PromptSlotInfo } from "../../../../shared/rpc/prompt-slots";
import { PROMPT_SLOTS, getPromptSlot } from "../../prompt-templates";

export function promptSlotsRequests(deps: RpcDeps) {
	return {
		promptSlotsList: async (): Promise<{ slots: PromptSlotInfo[] }> => {
			const overrides = await deps.pensieve.templates.listTemplates();
			const overrideMap = new Map<string, string>();
			for (const t of overrides) {
				overrideMap.set(t.name, t.id);
			}
			const slots: PromptSlotInfo[] = PROMPT_SLOTS.map((slot) => ({
				name: slot.name,
				kind: slot.kind,
				label: slot.label,
				description: slot.description,
				defaultBody: slot.defaultBody,
				usedIn: slot.usedIn,
				variables: slot.variables,
				overrideTemplateId: overrideMap.get(slot.name) ?? null,
			}));
			return { slots };
		},
		promptSlotsCreateOverride: async (
			params: { name: string; body?: string },
		): Promise<{ templateId: string | null }> => {
			const slot = getPromptSlot(params.name);
			if (!slot) return { templateId: null };
			const seedBody =
				typeof params.body === "string" && params.body.length > 0
					? params.body
					: slot.defaultBody ?? "";
			const created = await deps.pensieve.templates.createTemplate({
				name: slot.name,
				body: seedBody,
				tags: ["template", `slot:${slot.kind}`],
			});
			return { templateId: created?.id ?? null };
		},
	};
}
