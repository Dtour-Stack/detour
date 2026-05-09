/**
 * Right-side channel rail in the chat hub. Single column of round
 * "Discord-style" icon buttons — one per active channel + the in-app
 * agent chat at the top + a gear at the bottom for channel settings.
 *
 * Click an icon → switches the main view to that channel's feed.
 * Settings (gear) toggles the channels-config drawer (separate from the
 * Settings drawer; surfaces the existing Channels window content
 * inline).
 */

import type { ChannelStatus } from "../../shared/index";

export type HubView = "chat" | string; // "chat" or a channel id

const CHANNEL_GLYPH: Record<string, string> = {
	discord: "💬",
	telegram: "✈",
	github: "GH",
	imessage: "iM",
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
			<RailButton
				active={activeView === "chat"}
				onClick={() => onSelectView("chat")}
				label="Agent chat"
				glyph="🦋"
				tone="info"
			/>
			<div className="hub-rail-divider" />
			{wired.map((c) => (
				<RailButton
					key={c.id}
					active={activeView === c.id}
					onClick={() => onSelectView(c.id)}
					label={c.label}
					glyph={CHANNEL_GLYPH[c.id] ?? c.id.slice(0, 2).toUpperCase()}
					tone={statusTone(c)}
				/>
			))}
			<div style={{ flex: 1 }} />
			<RailButton
				onClick={onOpenChannelSettings}
				label="Channel settings"
				glyph="⚙"
				tone="muted"
			/>
		</aside>
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
	glyph: string;
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
			<span className="hub-rail-glyph">{glyph}</span>
		</button>
	);
}
