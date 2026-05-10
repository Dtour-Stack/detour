import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderId } from "../../shared/index";
import { rpc } from "../rpc";
import { onChatCommandRun, onChatComplete, onChatDelta, onChatError } from "../rpc-listeners/chat";
import { onProviderChanged } from "../rpc-listeners/providers";

type Bubble = {
	id: string;
	role: "user" | "assistant" | "error" | "media";
	text: string;
	thinking?: boolean;
	media?: { kind: "video"; url: string; contentType?: string };
	// `traceId` is the assistant turn's trajectory id (set on first
	// chatDelta after the bubble is created). When present, the
	// bubble renders thumbs feedback buttons.
	traceId?: string;
	rating?: 1 | -1;
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
	{ name: "/video", usage: "/video <prompt>", description: "Generate a video via ElizaOS Cloud (fal-ai/veo3).", insert: "/video " },
	{ name: "/help", usage: "/help", description: "Show native chat commands.", insert: "/help" },
];

function uid() {
	return Math.random().toString(36).slice(2, 10);
}

export function ChatView({
	onOpenSettings,
}: {
	onOpenSettings: () => void;
}) {
	const [bubbles, setBubbles] = useState<Bubble[]>([]);
	const [activeProvider, setActiveProvider] = useState<ProviderId | null>(null);
	const [pending, setPending] = useState(false);
	const [draft, setDraft] = useState("");
	const [slashIndex, setSlashIndex] = useState(0);
	const assistantId = useRef<string | null>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	// Holds the current `send` so listeners attached in a one-shot
	// useEffect (chatCommandRun) can dispatch through the latest
	// closure (with up-to-date activeProvider, etc.) without
	// re-subscribing on every render.
	const sendRef = useRef<(text: string) => void>(() => {});

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
		void rpc.request
			.providersList({})
			.then((ps) => setActiveProvider(ps.find((p) => p.active)?.id ?? null))
			.catch(() => {});
		const offDelta = onChatDelta((msg) => {
			if (msg.convId !== CONV_ID) return;
			setBubbles((bs) =>
				bs.map((b) =>
					b.id === assistantId.current
						? {
							...b,
							thinking: false,
							text: b.thinking ? msg.delta : b.text + msg.delta,
							// Stamp the trace id on the first delta so the
							// thumbs buttons have a target id to rate.
							...(b.traceId || !msg.traceId ? {} : { traceId: msg.traceId }),
						}
						: b,
				),
			);
		});
		const offComplete = onChatComplete((msg) => {
			if (msg.convId !== CONV_ID) return;
			setBubbles((bs) =>
				bs.map((b) =>
					b.id === assistantId.current
						? {
							...b,
							thinking: false,
							text: b.thinking ? "(no response)" : b.text,
							...(b.traceId || !msg.traceId ? {} : { traceId: msg.traceId }),
						}
						: b,
				),
			);
			assistantId.current = null;
			setPending(false);
		});
		const offError = onChatError((msg) => {
			if (msg.convId !== CONV_ID) return;
			setBubbles((bs) => [
				...bs.filter((b) => b.id !== assistantId.current),
				{ id: uid(), role: "error", text: msg.message },
			]);
			assistantId.current = null;
			setPending(false);
		});
		const offProvider = onProviderChanged((m) => setActiveProvider(m.activeProvider));
		// Command-palette injection. The palette emits chatCommandRun
		// via rpc.send.chatCommandRun; bun fans it out to all windows
		// (so the chat view picks it up regardless of which window the
		// palette opened in). `submit: false` parks the command in the
		// composer for the user to fill in arguments; `submit: true`
		// fires immediately.
		const offCommand = onChatCommandRun((msg) => {
			setDraft(msg.command.text);
			if (msg.command.submit) {
				const text = msg.command.text;
				queueMicrotask(() => sendRef.current(text));
			}
		});
		return () => {
			offDelta();
			offComplete();
			offError();
			offProvider();
			offCommand();
		};
	}, []);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [bubbles]);

	useEffect(() => {
		setSlashIndex(0);
	}, [slashMatches.length]);

	// Keep the latest `send` available to subscribers attached once
	// (chatCommandRun) so they dispatch through current state.
	useEffect(() => {
		sendRef.current = send;
	});

	function send(text: string) {
		const trimmed = text.trim();
		if (!trimmed) return;

		// `/video <prompt>` — short-circuit the agent path and call
		// ElizaOS Cloud's video generator directly. The prompt-or-empty
		// check matters because /video alone is meaningless.
		if (trimmed.startsWith("/video")) {
			const prompt = trimmed.replace(/^\/video\s*/, "").trim();
			if (!prompt) {
				setBubbles((bs) => [
					...bs,
					{ id: uid(), role: "user", text: trimmed },
					{ id: uid(), role: "error", text: "Usage: /video <prompt>" },
				]);
				return;
			}
			runVideoCommand(prompt);
			return;
		}

		if (!activeProvider) return;
		const userBubble: Bubble = { id: uid(), role: "user", text: trimmed };
		const aId = uid();
		assistantId.current = aId;
		setBubbles((bs) => [
			...bs,
			userBubble,
			{ id: aId, role: "assistant", text: "", thinking: true },
		]);
		setPending(true);
		void rpc.request.chatSend({ convId: CONV_ID, text: trimmed }).catch((err) => {
			setBubbles((bs) => [
				...bs.filter((b) => b.id !== assistantId.current),
				{ id: uid(), role: "error", text: err instanceof Error ? err.message : String(err) },
			]);
			assistantId.current = null;
			setPending(false);
		});
	}

	function rateBubble(bubbleId: string, rating: 1 | -1) {
		const bubble = bubbles.find((b) => b.id === bubbleId);
		if (!bubble?.traceId) return;
		const next = bubble.rating === rating ? undefined : rating;
		// Optimistic UI; flip back if the RPC rejects.
		setBubbles((bs) => bs.map((b) => (b.id === bubbleId ? { ...b, rating: next } : b)));
		if (next === undefined) return; // un-rating is local-only for now
		void rpc.request
			.chatRateMessage({
				traceId: bubble.traceId,
				convId: CONV_ID,
				rating: next,
				text: bubble.text,
			})
			.catch((err) => {
				console.warn("chatRateMessage failed:", err);
				setBubbles((bs) => bs.map((b) => (b.id === bubbleId ? { ...b, rating: bubble.rating } : b)));
			});
	}

	function runVideoCommand(prompt: string) {
		const userId = uid();
		const placeholderId = uid();
		setBubbles((bs) => [
			...bs,
			{ id: userId, role: "user", text: `/video ${prompt}` },
			{ id: placeholderId, role: "assistant", text: "Generating video…", thinking: true },
		]);
		setPending(true);
		void rpc.request
			.cloudGenerateVideo({ prompt })
			.then((res) => {
				setBubbles((bs) => bs.filter((b) => b.id !== placeholderId));
				if (res.ok) {
					setBubbles((bs) => [
						...bs,
						{
							id: uid(),
							role: "media",
							text: prompt,
							media: { kind: "video", url: res.video.url, ...(res.video.contentType ? { contentType: res.video.contentType } : {}) },
						},
					]);
				} else {
					const detail = res.insufficientCredits
						? ` (need ${res.insufficientCredits.required} credits)`
						: "";
					setBubbles((bs) => [
						...bs,
						{ id: uid(), role: "error", text: `Video generation failed: ${res.error}${detail}` },
					]);
				}
			})
			.catch((err) => {
				setBubbles((bs) => [
					...bs.filter((b) => b.id !== placeholderId),
					{ id: uid(), role: "error", text: err instanceof Error ? err.message : String(err) },
				]);
			})
			.finally(() => setPending(false));
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
						{b.media?.kind === "video" && (
							<video
								src={b.media.url}
								controls
								preload="metadata"
								playsInline
							/>
						)}
						{b.role === "assistant" && b.traceId && !b.thinking && (
							<FeedbackButtons
								rating={b.rating}
								onRate={(rating) => rateBubble(b.id, rating)}
							/>
						)}
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

function FeedbackButtons({
	rating,
	onRate,
}: {
	rating?: 1 | -1;
	onRate: (rating: 1 | -1) => void;
}) {
	return (
		<div className="bubble-feedback" role="group" aria-label="Rate this reply">
			<button
				type="button"
				className={`bubble-feedback-btn${rating === 1 ? " active up" : ""}`}
				onClick={() => onRate(1)}
				title="Good response"
				aria-label="Thumbs up"
			>
				👍
			</button>
			<button
				type="button"
				className={`bubble-feedback-btn${rating === -1 ? " active down" : ""}`}
				onClick={() => onRate(-1)}
				title="Bad response"
				aria-label="Thumbs down"
			>
				👎
			</button>
		</div>
	);
}
