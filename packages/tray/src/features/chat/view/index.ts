import Electrobun, { Electroview } from "electrobun/view";
import type { ChatRPC } from "../bun/rpc-schema";
import {
	appendDelta,
	appendError,
	completeMessage,
	mountChat,
	setProviderActive,
} from "./chat";

const rpc = Electroview.defineRPC<ChatRPC>({
	maxRequestTime: 60_000,
	handlers: {
		requests: {},
		messages: {
			tokenDelta: ({ convId, delta }) => appendDelta(convId, delta),
			messageComplete: ({ convId }) => completeMessage(convId),
			error: ({ message }) => appendError(message),
			providerChanged: ({ activeProvider }) => setProviderActive(activeProvider),
		},
	},
});

new Electrobun.Electroview({ rpc });

const root = document.getElementById("root") as HTMLDivElement;
const r = (rpc as any).request as {
	hideWindow: () => Promise<{ ok: true }>;
	openSettings: () => Promise<{ ok: true }>;
	isReady: () => Promise<{ ready: boolean; activeProvider: string | null }>;
	sendMessage: (p: { text: string; convId: string }) => Promise<{ ok: true }>;
};

function renderShell() {
	root.innerHTML = `
		<div class="titlebar electrobun-webkit-app-region-drag">
			<h1>Detour</h1>
			<div class="titlebar-actions electrobun-webkit-app-region-no-drag">
				<button class="icon-btn" data-action="settings" title="Settings">⚙</button>
				<button class="icon-btn" data-action="close" title="Hide (Esc)">✕</button>
			</div>
		</div>
		<div id="view"></div>
	`;
	root.querySelector<HTMLButtonElement>('[data-action="settings"]')?.addEventListener(
		"click",
		() => void r.openSettings(),
	);
	root.querySelector<HTMLButtonElement>('[data-action="close"]')?.addEventListener(
		"click",
		() => void r.hideWindow(),
	);
	const view = root.querySelector<HTMLDivElement>("#view")!;
	view.style.flex = "1";
	view.style.display = "flex";
	view.style.flexDirection = "column";
	view.style.minHeight = "0";
	mountChat(view, rpc as any);
}

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") void r.hideWindow();
});

async function boot() {
	renderShell();
	try {
		const ready = await r.isReady();
		setProviderActive(ready.activeProvider);
		if (!ready.activeProvider) {
			// No key yet — push the user to settings.
			void r.openSettings();
		}
	} catch {
		// stay in chat shell
	}
}

void boot();
