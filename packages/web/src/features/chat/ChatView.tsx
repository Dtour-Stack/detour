import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatCommandInfo, ProviderId } from "@detour/shared";
import type { WebClient } from "../../api/client";

type Bubble = {
	id: string;
	role: "user" | "assistant" | "error";
	text: string;
	thinking?: boolean;
};

const CONV_ID = "web-default";

const FALLBACK_SLASH_COMMANDS: ChatCommandInfo[] = [
	{ name: "/browser", usage: "/browser <url or search>", description: "Open the agent browser.", insert: "/browser ", aliases: ["/open", "/web", "/internet"] },
	{ name: "/inspect", usage: "/inspect", description: "Read the active browser tab.", insert: "/inspect", aliases: ["/read-page"] },
	{ name: "/script", usage: "/script <javascript>", description: "Run JavaScript in the browser tab.", insert: "/script ", aliases: ["/js"] },
	{ name: "/logins", usage: "/logins [domain]", description: "List saved logins from vault backends.", insert: "/logins ", aliases: ["/passwords"] },
	{ name: "/login", usage: "/login <source> <identifier> [url]", description: "Fill a saved login in the browser.", insert: "/login 1password " },
	{ name: "/1password", usage: "/1password <identifier> [url]", description: "Fill a 1Password login in the browser.", insert: "/1password ", aliases: ["/op"] },
	{ name: "/pet", usage: "/pet [name]", description: "List or inspect Codex pets.", insert: "/pet " },
	{ name: "/hatch", usage: "/hatch <concept>", description: "Prepare a Codex pet hatch run.", insert: "/hatch " },
	{ name: "/codex", usage: "/codex [cwd=/path] <task>", description: "Run a Codex coding subagent and wait for the result.", insert: "/codex " },
	{ name: "/claude", usage: "/claude [cwd=/path] <task>", description: "Run a Claude coding subagent and wait for the result.", insert: "/claude " },
	{ name: "/spawn-codex", usage: "/spawn-codex [cwd=/path] <task>", description: "Start a Codex coding subagent in the background.", insert: "/spawn-codex " },
	{ name: "/spawn-claude", usage: "/spawn-claude [cwd=/path] <task>", description: "Start a Claude coding subagent in the background.", insert: "/spawn-claude " },
	{ name: "/task", usage: "/task [cwd=/path] <task>", description: "Alias for a Codex coding subagent.", insert: "/task " },
	{ name: "/help", usage: "/help", description: "Show native chat commands.", insert: "/help" },
].map((command) => ({ ...command, source: "native" as const }));

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
	const [slashCommands, setSlashCommands] = useState<ChatCommandInfo[]>(FALLBACK_SLASH_COMMANDS);
	const assistantId = useRef<string | null>(null);
	const bottomRef = useRef<HTMLDivElement>(null);

	const slashMatches = useMemo(() => {
		if (!draft.startsWith("/")) return [];
		const needle = draft.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
		return slashCommands.filter((command) => {
			const names = [command.name, ...(command.aliases ?? [])];
			return names.some((name) => name.slice(1).startsWith(needle));
		});
	}, [draft, slashCommands]);
	const slashOpen = Boolean(activeProvider && !pending && draft.startsWith("/") && slashMatches.length > 0);

	useEffect(() => {
		client
			.listProviders()
			.then((ps) => setActiveProvider(ps.find((p) => p.active)?.id ?? null));
		client
			.listChatCommands()
			.then((result) => setSlashCommands(result.commands.length > 0 ? result.commands : FALLBACK_SLASH_COMMANDS))
			.catch(() => setSlashCommands(FALLBACK_SLASH_COMMANDS));
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

	function stopMessage() {
		if (!pending) return;
		const stoppedId = assistantId.current;
		client.send({ kind: "chat:cancel", convId: CONV_ID });
		setBubbles((bs) =>
			bs.map((b) =>
				b.id === stoppedId && b.thinking
					? { ...b, thinking: false, text: b.text || "(stopped)" }
					: b,
			),
		);
		assistantId.current = null;
		setPending(false);
	}

	function insertSlash(command: ChatCommandInfo) {
		setDraft(command.insert);
	}

	function selectedSlash(): ChatCommandInfo | null {
		return slashMatches[slashIndex] ?? slashMatches[0] ?? null;
	}

	function shouldInsertSlash(command: ChatCommandInfo) {
		const trimmed = draft.trim();
		if (!/^\/\S*$/.test(trimmed)) return false;
		return trimmed !== command.name || command.insert !== command.name;
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
				<div className="composer-row">
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
							if (slashOpen && (e.key === "Tab" || e.key === "ArrowRight")) {
								e.preventDefault();
								const command = selectedSlash();
								if (command) insertSlash(command);
								return;
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								const command = slashOpen ? selectedSlash() : null;
								if (command && shouldInsertSlash(command)) {
									insertSlash(command);
									return;
								}
								const text = draft;
								setDraft("");
								send(text);
							}
						}}
					/>
					{pending && (
						<button
							type="button"
							className="btn small ghost composer-stop"
							onClick={stopMessage}
						>
							Stop
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
