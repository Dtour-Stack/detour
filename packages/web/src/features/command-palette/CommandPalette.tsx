import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatCommandInfo, WindowOpenTarget } from "@detour/shared";
import type { WebClient } from "../../api/client";

type PaletteItem = {
	id: string;
	title: string;
	subtitle: string;
	kicker: string;
	group: string;
	keywords: string;
	run: () => void;
};

type ChatCommandRequest = {
	text: string;
	submit: boolean;
};

type Props = {
	client: WebClient;
	open: boolean;
	onClose: () => void;
	onOpenSettings: () => void;
	onChatCommand: (request: ChatCommandRequest) => void;
};

const WINDOW_COMMANDS: Array<{
	id: WindowOpenTarget;
	title: string;
	subtitle: string;
	kicker: string;
}> = [
	{ id: "chat", title: "Focus chat", subtitle: "Return to the main Detour conversation.", kicker: "Window" },
	{ id: "settings", title: "Open configuration", subtitle: "Providers, vault, models, character, and appearance.", kicker: "Window" },
	{ id: "pensieve", title: "Open Pensieve", subtitle: "Memories, knowledge, templates, relationships, and graphs.", kicker: "Window" },
	{ id: "activity", title: "Open Activity", subtitle: "Runtime, logs, trajectories, tasks, and autonomy.", kicker: "Window" },
	{ id: "channels", title: "Open Channels", subtitle: "Discord, Telegram, GitHub, and iMessage status.", kicker: "Window" },
	{ id: "browser", title: "Open agent browser", subtitle: "Inspect, automate, and use saved login flows.", kicker: "Window" },
	{ id: "agents", title: "Open coding agents", subtitle: "Workspace sessions, logs, previews, and project files.", kicker: "Window" },
];

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim();
}

function score(item: PaletteItem, query: string): number {
	if (!query) return 1;
	const haystack = normalize(`${item.title} ${item.subtitle} ${item.kicker} ${item.keywords}`);
	const needle = normalize(query);
	if (!needle) return 1;
	if (haystack.startsWith(needle)) return 100;
	if (haystack.includes(needle)) return 50;
	const terms = needle.split(/\s+/).filter(Boolean);
	const matched = terms.filter((term) => haystack.includes(term)).length;
	return matched === terms.length ? 30 + matched : 0;
}

function commandNeedsInput(command: ChatCommandInfo): boolean {
	return command.insert.endsWith(" ") || /<[^>]+>/.test(command.usage);
}

function groupRank(group: string): number {
	if (group === "Windows") return 0;
	if (group === "Chat commands") return 1;
	return 2;
}

export function CommandPalette({
	client,
	open,
	onClose,
	onOpenSettings,
	onChatCommand,
}: Props) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [commands, setCommands] = useState<ChatCommandInfo[]>([]);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActiveIndex(0);
		setError(null);
		requestAnimationFrame(() => inputRef.current?.focus());
		client
			.listChatCommands()
			.then((result) => setCommands(result.commands))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [client, open]);

	const items = useMemo(() => {
		const windowItems: PaletteItem[] = WINDOW_COMMANDS.map((command) => ({
			id: `window:${command.id}`,
			title: command.title,
			subtitle: command.subtitle,
			kicker: command.kicker,
			group: "Windows",
			keywords: command.id,
			run: () => {
				onClose();
				if (command.id === "settings") {
					onOpenSettings();
					return;
				}
				if (command.id === "chat") return;
				void client.openWindow(command.id);
			},
		}));

		const chatItems: PaletteItem[] = commands.map((command) => ({
			id: `command:${command.name}`,
			title: command.name,
			subtitle: command.description,
			kicker: command.source === "skill" ? "Skill" : "Command",
			group: command.source === "skill" ? "Skills" : "Chat commands",
			keywords: [command.usage, ...(command.aliases ?? [])].join(" "),
			run: () => {
				onClose();
				onChatCommand({
					text: command.insert,
					submit: !commandNeedsInput(command),
				});
			},
		}));

		return [...windowItems, ...chatItems];
	}, [client, commands, onChatCommand, onClose, onOpenSettings]);

	const filtered = useMemo(() => {
		return items
			.map((item) => ({ item, value: score(item, query) }))
			.filter((entry) => entry.value > 0)
			.sort((a, b) =>
				b.value - a.value ||
				groupRank(a.item.group) - groupRank(b.item.group) ||
				a.item.title.localeCompare(b.item.title),
			)
			.map((entry) => entry.item);
	}, [items, query]);

	useEffect(() => {
		setActiveIndex((index) => Math.min(index, Math.max(0, filtered.length - 1)));
	}, [filtered.length]);

	if (!open) return null;

	const active = filtered[activeIndex];

	return (
		<div
			className="command-palette-backdrop"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className="command-palette"
				role="dialog"
				aria-modal="true"
				aria-label="Command palette"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
						return;
					}
					if (event.key === "ArrowDown") {
						event.preventDefault();
						setActiveIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
						return;
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						setActiveIndex((index) => Math.max(0, index - 1));
						return;
					}
					if (event.key === "Enter" && active) {
						event.preventDefault();
						active.run();
					}
				}}
			>
				<div className="command-palette-search">
					<span className="command-palette-search-icon" aria-hidden>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="11" cy="11" r="7" />
							<line x1="16.5" y1="16.5" x2="21" y2="21" />
						</svg>
					</span>
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search windows, actions, slash commands, skills..."
						aria-label="Search commands"
					/>
					<span className="command-palette-shortcut">Cmd K</span>
				</div>
				<div className="command-palette-body" role="listbox" aria-label="Commands">
					{error && (
						<div className="command-palette-error">
							Command discovery failed. Native actions are still available.
						</div>
					)}
					{filtered.length === 0 ? (
						<div className="command-palette-empty">
							<div>No commands matched.</div>
							<span>Try “skills”, “activity”, “hatch”, or “browser”.</span>
						</div>
					) : (
						filtered.map((item, index) => {
							const previous = filtered[index - 1];
							const showGroup = !previous || previous.group !== item.group;
							return (
								<div key={item.id}>
									{showGroup && <div className="command-palette-group">{item.group}</div>}
									<button
										type="button"
										className={index === activeIndex ? "command-palette-item active" : "command-palette-item"}
										role="option"
										aria-selected={index === activeIndex}
										onMouseEnter={() => setActiveIndex(index)}
										onClick={() => item.run()}
									>
										<span className="command-palette-item-main">
											<span className="command-palette-title">{item.title}</span>
											<span className="command-palette-subtitle">{item.subtitle}</span>
										</span>
										<span className="command-palette-kicker">{item.kicker}</span>
									</button>
								</div>
							);
						})
					)}
				</div>
				<div className="command-palette-footer">
					<span>Enter run</span>
					<span>Arrows move</span>
					<span>Esc close</span>
				</div>
			</div>
		</div>
	);
}
