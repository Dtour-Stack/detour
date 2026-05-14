/**
 * Prompt slot RPC schema — the typed list of "named prompt template slots"
 * Detour or eliza reads. Powers the Pensieve → Templates "Known slots" UI.
 */

export interface PromptSlotInfo {
	name: string;
	kind: "eliza-builtin" | "detour-owned";
	label: string;
	description: string;
	defaultBody: string | null;
	usedIn: string;
	variables: string[];
	/** If a Pensieve template with `name === slot.name` exists, this is its id. */
	overrideTemplateId: string | null;
}

export type PromptSlotsRequests = {
	promptSlotsList: {
		params: Record<string, never>;
		response: { slots: PromptSlotInfo[] };
	};
	/**
	 * Create a Pensieve template at the slot's name slug so the user can
	 * start editing the override. If `body` is omitted, seeds with the
	 * Detour-owned default (eliza built-ins seed empty so users see the
	 * canvas).
	 */
	promptSlotsCreateOverride: {
		params: { name: string; body?: string };
		response: { templateId: string | null };
	};
};
