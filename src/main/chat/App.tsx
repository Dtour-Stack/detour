import { useCallback, useEffect, useRef, useState } from "react";
import { Sun, Settings, X } from "lucide-react";
import type {
	ChannelStatus,
	ProviderId,
	ProviderInfo,
	ThemeChoice,
} from "../../shared/index";
import { UI_POLL_INTERVAL_MS } from "../../shared/timing";
import { ChatView } from "./ChatView";
import { ChannelRail, hubChannelId, isHubToolView, type HubToolView, type HubView } from "./ChannelRail";
import { ChannelView } from "./ChannelView";
import { SettingsView } from "../settings/SettingsView";
import { ChannelsView } from "../channels/ChannelsView";
import { InboxPane } from "./inbox/InboxPane";
import { GatewayPane } from "./gateway/GatewayPane";
import { PensieveView } from "../pensieve/PensieveView";
import { ActivityView, type ActivityTab } from "../activity/ActivityView";
import { BrowserView } from "../browser/BrowserView";
import { GalleryView } from "../gallery/GalleryView";
import { PortlessView } from "../portless/PortlessView";
import { CommandPalette } from "../command-palette/CommandPalette";
import { rpc } from "../rpc";
import {
	onUiOpenActivity,
	onUiOpenAgents,
	onUiOpenBrowser,
	onUiOpenChat,
	onUiOpenCommandPalette,
	onUiOpenGallery,
	onUiOpenPensieve,
	onUiOpenPortless,
	onUiOpenSettings,
} from "../rpc-listeners/chat";
import { onProviderChanged } from "../rpc-listeners/providers";

function renderToolView(
	view: HubToolView,
	activityFocus: { focusTab: ActivityTab | null; onFocusApplied: () => void },
): React.ReactNode {
	switch (view) {
		case "pensieve": return <PensieveView />;
		case "activity": return <ActivityView focusTab={activityFocus.focusTab} onFocusApplied={activityFocus.onFocusApplied} />;
		case "browser": return <BrowserView />;
		case "gallery": return <GalleryView />;
		case "portless": return <PortlessView />;
	}
}

const ACCENT_SWATCHES = [
	{ name: "Blue", value: "#0a84ff" },
	{ name: "Purple", value: "#bf5af2" },
	{ name: "Pink", value: "#ff375f" },
	{ name: "Orange", value: "#ff9f0a" },
	{ name: "Green", value: "#30d158" },
	{ name: "Teal", value: "#64d2ff" },
	{ name: "Indigo", value: "#5e5ce6" },
	{ name: "Yellow", value: "#ffd60a" },
];

function applyTheme(theme: ThemeChoice) {
	if (theme === "system") {
		document.documentElement.removeAttribute("data-theme");
	} else {
		document.documentElement.setAttribute("data-theme", theme);
	}
}

function applyAccent(accent: string) {
	document.documentElement.style.setProperty("--accent", accent);
}

const PROVIDER_LABELS: Record<string, string> = {
	openai: "Codex",
	anthropic: "Claude",
	openrouter: "OpenRouter",
	elizacloud: "Eliza Cloud",
};

type HubDrawer = "settings" | "channels";

type AppProps = {
	initialView?: HubView;
	initialDrawer?: HubDrawer | null;
};

export function App({ initialView = "chat", initialDrawer = null }: AppProps = {}) {
	const [drawer, setDrawer] = useState<HubDrawer | null>(initialDrawer);
	const [theme, setTheme] = useState<ThemeChoice>("system");
	const [accent, setAccent] = useState("#0a84ff");
	const [appearancePopover, setAppearancePopover] = useState(false);
	const appearanceRef = useRef<HTMLDivElement>(null);
	const [activeProvider, setActiveProvider] = useState<string | null>(null);
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [settingsDeepLink, setSettingsDeepLink] = useState<string | null>(null);
	const [providerMenuOpen, setProviderMenuOpen] = useState(false);
	const providerMenuRef = useRef<HTMLDivElement>(null);
	const [llamaReady, setLlamaReady] = useState<boolean | null>(null);
	const [llamaProgress, setLlamaProgress] = useState<{ percent: number; downloaded: number; total: number } | null>(null);
	const [activeView, setActiveView] = useState<HubView>(initialView);
	// One-shot deep-link into an Activity sub-tab (e.g. "Open Coding Agents").
	// Cleared once ActivityView applies it, so normal navigation keeps the
	// user's last tab.
	const [pendingActivityTab, setPendingActivityTab] = useState<ActivityTab | null>(null);
	const [channels, setChannels] = useState<ChannelStatus[]>([]);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const drawerOpen = drawer !== null;

	// Channel rail data — refreshed on a 6s cadence so the icon tone
	// (online/error/etc) tracks the live channel state.
	useEffect(() => {
		let cancelled = false;
		const refresh = () => {
			void rpc.request.channelsList({}).then((s) => {
				if (!cancelled) setChannels(s.channels);
			}).catch(() => {});
		};
		refresh();
		const t = setInterval(refresh, UI_POLL_INTERVAL_MS.mainChat);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	}, []);

	useEffect(() => {
		rpc.request
			.uiGetPreferences({})
			.then((p) => {
				const t = (p.theme ?? "system") as ThemeChoice;
				setTheme(t);
				setAccent(p.accent ?? "#0a84ff");
				applyTheme(t);
				applyAccent(p.accent ?? "#0a84ff");
			})
			.catch(() => {
				/* keep defaults */
			});
		const offSettings = onUiOpenSettings((p) => {
			setDrawer("settings");
			if (p?.tab) setSettingsDeepLink(p.tab);
		});
		const offChat = onUiOpenChat(() => {
			setActiveView("chat");
			setDrawer(null);
		});
		// uiOpenPensieve / uiOpenActivity / uiOpenBrowser / uiOpenGallery
		// historically caused separate windows to self-show. Now that all
		// tool views live inside the hub, route them to setActiveView so
		// the pet menu / command palette / cron actions deep-link cleanly
		// into the right hub tab without spawning a second window.
		const offPensieve = onUiOpenPensieve(() => { setActiveView("pensieve"); setDrawer(null); });
		const offActivity = onUiOpenActivity(() => { setActiveView("activity"); setDrawer(null); });
		const offBrowser = onUiOpenBrowser(() => { setActiveView("browser"); setDrawer(null); });
		const offGallery = onUiOpenGallery(() => { setActiveView("gallery"); setDrawer(null); });
		const offPortless = onUiOpenPortless(() => { setActiveView("portless"); setDrawer(null); });
		// "Coding Agents" surfaces as Activity's Subagents pane. The one-shot
		// pendingActivityTab makes ActivityView focus subagents whether or not
		// it's already mounted (clicking this while already on Activity works).
		const offAgents = onUiOpenAgents(() => {
			setPendingActivityTab("subagents");
			setActiveView("activity");
			setDrawer(null);
		});
		const offPalette = onUiOpenCommandPalette(() => setPaletteOpen((x) => !x));
		const offProvider = onProviderChanged((m) => setActiveProvider(m.activeProvider));
		// Active provider for the header chip.
		void rpc.request.providersList({}).then((ps) => {
			setProviders(ps);
			setActiveProvider(ps.find((p) => p.active)?.id ?? null);
		}).catch(() => {});
		// Llama-server status: poll every 4s. The header chip flips from
		// "downloading" → "ready" once the bundled embedding model is
		// loaded.
		const refreshLlama = () => {
			void rpc.request.llamaStatus({}).then((s) => {
				setLlamaReady(s.running && !s.lastError);
				if (s.downloadProgress && s.downloadProgress.percent < 100) {
					setLlamaProgress({
						percent: s.downloadProgress.percent,
						downloaded: s.downloadProgress.downloadedBytes,
						total: s.downloadProgress.totalBytes,
					});
				} else {
					setLlamaProgress(null);
				}
			}).catch(() => setLlamaReady(false));
		};
		refreshLlama();
		const llamaTimer = setInterval(refreshLlama, UI_POLL_INTERVAL_MS.localAi);
		return () => {
			offSettings();
			offChat();
			offPensieve();
			offActivity();
			offBrowser();
			offGallery();
			offPortless();
			offAgents();
			offPalette();
			offProvider();
			clearInterval(llamaTimer);
		};
	}, []);

	// Cmd/Ctrl+K toggles the command palette globally. Captured at the
	// window level so it works regardless of which input has focus.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPaletteOpen((x) => !x);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Pin window while drawer is open so click-out / focus loss doesn't dismiss.
	useEffect(() => {
		void rpc.request.windowPin({ on: drawerOpen });
	}, [drawerOpen]);

	// Esc closes drawer; doesn't hide window.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && drawerOpen) {
				e.preventDefault();
				setDrawer(null);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [drawerOpen]);

	// Click-outside for the appearance popover.
	useEffect(() => {
		if (!appearancePopover) return;
		const onClick = (e: MouseEvent) => {
			if (!appearanceRef.current?.contains(e.target as Node)) {
				setAppearancePopover(false);
			}
		};
		setTimeout(() => document.addEventListener("mousedown", onClick), 0);
		return () => document.removeEventListener("mousedown", onClick);
	}, [appearancePopover]);

	// Click-outside for the provider switcher menu.
	useEffect(() => {
		if (!providerMenuOpen) return;
		const onClick = (e: MouseEvent) => {
			if (!providerMenuRef.current?.contains(e.target as Node)) {
				setProviderMenuOpen(false);
			}
		};
		setTimeout(() => document.addEventListener("mousedown", onClick), 0);
		return () => document.removeEventListener("mousedown", onClick);
	}, [providerMenuOpen]);

	const switchProvider = useCallback(async (id: ProviderId) => {
		setProviderMenuOpen(false);
		try {
			await rpc.request.providersSetActive({ id });
			const refreshed = await rpc.request.providersList({});
			setProviders(refreshed);
			setActiveProvider(refreshed.find((p) => p.active)?.id ?? null);
		} catch {
			/* swallow */
		}
	}, []);

	function changeTheme(next: ThemeChoice) {
		setTheme(next);
		applyTheme(next);
		void rpc.request.uiSetPreferences({ theme: next });
	}

	function changeAccent(next: string) {
		setAccent(next);
		applyAccent(next);
		void rpc.request.uiSetPreferences({ accent: next });
	}

	function closeWindow() {
		void rpc.request.windowHide({});
	}

	const activeChannelId = hubChannelId(activeView);
	const activeChannel = activeChannelId ? channels.find((c) => c.id === activeChannelId) : undefined;

	return (
		<div className="popup-shell hub-shell">
			<header className="popup-header electrobun-webkit-app-region-drag">
				<div className="popup-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span>Detour</span>
					<div
						className="provider-switcher"
						ref={providerMenuRef}
						style={{ position: "relative", display: "inline-flex" }}
					>
						<button
							type="button"
							onClick={() => setProviderMenuOpen((v) => !v)}
							disabled={providers.length === 0}
							title={
								activeProvider
									? `Active LLM provider: ${activeProvider} — click to switch`
									: "No provider configured"
							}
							style={{
								fontSize: 10,
								padding: "2px 8px",
								borderRadius: 999,
								background: activeProvider
									? "var(--accent, #0a84ff)"
									: "rgba(120,120,128,0.25)",
								color: activeProvider ? "white" : "var(--text, #ccc)",
								opacity: activeProvider ? 0.9 : 0.8,
								fontWeight: 600,
								letterSpacing: 0.3,
								border: "none",
								cursor: providers.length > 0 ? "pointer" : "not-allowed",
								display: "inline-flex",
								alignItems: "center",
								gap: 4,
							}}
						>
							{activeProvider
								? `via ${PROVIDER_LABELS[activeProvider] ?? activeProvider}`
								: "no provider"}
							<span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>
						</button>
						{providerMenuOpen && (
							<div
								style={{
									position: "absolute",
									top: "calc(100% + 6px)",
									left: 0,
									minWidth: 160,
									padding: 4,
									background: "var(--bg-elev, #2a2a2c)",
									border: "1px solid var(--border, rgba(255,255,255,0.1))",
									borderRadius: 8,
									boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
									zIndex: 100,
								}}
							>
								{providers.map((p) => {
									const configured =
										p.hasKey || (p.oauthAccountCount ?? 0) > 0;
									return (
										<button
											type="button"
											key={p.id}
											onClick={() => switchProvider(p.id)}
											disabled={!configured}
											title={
												configured
													? ""
													: "Not configured — add a key or sign in via Settings"
											}
											style={{
												width: "100%",
												display: "flex",
												alignItems: "center",
												gap: 6,
												padding: "6px 8px",
												background: "transparent",
												border: "none",
												borderRadius: 5,
												color: "inherit",
												fontSize: 11,
												cursor: configured ? "pointer" : "not-allowed",
												textAlign: "left",
												opacity: configured ? 1 : 0.5,
											}}
										>
											<span
												style={{
													width: 6,
													height: 6,
													borderRadius: 999,
													background: p.active ? "#30d158" : "rgba(255,255,255,0.2)",
												}}
											/>
											<span
												style={{
													flex: 1,
													fontWeight: p.active ? 600 : 400,
													color: p.active ? "var(--accent, #0a84ff)" : "inherit",
												}}
											>
												{PROVIDER_LABELS[p.id] ?? p.id}
											</span>
											{!configured && (
												<span style={{ fontSize: 9, opacity: 0.6, fontStyle: "italic" }}>
													not set
												</span>
											)}
										</button>
									);
								})}
							</div>
						)}
					</div>
					{llamaReady === true && !llamaProgress && (
						<span
							style={{
								fontSize: 10,
								padding: "2px 6px",
								borderRadius: 999,
								background: "rgba(48,209,88,0.18)",
								color: "#30d158",
								fontWeight: 600,
							}}
							title="Local embedding server is running"
						>
							● local
						</span>
					)}
					{llamaProgress && (
						<span
							style={{
								fontSize: 10,
								padding: "2px 6px",
								borderRadius: 999,
								background: "rgba(255,159,10,0.18)",
								color: "#ff9f0a",
								fontWeight: 600,
							}}
							title="Downloading the bundled embedding model"
						>
							⇣ embed model {llamaProgress.percent}%
						</span>
					)}
				</div>
				<div className="popup-actions" style={{ WebkitAppRegion: "no-drag" } as any}>
					<div className="appearance-wrap" ref={appearanceRef}>
						<button
							type="button"
							className="icon-btn"
							title="Appearance"
							onClick={() => setAppearancePopover((x) => !x)}
						>
							<Sun size={14} />
						</button>
						{appearancePopover && (
							<div className="popover">
								<div className="popover-section">
									<div className="popover-label">Theme</div>
									<div className="theme-toggle">
										{(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
											<button
												key={t}
												type="button"
												className={theme === t ? "active" : ""}
												onClick={() => changeTheme(t)}
											>
												{t}
											</button>
										))}
									</div>
								</div>
								<div className="popover-section">
									<div className="popover-label">Accent</div>
									<div className="accent-picker">
										{ACCENT_SWATCHES.map((s) => (
											<button
												key={s.value}
												type="button"
												className={accent === s.value ? "accent-swatch active" : "accent-swatch"}
												style={{ background: s.value }}
												title={s.name}
												onClick={() => changeAccent(s.value)}
											/>
										))}
									</div>
								</div>
							</div>
						)}
					</div>
					<button
						type="button"
						className={drawer === "settings" ? "icon-btn active" : "icon-btn"}
						title="Configuration"
						onClick={() => setDrawer((current) => current === "settings" ? null : "settings")}
					>
						<Settings size={14} />
					</button>
					<button
						type="button"
						className="icon-btn"
						title="Hide window"
						onClick={closeWindow}
					>
						<X size={14} />
					</button>
				</div>
			</header>
			<main className="popup-body hub-body">
				<ChannelRail
					channels={channels}
					activeView={activeView}
					onSelectView={setActiveView}
					onOpenChannelSettings={() => setDrawer((current) => current === "channels" ? null : "channels")}
				/>
				<div className="hub-main">
					{isHubToolView(activeView) ? (
						renderToolView(activeView, {
							focusTab: pendingActivityTab,
							onFocusApplied: () => setPendingActivityTab(null),
						})
					) : activeView === "inbox" ? (
						<InboxPane />
					) : activeView === "feed" ? (
						<GatewayPane />
					) : activeChannel ? (
						<ChannelView channel={activeChannel} />
					) : (
						<ChatView onOpenSettings={() => setDrawer("settings")} />
					)}
				</div>
				{drawer && (
					<div className="drawer">
						<div className="drawer-header electrobun-webkit-app-region-drag">
							<span className="popup-title">{drawer === "channels" ? "Messaging" : "Configuration"}</span>
							<button
								type="button"
								className="icon-btn"
								title="Close configuration"
								style={{ WebkitAppRegion: "no-drag" } as any}
								onClick={() => setDrawer(null)}
							>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
									<line x1="18" y1="6" x2="6" y2="18" />
									<line x1="6" y1="6" x2="18" y2="18" />
								</svg>
							</button>
						</div>
						<div className="drawer-body">
							{drawer === "channels" ? (
								<ChannelsView />
							) : (
								<SettingsView
									{...(settingsDeepLink ? { deepLink: settingsDeepLink } : {})}
									onConsumeDeepLink={() => setSettingsDeepLink(null)}
								/>
							)}
						</div>
					</div>
				)}
				<CommandPalette
					open={paletteOpen}
					onClose={() => setPaletteOpen(false)}
					onOpenSettings={(deepLink) => {
						setDrawer("settings");
						if (deepLink) setSettingsDeepLink(deepLink);
					}}
					onChatCommand={(command) => {
						// Round-trip through bun so the chat view picks
						// up the command via its onChatCommandRun
						// listener. Keeps behaviour identical regardless
						// of which window opened the palette.
						void rpc.send.chatCommandRun({ command });
					}}
				/>
			</main>
		</div>
	);
}
