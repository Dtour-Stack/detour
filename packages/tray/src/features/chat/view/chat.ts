type ChatRpc = {
	request: {
		sendMessage: (params: { text: string; convId: string }) => Promise<{ ok: true }>;
		hideWindow: () => Promise<{ ok: true }>;
	};
};

type Bubble = {
	id: string;
	role: "user" | "assistant" | "error";
	text: string;
	thinking?: boolean;
};

const CONV_ID = "default";

let bubbles: Bubble[] = [];
let bubblesEl: HTMLDivElement | null = null;
let composerEl: HTMLTextAreaElement | null = null;
let rpc: ChatRpc | null = null;
let assistantBubbleId: string | null = null;
let activeProvider: string | null = null;

export function setProviderActive(provider: string | null) {
	activeProvider = provider;
	if (composerEl) {
		composerEl.disabled = !activeProvider;
		composerEl.placeholder = activeProvider
			? `Message Detour…`
			: "Add an API key in Settings to start chatting";
	}
}

function uid() {
	return Math.random().toString(36).slice(2, 10);
}

function renderBubbles() {
	if (!bubblesEl) return;
	bubblesEl.innerHTML = "";
	for (const b of bubbles) {
		const el = document.createElement("div");
		el.className = `bubble ${b.role}${b.thinking ? " thinking" : ""}`;
		el.textContent = b.text;
		el.dataset.id = b.id;
		bubblesEl.appendChild(el);
	}
	bubblesEl.scrollTop = bubblesEl.scrollHeight;
}

async function send(text: string) {
	if (!rpc) return;
	if (!activeProvider) {
		appendError("No provider configured. Open Settings to add an API key.");
		return;
	}
	const trimmed = text.trim();
	if (!trimmed) return;
	bubbles.push({ id: uid(), role: "user", text: trimmed });
	const aid = uid();
	assistantBubbleId = aid;
	bubbles.push({ id: aid, role: "assistant", text: "", thinking: true });
	renderBubbles();

	try {
		await rpc.request.sendMessage({ text: trimmed, convId: CONV_ID });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		appendError(msg);
	}
}

export function appendDelta(convId: string, delta: string) {
	if (convId !== CONV_ID || !assistantBubbleId) return;
	const b = bubbles.find((x) => x.id === assistantBubbleId);
	if (!b) return;
	if (b.thinking) {
		b.thinking = false;
		b.text = "";
	}
	b.text += delta;
	renderBubbles();
}

export function completeMessage(convId: string) {
	if (convId !== CONV_ID) return;
	const b = bubbles.find((x) => x.id === assistantBubbleId);
	if (b?.thinking) {
		// Got messageComplete with no tokens — treat as empty reply.
		b.thinking = false;
		b.text = "(no response)";
	}
	assistantBubbleId = null;
	renderBubbles();
}

export function appendError(message: string) {
	if (assistantBubbleId) {
		const b = bubbles.find((x) => x.id === assistantBubbleId);
		if (b) {
			bubbles = bubbles.filter((x) => x.id !== assistantBubbleId);
		}
		assistantBubbleId = null;
	}
	bubbles.push({ id: uid(), role: "error", text: message });
	renderBubbles();
}

export function mountChat(root: HTMLElement, rpcInstance: ChatRpc) {
	rpc = rpcInstance;
	root.innerHTML = `
		<div class="chat">
			<div class="bubbles" id="bubbles"></div>
			<div class="composer">
				<textarea id="composer" placeholder="Message Detour…" rows="1"></textarea>
			</div>
		</div>
	`;
	bubblesEl = root.querySelector<HTMLDivElement>("#bubbles");
	composerEl = root.querySelector<HTMLTextAreaElement>("#composer");

	composerEl?.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			const text = composerEl!.value;
			composerEl!.value = "";
			void send(text);
		}
		if (e.key === "Escape") {
			void rpc?.request.hideWindow();
		}
	});

	composerEl?.addEventListener("input", () => {
		if (!composerEl) return;
		composerEl.style.height = "auto";
		composerEl.style.height = `${Math.min(composerEl.scrollHeight, 120)}px`;
	});

	renderBubbles();
	composerEl?.focus();
}
