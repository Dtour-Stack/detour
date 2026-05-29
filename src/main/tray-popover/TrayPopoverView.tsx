/**
 * Tray popover — rich Octowatch/MeetingBar-style dropdown anchored to
 * the menu-bar tray icon. Replaces the bare native menu with a live
 * card: provider + embed + memory budget at a glance, quick actions
 * to jump to each window, switch provider inline, see the last few
 * trajectories, and quit.
 *
 * Lives in its own narrow BrowserWindow (320 × 480). Tray click → show
 * + reposition under icon → focus. Window `blur` → hide. The view
 * polls every 4s while visible (the bun-side broadcasts a few state
 * snapshots, but the popover is opened on demand and we want it fresh
 * the moment it appears).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	CompanionStatusWire,
	LlamaMemoryBudgetWire,
	LlamaServerStatusWire,
	LocalChatStatusWire,
} from "../../shared/rpc/llama";
import {
	DEFAULT_TRAY_PREFS,
	DEFAULT_TRAY_SLOTS,
	type ProviderId,
	type ProviderInfo,
	type TrayPrefs,
	type TraySlot,
} from "../../shared/index";
import { WINDOW_TARGET_META, traySlotMeta } from "../../shared/window-targets";
import { UI_POLL_INTERVAL_MS } from "../../shared/timing";
import { rpc } from "../rpc";
import { onTrayPrefsChanged } from "../rpc-listeners/config";

const POLL_MS = UI_POLL_INTERVAL_MS.trayStatus;

const ICONS = {
	quit: "⏻",
	provider: "✦",
};

interface Snapshot {
	providers: ProviderInfo[];
	activeProvider: ProviderId | null;
	llama: LlamaServerStatusWire | null;
	localChat: LocalChatStatusWire | null;
	companion: CompanionStatusWire | null;
	memory: LlamaMemoryBudgetWire | null;
	prefs: TrayPrefs;
	recentTrajectories: Array<{
		id: string;
		actionName?: string;
		startTime?: number;
		status?: string;
	}>;
}

const EMPTY_SNAPSHOT: Snapshot = {
	providers: [],
	activeProvider: null,
	llama: null,
	localChat: null,
	companion: null,
	memory: null,
	prefs: { ...DEFAULT_TRAY_PREFS, slots: [...DEFAULT_TRAY_SLOTS] },
	recentTrajectories: [],
};

function fmtRelative(ts?: number): string {
	if (!ts) return "—";
	const delta = Date.now() - ts;
	if (delta < 60_000) return "just now";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
	return `${Math.floor(delta / 86_400_000)}d`;
}

function providerLabel(id: ProviderId): string {
	switch (id) {
		case "anthropic":
			return "Claude";
		case "openai":
			return "Codex";
		case "openrouter":
			return "OpenRouter";
		case "elizacloud":
			return "Eliza Cloud";
	}
}

async function loadSnapshot(): Promise<Snapshot> {
	const [
		providersResult,
		llamaResult,
		chatResult,
		companionResult,
		memoryResult,
		trajectoriesResult,
		prefsResult,
	] = await Promise.allSettled([
		rpc.request.providersList({}),
		rpc.request.llamaStatus({}),
		rpc.request.localChatStatus({}),
		rpc.request.companionStatus({}),
		rpc.request.llamaMemoryBudget({}),
		rpc.request.activityTrajectoriesList({ limit: 5, offset: 0 }),
		rpc.request.configGetTrayPrefs({}),
	]);
	const providers =
		providersResult.status === "fulfilled" ? providersResult.value : [];
	const activeProvider = providers.find((p) => p.active)?.id ?? null;
	const prefs =
		prefsResult.status === "fulfilled"
			? prefsResult.value
			: { ...DEFAULT_TRAY_PREFS, slots: [...DEFAULT_TRAY_SLOTS] };
	return {
		providers,
		activeProvider,
		llama: llamaResult.status === "fulfilled" ? llamaResult.value : null,
		localChat: chatResult.status === "fulfilled" ? chatResult.value : null,
		companion:
			companionResult.status === "fulfilled" ? companionResult.value : null,
		memory: memoryResult.status === "fulfilled" ? memoryResult.value : null,
		prefs,
		recentTrajectories:
			trajectoriesResult.status === "fulfilled"
				? trajectoriesResult.value.trajectories.slice(0, 5).map((t) => ({
						id: t.id,
						...(t.source !== undefined ? { actionName: t.source } : {}),
						...(t.startTime !== undefined ? { startTime: t.startTime } : {}),
						...(t.status !== undefined ? { status: t.status } : {}),
					}))
				: [],
	};
}

export function TrayPopoverView() {
	const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
	const [providerMenuOpen, setProviderMenuOpen] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [dragging, setDragging] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const lastPointer = useRef<{ x: number; y: number } | null>(null);

	const refresh = useCallback(async () => {
		try {
			setSnap(await loadSnapshot());
		} catch {
			/* swallow — popover stays on last good snapshot */
		}
	}, []);

	useEffect(() => {
		void refresh();
		pollRef.current = setInterval(() => void refresh(), POLL_MS);
		const offPrefs = onTrayPrefsChanged((m) => {
			setSnap((prev) => ({ ...prev, prefs: m.prefs }));
		});
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
			offPrefs();
		};
	}, [refresh]);

	/* ── Drag-to-reposition ── */
	useEffect(() => {
		if (!dragging) return;
		const onMove = (event: PointerEvent) => {
			if (!lastPointer.current) return;
			const dx = event.screenX - lastPointer.current.x;
			const dy = event.screenY - lastPointer.current.y;
			lastPointer.current = { x: event.screenX, y: event.screenY };
			rpc.send.trayPopoverDrag({ dx, dy });
		};
		const onUp = () => {
			lastPointer.current = null;
			setDragging(false);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [dragging]);

	const switchProvider = useCallback(
		async (id: ProviderId) => {
			setSwitching(true);
			setProviderMenuOpen(false);
			try {
				await rpc.request.providersSetActive({ id });
				await refresh();
			} catch {
				/* swallow */
			} finally {
				setSwitching(false);
			}
		},
		[refresh],
	);

	const openWindow = useCallback(async (slot: TraySlot) => {
		try {
			await rpc.request.windowOpen({ target: slot });
		} catch {
			/* swallow */
		}
	}, []);

	const quit = useCallback(async () => {
		try {
			await rpc.request.appQuit({});
		} catch {
			/* swallow */
		}
	}, []);

	const memoryBar = useMemo(() => {
		const m = snap.memory;
		if (!m || m.budgetGB <= 0) return null;
		const pct = Math.min(100, Math.round((m.usedGB / m.budgetGB) * 100));
		const tone = pct >= 90 ? "#ff453a" : pct >= 70 ? "#ff9f0a" : "#30d158";
		return { pct, tone, label: `${m.usedGB.toFixed(1)} / ${m.budgetGB.toFixed(1)} GB` };
	}, [snap.memory]);

	const activeProviderInfo = snap.providers.find(
		(p) => p.id === snap.activeProvider,
	);
	const llamaRunning = snap.llama?.running ?? false;
	const chatRunning = snap.localChat?.running ?? false;
	const companionRunning = snap.companion?.running ?? false;
	const companionShared = snap.companion?.sharedWithLocalChat ?? false;

	return (
		<div className={`tray-popover${dragging ? " tp-dragging" : ""}`}>
			<style>{POPOVER_CSS}</style>

			{/* Header — identity + active provider chip + drag handle */}
			<header
				className="tp-header"
				onPointerDown={(event) => {
					lastPointer.current = { x: event.screenX, y: event.screenY };
					setDragging(true);
				}}
			>
				<div className="tp-header-left">
					<div className="tp-app-name">Detour</div>
					<div className="tp-app-sub">
						{activeProviderInfo
							? `via ${providerLabel(activeProviderInfo.id)}`
							: "no provider"}
					</div>
				</div>
				<button
					type="button"
					className="tp-provider-chip"
					onClick={() => setProviderMenuOpen((v) => !v)}
					onPointerDown={(event) => event.stopPropagation()}
					disabled={switching || snap.providers.length === 0}
				>
					<span className="tp-provider-dot" />
					{activeProviderInfo ? providerLabel(activeProviderInfo.id) : "—"}
					<span className="tp-chevron">▾</span>
				</button>
			</header>

			{providerMenuOpen && (
				<div className="tp-provider-menu">
					{snap.providers.map((p) => (
						<button
							type="button"
							key={p.id}
							className={`tp-provider-row ${p.active ? "active" : ""}`}
							onClick={() => switchProvider(p.id)}
							disabled={!p.hasKey && (p.oauthAccountCount ?? 0) === 0}
							title={
								!p.hasKey && (p.oauthAccountCount ?? 0) === 0
									? "Not configured — add a key or sign in via Settings"
									: ""
							}
						>
							<span className={`tp-provider-mark ${p.active ? "on" : ""}`} />
							<span className="tp-provider-name">{providerLabel(p.id)}</span>
							{!p.hasKey && (p.oauthAccountCount ?? 0) === 0 && (
								<span className="tp-provider-note">not set</span>
							)}
						</button>
					))}
				</div>
			)}

			{/* Status row — pills shown per user prefs (configGetTrayPrefs) */}
			{(snap.prefs.pillsVisible.embed ||
				snap.prefs.pillsVisible.chat ||
				snap.prefs.pillsVisible.companion) && (
				<div className="tp-status-row">
					{snap.prefs.pillsVisible.embed && (
						<StatusPill
							label="Embed"
							on={llamaRunning}
							hint={
								llamaRunning
									? "Local llama.cpp embeddings online"
									: snap.llama?.lastError ?? "Starting…"
							}
						/>
					)}
					{snap.prefs.pillsVisible.chat && (
						<StatusPill
							label="Chat"
							on={chatRunning}
							hint={
								chatRunning
									? `Local chat: ${snap.localChat?.preset ?? "—"}`
									: "Local chat off"
							}
						/>
					)}
					{snap.prefs.pillsVisible.companion && (
						<StatusPill
							label="Companion"
							on={companionRunning}
							hint={
								companionShared
									? "Companion sharing chat server (no extra RAM)"
									: companionRunning
										? `Companion: ${snap.companion?.preset ?? "—"}`
										: "Companion off"
							}
							badge={companionShared ? "shared" : undefined}
						/>
					)}
				</div>
			)}

			{/* Memory budget strip */}
			{memoryBar && (
				<div className="tp-memory">
					<div className="tp-memory-row">
						<span className="tp-memory-label">RAM</span>
						<span className="tp-memory-value">{memoryBar.label}</span>
					</div>
					<div className="tp-memory-track">
						<div
							className="tp-memory-fill"
							style={{ width: `${memoryBar.pct}%`, background: memoryBar.tone }}
						/>
					</div>
				</div>
			)}

			<button
				type="button"
				className="tp-capture"
				onClick={() => void rpc.request.windowOpen({ target: "capsule" })}
			>
				<span className="tp-capture-icon">{WINDOW_TARGET_META.capsule.icon}</span>
				<span className="tp-capture-text">{WINDOW_TARGET_META.capsule.label}</span>
				<span className="tp-capture-key">{WINDOW_TARGET_META.capsule.accelerator?.replace("CommandOrControl+", "⌘").replace("Shift+", "⇧")}</span>
			</button>

			{/* Quick actions grid — user-configurable, see Settings → Tray */}
			<div className="tp-grid">
				{snap.prefs.slots.slice(0, 6).map((slot, idx) => {
					const meta = traySlotMeta(slot);
					return (
						<GridButton
							key={`${slot}-${idx}`}
							icon={meta.icon}
							label={meta.label}
							onClick={() => openWindow(slot)}
						/>
					);
				})}
			</div>

			{/* Recent activity */}
			<div className="tp-section-title">Recent activity</div>
			<div className="tp-recent">
				{snap.recentTrajectories.length === 0 ? (
					<div className="tp-empty">No trajectories yet — start a chat.</div>
				) : (
					snap.recentTrajectories.map((t) => (
						<button
							type="button"
							key={t.id}
							className="tp-recent-row"
							onClick={() => openWindow("activity")}
						>
							<span className={`tp-recent-dot ${t.status ?? ""}`} />
							<span className="tp-recent-text">
								{t.actionName ?? "turn"}
							</span>
							<span className="tp-recent-time">{fmtRelative(t.startTime)}</span>
						</button>
					))
				)}
			</div>

			{/* Footer — refresh + quit */}
			<footer className="tp-footer">
				<button type="button" className="tp-footer-btn" onClick={() => void refresh()}>
					Refresh
				</button>
				<button type="button" className="tp-footer-btn quit" onClick={quit}>
					{ICONS.quit} Quit
				</button>
			</footer>
		</div>
	);
}

function StatusPill({
	label,
	on,
	hint,
	badge,
}: {
	label: string;
	on: boolean;
	hint: string;
	badge?: string;
}) {
	return (
		<div className={`tp-pill ${on ? "on" : "off"}`} title={hint}>
			<span className="tp-pill-dot" />
			<span className="tp-pill-label">{label}</span>
			{badge && <span className="tp-pill-badge">{badge}</span>}
		</div>
	);
}

function GridButton({
	icon,
	label,
	onClick,
}: {
	icon: string;
	label: string;
	onClick: () => void;
}) {
	return (
		<button type="button" className="tp-grid-btn" onClick={onClick}>
			<span className="tp-grid-icon">{icon}</span>
			<span className="tp-grid-label">{label}</span>
		</button>
	);
}

const POPOVER_CSS = `
:root {
	color-scheme: light dark;
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }

.tray-popover {
	--tp-bg: rgba(28, 28, 30, 0.96);
	--tp-fg: #f5f5f7;
	--tp-muted: rgba(245, 245, 247, 0.55);
	--tp-border: rgba(255, 255, 255, 0.08);
	--tp-accent: #0a84ff;
	--tp-on: #30d158;
	--tp-off: #6e6e73;
	--tp-warn: #ff9f0a;
	--tp-err: #ff453a;
	--tp-shared: #a5b4fc;
	width: 320px;
	min-height: 480px;
	background: var(--tp-bg);
	color: var(--tp-fg);
	font-size: 13px;
	padding: 12px 12px 8px;
	border-radius: 10px;
	user-select: none;
	-webkit-user-select: none;
	backdrop-filter: saturate(180%) blur(20px);
	-webkit-backdrop-filter: saturate(180%) blur(20px);
}

@media (prefers-color-scheme: light) {
	.tray-popover {
		--tp-bg: rgba(248, 248, 250, 0.96);
		--tp-fg: #1d1d1f;
		--tp-muted: rgba(29, 29, 31, 0.55);
		--tp-border: rgba(0, 0, 0, 0.08);
		--tp-off: #c7c7cc;
	}
}

/* Header */
.tp-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-bottom: 10px;
	cursor: grab;
	user-select: none;
	-webkit-user-select: none;
}
.tp-dragging .tp-header {
	cursor: grabbing;
}
.tp-app-name {
	font-weight: 600;
	font-size: 15px;
	letter-spacing: -0.01em;
}
.tp-app-sub {
	font-size: 11px;
	color: var(--tp-muted);
	margin-top: 1px;
}
.tp-provider-chip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 5px 10px;
	border-radius: 999px;
	background: rgba(120, 120, 128, 0.18);
	border: 1px solid var(--tp-border);
	color: var(--tp-fg);
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	transition: background 120ms ease;
}
.tp-provider-chip:hover:not(:disabled) {
	background: rgba(120, 120, 128, 0.28);
}
.tp-provider-chip:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.tp-provider-dot {
	width: 6px;
	height: 6px;
	border-radius: 999px;
	background: var(--tp-on);
}
.tp-chevron {
	font-size: 9px;
	opacity: 0.6;
}

/* Provider menu */
.tp-provider-menu {
	margin: 0 0 10px;
	padding: 4px;
	background: rgba(255, 255, 255, 0.04);
	border: 1px solid var(--tp-border);
	border-radius: 8px;
}
.tp-provider-row {
	width: 100%;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 8px;
	background: transparent;
	border: none;
	border-radius: 6px;
	color: var(--tp-fg);
	font-size: 12px;
	cursor: pointer;
	text-align: left;
}
.tp-provider-row:hover:not(:disabled) {
	background: rgba(120, 120, 128, 0.18);
}
.tp-provider-row:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.tp-provider-row.active .tp-provider-name {
	color: var(--tp-accent);
	font-weight: 600;
}
.tp-provider-mark {
	width: 6px;
	height: 6px;
	border-radius: 999px;
	background: var(--tp-off);
}
.tp-provider-mark.on {
	background: var(--tp-on);
}
.tp-provider-name {
	flex: 1;
}
.tp-provider-note {
	font-size: 10px;
	color: var(--tp-muted);
	font-style: italic;
}

/* Status row */
.tp-status-row {
	display: flex;
	gap: 6px;
	margin-bottom: 10px;
}
.tp-pill {
	flex: 1;
	display: inline-flex;
	align-items: center;
	gap: 5px;
	padding: 5px 8px;
	border-radius: 6px;
	background: rgba(120, 120, 128, 0.12);
	font-size: 11px;
	border: 1px solid transparent;
}
.tp-pill.on {
	border-color: rgba(48, 209, 88, 0.25);
}
.tp-pill-dot {
	width: 5px;
	height: 5px;
	border-radius: 999px;
	background: var(--tp-off);
}
.tp-pill.on .tp-pill-dot {
	background: var(--tp-on);
	box-shadow: 0 0 4px rgba(48, 209, 88, 0.5);
}
.tp-pill-label {
	flex: 1;
}
.tp-pill-badge {
	font-size: 9px;
	padding: 1px 5px;
	border-radius: 4px;
	background: rgba(165, 180, 252, 0.2);
	color: var(--tp-shared);
}

/* Memory */
.tp-memory {
	margin-bottom: 10px;
	padding: 8px 10px;
	background: rgba(120, 120, 128, 0.08);
	border-radius: 8px;
}
.tp-memory-row {
	display: flex;
	justify-content: space-between;
	font-size: 11px;
	margin-bottom: 4px;
}
.tp-memory-label {
	color: var(--tp-muted);
	font-weight: 500;
}
.tp-memory-value {
	font-family: ui-monospace, "SF Mono", monospace;
	font-size: 10px;
}
.tp-memory-track {
	height: 4px;
	background: rgba(120, 120, 128, 0.2);
	border-radius: 2px;
	overflow: hidden;
}
.tp-memory-fill {
	height: 100%;
	transition: width 200ms ease;
	border-radius: 2px;
}

.tp-capture {
	width: 100%;
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0 0 10px;
	padding: 9px 10px;
	border-radius: 8px;
	border: 1px solid rgba(10, 132, 255, 0.28);
	background: rgba(10, 132, 255, 0.14);
	color: var(--tp-fg);
	cursor: pointer;
}
.tp-capture:hover {
	background: rgba(10, 132, 255, 0.2);
}
.tp-capture-icon {
	width: 18px;
	height: 18px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 5px;
	background: rgba(10, 132, 255, 0.22);
	color: var(--tp-accent);
	font-size: 12px;
}
.tp-capture-text {
	flex: 1;
	font-size: 12px;
	font-weight: 600;
	text-align: left;
}
.tp-capture-key {
	font-size: 10px;
	color: var(--tp-muted);
}

/* Quick actions grid */
.tp-grid {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 6px;
	margin-bottom: 12px;
}
.tp-grid-btn {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	padding: 10px 8px;
	background: rgba(120, 120, 128, 0.12);
	border: 1px solid transparent;
	border-radius: 8px;
	color: var(--tp-fg);
	cursor: pointer;
	font: inherit;
	transition: background 120ms ease, transform 100ms ease;
}
.tp-grid-btn:hover {
	background: rgba(120, 120, 128, 0.22);
}
.tp-grid-btn:active {
	transform: scale(0.97);
}
.tp-grid-icon {
	font-size: 16px;
}
.tp-grid-label {
	font-size: 10px;
	color: var(--tp-muted);
}
.tp-grid-btn:hover .tp-grid-label {
	color: var(--tp-fg);
}

/* Section title */
.tp-section-title {
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--tp-muted);
	margin: 0 2px 4px;
}

/* Recent */
.tp-recent {
	display: flex;
	flex-direction: column;
	gap: 1px;
	margin-bottom: 10px;
}
.tp-empty {
	padding: 12px;
	font-size: 11px;
	color: var(--tp-muted);
	text-align: center;
	font-style: italic;
}
.tp-recent-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 5px 6px;
	background: transparent;
	border: none;
	border-radius: 5px;
	color: var(--tp-fg);
	font-size: 11px;
	cursor: pointer;
	text-align: left;
	width: 100%;
}
.tp-recent-row:hover {
	background: rgba(120, 120, 128, 0.14);
}
.tp-recent-dot {
	width: 5px;
	height: 5px;
	border-radius: 999px;
	background: var(--tp-off);
	flex-shrink: 0;
}
.tp-recent-dot.completed {
	background: var(--tp-on);
}
.tp-recent-dot.failed,
.tp-recent-dot.error {
	background: var(--tp-err);
}
.tp-recent-text {
	flex: 1;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}
.tp-recent-time {
	color: var(--tp-muted);
	font-size: 10px;
	font-family: ui-monospace, "SF Mono", monospace;
}

/* Footer */
.tp-footer {
	display: flex;
	gap: 4px;
	padding-top: 6px;
	border-top: 1px solid var(--tp-border);
	margin-top: 4px;
}
.tp-footer-btn {
	flex: 1;
	padding: 6px 10px;
	background: transparent;
	border: none;
	border-radius: 5px;
	color: var(--tp-fg);
	font-size: 11px;
	cursor: pointer;
}
.tp-footer-btn:hover {
	background: rgba(120, 120, 128, 0.16);
}
.tp-footer-btn.quit:hover {
	background: rgba(255, 69, 58, 0.15);
	color: var(--tp-err);
}
`;
