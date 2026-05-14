import { useCallback, useEffect, useMemo, useState } from "react";
import type { GeneratedMediaItem, GeneratedMediaKind } from "../../shared/rpc/media";
import { rpc } from "../rpc";
import { useDetourTheme } from "../useDetourTheme";

type FilterKind = "all" | GeneratedMediaKind;

const KIND_OPTIONS: { id: FilterKind; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "image", label: "Pictures" },
	{ id: "video", label: "Videos" },
	{ id: "audio", label: "Audio" },
];

export function GalleryView({ embedded = false }: { embedded?: boolean } = {}) {
	useDetourTheme();
	const [kind, setKind] = useState<FilterKind>("all");
	const [provider, setProvider] = useState("all");
	const [items, setItems] = useState<GeneratedMediaItem[]>([]);
	const [root, setRoot] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const response = await rpc.request.mediaGalleryList({
				limit: 300,
				...(kind === "all" ? {} : { kind }),
				...(provider === "all" ? {} : { provider }),
			});
			setItems(response.items);
			setRoot(response.root);
			setSelectedId((current) => current && response.items.some((item) => item.id === current)
				? current
				: response.items[0]?.id ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [kind, provider]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const providers = useMemo(() => {
		const names = new Set(items.map((item) => item.provider));
		return [...names].sort((a, b) => a.localeCompare(b));
	}, [items]);
	const selected = items.find((item) => item.id === selectedId) ?? null;

	return (
		<div className={embedded ? "gallery-shell embedded" : "gallery-shell"}>
			<aside className="gallery-sidebar">
				<div className="window-brand">Gallery</div>
				<div className="gallery-filter-group">
					<div className="gallery-filter-label">Kind</div>
					<div className="gallery-segments">
						{KIND_OPTIONS.map((option) => (
							<button
								key={option.id}
								type="button"
								className={kind === option.id ? "active" : ""}
								onClick={() => setKind(option.id)}
							>
								{option.label}
							</button>
						))}
					</div>
				</div>
				<div className="gallery-filter-group">
					<label className="gallery-filter-label" htmlFor="gallery-provider">Provider</label>
					<select
						id="gallery-provider"
						className="pensieve-select"
						value={provider}
						onChange={(event) => setProvider(event.target.value)}
					>
						<option value="all">All providers</option>
						{providers.map((name) => (
							<option key={name} value={name}>{name}</option>
						))}
					</select>
				</div>
				<button type="button" className="btn small" onClick={() => void refresh()} disabled={loading}>
					{loading ? "Refreshing..." : "Refresh"}
				</button>
				{root && <div className="gallery-root">{root}</div>}
			</aside>
			<main className="gallery-main">
				<div className="gallery-toolbar">
					<div>
						<strong>{items.length}</strong>
						<span className="hint"> generated items</span>
					</div>
					{selected && (
						<button
							type="button"
							className="btn ghost small"
							onClick={() => void rpc.request.mediaGalleryReveal({ id: selected.id })}
						>
							Show in Finder
						</button>
					)}
				</div>
				{error && <div className="banner error">{error}</div>}
				<div className="gallery-content">
					<section className="gallery-grid" aria-label="Generated media">
						{items.map((item) => (
							<button
								key={item.id}
								type="button"
								className={item.id === selectedId ? "gallery-tile active" : "gallery-tile"}
								onClick={() => setSelectedId(item.id)}
							>
								<MediaPreview item={item} compact />
								<span className="gallery-tile-meta">
									<strong>{item.title}</strong>
									<span>{item.provider} · {relativeTime(item.createdAt)}</span>
								</span>
							</button>
						))}
						{!loading && items.length === 0 && (
							<div className="empty gallery-empty">No generated media yet.</div>
						)}
					</section>
					<aside className="gallery-detail">
						{selected ? (
							<>
								<MediaPreview item={selected} />
								<div className="gallery-detail-copy">
									<h3>{selected.title}</h3>
									<dl>
										<dt>Type</dt>
										<dd>{selected.kind}</dd>
										<dt>Provider</dt>
										<dd>{selected.provider}</dd>
										<dt>Capability</dt>
										<dd>{selected.capability}</dd>
										{selected.model && (
											<>
												<dt>Model</dt>
												<dd>{selected.model}</dd>
											</>
										)}
										<dt>Size</dt>
										<dd>{formatBytes(selected.bytes)}</dd>
										<dt>Created</dt>
										<dd>{new Date(selected.createdAt).toLocaleString()}</dd>
										{selected.prompt && (
											<>
												<dt>Prompt</dt>
												<dd>{selected.prompt}</dd>
											</>
										)}
										<dt>Path</dt>
										<dd>{selected.path}</dd>
									</dl>
								</div>
							</>
						) : (
							<div className="empty gallery-empty">Select an item.</div>
						)}
					</aside>
				</div>
			</main>
		</div>
	);
}

function MediaPreview({ item, compact = false }: { item: GeneratedMediaItem; compact?: boolean }) {
	if (item.kind === "image") {
		return <img className="gallery-media" src={item.url} alt={item.title} />;
	}
	if (item.kind === "video") {
		return (
			<video
				className="gallery-media"
				src={item.url}
				controls={!compact}
				preload="metadata"
				playsInline
				muted={compact}
			/>
		);
	}
	return (
		<div className="gallery-audio">
			<div className="gallery-audio-icon">AUDIO</div>
			{!compact && <audio src={item.url} controls preload="metadata" />}
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function relativeTime(time: number): string {
	const delta = Date.now() - time;
	if (!Number.isFinite(delta) || delta < 0) return "now";
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}
