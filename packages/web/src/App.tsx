import { useEffect, useMemo, useRef, useState } from "react";
import type { ThemeChoice } from "@detour/shared";
import { WebClient } from "./api/client";
import { ChatView } from "./features/chat/ChatView";
import { SettingsView } from "./features/settings/SettingsView";

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

export function App() {
	const client = useMemo(() => new WebClient(), []);
	const [connected, setConnected] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [theme, setTheme] = useState<ThemeChoice>("system");
	const [accent, setAccent] = useState("#0a84ff");
	const [appearancePopover, setAppearancePopover] = useState(false);
	const appearanceRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		client
			.connect()
			.then(() => setConnected(true))
			.catch((err) => console.error("connect failed:", err));
	}, [client]);

	useEffect(() => {
		if (!connected) return;
		client
			.getUiPreferences()
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
		// Listen for tray menu / global-shortcut requests to open settings.
		const off = client.on((m) => {
			if (m.kind === "ui:open-settings") setDrawerOpen(true);
		});
		return off;
	}, [client, connected]);

	// Pin window while drawer is open so click-out / focus loss doesn't dismiss.
	useEffect(() => {
		if (!connected) return;
		void client.pinWindow(drawerOpen);
	}, [client, connected, drawerOpen]);

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
		void client.setUiPreferences({ theme: next });
	}

	function changeAccent(next: string) {
		setAccent(next);
		applyAccent(next);
		void client.setUiPreferences({ accent: next });
	}

	function closeWindow() {
		void client.hideWindow();
	}

	if (!connected) {
		return (
			<div style={{ padding: 40, color: "var(--fg-muted)" }}>Connecting…</div>
		);
	}

	return (
		<div className="popup-shell">
			<header className="popup-header electrobun-webkit-app-region-drag">
				<div className="popup-title">Detour</div>
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
			<main className="popup-body">
				<ChatView client={client} onOpenSettings={() => setDrawerOpen(true)} />
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
							<SettingsView client={client} />
						</div>
					</div>
				)}
			</main>
		</div>
	);
}
