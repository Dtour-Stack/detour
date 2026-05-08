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
		} else if (msg.kind === "ui:open-chat") {
			events.emit("ui:open-chat", {});
		} else if (msg.kind === "ui:open-command-palette") {
			events.emit("ui:open-command-palette", {});
		} else if (msg.kind === "ui:toggle-command-palette") {
			events.emit("ui:toggle-command-palette", {});
		} else if (msg.kind === "ui:close-command-palette") {
			events.emit("ui:close-command-palette", {});
		} else if (msg.kind === "ui:open-settings") {
			events.emit("ui:open-settings", {});
		} else if (msg.kind === "ui:open-pensieve") {
			events.emit("ui:open-pensieve", {});
		} else if (msg.kind === "ui:open-activity") {
			events.emit("ui:open-activity", {});
		} else if (msg.kind === "ui:open-channels") {
			events.emit("ui:open-channels", {});
		} else if (msg.kind === "ui:open-agents") {
			events.emit("ui:open-agents", {});
		} else if (msg.kind === "ui:open-pet") {
			events.emit("ui:open-pet", {});
		} else if (msg.kind === "ui:pet-window-drag") {
			events.emit("ui:pet-window-drag", { dx: msg.dx, dy: msg.dy });
		} else if (msg.kind === "ui:open-browser" || msg.kind === "browser:command") {
			events.emit("ui:open-browser", {});
		}
	});

	// Tray status poller — surfaces "● Agent ready (Codex + local embeds)"
	// at the top of the menu so the user sees lifecycle state without
	// opening Settings. Polls every 4 seconds; calls setStatus(text) which
	// no-ops when the text hasn't changed.
	const baseUrl = `http://127.0.0.1:${opts.core.port}`;
	const refreshTrayStatus = async (): Promise<void> => {
		try {
			const [providers, llama] = await Promise.all([
				fetch(`${baseUrl}/api/providers`).then((r) => r.json() as Promise<Array<{ id: string; active?: boolean }>>),
				fetch(`${baseUrl}/api/llama/status`).then((r) => r.json() as Promise<{ running?: boolean; downloadProgress?: { percent?: number } | null; lastError?: string | null }>),
			]);
			const active = providers.find((p) => p.active)?.id ?? null;
			const providerLabel = active === "openai" ? "Codex" : active === "anthropic" ? "Claude" : null;
			const dl = llama.downloadProgress;
			let llamaLabel: string;
			if (dl && (dl.percent ?? 0) < 100) {
				llamaLabel = `embed model ${dl.percent}%`;
			} else if (llama.running) {
				llamaLabel = "local embeds";
			} else if (llama.lastError) {
				llamaLabel = "embed error";
			} else {
				llamaLabel = "embeds starting";
			}
			let label: string;
			if (active && llama.running) {
				label = `● Detour: ${providerLabel} + ${llamaLabel}`;
			} else if (active) {
				label = `● Detour: ${providerLabel} (${llamaLabel})`;
			} else if (llama.running) {
				label = `○ Detour: no LLM provider (${llamaLabel})`;
			} else {
				label = "○ Detour: starting…";
			}
			tray.setStatus(label);
		} catch {
			tray.setStatus("✕ Detour: not reachable");
		}
	};
	void refreshTrayStatus();
	const statusTimer = setInterval(() => void refreshTrayStatus(), 4_000);
	(statusTimer as unknown as { unref?: () => void }).unref?.();

	return { api: opts.api, core: opts.core, windows, tray, events };
}
