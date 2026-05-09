import type { CoreHandle } from "../core/index";
import { registerWindow } from "../core/rpc/registry";
import { EventBus, type KernelEvents } from "./events";
import { TrayController } from "./tray";
import { WindowFactory } from "./windows";

export type KernelDeps = {
	core: CoreHandle;
	windows: WindowFactory;
	tray: TrayController;
	events: EventBus<KernelEvents>;
};

export function createKernel(opts: {
	trayTitle: string;
	core: CoreHandle;
}): KernelDeps {
	const events = new EventBus<KernelEvents>();
	const windows = new WindowFactory(opts.core.rpcDeps);
	const tray = new TrayController({ title: opts.trayTitle });

	// Bridge typed-RPC broadcasts onto the kernel event bus. The browser
	// RPC handler / vault-tools agent enqueue browser commands through the
	// `BROWSER_CONTROL_GLOBAL` symbol, which broadcasts `uiOpenBrowser`
	// via the rpc broadcaster. We register an in-process faux send fn so
	// the kernel can react alongside the real webview windows — this is
	// what triggers the browser window to open when an agent calls
	// `enqueueAndWait`. `browserCommand` is view-only and ignored here.
	registerWindow((name) => {
		if (name === "uiOpenBrowser") events.emit("ui:open-browser", {});
	});

	// Tray status poller — surfaces "● Agent ready (Codex + local embeds)"
	// at the top of the menu so the user sees lifecycle state without
	// opening Settings. Polls every 4 seconds; calls setStatus(text) which
	// no-ops when the text hasn't changed.
	//
	// Reads directly from in-process services (no HTTP fetch).
	const refreshTrayStatus = async (): Promise<void> => {
		try {
			const active = opts.core.runtime.getCurrentProvider();
			const llama = opts.core.rpcDeps.llama.status();
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

	return { core: opts.core, windows, tray, events };
}
