import { useEffect, useRef, useState } from "react";
import type { ProviderId } from "@detour/shared";
import type { WebClient } from "../../api/client";

type Bubble = {
	id: string;
	role: "user" | "assistant" | "error";
	text: string;
	thinking?: boolean;
};

const CONV_ID = "web-default";

function uid() {
	return Math.random().toString(36).slice(2, 10);
}

export function ChatView({
	client,
	onOpenSettings,
}: {
	client: WebClient;
	onOpenSettings: () => void;
}) {
	const [bubbles, setBubbles] = useState<Bubble[]>([]);
	const [activeProvider, setActiveProvider] = useState<ProviderId | null>(null);
	const [pending, setPending] = useState(false);
	const assistantId = useRef<string | null>(null);
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		client
			.listProviders()
			.then((ps) => setActiveProvider(ps.find((p) => p.active)?.id ?? null));
		const off = client.on((msg) => {
			if (msg.kind === "provider:changed") {
				setActiveProvider(msg.activeProvider);
			} else if (msg.kind === "chat:delta" && msg.convId === CONV_ID) {
				setBubbles((bs) =>
					bs.map((b) =>
						b.id === assistantId.current
							? { ...b, thinking: false, text: b.thinking ? msg.delta : b.text + msg.delta }
							: b,
					),
				);
			} else if (msg.kind === "chat:complete" && msg.convId === CONV_ID) {
				setBubbles((bs) =>
					bs.map((b) =>
						b.id === assistantId.current && b.thinking
							? { ...b, thinking: false, text: "(no response)" }
							: b,
					),
				);
				assistantId.current = null;
				setPending(false);
			} else if (msg.kind === "chat:error" && msg.convId === CONV_ID) {
				setBubbles((bs) => [
					...bs.filter((b) => b.id !== assistantId.current),
					{ id: uid(), role: "error", text: msg.message },
				]);
				assistantId.current = null;
				setPending(false);
			}
		});
		return off;
	}, [client]);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [bubbles]);

	function send(text: string) {
		if (!text.trim()) return;
		if (!activeProvider) return;
		const userBubble: Bubble = { id: uid(), role: "user", text: text.trim() };
		const aId = uid();
		assistantId.current = aId;
		setBubbles((bs) => [
			...bs,
			userBubble,
			{ id: aId, role: "assistant", text: "", thinking: true },
		]);
		setPending(true);
		client.send({ kind: "chat:send", convId: CONV_ID, text: text.trim() });
	}

	return (
		<div className="chat-shell">
			<div className="bubbles">
				{bubbles.length === 0 && !activeProvider && (
					<div className="bubble error">
						No active provider configured.{" "}
						<button
							type="button"
							className="btn"
							style={{ marginLeft: 12 }}
							onClick={onOpenSettings}
						>
							Open Settings
						</button>
					</div>
				)}
				{bubbles.map((b) => (
					<div key={b.id} className={`bubble ${b.role}${b.thinking ? " thinking" : ""}`}>
						{b.text}
					</div>
				))}
				<div ref={bottomRef} />
			</div>
			<div className="composer">
				<textarea
					placeholder={activeProvider ? "Message Eliza…" : "Configure a provider in Settings to start"}
					disabled={!activeProvider || pending}
					rows={1}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							const text = (e.target as HTMLTextAreaElement).value;
							(e.target as HTMLTextAreaElement).value = "";
							send(text);
						}
					}}
				/>
			</div>
		</div>
	);
}
