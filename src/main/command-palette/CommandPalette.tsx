import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatCommandInfo, WindowOpenTarget } from "../../shared/index";
import { rpc } from "../rpc";

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
	open: boolean;
	onClose: () => void;
	onOpenSettings: (deepLink?: string) => void;
	onChatCommand: (request: ChatCommandRequest) => void;
	windowed?: boolean;
};

const WINDOW_COMMANDS: Array<{
	id: WindowOpenTarget;
	title: string;
	subtitle: string;
	kicker: string;
}> = [
	{ id: "chat", title: "Open Detour", subtitle: "Inbox, agent chat, message feed, and connector status.", kicker: "Window" },
	{ id: "settings", title: "Open configuration", subtitle: "Providers, vault, models, character, and appearance.", kicker: "Window" },
	{ id: "pensieve", title: "Open Pensieve", subtitle: "Memories, knowledge, templates, relationships, and graphs.", kicker: "Window" },
	{ id: "activity", title: "Open Activity", subtitle: "Runtime, logs, trajectories, subagents, tasks, and autonomy.", kicker: "Window" },
	{ id: "browser", title: "Open agent browser", subtitle: "Inspect, automate, and use saved login flows.", kicker: "Window" },
	{ id: "agents", title: "Open coding agents", subtitle: "Running coding subagents, logs, previews, and task state.", kicker: "Window" },
	{ id: "gallery", title: "Open gallery", subtitle: "Generated pictures, videos, and audio.", kicker: "Window" },
];

/**
 * Deep-link palette items — jump straight to a Settings tab. The format
 * `<section>:<tab>` matches what SettingsView.parseDeepLink expects. Keep
 * this in sync with src/main/settings/SettingsView.tsx CONFIG_TABS /
 * VAULT_TABS / CLOUD_TABS.
 */
const SETTINGS_DEEP_LINKS: Array<{
	id: string;
	title: string;
	subtitle: string;
	keywords: string;
}> = [
	{ id: "configuration:appearance", title: "Settings → Appearance", subtitle: "Theme, accent color, fonts.", keywords: "theme dark light accent color font" },
	{ id: "configuration:providers", title: "Settings → Providers", subtitle: "Anthropic, OpenAI / Codex, OpenRouter, Eliza Cloud.", keywords: "anthropic openai codex openrouter elizacloud api key oauth" },
	{ id: "configuration:models", title: "Settings → Models & Routing", subtitle: "Per-tier model picker + fallback chain.", keywords: "model routing fallback codex anthropic openrouter" },
	{ id: "configuration:local-ai", title: "Settings → Local AI", subtitle: "llama-server status, local chat, companion, memory budget.", keywords: "llama local chat companion embed embedding memory ram budget gguf" },
	{ id: "configuration:audio", title: "Settings → Audio", subtitle: "TTS, voice cloning, audio generation.", keywords: "audio tts voice elevenlabs cartesia" },
	{ id: "configuration:character", title: "Settings → Agent Character", subtitle: "Bio, lore, voice templates.", keywords: "character bio persona prompt template voice" },
	{ id: "configuration:agent", title: "Settings → Agent Permissions", subtitle: "Vault scope, browser/computer use, coding sandbox.", keywords: "agent permissions vault browser computer sandbox elevated" },
	{ id: "configuration:skills", title: "Settings → Skills", subtitle: "Bundled + user-installed agent skills.", keywords: "skills tools capabilities agent-skills" },
	{ id: "configuration:phantom", title: "Settings → Phantom wallet", subtitle: "Embedded Connect, Portal config, Solana + EVM.", keywords: "phantom wallet solana evm crypto portal connect" },
	{ id: "configuration:os", title: "Settings → OS Permissions", subtitle: "Camera, microphone, accessibility, automation.", keywords: "tcc os permissions camera microphone accessibility automation screen recording" },
	{ id: "configuration:window", title: "Settings → Window", subtitle: "Size, hide-on-blur, always-on-top.", keywords: "window size hide blur top" },
	{ id: "vault:inventory", title: "Settings → Vault inventory", subtitle: "All vault keys + their categories.", keywords: "vault keys secrets inventory" },
	{ id: "vault:saved-logins", title: "Settings → Saved logins", subtitle: "1Password / Bitwarden / in-house entries.", keywords: "1password bitwarden saved logins passwords" },
	{ id: "vault:backends", title: "Settings → Vault backends", subtitle: "Enable / sign in to 1Password, Bitwarden, ProtonPass.", keywords: "1password bitwarden protonpass backend signin" },
	{ id: "cloud:elizacloud", title: "Settings → ElizaOS Cloud", subtitle: "Cloud auth, model catalog.", keywords: "elizacloud eliza cloud auth model catalog" },
	{ id: "cloud:apps", title: "Settings → Cloud apps", subtitle: "Managed app deployments.", keywords: "cloud apps deploy" },
	{ id: "cloud:containers", title: "Settings → Cloud containers", subtitle: "Managed container runtime status.", keywords: "cloud containers" },
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
	if (group === "Settings") return 1;
	if (group === "Chat commands") return 2;
	return 3;
}

export function CommandPalette({
	open,
	onClose,
	onOpenSettings,
	onChatCommand,
	windowed = false,
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
		rpc.request
			.listChatCommands({})
			.then((result) => setCommands(result.commands))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [open]);

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
				void rpc.request.windowOpen({ target: command.id });
			},
		}));

		const settingsItems: PaletteItem[] = SETTINGS_DEEP_LINKS.map((link) => ({
			id: `settings-tab:${link.id}`,
			title: link.title,
			subtitle: link.subtitle,
			kicker: "Settings",
			group: "Settings",
			keywords: `${link.id} ${link.keywords}`,
			run: () => {
				onClose();
				onOpenSettings(link.id);
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

		return [...windowItems, ...settingsItems, ...chatItems];
	}, [commands, onChatCommand, onClose, onOpenSettings]);

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
			className={windowed ? "command-palette-backdrop windowed" : "command-palette-backdrop"}
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
					if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
						event.preventDefault();
						onClose();
						return;
					}
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
					<button
						type="button"
						className="command-palette-close"
						aria-label="Close command palette"
						onClick={onClose}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
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
