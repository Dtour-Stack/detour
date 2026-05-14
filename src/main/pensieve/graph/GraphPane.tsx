import { useEffect, useMemo, useRef, useState } from "react";
import type { PensieveGraphSnapshot, PensieveGraphNode, PensieveGraphEdge } from "../../../shared/index";
import { rpc } from "../../rpc";
import { MemoryDetail } from "../memories/MemoryDetail";

const KIND_COLORS: Record<string, string> = {
	memory: "var(--accent)",
	entity: "var(--ok)",
};

interface PositionedNode extends PensieveGraphNode {
	x: number;
	y: number;
}

/**
 * Lightweight force-directed graph rendered to an SVG canvas. No external lib —
 * we run a few iterations of Fruchterman-Reingold ourselves. Good enough for
 * up to ~500 nodes; beyond that the user should filter.
 */
export function GraphPane() {
	const [snap, setSnap] = useState<PensieveGraphSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [hovered, setHovered] = useState<string | null>(null);
	const [selected, setSelected] = useState<PositionedNode | null>(null);
	const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
	const containerRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
	const [size, setSize] = useState({ w: 800, h: 600 });

	useEffect(() => {
		rpc.request.pensieveGraph({}).then(setSnap).catch((e) => setError(e.message));
	}, []);

	useEffect(() => {
		if (!containerRef.current) return;
		const obs = new ResizeObserver((entries) => {
			const { width, height } = entries[0]!.contentRect;
			setSize({ w: Math.max(400, width), h: Math.max(300, height) });
		});
		obs.observe(containerRef.current);
		return () => obs.disconnect();
	}, []);

	const layout = useMemo(() => snap ? simulate(snap.nodes, snap.edges, size.w, size.h) : null, [snap, size.w, size.h]);

	if (error) return <div className="banner error">{error}</div>;
	if (!snap) return <div className="hint" style={{ padding: 12 }}>Building graph…</div>;
	if (snap.nodes.length === 0) {
		return <div className="empty">No nodes yet — chat with the agent to populate memories + relationships.</div>;
	}

	const nodeById = new Map(layout?.map((n) => [n.id, n]) ?? []);
	const selectedMemoryId = selected?.kind === "memory" ? selected.id.replace(/^memory:/, "") : null;

	function zoom(event: React.WheelEvent<SVGSVGElement>) {
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		const mx = event.clientX - rect.left;
		const my = event.clientY - rect.top;
		setTransform((current) => {
			const nextScale = Math.max(0.35, Math.min(3, current.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
			const worldX = (mx - current.x) / current.scale;
			const worldY = (my - current.y) / current.scale;
			return {
				scale: nextScale,
				x: mx - worldX * nextScale,
				y: my - worldY * nextScale,
			};
		});
	}

	function startPan(event: React.PointerEvent<SVGRectElement>) {
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			originX: transform.x,
			originY: transform.y,
		};
	}

	function movePan(event: React.PointerEvent<SVGRectElement>) {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		setTransform((current) => ({
			...current,
			x: drag.originX + event.clientX - drag.x,
			y: drag.originY + event.clientY - drag.y,
		}));
	}

	function endPan(event: React.PointerEvent<SVGRectElement>) {
		const drag = dragRef.current;
		if (drag?.pointerId === event.pointerId) dragRef.current = null;
	}

	return (
		<div className="pensieve-graph">
			<div className="pensieve-toolbar">
				<span className="hint">
					{snap.stats.memories} memories · {snap.stats.entities} entities · {snap.stats.edges} edges
				</span>
				<button type="button" className="link" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>
					Reset view
				</button>
				{hovered && (
					<span className="hint" style={{ marginLeft: "auto", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 }}>
						{hovered}
					</span>
				)}
			</div>
			<div className={selected ? "pensieve-graph-body with-detail" : "pensieve-graph-body"}>
				<div ref={containerRef} className="pensieve-graph-canvas">
					<svg width={size.w} height={size.h} onWheel={zoom}>
						<rect
							x={0}
							y={0}
							width={size.w}
							height={size.h}
							fill="var(--bg)"
							onPointerDown={startPan}
							onPointerMove={movePan}
							onPointerUp={endPan}
							onPointerCancel={endPan}
						/>
						<g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
							{snap.edges.map((e, i) => {
								const a = nodeById.get(e.source);
								const b = nodeById.get(e.target);
								if (!a || !b) return null;
								return (
									<line
										key={i}
										x1={a.x} y1={a.y} x2={b.x} y2={b.y}
										stroke="rgba(127,127,127,0.25)"
										strokeWidth={Math.max(1, e.weight ?? 1)}
									/>
								);
							})}
							{layout?.map((n) => (
								<g
									key={n.id}
									onMouseEnter={() => setHovered(n.label)}
									onMouseLeave={() => setHovered(null)}
									onClick={() => setSelected(n)}
									style={{ cursor: "pointer" }}
								>
									<circle
										cx={n.x} cy={n.y}
										r={n.kind === "entity" ? 8 : 5}
										fill={KIND_COLORS[n.kind] ?? "var(--fg-muted)"}
										stroke={selected?.id === n.id ? "var(--fg)" : "var(--bg)"}
										strokeWidth={selected?.id === n.id ? 2 : 1}
									/>
									{n.kind === "entity" && (
										<text x={n.x + 10} y={n.y + 4} fontSize={11} fill="var(--fg-muted)">
											{n.label.slice(0, 20)}
										</text>
									)}
								</g>
							))}
						</g>
					</svg>
				</div>
				{selected && (
					<aside className="pensieve-graph-detail">
						<div className="pensieve-toolbar">
							<strong>{selected.kind === "memory" ? "Memory" : "Entity"}</strong>
							<button type="button" className="link" onClick={() => setSelected(null)}>Close</button>
						</div>
						{selectedMemoryId ? (
							<MemoryDetail memoryId={selectedMemoryId} onDelete={() => setSelected(null)} onUpdate={() => {}} />
						) : (
							<div className="pensieve-detail">
								<div className="pensieve-detail-title">{selected.label}</div>
								<div className="pensieve-detail-section">
									<label>ID</label>
									<div className="pensieve-detail-content">{selected.id}</div>
								</div>
							</div>
						)}
					</aside>
				)}
			</div>
		</div>
	);
}

/**
 * Quick & dirty force-directed: random init, ~80 iterations of repulsion +
 * spring attraction. Fine for ≤ 500 nodes; we're not solving the n-body
 * problem here.
 */
function simulate(nodes: PensieveGraphNode[], edges: PensieveGraphEdge[], w: number, h: number): PositionedNode[] {
	const N = nodes.length;
	if (N === 0) return [];
	const k = Math.sqrt((w * h) / N) * 0.7;
	const positioned: PositionedNode[] = nodes.map((n, i) => ({
		...n,
		// Sunflower-pattern init for stability.
		x: w / 2 + (Math.cos(i * 2.4) * Math.sqrt(i)) * 12,
		y: h / 2 + (Math.sin(i * 2.4) * Math.sqrt(i)) * 12,
	}));
	const idx = new Map(positioned.map((n, i) => [n.id, i]));
	const ITERATIONS = 80;
	for (let it = 0; it < ITERATIONS; it++) {
		const t = (1 - it / ITERATIONS) * 30; // cooling
		const disp = positioned.map(() => ({ x: 0, y: 0 }));
		// Repulsion (O(n²) — fine at N≤500).
		for (let i = 0; i < N; i++) {
			for (let j = i + 1; j < N; j++) {
				const dx = positioned[i]!.x - positioned[j]!.x;
				const dy = positioned[i]!.y - positioned[j]!.y;
				const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
				const force = (k * k) / dist;
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				disp[i]!.x += fx; disp[i]!.y += fy;
				disp[j]!.x -= fx; disp[j]!.y -= fy;
			}
		}
		// Attraction along edges.
		for (const e of edges) {
			const ai = idx.get(e.source); const bi = idx.get(e.target);
			if (ai == null || bi == null) continue;
			const dx = positioned[ai]!.x - positioned[bi]!.x;
			const dy = positioned[ai]!.y - positioned[bi]!.y;
			const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
			const force = (dist * dist) / k;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			disp[ai]!.x -= fx; disp[ai]!.y -= fy;
			disp[bi]!.x += fx; disp[bi]!.y += fy;
		}
		// Apply with cooling + bounds.
		for (let i = 0; i < N; i++) {
			const dx = disp[i]!.x; const dy = disp[i]!.y;
			const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
			positioned[i]!.x += (dx / dist) * Math.min(dist, t);
			positioned[i]!.y += (dy / dist) * Math.min(dist, t);
			positioned[i]!.x = Math.max(20, Math.min(w - 20, positioned[i]!.x));
			positioned[i]!.y = Math.max(20, Math.min(h - 20, positioned[i]!.y));
		}
	}
	return positioned;
}
