/**
 * Carrot bridge — public API consumed by RuntimeService.
 *
 *   const cm = new CarrotManager();
 *   cm.registerService("cron", cronServiceHandle);
 *   const plugins = await cm.loadFromDir("/path/to/carrots/cron-tools");
 *   // returns eliza Plugins ready to register with AgentRuntime
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CarrotHost, loadManifestSync } from "./host-loader";
import type { CallbackRegistry, RuntimeRegistry, RuntimeProxyTarget, ServiceHandle } from "./host-loader";
import { carrotToPlugin } from "./plugin-adapter";
import type { Plugin } from "@elizaos/core";

type HandlerCallback = ((p: { text: string; action: string }) => Promise<void> | void) | undefined;

class InMemoryCallbackRegistry implements CallbackRegistry {
	private map = new Map<string, HandlerCallback>();
	register(cb: HandlerCallback): string | null {
		if (!cb) return null;
		const id = randomUUID();
		this.map.set(id, cb);
		return id;
	}
	async emit(callbackId: string, text: string, action: string): Promise<void> {
		const cb = this.map.get(callbackId);
		if (!cb) return;
		await cb({ text, action });
	}
	release(callbackId: string): void {
		this.map.delete(callbackId);
	}
}

class InMemoryRuntimeRegistry implements RuntimeRegistry {
	private map = new Map<string, RuntimeProxyTarget>();
	register(target: RuntimeProxyTarget): string {
		const id = randomUUID();
		this.map.set(id, target);
		return id;
	}
	get(token: string): RuntimeProxyTarget | null {
		return this.map.get(token) ?? null;
	}
	release(token: string): void {
		this.map.delete(token);
	}
}

export class CarrotManager {
	private services = new Map<string, ServiceHandle>();
	private hosts = new Map<string, CarrotHost>();
	private callbacks = new InMemoryCallbackRegistry();
	private runtimes = new InMemoryRuntimeRegistry();

	registerService(name: string, handle: ServiceHandle): void {
		this.services.set(name, handle);
	}

	async loadFromDir(carrotDir: string): Promise<Plugin> {
		if (!existsSync(carrotDir)) throw new Error(`carrot dir not found: ${carrotDir}`);
		const manifest = loadManifestSync(carrotDir);
		if (this.hosts.has(manifest.id)) throw new Error(`carrot ${manifest.id} already loaded`);
		const host = new CarrotHost(manifest, carrotDir, this.services, this.callbacks, this.runtimes);
		await host.load();
		this.hosts.set(manifest.id, host);
		return carrotToPlugin(host);
	}

	stopAll(): void {
		for (const host of this.hosts.values()) host.stop();
		this.hosts.clear();
	}

	loaded(): string[] {
		return [...this.hosts.keys()];
	}
}
