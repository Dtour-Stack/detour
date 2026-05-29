/**
 * Settings → Tray
 *
 * User-configurable bits of the menu-bar surface:
 *   - Quick-action grid (2×3) — pick which six destinations the tray
 *     popover shows. Click a slot to cycle through choices.
 *   - Status pills — hide pills the user doesn't care about (e.g.
 *     hide "Companion" on a 16 GB Mac where it's intentionally off).
 *   - Status label mode — terse `● Claude` vs verbose
 *     `● Detour: Claude + local embeds`.
 *   - Status widget toggle — opt into the floating overlay (see
 *     src/main/status-widget/).
 */

import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_TRAY_PREFS,
	DEFAULT_TRAY_SLOTS,
	type TrayPrefs,
	type TraySlot,
	type TrayStatusLabelMode,
} from "../../shared/index";
import { TRAY_SLOT_CHOICES, traySlotMeta } from "../../shared/window-targets";
import { rpc } from "../rpc";

function slotMeta(id: TraySlot) {
	return traySlotMeta(id);
}

export function TrayTab() {
	const [prefs, setPrefs] = useState<TrayPrefs | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedTick, setSavedTick] = useState(0);

	useEffect(() => {
		void rpc.request.configGetTrayPrefs({}).then(setPrefs).catch(() => {
			setPrefs({ ...DEFAULT_TRAY_PREFS, slots: [...DEFAULT_TRAY_SLOTS] });
		});
	}, []);

	const persist = useCallback(async (next: TrayPrefs) => {
		setPrefs(next);
		setSaving(true);
		try {
			const sanitized = await rpc.request.configSetTrayPrefs(next);
			setPrefs(sanitized);
			setSavedTick((t) => t + 1);
		} catch {
			/* swallow */
		} finally {
			setSaving(false);
		}
	}, []);

	const cycleSlot = useCallback(
		(index: number) => {
			if (!prefs) return;
			const current = prefs.slots[index];
			const taken = new Set(prefs.slots);
			// Find the next choice not already pinned elsewhere in the grid.
			const choices = [...TRAY_SLOT_CHOICES];
			const startAt = current ? choices.indexOf(current) : -1;
			for (let i = 1; i <= choices.length; i += 1) {
				const candidate = choices[(startAt + i) % choices.length]!;
				if (!taken.has(candidate) || candidate === current) {
					const nextSlots = [...prefs.slots];
					nextSlots[index] = candidate;
					void persist({ ...prefs, slots: nextSlots });
					return;
				}
			}
		},
		[prefs, persist],
	);

	const resetSlots = useCallback(() => {
		if (!prefs) return;
		void persist({ ...prefs, slots: [...DEFAULT_TRAY_SLOTS] });
	}, [prefs, persist]);

	const togglePill = useCallback(
		(pill: keyof TrayPrefs["pillsVisible"]) => {
			if (!prefs) return;
			void persist({
				...prefs,
				pillsVisible: {
					...prefs.pillsVisible,
					[pill]: !prefs.pillsVisible[pill],
				},
			});
		},
		[prefs, persist],
	);

	const setLabelMode = useCallback(
		(mode: TrayStatusLabelMode) => {
			if (!prefs) return;
			void persist({ ...prefs, statusLabelMode: mode });
		},
		[prefs, persist],
	);

	const toggleWidget = useCallback(() => {
		if (!prefs) return;
		void persist({ ...prefs, statusWidgetEnabled: !prefs.statusWidgetEnabled });
	}, [prefs, persist]);

	if (!prefs) {
		return (
			<div className="settings-pane" style={{ padding: 16 }}>
				<h2 style={{ margin: 0 }}>Tray</h2>
				<p style={{ opacity: 0.6, fontSize: 12, marginTop: 8 }}>Loading…</p>
			</div>
		);
	}

	return (
		<div className="settings-pane" style={{ padding: 16 }}>
			<header style={{ marginBottom: 16 }}>
				<h2 style={{ margin: 0 }}>Tray</h2>
				<div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
					Customize the menu-bar popover: pick which six destinations
					sit in the quick-action grid, hide status pills you don't
					use, and choose a terse or verbose menu-bar label.
				</div>
				{savedTick > 0 && !saving && (
					<div style={{ fontSize: 11, color: "#30d158", marginTop: 4 }}>
						✓ saved
					</div>
				)}
			</header>

			{/* Slots */}
			<section
				style={{
					border: "1px solid var(--border, #333)",
					borderRadius: 8,
					padding: 14,
					marginBottom: 14,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						marginBottom: 8,
					}}
				>
					<strong>Quick-action grid</strong>
					<button type="button" onClick={resetSlots} style={{ fontSize: 11 }}>
						Reset to defaults
					</button>
				</div>
				<div style={{ fontSize: 11, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 }}>
					Click any slot to cycle through window targets. The grid is
					2×3 in the popover; duplicates are auto-skipped.
				</div>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(3, 1fr)",
						gap: 6,
						maxWidth: 280,
					}}
				>
					{prefs.slots.slice(0, 6).map((slot, idx) => {
						const meta = slotMeta(slot);
						return (
							<button
								type="button"
								key={`${slot}-${idx}`}
								onClick={() => cycleSlot(idx)}
								disabled={saving}
								style={{
									display: "flex",
									flexDirection: "column",
									alignItems: "center",
									gap: 4,
									padding: "10px 8px",
									background: "rgba(120,120,128,0.12)",
									border: "1px solid var(--border, rgba(255,255,255,0.06))",
									borderRadius: 8,
									cursor: "pointer",
									fontSize: 11,
								}}
							>
								<span style={{ fontSize: 18 }}>{meta.icon}</span>
								<span style={{ opacity: 0.85 }}>{meta.label}</span>
							</button>
						);
					})}
				</div>
				<div style={{ fontSize: 10, opacity: 0.45, marginTop: 8 }}>
					Available: {TRAY_SLOT_CHOICES.map((slot) => slotMeta(slot).label).join(", ")}
				</div>
			</section>

			{/* Pills */}
			<section
				style={{
					border: "1px solid var(--border, #333)",
					borderRadius: 8,
					padding: 14,
					marginBottom: 14,
				}}
			>
				<strong style={{ display: "block", marginBottom: 8 }}>
					Status pills
				</strong>
				<div style={{ fontSize: 11, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 }}>
					Three live state indicators in the popover header — show
					only the ones you care about.
				</div>
				{([
					["embed", "Embed (always-on local embeddings)"],
					["chat", "Chat (optional local-chat tier)"],
					["companion", "Companion (small sidecar model)"],
				] as const).map(([key, label]) => (
					<label
						key={key}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							padding: "4px 0",
							cursor: "pointer",
							fontSize: 12,
						}}
					>
						<input
							type="checkbox"
							checked={prefs.pillsVisible[key]}
							onChange={() => togglePill(key)}
							disabled={saving}
						/>
						{label}
					</label>
				))}
			</section>

			{/* Status label */}
			<section
				style={{
					border: "1px solid var(--border, #333)",
					borderRadius: 8,
					padding: 14,
					marginBottom: 14,
				}}
			>
				<strong style={{ display: "block", marginBottom: 8 }}>
					Menu-bar status label
				</strong>
				<div style={{ fontSize: 11, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 }}>
					Shown next to the tray icon. Terse trades context for
					screen space.
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					{(["terse", "verbose"] as TrayStatusLabelMode[]).map((mode) => (
						<button
							key={mode}
							type="button"
							onClick={() => setLabelMode(mode)}
							disabled={saving}
							style={{
								flex: 1,
								padding: "8px 12px",
								background:
									prefs.statusLabelMode === mode
										? "var(--accent, #0a84ff)"
										: "rgba(120,120,128,0.12)",
								color: prefs.statusLabelMode === mode ? "white" : "inherit",
								border: "none",
								borderRadius: 6,
								cursor: "pointer",
								fontSize: 12,
							}}
						>
							<div style={{ fontWeight: 600 }}>{mode}</div>
							<div style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>
								{mode === "terse" ? "● Claude" : "● Detour: Claude + local embeds"}
							</div>
						</button>
					))}
				</div>
			</section>

			{/* Status widget */}
			<section
				style={{
					border: "1px solid var(--border, #333)",
					borderRadius: 8,
					padding: 14,
				}}
			>
				<strong style={{ display: "block", marginBottom: 8 }}>
					Floating status widget
				</strong>
				<div style={{ fontSize: 11, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 }}>
					Pin a small always-on-top overlay showing live agent state
					anywhere on screen. Drag to reposition; auto-hides while
					the chat window is focused.
				</div>
				<label
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						cursor: "pointer",
						fontSize: 12,
					}}
				>
					<input
						type="checkbox"
						checked={prefs.statusWidgetEnabled}
						onChange={toggleWidget}
						disabled={saving}
					/>
					Show status widget
				</label>
			</section>
		</div>
	);
}
