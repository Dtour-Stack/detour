import type { CoreHandle } from "../core/index";
import { registerWindow } from "../core/rpc/registry";
import { EventBus, type KernelEvents } from "./events";
import { TrayController } from "./tray";
import { WindowFactory } from "./windows";
import {
	WINDOW_OPEN_MESSAGE,
	WINDOW_OPEN_KERNEL_EVENT,
} from "../../shared/window-targets";
import type { WindowOpenTarget } from "../../shared/index";

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

	// Bridge typed-RPC `uiOpen*` broadcasts onto the kernel event bus so opens
	// that originate outside an already-open hub (tray popover, detour:// URL,
	// an agent broadcasting `uiOpenBrowser`) still reach the feature that owns
	// the window/hub. Derived from the shared WINDOW_OPEN_* maps so it can't
	// drift from the target set (the prior hardcoded if-chain had silently
	// missed pensieve/activity). `browserCommand` is view-only and ignored here.
	// Every WINDOW_OPEN_KERNEL_EVENT value is a `ui:open-*` event, all of which
	// carry an empty payload — narrow to that subset so emit accepts `{}`.
	type OpenEvent = Extract<keyof KernelEvents, `ui:open-${string}`>;
	const BROADCAST_TO_KERNEL_EVENT = new Map<string, OpenEvent>(
		(Object.entries(WINDOW_OPEN_KERNEL_EVENT) as Array<[WindowOpenTarget, string]>).map(
			([target, event]) => [WINDOW_OPEN_MESSAGE[target], event as OpenEvent],
		),
	);
	registerWindow((name) => {
		const event = BROADCAST_TO_KERNEL_EVENT.get(name);
		if (event) events.emit(event, {});
	});

	// Tray status poller — surfaces "● Detour: Codex + local embeds" at the
	// top of the menu so the user sees lifecycle state without opening
	// Settings. Polls every 4 seconds; setStatus no-ops when the text
	// hasn't changed.
	//
	// Reads directly from in-process services (no HTTP fetch). User can
	// flip between terse (`● Claude`) and verbose (`● Detour: Claude +
	// local embeds`) modes in Settings → Tray.
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
			let labelMode: "terse" | "verbose" = "verbose";
			try {
				const prefs = await opts.core.rpcDeps.config.getTrayPrefs();
				labelMode = prefs.statusLabelMode;
			} catch {
				/* keep verbose */
			}
			let label: string;
			if (labelMode === "terse") {
				if (active) label = `● ${providerLabel}`;
				else if (llama.running) label = `○ no LLM`;
				else label = "○ starting…";
			} else if (active && llama.running) {
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
