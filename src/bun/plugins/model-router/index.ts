/**
 * model-router — turns the user's `DETOUR_MODEL_<TYPE>_PROVIDER`
 * preference into actual dispatch authority, including cloud↔cloud.
 *
 * Registers at priority 1000 (highest) for each routed ModelType. On
 * call:
 *
 *   1. If `DETOUR_MODEL_<TYPE>_PROVIDER` is unset → throw
 *      RouterPassthrough so eliza's resolver falls through to the next
 *      handler governed by the existing priority order.
 *
 *   2. If set → call `runtime.useModel(type, params, providerName)`.
 *      Eliza's resolveModelRegistration (runtime.ts:4636) looks up by
 *      provider name, returning ONLY that named handler — no recursion
 *      back into the router because the router's own provider name
 *      ("model-router") doesn't match any user-selectable id.
 *
 * Net effect: the unified picker in tray + Settings genuinely steers
 * dispatch across local AND cloud providers, not just local-vs-cloud.
 *
 * Caveat: if the user picks a provider whose plugin isn't currently
 * registered (no API key, plugin not loaded), useModel returns
 * undefined / throws "no handler" — we let that propagate so the user
 * sees a clear "you picked X but X isn't configured" error rather
 * than silently routing somewhere else.
 */

import {
	ModelType,
	logger,
	type IAgentRuntime,
	type JsonValue,
	type Plugin,
} from "@elizaos/core";
import { getProviderFor, type RoutedType } from "../../core/model-routing";

/// Eliza modelType strings used by registerModel. VIDEO_GENERATION is
/// Detour-internal (eliza only has VIDEO for processing) — we don't
/// register the router there because there's no eliza model slot to
/// hook; the videoHandler in media-generation/index.ts already routes
/// VIDEO_GENERATION explicitly.
const ROUTED_MODEL_TYPES: Array<{ type: string; routedType: RoutedType }> = [
	{ type: ModelType.IMAGE, routedType: "IMAGE" },
	{ type: ModelType.IMAGE_DESCRIPTION, routedType: "IMAGE_DESCRIPTION" },
	{ type: ModelType.TRANSCRIPTION, routedType: "TRANSCRIPTION" },
	{ type: ModelType.TEXT_TO_SPEECH, routedType: "TEXT_TO_SPEECH" },
];

export class RouterPassthrough extends Error {
	constructor() {
		super("model-router: no explicit provider preference set — falling through");
		this.name = "RouterPassthrough";
	}
}

async function dispatchTo(
	runtime: IAgentRuntime,
	modelType: string,
	routedType: RoutedType,
	params: Record<string, JsonValue | object>,
): Promise<JsonValue | object> {
	const preferred = getProviderFor(runtime, routedType);
	if (!preferred) {
		// No explicit pref — let the existing priority-based handlers fire.
		throw new RouterPassthrough();
	}
	// Don't recurse back into ourselves if the user somehow set the
	// pref to "model-router" (shouldn't happen via our UI but defend
	// against it).
	if (preferred === "model-router") {
		throw new RouterPassthrough();
	}
	logger.info(`[model-router] ${modelType} → dispatching to provider=${preferred}`);
	const result = await runtime.useModel(modelType as never, params as never, preferred);
	return result as JsonValue | object;
}

export const modelRouterPlugin: Plugin = {
	name: "model-router",
	description: "Routes each ModelType call to the user-preferred provider (local or cloud) per Settings → Model Routing.",
	init: async (_config, runtime) => {
		if (!runtime) return;
		for (const { type, routedType } of ROUTED_MODEL_TYPES) {
			runtime.registerModel(
				type,
				async (rt: IAgentRuntime, params: Record<string, JsonValue | object>) => {
					return dispatchTo(rt, type, routedType, params);
				},
				"model-router",
				1000,   // priority above everything else
			);
		}
		logger.info(`[model-router] registered for ${ROUTED_MODEL_TYPES.length} types at priority 1000`);
	},
};

export default modelRouterPlugin;
