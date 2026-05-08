/**
 * CarrotHost — owns the lifecycle of a single loaded carrot.
 *
 *   load()    spawn Bun Worker, send init, wait for `ready` (which carries
 *             the carrot's plugin manifest)
 *   pluginManifest()  what the carrot declared — used by the Plugin adapter
 *   invokeAction(name, args)   route an eliza handler call to the worker
 *   stop()    terminate the worker
 *
 * Wire protocol: see ./types.ts. Service registry: see ./service-registry.ts.
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type {
	CarrotManifest,
	CarrotPluginManifest,
	HostToWorkerMessage,
	WorkerToHostMessage,
} from "./types";
import { isMethodAllowed, permissionForService } from "./service-registry";

const HOST_MESSAGE_TIMEOUT_MS = 30_000;

export type ServiceHandle = Record<string, (...args: unknown[]) => unknown>;

export interface RuntimeProxyTarget {
	useModel?: (...args: unknown[]) => unknown;
	getSetting?: (...args: unknown[]) => unknown;
	composeState?: (...args: unknown[]) => unknown;
}

/**
 * Resolves a callbackId back to a live HandlerCallback. The host owns the
 * mapping and tears entries down when an action finishes.
 */
export interface CallbackRegistry {
	register(cb: ((payload: { text: string; action: string }) => Promise<void> | void) | undefined): string | null;
	emit(callbackId: string, text: string, action: string): Promise<void>;
	release(callbackId: string): void;
}

export interface RuntimeRegistry {
	register(target: RuntimeProxyTarget): string;
	get(token: string): RuntimeProxyTarget | null;
	release(token: string): void;
}

export class CarrotHost {
	private worker: Worker | null = null;
	private nextRequestId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (err: Error) => void; timer: Timer }>();
	private plugin: CarrotPluginManifest | null = null;
	private readyPromise: Promise<CarrotPluginManifest> | null = null;
	private readyResolve: ((manifest: CarrotPluginManifest) => void) | null = null;
	private readyReject: ((err: Error) => void) | null = null;

	constructor(
		readonly manifest: CarrotManifest,
		readonly carrotDir: string,
		private readonly services: Map<string, ServiceHandle>,
		private readonly callbacks: CallbackRegistry,
		private readonly runtimes: RuntimeRegistry,
	) {}

	pluginManifest(): CarrotPluginManifest | null {
		return this.plugin;
	}

	async load(): Promise<CarrotPluginManifest> {
		if (this.worker) throw new Error(`carrot ${this.manifest.id} already loaded`);
		const workerPath = isAbsolute(this.manifest.worker.relativePath)
			? this.manifest.worker.relativePath
			: resolvePath(this.carrotDir, this.manifest.worker.relativePath);
		try { statSync(workerPath); }
		catch { throw new Error(`carrot ${this.manifest.id}: worker file not found at ${workerPath}`); }

		const statePath = carrotStatePath(this.manifest.id);
		mkdirSync(dirname(statePath), { recursive: true });

		this.readyPromise = new Promise((res, rej) => {
			this.readyResolve = res;
			this.readyReject = rej;
			setTimeout(() => rej(new Error(`carrot ${this.manifest.id} did not signal ready within ${HOST_MESSAGE_TIMEOUT_MS}ms`)), HOST_MESSAGE_TIMEOUT_MS);
		});

		// Bun supports `permissions` on Worker but @types/bun doesn't surface
		// the option, so we cast through unknown.
		const workerOpts: WorkerOptions = { type: "module" };
		if (this.manifest.bunPermissions) {
			(workerOpts as unknown as Record<string, unknown>).permissions = this.manifest.bunPermissions;
		}
		this.worker = new Worker(workerPath, workerOpts);
		this.worker.onmessage = (event: MessageEvent<WorkerToHostMessage>) => {
			void this.handleWorkerMessage(event.data);
		};
		this.worker.onerror = (event: ErrorEvent) => {
			const err = new Error(`carrot ${this.manifest.id} worker error: ${event.message}`);
			this.readyReject?.(err);
			for (const [, p] of this.pending) p.reject(err);
			this.pending.clear();
		};

		this.send({
			kind: "init",
			manifest: this.manifest,
			carrotDir: this.carrotDir,
			statePath,
		});

		return this.readyPromise;
	}

	stop(): void {
		this.worker?.terminate();
		this.worker = null;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error(`carrot ${this.manifest.id} stopped`));
		}
		this.pending.clear();
	}

	async invokeAction(actionName: string, runtimeTarget: RuntimeProxyTarget, message: unknown, state: unknown, options: unknown, callback: ((p: { text: string; action: string }) => Promise<void> | void) | undefined): Promise<unknown> {
		const runtimeToken = this.runtimes.register(runtimeTarget);
		const callbackId = this.callbacks.register(callback);
		const t0 = Date.now();
		console.log(`[carrot:${this.manifest.id}] action.invoke ${actionName}`);
		try {
			const result = await this.request("action.invoke", {
				actionName,
				args: { runtimeToken, message, state, options, callbackId },
			});
			console.log(`[carrot:${this.manifest.id}] action.invoke ${actionName} → ${Date.now() - t0}ms`);
			return result;
		} finally {
			this.runtimes.release(runtimeToken);
			if (callbackId) this.callbacks.release(callbackId);
		}
	}

	async invokeProvider(providerName: string, runtimeTarget: RuntimeProxyTarget, message: unknown, state: unknown): Promise<unknown> {
		const runtimeToken = this.runtimes.register(runtimeTarget);
		try {
			return await this.request("provider.get", {
				providerName,
				args: { runtimeToken, message, state },
			});
		} finally {
			this.runtimes.release(runtimeToken);
		}
	}

	private send(msg: HostToWorkerMessage): void {
		if (!this.worker) throw new Error(`carrot ${this.manifest.id} not running`);
		this.worker.postMessage(msg);
	}

	private async request(kind: "action.invoke" | "provider.get", payload: Record<string, unknown>): Promise<unknown> {
		const id = this.nextRequestId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`carrot ${this.manifest.id} ${kind} timed out`));
			}, HOST_MESSAGE_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ kind, id, ...payload } as HostToWorkerMessage);
		});
	}

	private async handleWorkerMessage(msg: WorkerToHostMessage): Promise<void> {
		switch (msg.kind) {
			case "ready":
				this.plugin = msg.plugin;
				this.readyResolve?.(msg.plugin);
				return;
			case "log":
				console[msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "log"](`[carrot:${this.manifest.id}] ${msg.message}`);
				return;
			case "action.invoke.response":
			case "provider.get.response": {
				const pending = this.pending.get(msg.id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(msg.id);
				if (msg.success) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "carrot action failed"));
				return;
			}
			case "service.invoke":
				return this.handleServiceInvoke(msg.id, msg.service, msg.method, msg.args);
			case "runtime.invoke":
				return this.handleRuntimeInvoke(msg.id, msg.runtimeToken, msg.method, msg.args);
			case "callback.emit":
				return this.callbacks.emit(msg.callbackId, msg.text, msg.action);
		}
	}

	private async handleServiceInvoke(id: number, service: string, method: string, args: unknown[]): Promise<void> {
		const perm = permissionForService(service);
		if (!perm) return this.respondServiceInvoke(id, false, undefined, `unknown service '${service}'`);
		if (!this.manifest.permissions.includes(perm)) return this.respondServiceInvoke(id, false, undefined, `carrot ${this.manifest.id} did not request ${perm}`);
		if (!isMethodAllowed(service, method)) return this.respondServiceInvoke(id, false, undefined, `method '${method}' not allowed on service '${service}'`);
		const handle = this.services.get(service);
		if (!handle) return this.respondServiceInvoke(id, false, undefined, `service '${service}' not registered with host`);
		const fn = handle[method];
		if (typeof fn !== "function") return this.respondServiceInvoke(id, false, undefined, `service '${service}' has no method '${method}'`);
		try {
			const result = await Promise.resolve(fn.apply(handle, args));
			console.log(`[carrot:${this.manifest.id}] service.invoke ${service}.${method}() → ok`);
			this.respondServiceInvoke(id, true, result);
		} catch (err) {
			console.log(`[carrot:${this.manifest.id}] service.invoke ${service}.${method}() → error: ${err instanceof Error ? err.message : String(err)}`);
			this.respondServiceInvoke(id, false, undefined, err instanceof Error ? err.message : String(err));
		}
	}

	private respondServiceInvoke(id: number, success: boolean, result?: unknown, error?: string): void {
		this.send({ kind: "service.invoke.response", id, success, ...(error ? { error } : {}), ...(result !== undefined ? { result } : {}) } as HostToWorkerMessage);
	}

	private async handleRuntimeInvoke(id: number, token: string, method: string, args: unknown[]): Promise<void> {
		const target = this.runtimes.get(token);
		if (!target) return this.respondRuntimeInvoke(id, false, undefined, `runtime token '${token}' expired`);
		const fn = (target as Record<string, unknown>)[method];
		if (typeof fn !== "function") return this.respondRuntimeInvoke(id, false, undefined, `runtime has no method '${method}'`);
		try {
			const result = await Promise.resolve((fn as (...a: unknown[]) => unknown).apply(target, args));
			this.respondRuntimeInvoke(id, true, result);
		} catch (err) {
			this.respondRuntimeInvoke(id, false, undefined, err instanceof Error ? err.message : String(err));
		}
	}

	private respondRuntimeInvoke(id: number, success: boolean, result?: unknown, error?: string): void {
		this.send({ kind: "runtime.invoke.response", id, success, ...(error ? { error } : {}), ...(result !== undefined ? { result } : {}) } as HostToWorkerMessage);
	}
}

function carrotStatePath(carrotId: string): string {
	const stateRoot = process.env.ELIZA_STATE_DIR?.trim() || join(homedir(), ".detour");
	return join(stateRoot, "carrots", carrotId, "state.json");
}

export function loadManifestSync(carrotDir: string): CarrotManifest {
	const manifestPath = join(carrotDir, "carrot.json");
	const raw = readFileSync(manifestPath, "utf8");
	const parsed = JSON.parse(raw) as CarrotManifest;
	if (!parsed.id || !parsed.worker?.relativePath) {
		throw new Error(`carrot.json at ${manifestPath} missing required fields (id, worker.relativePath)`);
	}
	return parsed;
}
