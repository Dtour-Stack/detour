import type { ReactNode } from "react";
import type { ChannelStatus } from "../../shared/index";
import { BrandIcon, isBrandIconName } from "./BrandIcon";

const CHANNEL_VIEW_PREFIX = "channel:";

/**
 * Top-level Detour view selector. Three kinds of values:
 *
 *   - canonical conversation views: "inbox" | "chat" | "feed"
 *   - per-channel feeds:            "channel:discord" | "channel:telegram" | …
 *   - tool views:                   "pensieve" | "browser" | "activity" | "workspace" | "gallery" | "portless"
 *
 * Tool views are rendered inline inside `.hub-main`; their own sub-nav is
 * moved to the right side as `.embedded-right-rail` (collapsed by default,
 * expands on hover). Single window, single source of truth for navigation.
 */
export type HubToolView =
	| "pensieve"
	| "browser"
	| "activity"
	| "workspace"
	| "gallery"
	| "portless";

export type HubView =
	| "inbox"
	| "chat"
	| "feed"
	| `channel:${string}`
	| HubToolView;

export const HUB_TOOL_VIEWS: ReadonlyArray<HubToolView> = [
	"pensieve",
	"browser",
	"activity",
	"workspace",
	"gallery",
	"portless",
];

const TOOL_VIEW_SET = new Set<string>(HUB_TOOL_VIEWS);

export function isHubToolView(view: HubView): view is HubToolView {
	return TOOL_VIEW_SET.has(view);
}

export function hubChannelView(channelId: string): HubView {
	return `${CHANNEL_VIEW_PREFIX}${channelId}`;
}

export function hubChannelId(view: HubView): string | null {
	return view.startsWith(CHANNEL_VIEW_PREFIX) ? view.slice(CHANNEL_VIEW_PREFIX.length) : null;
}

/**
 * Channel id → leading glyph for the rail row. When the id matches a
 * brand we have a real SVG for (discord/telegram/github/imessage),
 * `renderChannelGlyph` returns the SVG; otherwise it falls back to a
 * two-letter monogram so unknown channels still render cleanly.
 */
function renderChannelGlyph(channelId: string): ReactNode {
	if (isBrandIconName(channelId)) {
		return <BrandIcon name={channelId} size={14} />;
	}
	return <span className="hub-rail-glyph-text">{channelId.slice(0, 2).toUpperCase()}</span>;
}

const TOOL_META: Record<HubToolView, { label: string; glyph: string }> = {
	pensieve: { label: "Pensieve", glyph: "PN" },
	browser: { label: "Browser", glyph: "BR" },
	activity: { label: "Activity", glyph: "AC" },
	workspace: { label: "Workspace", glyph: "WS" },
	gallery: { label: "Gallery", glyph: "GL" },
	portless: { label: "Portless", glyph: "PL" },
};

function statusTone(c: ChannelStatus | undefined): string {
	if (!c) return "muted";
	switch (c.liveStatus) {
		case "online": return "ok";
		case "connecting":
		case "loaded": return "info";
		case "invalid-token":
		case "error": return "err";
		case "off":
		default: return "muted";
	}
}

/**
 * Detour's unified left-side rail. Renamed conceptually from "ChannelRail"
 * but kept as the same export so existing callers don't break — the
 * component now also surfaces tool views (Pensieve, Browser, Activity, …).
 */
export function ChannelRail({
	channels,
	activeView,
	onSelectView,
	onOpenChannelSettings,
}: {
	channels: ChannelStatus[];
	activeView: HubView;
	onSelectView: (view: HubView) => void;
	onOpenChannelSettings: () => void;
}) {
	const wired = channels.filter((c) => c.platformAvailable);
	return (
		<aside className="hub-rail">
			<RailSection label="Conversations">
				<RailButton
					active={activeView === "chat"}
					onClick={() => onSelectView("chat")}
					label="Chat"
					glyph={<span className="hub-rail-glyph-text">AI</span>}
					tone="info"
				/>
				<RailButton
					active={activeView === "inbox"}
					onClick={() => onSelectView("inbox")}
					label="Inbox"
					glyph={<span className="hub-rail-glyph-text">IN</span>}
					tone="info"
				/>
				<RailButton
					active={activeView === "feed"}
					onClick={() => onSelectView("feed")}
					label="All messages"
					glyph={<span className="hub-rail-glyph-text">FD</span>}
					tone="muted"
				/>
				{wired.map((c) => (
					<RailButton
						key={c.id}
						active={activeView === hubChannelView(c.id)}
						onClick={() => onSelectView(hubChannelView(c.id))}
						label={c.label}
						glyph={renderChannelGlyph(c.id)}
						tone={statusTone(c)}
					/>
				))}
			</RailSection>
			<RailSection label="Tools">
				{HUB_TOOL_VIEWS.map((view) => {
					const meta = TOOL_META[view];
					return (
						<RailButton
							key={view}
							active={activeView === view}
							onClick={() => onSelectView(view)}
							label={meta.label}
							glyph={<span className="hub-rail-glyph-text">{meta.glyph}</span>}
							tone="muted"
						/>
					);
				})}
			</RailSection>
			<div style={{ flex: 1 }} />
			<RailButton
				onClick={onOpenChannelSettings}
				label="Messaging connections"
				glyph={<span className="hub-rail-glyph-text">SET</span>}
				tone="muted"
			/>
		</aside>
	);
}

function RailSection({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="hub-rail-section">
			<div className="hub-rail-section-label">{label}</div>
			{children}
		</div>
	);
}

function RailButton({
	active,
	onClick,
	label,
	glyph,
	tone,
}: {
	active?: boolean;
	onClick: () => void;
	label: string;
	glyph: ReactNode;
	tone: string;
}) {
	return (
		<button
			type="button"
			className={`hub-rail-btn${active ? " active" : ""}`}
			onClick={onClick}
			title={label}
			aria-label={label}
			data-tone={tone}
		>
			<span className="hub-rail-glyph" aria-hidden>{glyph}</span>
			<span className="hub-rail-label">{label}</span>
		</button>
	);
}
