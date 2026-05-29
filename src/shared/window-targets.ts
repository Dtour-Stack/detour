import type { TraySlot, WindowOpenTarget } from "./index";

export type WindowTargetMeta = {
	id: WindowOpenTarget;
	label: string;
	title: string;
	subtitle: string;
	icon: string;
	menuLabel: string;
	keywords: string;
	accelerator?: string;
};

export const GLOBAL_SHORTCUTS = {
	toggleChat: "CommandOrControl+Shift+Space",
	openCapsule: "CommandOrControl+Shift+U",
	openSettings: "CommandOrControl+Shift+S",
	openPensieve: "CommandOrControl+Shift+P",
	openActivity: "CommandOrControl+Shift+A",
	openBrowser: "CommandOrControl+Shift+B",
	openGallery: "CommandOrControl+Shift+G",
} as const;

export const PRIMARY_CAPTURE_TARGET = "capsule" satisfies WindowOpenTarget;

export const WINDOW_TARGET_META: Record<WindowOpenTarget, WindowTargetMeta> = {
	capsule: {
		id: "capsule",
		label: "Capsule",
		title: "Open Capsule",
		subtitle: "Floating capture for text, voice, files, images, and URLs.",
		icon: "✏️",
		menuLabel: "Open Capsule",
		keywords: "capture ask voice mic file image url input floating",
		accelerator: GLOBAL_SHORTCUTS.openCapsule,
	},
	chat: {
		id: "chat",
		label: "Detour",
		title: "Open Detour",
		subtitle: "Inbox, agent chat, message feed, and connector status.",
		icon: "💬",
		menuLabel: "Open Detour",
		keywords: "chat inbox feed connector hub",
		accelerator: GLOBAL_SHORTCUTS.toggleChat,
	},
	settings: {
		id: "settings",
		label: "Settings",
		title: "Open Configuration",
		subtitle: "Providers, vault, models, character, and appearance.",
		icon: "⚙",
		menuLabel: "Open Configuration",
		keywords: "settings configuration providers vault models appearance",
		accelerator: GLOBAL_SHORTCUTS.openSettings,
	},
	pensieve: {
		id: "pensieve",
		label: "Pensieve",
		title: "Open Pensieve",
		subtitle: "Memories, knowledge, templates, relationships, and graphs.",
		icon: "🧠",
		menuLabel: "Open Pensieve",
		keywords: "memory memories knowledge templates graph pensieve",
		accelerator: GLOBAL_SHORTCUTS.openPensieve,
	},
	activity: {
		id: "activity",
		label: "Activity",
		title: "Open Activity",
		subtitle: "Runtime, logs, trajectories, subagents, tasks, and autonomy.",
		icon: "📊",
		menuLabel: "Open Activity",
		keywords: "activity logs trajectory trajectories subagents tasks autonomy",
		accelerator: GLOBAL_SHORTCUTS.openActivity,
	},
	browser: {
		id: "browser",
		label: "Browser",
		title: "Open Browser",
		subtitle: "Inspect, automate, and use saved login flows.",
		icon: "🌐",
		menuLabel: "Open Browser",
		keywords: "browser web inspect automate login saved",
		accelerator: GLOBAL_SHORTCUTS.openBrowser,
	},
	gallery: {
		id: "gallery",
		label: "Gallery",
		title: "Open Gallery",
		subtitle: "Generated pictures, videos, and audio.",
		icon: "🖼️",
		menuLabel: "Open Gallery",
		keywords: "gallery generated media image video audio",
		accelerator: GLOBAL_SHORTCUTS.openGallery,
	},
	"command-palette": {
		id: "command-palette",
		label: "Palette",
		title: "Open Command Palette",
		subtitle: "Search windows, settings, and native chat commands.",
		icon: "⌘",
		menuLabel: "Open Command Palette",
		keywords: "command palette search commands shortcuts",
	},
	portless: {
		id: "portless",
		label: "Portless",
		title: "Open Portless",
		subtitle: "Local preview routes and shareable dev URLs.",
		icon: "🔌",
		menuLabel: "Open Portless",
		keywords: "portless preview routes localhost dev server",
	},
	agents: {
		id: "agents",
		label: "Agents",
		title: "Open Coding Agents",
		subtitle: "Running coding subagents, logs, previews, and task state.",
		icon: "🤖",
		menuLabel: "Open Coding Agents",
		keywords: "agents coding subagents worktree logs previews",
	},
	pet: {
		id: "pet",
		label: "Pet",
		title: "Open Pet",
		subtitle: "Floating companion status.",
		icon: "🐾",
		menuLabel: "Open Pet",
		keywords: "pet companion floating status",
	},
};

export const TRAY_SLOT_CHOICES = [
	"chat",
	"pensieve",
	"activity",
	"browser",
	"gallery",
	"settings",
	"command-palette",
	"portless",
	"capsule",
] as const satisfies readonly TraySlot[];

export const COMMAND_PALETTE_WINDOW_TARGETS = [
	"capsule",
	"chat",
	"settings",
	"pensieve",
	"activity",
	"browser",
	"agents",
	"gallery",
	"portless",
] as const satisfies readonly WindowOpenTarget[];

export function windowTargetMeta(id: WindowOpenTarget): WindowTargetMeta {
	return WINDOW_TARGET_META[id];
}

export function traySlotMeta(id: TraySlot): WindowTargetMeta {
	return WINDOW_TARGET_META[id];
}

// ── Window-open dispatch: single source of truth ──────────────────────────
// Every entry point (windowOpen RPC, detour:// url-scheme, tray popover) that
// "opens" a target turns it into exactly one `uiOpen*` broadcast via this map.
// Centralized so the three dispatchers can't derive the name three different
// ways — the url-scheme used to string-capitalize, which produced the bogus
// `uiOpenCommand-palette` for the one hyphenated target.
export const WINDOW_OPEN_MESSAGE = {
	chat: "uiOpenChat",
	"command-palette": "uiOpenCommandPalette",
	settings: "uiOpenSettings",
	pensieve: "uiOpenPensieve",
	activity: "uiOpenActivity",
	browser: "uiOpenBrowser",
	agents: "uiOpenAgents",
	pet: "uiOpenPet",
	gallery: "uiOpenGallery",
	portless: "uiOpenPortless",
	capsule: "uiOpenCapsule",
} as const satisfies Record<WindowOpenTarget, string>;

// Targets whose `uiOpen*` broadcast the kernel converts into a `ui:open-*`
// event, so opens that originate outside an already-open hub (tray popover,
// url-scheme, agent) still reach the feature that owns the window/hub. Derived
// from one place so it can't silently drift from the target set the way the
// old hardcoded if-chain did (it was missing pensieve/activity).
export const WINDOW_OPEN_KERNEL_EVENT = {
	chat: "ui:open-chat",
	pensieve: "ui:open-pensieve",
	activity: "ui:open-activity",
	browser: "ui:open-browser",
	gallery: "ui:open-gallery",
	portless: "ui:open-portless",
	pet: "ui:open-pet",
	capsule: "ui:open-capsule",
} as const satisfies Partial<Record<WindowOpenTarget, string>>;
