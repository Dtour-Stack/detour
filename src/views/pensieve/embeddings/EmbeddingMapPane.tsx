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
import type { WebClient } from "../../_shared/api/client";

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

export function EmbeddingMapPane({ client }: { client: WebClient }) {
	const [data, setData] = useState<PensieveEmbeddingMap | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [hovered, setHovered] = useState<PensieveEmbeddingPoint | null>(null);
	const [size, setSize] = useState({ w: 800, h: 600 });
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		client.pensieveEmbeddingMap()
			.then(setData)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)));
	}, [client]);

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

	return (
		<div className="embedding-map">
			<div className="pensieve-toolbar">
				<span className="hint">{data.count} embeddings · {data.points[0]?.dim}D · random projection</span>
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
			<div className="embedding-map-canvas" ref={containerRef}>
				<svg width={w} height={h}>
					<rect x={0} y={0} width={w} height={h} fill="var(--bg)" />
					{points.map((p) => (
						<circle
							key={p.memoryId}
							cx={p.px}
							cy={p.py}
							r={hovered?.memoryId === p.memoryId ? 7 : 4}
							fill={p.color}
							opacity={hovered && hovered.memoryId !== p.memoryId ? 0.35 : 0.9}
							onMouseEnter={() => setHovered(p)}
							onMouseLeave={() => setHovered(null)}
							style={{ cursor: "pointer", transition: "r 0.1s ease" }}
						>
							<title>{p.path}\n{p.preview}</title>
						</circle>
					))}
				</svg>
				{hovered && (
					<div className="embedding-map-tooltip">
						<div className="embedding-map-tooltip-path">{hovered.path}</div>
						<div className="embedding-map-tooltip-preview">{hovered.preview}</div>
					</div>
				)}
			</div>
		</div>
	);
}
