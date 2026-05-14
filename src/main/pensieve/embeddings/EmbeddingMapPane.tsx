/**
 * Pensieve > Embedding Map.
 *
 * 2D scatter plot of memory embeddings (Achlioptas random projection from
 * the eliza embeddings table — see PensieveEmbeddingMapService). Hover for
 * preview; click to open MemoryDetail. Color by source path (top-level
 * folder), so clusters of related memories should visually group.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PensieveEmbeddingMap, PensieveEmbeddingPoint } from "../../../shared/index";
import { rpc } from "../../rpc";
import { MemoryDetail } from "../memories/MemoryDetail";

const PALETTE = [
	"var(--accent)",
	"var(--ok)",
	"var(--warn)",
	"var(--info)",
	"#ff375f",
	"#bf5af2",
	"#64d2ff",
	"#30d158",
	"#ffd60a",
	"#ff9f0a",
];

function topFolder(path: string): string {
	const segs = path.split("/").filter(Boolean);
	return segs[0] ?? "uncategorized";
}

export function EmbeddingMapPane() {
	const [data, setData] = useState<PensieveEmbeddingMap | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [hovered, setHovered] = useState<PensieveEmbeddingPoint | null>(null);
	const [selected, setSelected] = useState<PensieveEmbeddingPoint | null>(null);
	const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
	const [size, setSize] = useState({ w: 800, h: 600 });
	const containerRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);

	useEffect(() => {
		rpc.request.pensieveEmbeddingMap({})
			.then(setData)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)));
	}, []);

	useEffect(() => {
		if (!containerRef.current) return;
		const obs = new ResizeObserver((entries) => {
			const r = entries[0]!.contentRect;
			setSize({ w: Math.max(400, r.width), h: Math.max(300, r.height) });
		});
		obs.observe(containerRef.current);
		return () => obs.disconnect();
	}, []);

	const colorByFolder = useMemo(() => {
		if (!data) return new Map<string, string>();
		const folders = Array.from(new Set(data.points.map((p) => topFolder(p.path))));
		folders.sort();
		const m = new Map<string, string>();
		folders.forEach((f, i) => m.set(f, PALETTE[i % PALETTE.length]!));
		return m;
	}, [data]);

	if (error) return <div className="banner error">{error}</div>;
	if (!data) return <div className="empty">Loading embeddings…</div>;
	if (!data.available) {
		return <div className="empty" style={{ margin: 24 }}>Database adapter not available — runtime not built yet.</div>;
	}
	if (data.points.length === 0) {
		return (
			<div className="empty" style={{ margin: 24, lineHeight: 1.6 }}>
				No embeddings yet. The agent stores embeddings when a real provider is configured —
				the default embedding-stub plugin doesn't populate vectors. Add a model with embeddings
				support (OpenAI text-embedding-3-*, Anthropic via voyage, etc.) and the map will fill in.
			</div>
		);
	}

	const padding = 30;
	const w = size.w;
	const h = size.h;
	const points = data.points.map((p) => ({
		...p,
		px: padding + ((p.x + 1) / 2) * (w - padding * 2),
		py: padding + ((p.y + 1) / 2) * (h - padding * 2),
		color: colorByFolder.get(topFolder(p.path)) ?? "var(--fg-muted)",
	}));

	function zoom(event: React.WheelEvent<SVGSVGElement>) {
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		const mx = event.clientX - rect.left;
		const my = event.clientY - rect.top;
		setTransform((current) => {
			const nextScale = Math.max(0.35, Math.min(5, current.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
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
		<div className="embedding-map">
			<div className="pensieve-toolbar">
				<span className="hint">{data.count} embeddings · {data.points[0]?.dim}D · random projection</span>
				<button type="button" className="link" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>
					Reset view
				</button>
				<span style={{ flex: 1 }} />
				{hovered && (
					<span className="hint" style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 }}>
						{topFolder(hovered.path)} · {hovered.path}
					</span>
				)}
			</div>
			<div className="embedding-map-legend">
				{Array.from(colorByFolder.entries()).map(([folder, color]) => (
					<span key={folder} className="embedding-map-legend-item">
						<span className="embedding-map-swatch" style={{ background: color }} />
						{folder}
					</span>
				))}
			</div>
			<div className={selected ? "embedding-map-body with-detail" : "embedding-map-body"}>
				<div className="embedding-map-canvas" ref={containerRef}>
					<svg width={w} height={h} onWheel={zoom}>
						<rect
							x={0}
							y={0}
							width={w}
							height={h}
							fill="var(--bg)"
							onPointerDown={startPan}
							onPointerMove={movePan}
							onPointerUp={endPan}
							onPointerCancel={endPan}
						/>
						<g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
							{points.map((p) => (
								<circle
									key={p.memoryId}
									cx={p.px}
									cy={p.py}
									r={hovered?.memoryId === p.memoryId ? 7 : 4}
									fill={p.color}
									opacity={hovered && hovered.memoryId !== p.memoryId ? 0.35 : 0.9}
									stroke={selected?.memoryId === p.memoryId ? "var(--fg)" : "transparent"}
									strokeWidth={selected?.memoryId === p.memoryId ? 2 : 0}
									onMouseEnter={() => setHovered(p)}
									onMouseLeave={() => setHovered(null)}
									onClick={() => setSelected(p)}
									style={{ cursor: "pointer", transition: "r 0.1s ease" }}
								>
									<title>{p.path}\n{p.preview}</title>
								</circle>
							))}
						</g>
					</svg>
					{hovered && (
						<div className="embedding-map-tooltip">
							<div className="embedding-map-tooltip-path">{hovered.path}</div>
							<div className="embedding-map-tooltip-preview">{hovered.preview}</div>
						</div>
					)}
				</div>
				{selected && (
					<aside className="embedding-map-detail">
						<div className="pensieve-toolbar">
							<strong>Memory</strong>
							<button type="button" className="link" onClick={() => setSelected(null)}>Close</button>
						</div>
						<MemoryDetail memoryId={selected.memoryId} onDelete={() => setSelected(null)} onUpdate={() => {}} />
					</aside>
				)}
			</div>
		</div>
	);
}
