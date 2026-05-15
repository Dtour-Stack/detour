/**
 * Floating status widget — a small always-on-top overlay that shows
 * the agent's live state anywhere the user wants on their desktop.
 *
 * Compact (240×56) so it doesn't dominate the screen. Drag from
 * anywhere on the surface to reposition; double-click to open the
 * full chat window. Auto-hides while the chat window has focus
 * (handled bun-side via window blur/focus events).
 *
 * Renders:
 *   - Provider chip (active LLM)
 *   - Memory usage strip (color-coded)
 *   - Mode glyph: ● running, ◐ thinking, ○ stopped/error
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	LlamaMemoryBudgetWire,
	LlamaServerStatusWire,
} from "../../shared/rpc/llama";
import type { ProviderId, ProviderInfo } from "../../shared/index";
import { rpc } from "../rpc";

const POLL_MS = 4_000;

interface State {
	providers: ProviderInfo[];
	active: ProviderId | null;
	llama: LlamaServerStatusWire | null;
	memory: LlamaMemoryBudgetWire | null;
}

const EMPTY: State = { providers: [], active: null, llama: null, memory: null };

function providerLabel(id: ProviderId | null): string {
	if (!id) return "—";
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

export function StatusWidget() {
	const [state, setState] = useState<State>(EMPTY);
	const dragRef = useRef<{
		startX: number;
		startY: number;
		startWinX: number;
		startWinY: number;
	} | null>(null);

	const refresh = useCallback(async () => {
		const [pRes, lRes, mRes] = await Promise.allSettled([
			rpc.request.providersList({}),
			rpc.request.llamaStatus({}),
			rpc.request.llamaMemoryBudget({}),
		]);
		const providers = pRes.status === "fulfilled" ? pRes.value : [];
		setState({
			providers,
			active: providers.find((p) => p.active)?.id ?? null,
			llama: lRes.status === "fulfilled" ? lRes.value : null,
			memory: mRes.status === "fulfilled" ? mRes.value : null,
		});
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), POLL_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		// Drag from anywhere in the widget — request window-position
		// updates via the same RPC the pet uses. The bun-side handler
		// translates deltas into setPosition() calls.
		dragRef.current = {
			startX: e.screenX,
			startY: e.screenY,
			startWinX: 0,
			startWinY: 0,
		};
		(e.target as Element).setPointerCapture(e.pointerId);
	}, []);

	const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (!d) return;
		const dx = e.screenX - d.startX;
		const dy = e.screenY - d.startY;
		d.startX = e.screenX;
		d.startY = e.screenY;
		// Reuse the pet drag RPC — bun-side handler is keyed by which
		// window currently owns the drag handler. We register the
		// widget at feature load time the same way the pet does.
		void rpc.send.petWindowDrag({ dx, dy });
	}, []);

	const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		dragRef.current = null;
		(e.target as Element).releasePointerCapture(e.pointerId);
	}, []);

	const onDoubleClick = useCallback(() => {
		void rpc.request.windowOpen({ target: "chat" }).catch(() => {});
	}, []);

	const llamaRunning = state.llama?.running ?? false;
	const memBar = state.memory && state.memory.budgetGB > 0
		? {
				pct: Math.min(
					100,
					Math.round((state.memory.usedGB / state.memory.budgetGB) * 100),
				),
				label: `${state.memory.usedGB.toFixed(1)}/${state.memory.budgetGB.toFixed(1)} GB`,
			}
		: null;
	const tone = memBar
		? memBar.pct >= 90
			? "#ff453a"
			: memBar.pct >= 70
				? "#ff9f0a"
				: "#30d158"
		: "#30d158";

	return (
		<div
			className="status-widget"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onDoubleClick={onDoubleClick}
			title="Drag to move • double-click to open chat"
		>
			<style>{WIDGET_CSS}</style>
			<div className="sw-row">
				<span className={`sw-dot ${llamaRunning ? "on" : "off"}`} />
				<span className="sw-provider">{providerLabel(state.active)}</span>
			</div>
			{memBar && (
				<div className="sw-mem">
					<div className="sw-mem-track">
						<div
							className="sw-mem-fill"
							style={{ width: `${memBar.pct}%`, background: tone }}
						/>
					</div>
					<span className="sw-mem-label">{memBar.label}</span>
				</div>
			)}
		</div>
	);
}

const WIDGET_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }

.status-widget {
	--sw-bg: rgba(28, 28, 30, 0.92);
	--sw-fg: #f5f5f7;
	--sw-muted: rgba(245, 245, 247, 0.55);
	--sw-on: #30d158;
	--sw-off: #6e6e73;
	width: 240px;
	height: 56px;
	background: var(--sw-bg);
	color: var(--sw-fg);
	border-radius: 10px;
	padding: 8px 12px;
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-size: 12px;
	backdrop-filter: saturate(180%) blur(20px);
	-webkit-backdrop-filter: saturate(180%) blur(20px);
	cursor: grab;
	-webkit-app-region: drag;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.status-widget:active { cursor: grabbing; }

@media (prefers-color-scheme: light) {
	.status-widget {
		--sw-bg: rgba(248, 248, 250, 0.94);
		--sw-fg: #1d1d1f;
		--sw-muted: rgba(29, 29, 31, 0.55);
		--sw-off: #c7c7cc;
	}
}

.sw-row {
	display: flex;
	align-items: center;
	gap: 6px;
}
.sw-dot {
	width: 7px;
	height: 7px;
	border-radius: 999px;
	background: var(--sw-off);
}
.sw-dot.on {
	background: var(--sw-on);
	box-shadow: 0 0 6px rgba(48, 209, 88, 0.55);
}
.sw-provider {
	font-weight: 600;
	letter-spacing: -0.01em;
}
.sw-mem {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 10px;
	color: var(--sw-muted);
}
.sw-mem-track {
	flex: 1;
	height: 3px;
	background: rgba(120, 120, 128, 0.25);
	border-radius: 2px;
	overflow: hidden;
}
.sw-mem-fill {
	height: 100%;
	transition: width 200ms ease;
	border-radius: 2px;
}
.sw-mem-label {
	font-family: ui-monospace, "SF Mono", monospace;
	font-size: 9px;
	white-space: nowrap;
}
`;
