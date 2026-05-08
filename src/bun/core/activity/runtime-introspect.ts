/**
 * Snapshot of the AgentRuntime's internal registries (actions, providers,
 * services, evaluators, plugins). The Activity > Runtime tab renders this
 * as a tree, with the same controls milady's RuntimeView has.
 *
 * Returns a serialisable snapshot so the JSON HTTP layer can ship it without
 * touching live class instances.
 */

import type { IAgentRuntime } from "@elizaos/core";

export interface ActivityPluginDetail {
	readonly name: string;
	readonly description?: string;
	readonly actionCount: number;
	readonly actionNames: string[];
	readonly providerCount: number;
	readonly providerNames: string[];
	readonly evaluatorCount: number;
	readonly evaluatorNames: string[];
	readonly serviceCount: number;
	readonly serviceTypes: string[];
	readonly hasInit: boolean;
	readonly hasRoutes: boolean;
	readonly hasModels: boolean;
}

export interface ActivityPluginsSnapshot {
	readonly available: boolean;
	readonly generatedAt: number;
	readonly count: number;
	readonly plugins: ActivityPluginDetail[];
}

export interface RuntimeRegistryItem {
	readonly name: string;
	readonly description?: string;
	readonly className?: string;
	readonly id?: string;
	readonly extras?: Record<string, unknown>;
}

export interface ActivityRuntimeSnapshot {
	readonly available: boolean;
	readonly generatedAt: number;
	readonly agentId?: string;
	readonly agentName?: string;
	readonly counts: {
		readonly actions: number;
		readonly providers: number;
		readonly evaluators: number;
		readonly services: number;
		readonly plugins: number;
	};
	readonly actions: RuntimeRegistryItem[];
	readonly providers: RuntimeRegistryItem[];
	readonly evaluators: RuntimeRegistryItem[];
	readonly services: RuntimeRegistryItem[];
	readonly plugins: RuntimeRegistryItem[];
}

function pickString(o: unknown, key: string): string | undefined {
	if (o && typeof o === "object" && key in (o as Record<string, unknown>)) {
		const v = (o as Record<string, unknown>)[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function listToItems(list: unknown): RuntimeRegistryItem[] {
	if (!Array.isArray(list)) return [];
	return list
		.map((entry) => {
			const name = pickString(entry, "name") ?? "(unnamed)";
			const description = pickString(entry, "description") ?? pickString(entry, "descriptionCompressed");
			const className = entry?.constructor?.name && entry.constructor.name !== "Object" ? entry.constructor.name : undefined;
			const id = pickString(entry, "id");
			const item: RuntimeRegistryItem = {
				name,
				...(description ? { description } : {}),
				...(className ? { className } : {}),
				...(id ? { id } : {}),
			};
			return item;
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function servicesToItems(services: unknown): RuntimeRegistryItem[] {
	// services is typically a Map<serviceType, Service[]> or Map<string, Service>
	if (!services) return [];
	const out: RuntimeRegistryItem[] = [];
	const append = (key: string, val: unknown) => {
		if (Array.isArray(val)) {
			for (const v of val) {
				out.push({
					name: key,
					className: v?.constructor?.name && v.constructor.name !== "Object" ? v.constructor.name : undefined,
					...(pickString(v, "capabilityDescription") ? { description: pickString(v, "capabilityDescription") } : {}),
				});
			}
		} else if (val && typeof val === "object") {
			out.push({
				name: key,
				className: (val as { constructor?: { name?: string } }).constructor?.name,
				...(pickString(val, "capabilityDescription") ? { description: pickString(val, "capabilityDescription") } : {}),
			});
		}
	};
	if (services instanceof Map) {
		for (const [k, v] of services) append(String(k), v);
	} else if (typeof services === "object") {
		for (const [k, v] of Object.entries(services)) append(k, v);
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

function pluginsToItems(plugins: unknown): RuntimeRegistryItem[] {
	if (!Array.isArray(plugins)) return [];
	return plugins
		.map((p) => {
			const name = pickString(p, "name") ?? "(unnamed plugin)";
			const description = pickString(p, "description");
			const out: RuntimeRegistryItem = {
				name,
				...(description ? { description } : {}),
			};
			return out;
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function pickArrayNames(obj: unknown, key: string): string[] {
	if (!obj || typeof obj !== "object") return [];
	const arr = (obj as Record<string, unknown>)[key];
	if (!Array.isArray(arr)) return [];
	return arr
		.map((entry) => pickString(entry, "name"))
		.filter((n): n is string => typeof n === "string" && n.length > 0)
		.sort((a, b) => a.localeCompare(b));
}

function pickServiceTypes(p: unknown): string[] {
	const services = (p as { services?: unknown })?.services;
	if (!Array.isArray(services)) return [];
	const out: string[] = [];
	for (const cls of services) {
		const t = (cls as { serviceType?: string })?.serviceType ?? pickString(cls, "name");
		if (t) out.push(t);
	}
	return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Per-plugin breakdown — what each registered plugin contributes to the
 * runtime (actions, providers, evaluators, services). Used by the Activity >
 * Plugins pane to give a "what is each plugin doing" view that the basic
 * runtime snapshot doesn't.
 */
export function snapshotPlugins(runtime: IAgentRuntime | null): ActivityPluginsSnapshot {
	if (!runtime) {
		return { available: false, generatedAt: Date.now(), count: 0, plugins: [] };
	}
	const plugins = (runtime as unknown as { plugins?: unknown[] }).plugins;
	if (!Array.isArray(plugins)) {
		return { available: true, generatedAt: Date.now(), count: 0, plugins: [] };
	}
	const details: ActivityPluginDetail[] = plugins.map((p) => {
		const actionNames = pickArrayNames(p, "actions");
		const providerNames = pickArrayNames(p, "providers");
		const evaluatorNames = pickArrayNames(p, "evaluators");
		const serviceTypes = pickServiceTypes(p);
		return {
			name: pickString(p, "name") ?? "(unnamed plugin)",
			...(pickString(p, "description") ? { description: pickString(p, "description") } : {}),
			actionCount: actionNames.length,
			actionNames,
			providerCount: providerNames.length,
			providerNames,
			evaluatorCount: evaluatorNames.length,
			evaluatorNames,
			serviceCount: serviceTypes.length,
			serviceTypes,
			hasInit: typeof (p as { init?: unknown })?.init === "function",
			hasRoutes: Array.isArray((p as { routes?: unknown[] })?.routes) && (p as { routes: unknown[] }).routes.length > 0,
			hasModels: !!((p as { models?: unknown })?.models),
		};
	});
	details.sort((a, b) => a.name.localeCompare(b.name));
	return {
		available: true,
		generatedAt: Date.now(),
		count: details.length,
		plugins: details,
	};
}

export function snapshotRuntime(runtime: IAgentRuntime | null): ActivityRuntimeSnapshot {
	if (!runtime) {
		return {
			available: false,
			generatedAt: Date.now(),
			counts: { actions: 0, providers: 0, evaluators: 0, services: 0, plugins: 0 },
			actions: [],
			providers: [],
			evaluators: [],
			services: [],
			plugins: [],
		};
	}
	const r = runtime as unknown as Record<string, unknown>;
	const actions = listToItems(r.actions);
	const providers = listToItems(r.providers);
	const evaluators = listToItems(r.evaluators);
	const services = servicesToItems(r.services);
	const plugins = pluginsToItems(r.plugins);
	const character = r.character as { name?: string } | undefined;
	return {
		available: true,
		generatedAt: Date.now(),
		agentId: pickString(r, "agentId"),
		agentName: character?.name,
		counts: {
			actions: actions.length,
			providers: providers.length,
			evaluators: evaluators.length,
			services: services.length,
			plugins: plugins.length,
		},
		actions,
		providers,
		evaluators,
		services,
		plugins,
	};
}
