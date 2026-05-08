/**
 * Carrot bridge — wire protocol between Detour's bun core (host) and a
 * carrot worker. The host loads a carrot at runtime, spawns its `worker.ts`
 * in an isolated Bun Worker, and translates eliza Plugin lifecycle calls
 * (action handler invocations, provider get(), etc.) into RPC messages.
 *
 * The carrot author writes what looks like an eliza Plugin (actions/
 * providers/services). Their handler receives a *proxied* IAgentRuntime
 * whose method calls round-trip through the host. The host never knows
 * the Plugin it registered with the AgentRuntime is backed by a worker.
 */

// ── Manifest (carrot.json) ─────────────────────────────────────────────────

/**
 * Detour-specific permissions a carrot can request. These are layered on
 * top of Bun's worker permissions (read/write/env/run/ffi). The host gates
 * each one — a carrot that didn't ask for `service:cron` can't reach the
 * cron service even if it tries to invoke it.
 */
export type DetourCarrotPermission =
	| "service:cron"
	| "service:vault"
	| "service:pensieve"
	| "service:channels"
	| "service:llama"
	| "runtime:useModel"
	| "runtime:composeState";

export interface CarrotManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	/** Path within the carrot dir to the worker entrypoint (relative). */
	worker: { relativePath: string };
	/**
	 * Detour permissions this carrot needs. Granted at install/load time;
	 * host enforces by rejecting RPC calls for ungranted services.
	 */
	permissions: DetourCarrotPermission[];
	/**
	 * Bun Worker permissions. Defaults to fully sandboxed (no fs/env/run).
	 * Most carrots that only call host services don't need any of these.
	 * Shape matches Bun.WorkerPermissions but kept structural to avoid
	 * a hard typings dependency on @types/bun internals.
	 */
	bunPermissions?: {
		read?: boolean;
		write?: boolean;
		env?: boolean;
		run?: boolean;
		ffi?: boolean;
		addons?: boolean;
		worker?: boolean;
	};
}

// ── Plugin shape declared by a carrot ──────────────────────────────────────

/**
 * What a carrot declares about its eliza Plugin contributions, sent on
 * boot (`worker → host: ready`). The host uses this to build a real
 * eliza Plugin object whose handlers proxy back over RPC.
 *
 * We intentionally do NOT serialize the handler closures; only the
 * descriptive metadata. When eliza calls a handler, we look up the action
 * by name and route to the worker.
 */
export interface CarrotPluginManifest {
	name: string;
	description?: string;
	actions: CarrotActionDescriptor[];
	providers: CarrotProviderDescriptor[];
	services: CarrotServiceDescriptor[];
}

export interface CarrotActionDescriptor {
	name: string;
	similes?: string[];
	description: string;
	parameters?: Array<{
		name: string;
		description: string;
		required?: boolean;
		schema?: { type: "string" | "number" | "boolean" | "object" | "array" };
	}>;
}

export interface CarrotProviderDescriptor {
	name: string;
	description?: string;
}

export interface CarrotServiceDescriptor {
	name: string;
	/** Method names on the service that the host can call. */
	methods: string[];
}

// ── Wire protocol (host ⇄ worker) ──────────────────────────────────────────

/**
 * Every message has a `kind`. Requests carry an `id`; the corresponding
 * response carries the same `id`. One-way messages (events, init) have no id.
 */

// host → worker

export interface HostInitMessage {
	kind: "init";
	manifest: CarrotManifest;
	carrotDir: string;
	statePath: string;
}

export interface HostActionInvokeMessage {
	kind: "action.invoke";
	id: number;
	actionName: string;
	/** Serialized eliza handler args (runtime is replaced by an opaque token). */
	args: {
		runtimeToken: string;
		message: unknown;
		state: unknown;
		options: unknown;
		callbackId: string | null;
	};
}

export interface HostProviderGetMessage {
	kind: "provider.get";
	id: number;
	providerName: string;
	args: {
		runtimeToken: string;
		message: unknown;
		state: unknown;
	};
}

export interface HostServiceInvokeResponse {
	kind: "service.invoke.response";
	id: number;
	success: boolean;
	result?: unknown;
	error?: string;
}

export interface HostRuntimeInvokeResponse {
	kind: "runtime.invoke.response";
	id: number;
	success: boolean;
	result?: unknown;
	error?: string;
}

export type HostToWorkerMessage =
	| HostInitMessage
	| HostActionInvokeMessage
	| HostProviderGetMessage
	| HostServiceInvokeResponse
	| HostRuntimeInvokeResponse;

// worker → host

export interface WorkerReadyMessage {
	kind: "ready";
	plugin: CarrotPluginManifest;
}

export interface WorkerActionInvokeResponse {
	kind: "action.invoke.response";
	id: number;
	success: boolean;
	result?: unknown;
	error?: string;
}

export interface WorkerProviderGetResponse {
	kind: "provider.get.response";
	id: number;
	success: boolean;
	result?: unknown;
	error?: string;
}

/**
 * Worker calls a registered Detour service over RPC.
 * E.g. `service.invoke` { service: "cron", method: "createJob", args: [{...}] }
 */
export interface WorkerServiceInvokeMessage {
	kind: "service.invoke";
	id: number;
	service: string;
	method: string;
	args: unknown[];
}

/**
 * Worker calls a method on the proxied IAgentRuntime. Currently used for
 * `useModel`, `getSetting`, `composeState` etc. — anything the action
 * handler reaches into the runtime for.
 */
export interface WorkerRuntimeInvokeMessage {
	kind: "runtime.invoke";
	id: number;
	runtimeToken: string;
	method: string;
	args: unknown[];
}

/**
 * Worker fires the eliza handler `callback({text, action})`. The host
 * routes it to the live HandlerCallback by callbackId.
 */
export interface WorkerCallbackEmitMessage {
	kind: "callback.emit";
	callbackId: string;
	text: string;
	action: string;
}

export interface WorkerLogMessage {
	kind: "log";
	level: "info" | "warn" | "error";
	message: string;
}

export type WorkerToHostMessage =
	| WorkerReadyMessage
	| WorkerActionInvokeResponse
	| WorkerProviderGetResponse
	| WorkerServiceInvokeMessage
	| WorkerRuntimeInvokeMessage
	| WorkerCallbackEmitMessage
	| WorkerLogMessage;
