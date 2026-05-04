import type { CoreHandle } from "@detour/core";
import { ApiClient } from "./api-client";
import { EventBus, type KernelEvents } from "./events";
import { TrayController } from "./tray";
import { WindowFactory } from "./windows";

export type KernelDeps = {
	api: ApiClient;
	core: CoreHandle;
	windows: WindowFactory;
	tray: TrayController;
	events: EventBus<KernelEvents>;
};

export function createKernel(opts: {
	trayTitle: string;
	core: CoreHandle;
	api: ApiClient;
}): KernelDeps {
	const events = new EventBus<KernelEvents>();
	const windows = new WindowFactory();
	const tray = new TrayController({ title: opts.trayTitle });

	// Bridge WS server-push messages onto the kernel event bus
	opts.api.on((msg) => {
		if (msg.kind === "provider:changed") {
			events.emit("provider:changed", { activeProvider: msg.activeProvider });
		}
	});

	return { api: opts.api, core: opts.core, windows, tray, events };
}
