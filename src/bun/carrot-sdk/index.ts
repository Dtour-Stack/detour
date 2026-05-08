/**
 * @detour/carrot-sdk — worker-side helper for writing a carrot.
 *
 * Usage in a carrot's worker.ts:
 *
 *   import { defineCarrot } from "<path-to-detour>/src/bun/carrot-sdk";
 *
 *   defineCarrot({
 *     plugin: {
 *       name: "cron-tools",
 *       actions: [
 *         {
 *           name: "CRON_CREATE",
 *           description: "...",
 *           handler: async (rt, msg, state, options, callback) => {
 *             const cron = rt.service("cron");
 *             const job = await cron.createJob({ ... });
 *             await callback?.({ text: `created ${job.id}`, action: "CRON_CREATE" });
 *             return { success: true, job };
 *           },
 *         },
 *       ],
 *     },
 *   });
 *
 * The SDK wires up postMessage for you, so you write what looks like an
 * eliza Plugin and the bridge takes care of the wire.
 */

import type {
	CarrotActionDescriptor,
	CarrotProviderDescriptor,
	CarrotPluginManifest,
	HostToWorkerMessage,
	WorkerToHostMessage,
} from "../core/carrots/types";

// ── Author-facing types ────────────────────────────────────────────────────

export interface CarrotHandlerCallback {
	(payload: { text: string; action: string }): Promise<void>;
}

export interface CarrotRuntime {
	/**
	 * Get a typed proxy for a Detour core service. The returned object's
	 * methods are async-RPC stubs — calls round-trip through the host. Method
	 * existence is checked client-side; the host enforces the actual
	 * permission/method allowlist.
	 */
	service<T extends Record<string, (...args: any[]) => any>>(name: string): { [K in keyof T]: (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>> };
	/** Proxied AgentRuntime methods. Each call is an async RPC. */
	useModel(modelType: string, params: unknown): Promise<unknown>;
	getSetting(key: string): Promise<unknown>;
	composeState(message: unknown, includeList?: unknown, onlyInclude?: unknown): Promise<unknown>;
}

export interface CarrotActionHandler {
	(
		rt: CarrotRuntime,
		message: unknown,
		state: unknown,
		options: unknown,
		callback: CarrotHandlerCallback | undefined,
	): Promise<unknown>;
}

export interface CarrotAction {
	name: string;
	description: string;
	similes?: string[];
	parameters?: CarrotActionDescriptor["parameters"];
	handler: CarrotActionHandler;
}

export interface CarrotProvider {
	name: string;
	description?: string;
	get(rt: CarrotRuntime, message: unknown, state: unknown): Promise<{ data?: unknown; values?: Record<string, unknown>; text?: string }>;
}

export interface CarrotDefinition {
	plugin: {
		name: string;
		description?: string;
		actions?: CarrotAction[];
		providers?: CarrotProvider[];
	};
}

// ── Wire glue ──────────────────────────────────────────────────────────────

let nextRequestId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (err: Error) => void }>();

declare const self: {
	postMessage(msg: WorkerToHostMessage): void;
	onmessage: ((ev: MessageEvent<HostToWorkerMessage>) => void) | null;
};

function send(msg: WorkerToHostMessage): void {
	self.postMessage(msg);
}

function rpc(msg: Omit<WorkerToHostMessage, "id"> & { kind: "service.invoke" | "runtime.invoke" }): Promise<unknown> {
	const id = nextRequestId++;
	return new Promise<unknown>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ ...msg, id } as WorkerToHostMessage);
	});
}

function makeRuntime(runtimeToken: string): CarrotRuntime {
	const serviceProxy = (name: string) =>
		new Proxy({}, {
			get(_, method: string) {
				return (...args: unknown[]) => rpc({ kind: "service.invoke", service: name, method, args } as never);
			},
		});
	return {
		service: ((name: string) => serviceProxy(name)) as CarrotRuntime["service"],
		useModel: (modelType, params) => rpc({ kind: "runtime.invoke", runtimeToken, method: "useModel", args: [modelType, params] } as never),
		getSetting: (key) => rpc({ kind: "runtime.invoke", runtimeToken, method: "getSetting", args: [key] } as never),
		composeState: (message, includeList, onlyInclude) => rpc({ kind: "runtime.invoke", runtimeToken, method: "composeState", args: [message, includeList, onlyInclude] } as never),
	};
}

function makeCallback(callbackId: string | null): CarrotHandlerCallback | undefined {
	if (!callbackId) return undefined;
	return async (payload) => {
		send({ kind: "callback.emit", callbackId, text: payload.text, action: payload.action });
	};
}

export function defineCarrot(definition: CarrotDefinition): void {
	const actionMap = new Map<string, CarrotAction>();
	for (const a of definition.plugin.actions ?? []) actionMap.set(a.name, a);
	const providerMap = new Map<string, CarrotProvider>();
	for (const p of definition.plugin.providers ?? []) providerMap.set(p.name, p);

	const pluginManifest: CarrotPluginManifest = {
		name: definition.plugin.name,
		description: definition.plugin.description,
		actions: (definition.plugin.actions ?? []).map<CarrotActionDescriptor>((a) => ({
			name: a.name,
			description: a.description,
			similes: a.similes,
			parameters: a.parameters,
		})),
		providers: (definition.plugin.providers ?? []).map<CarrotProviderDescriptor>((p) => ({
			name: p.name,
			description: p.description,
		})),
		services: [],
	};

	self.onmessage = (ev) => {
		const msg = ev.data;
		void handle(msg);
	};

	async function handle(msg: HostToWorkerMessage): Promise<void> {
		switch (msg.kind) {
			case "init":
				send({ kind: "ready", plugin: pluginManifest });
				return;
			case "action.invoke":
				return invokeAction(msg);
			case "provider.get":
				return invokeProvider(msg);
			case "service.invoke.response":
			case "runtime.invoke.response": {
				const p = pending.get(msg.id);
				if (!p) return;
				pending.delete(msg.id);
				if (msg.success) p.resolve(msg.result);
				else p.reject(new Error(msg.error ?? "RPC failed"));
				return;
			}
		}
	}

	async function invokeAction(msg: Extract<HostToWorkerMessage, { kind: "action.invoke" }>): Promise<void> {
		const action = actionMap.get(msg.actionName);
		if (!action) {
			send({ kind: "action.invoke.response", id: msg.id, success: false, error: `unknown action ${msg.actionName}` });
			return;
		}
		try {
			const rt = makeRuntime(msg.args.runtimeToken);
			const cb = makeCallback(msg.args.callbackId);
			const result = await action.handler(rt, msg.args.message, msg.args.state, msg.args.options, cb);
			send({ kind: "action.invoke.response", id: msg.id, success: true, result });
		} catch (err) {
			send({ kind: "action.invoke.response", id: msg.id, success: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	async function invokeProvider(msg: Extract<HostToWorkerMessage, { kind: "provider.get" }>): Promise<void> {
		const provider = providerMap.get(msg.providerName);
		if (!provider) {
			send({ kind: "provider.get.response", id: msg.id, success: false, error: `unknown provider ${msg.providerName}` });
			return;
		}
		try {
			const rt = makeRuntime(msg.args.runtimeToken);
			const result = await provider.get(rt, msg.args.message, msg.args.state);
			send({ kind: "provider.get.response", id: msg.id, success: true, result });
		} catch (err) {
			send({ kind: "provider.get.response", id: msg.id, success: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
}

export function log(level: "info" | "warn" | "error", message: string): void {
	send({ kind: "log", level, message });
}
