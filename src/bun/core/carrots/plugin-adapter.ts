/**
 * Plugin adapter — turns a loaded CarrotHost into an eliza Plugin object
 * that AgentRuntime accepts. The Plugin's actions/providers don't contain
 * real handler code; they're stubs that route every invocation back to the
 * carrot worker over RPC.
 *
 * AgentRuntime sees a normal Plugin. The carrot worker, on the other side
 * of the wire, sees what looks like an IAgentRuntime. Eliza is unmodified.
 */

import type { Action, Handler, IAgentRuntime, Plugin, Provider } from "@elizaos/core";
import type { CarrotHost, RuntimeProxyTarget } from "./host-loader";

const alwaysValid: Action["validate"] = async () => true;

export function carrotToPlugin(host: CarrotHost): Plugin {
	const manifest = host.pluginManifest();
	if (!manifest) throw new Error(`carrot ${host.manifest.id} has not loaded — call host.load() first`);

	const actions: Action[] = manifest.actions.map((descriptor) => ({
		name: descriptor.name,
		similes: descriptor.similes,
		description: descriptor.description,
		validate: alwaysValid,
		handler: makeActionHandler(host, descriptor.name),
		examples: [],
		...(descriptor.parameters ? { parameters: descriptor.parameters } : {}),
	} as Action));

	const providers: Provider[] = manifest.providers.map((descriptor) => ({
		name: descriptor.name,
		description: descriptor.description ?? "",
		get: async (runtime, message, state) => {
			const target = makeRuntimeTarget(runtime);
			return host.invokeProvider(descriptor.name, target, message, state) as Promise<{ data?: unknown; values?: Record<string, unknown>; text?: string }>;
		},
	} as Provider));

	return {
		name: manifest.name,
		description: manifest.description ?? `Carrot ${host.manifest.id}@${host.manifest.version}`,
		actions,
		providers,
	};
}

function makeActionHandler(host: CarrotHost, actionName: string): Handler {
	return async (runtime, message, state, options, callback) => {
		const target = makeRuntimeTarget(runtime);
		// eliza's HandlerCallback signature returns Promise<Memory[]> while our
		// bridge speaks a narrower {text, action} shape. Adapt by ignoring the
		// returned Memory[] — carrots can't use it through the wire anyway.
		const adaptedCallback = callback
			? async (p: { text: string; action: string }) => { await callback(p); }
			: undefined;
		const result = await host.invokeAction(actionName, target, message, state, options, adaptedCallback);
		return result as { success: boolean; [k: string]: unknown };
	};
}

/**
 * The set of IAgentRuntime methods we proxy back to the worker. We could
 * generate this dynamically with a Proxy, but an explicit list makes the
 * RPC surface auditable and prevents the worker from poking at internals
 * (db handles, plugin registry, etc.) that don't belong over the wire.
 */
function makeRuntimeTarget(runtime: IAgentRuntime): RuntimeProxyTarget {
	return {
		useModel: (modelType: unknown, params: unknown) =>
			(runtime as unknown as { useModel: (...a: unknown[]) => unknown }).useModel(modelType, params),
		getSetting: (key: unknown) =>
			(runtime as unknown as { getSetting: (k: unknown) => unknown }).getSetting(key),
		composeState: (message: unknown, includeList: unknown, onlyInclude: unknown) =>
			(runtime as unknown as { composeState: (...a: unknown[]) => unknown }).composeState(message, includeList, onlyInclude),
	};
}
