import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderId } from "../../shared/index";
import type { WebClient } from "../api/client";

type Bubble = {
	id: string;
	role: "user" | "assistant" | "error";
	text: string;
	thinking?: boolean;
};

const CONV_ID = "web-default";

type SlashCommand = {
	name: string;
	usage: string;
	description: string;
	insert: string;
	aliases?: string[];
};

const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "/browser", usage: "/browser <url or search>", description: "Open the agent browser.", insert: "/browser ", aliases: ["/open", "/web", "/internet"] },
	{ name: "/inspect", usage: "/inspect", description: "Read the active browser tab.", insert: "/inspect", aliases: ["/read-page"] },
	{ name: "/script", usage: "/script <javascript>", description: "Run JavaScript in the browser tab.", insert: "/script ", aliases: ["/js"] },
	{ name: "/logins", usage: "/logins [domain]", description: "List saved logins from vault backends.", insert: "/logins ", aliases: ["/passwords"] },
	{ name: "/login", usage: "/login <source> <identifier> [url]", description: "Fill a saved login in the browser.", insert: "/login 1password " },
	{ name: "/1password", usage: "/1password <identifier> [url]", description: "Fill a 1Password login in the browser.", insert: "/1password ", aliases: ["/op"] },
	{ name: "/pet", usage: "/pet [name]", description: "List or inspect Codex pets.", insert: "/pet " },
	{ name: "/hatch", usage: "/hatch <concept>", description: "Prepare a Codex pet hatch run.", insert: "/hatch " },
	{ name: "/help", usage: "/help", description: "Show native chat commands.", insert: "/help" },
];

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
	const [draft, setDraft] = useState("");
	const [slashIndex, setSlashIndex] = useState(0);
	const assistantId = useRef<string | null>(null);
	const bottomRef = useRef<HTMLDivElement>(null);

	const slashMatches = useMemo(() => {
		if (!draft.startsWith("/")) return [];
		const needle = draft.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
		return SLASH_COMMANDS.filter((command) => {
			const names = [command.name, ...(command.aliases ?? [])];
			return names.some((name) => name.slice(1).startsWith(needle));
		});
	}, [draft]);
	const slashOpen = Boolean(activeProvider && !pending && draft.startsWith("/") && slashMatches.length > 0);

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

	useEffect(() => {
		setSlashIndex(0);
	}, [slashMatches.length]);

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

	function insertSlash(command: SlashCommand) {
		setDraft(command.insert);
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
				{slashOpen && (
					<div className="slash-menu">
						{slashMatches.map((command, index) => (
							<button
								key={command.name}
								type="button"
								className={`slash-command${index === slashIndex ? " active" : ""}`}
								onMouseDown={(e) => {
									e.preventDefault();
									insertSlash(command);
								}}
							>
								<span className="slash-command-name">{command.usage}</span>
								<span className="slash-command-description">{command.description}</span>
							</button>
						))}
					</div>
				)}
				<textarea
					placeholder={activeProvider ? "Message Detour…" : "Configure a provider in Configuration to start"}
					disabled={!activeProvider || pending}
					value={draft}
					rows={1}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (slashOpen && e.key === "ArrowDown") {
							e.preventDefault();
							setSlashIndex((index) => (index + 1) % slashMatches.length);
							return;
						}
						if (slashOpen && e.key === "ArrowUp") {
							e.preventDefault();
							setSlashIndex((index) => (index + slashMatches.length - 1) % slashMatches.length);
							return;
						}
						if (slashOpen && e.key === "Tab") {
							e.preventDefault();
							insertSlash(slashMatches[slashIndex] ?? slashMatches[0]);
							return;
						}
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							if (slashOpen && draft.trim() === "/") {
								insertSlash(slashMatches[slashIndex] ?? slashMatches[0]);
								return;
							}
							const text = draft;
							setDraft("");
							send(text);
						}
					}}
				/>
			</div>
		</div>
	);
}
