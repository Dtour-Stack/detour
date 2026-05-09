import { useEffect, useRef, useState } from "react";
import type { ChannelStatus, ThemeChoice } from "../../shared/index";
import { ChatView } from "./ChatView";
import { ChannelRail, type HubView } from "./ChannelRail";
import { ChannelView } from "./ChannelView";
import { SettingsView } from "../settings/SettingsView";
import { rpc } from "../rpc";
import { onUiOpenSettings } from "../rpc-listeners/chat";
import { onProviderChanged } from "../rpc-listeners/providers";

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
};

export function App() {
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [theme, setTheme] = useState<ThemeChoice>("system");
	const [accent, setAccent] = useState("#0a84ff");
	const [appearancePopover, setAppearancePopover] = useState(false);
	const appearanceRef = useRef<HTMLDivElement>(null);
	const [activeProvider, setActiveProvider] = useState<string | null>(null);
	const [llamaReady, setLlamaReady] = useState<boolean | null>(null);
	const [llamaProgress, setLlamaProgress] = useState<{ percent: number; downloaded: number; total: number } | null>(null);
	const [activeView, setActiveView] = useState<HubView>("chat");
	const [channels, setChannels] = useState<ChannelStatus[]>([]);

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
		const t = setInterval(refresh, 6000);
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
		const offSettings = onUiOpenSettings(() => setDrawerOpen(true));
		const offProvider = onProviderChanged((m) => setActiveProvider(m.activeProvider));
		// Active provider for the header chip.
		void rpc.request.providersList({}).then((ps) => {
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
		const llamaTimer = setInterval(refreshLlama, 4_000);
		return () => {
			offSettings();
			offProvider();
			clearInterval(llamaTimer);
		};
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
				setDrawerOpen(false);
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

	const activeChannel = channels.find((c) => c.id === activeView);

	return (
		<div className="popup-shell hub-shell">
			<header className="popup-header electrobun-webkit-app-region-drag">
				<div className="popup-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span>Detour</span>
					{activeProvider && (
						<span
							style={{
								fontSize: 10,
								padding: "2px 8px",
								borderRadius: 999,
								background: "var(--accent, #0a84ff)",
								color: "white",
								opacity: 0.85,
								fontWeight: 600,
								letterSpacing: 0.3,
							}}
							title={`Active LLM provider: ${activeProvider}`}
						>
							via {PROVIDER_LABELS[activeProvider] ?? activeProvider}
						</span>
					)}
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
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<circle cx="12" cy="12" r="5" />
								<line x1="12" y1="1" x2="12" y2="3" />
								<line x1="12" y1="21" x2="12" y2="23" />
								<line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
								<line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
								<line x1="1" y1="12" x2="3" y2="12" />
								<line x1="21" y1="12" x2="23" y2="12" />
								<line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
								<line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
							</svg>
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
						className={drawerOpen ? "icon-btn active" : "icon-btn"}
						title="Configuration"
						onClick={() => setDrawerOpen((x) => !x)}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
						</svg>
					</button>
					<button
						type="button"
						className="icon-btn"
						title="Hide window"
						onClick={closeWindow}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			</header>
			<main className="popup-body hub-body">
				<div className="hub-main">
					{activeView === "chat" || !activeChannel ? (
						<ChatView onOpenSettings={() => setDrawerOpen(true)} />
					) : (
						<ChannelView channel={activeChannel} />
					)}
				</div>
				<ChannelRail
					channels={channels}
					activeView={activeView}
					onSelectView={setActiveView}
					onOpenChannelSettings={() => setDrawerOpen(true)}
				/>
				{drawerOpen && (
					<div className="drawer">
						<div className="drawer-header electrobun-webkit-app-region-drag">
							<span className="popup-title">Configuration</span>
							<button
								type="button"
								className="icon-btn"
								title="Close configuration"
								style={{ WebkitAppRegion: "no-drag" } as any}
								onClick={() => setDrawerOpen(false)}
							>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
									<line x1="18" y1="6" x2="6" y2="18" />
									<line x1="6" y1="6" x2="18" y2="18" />
								</svg>
							</button>
						</div>
						<div className="drawer-body">
							<SettingsView />
						</div>
					</div>
				)}
			</main>
		</div>
	);
}
