import { useCallback, useEffect, useMemo, useState } from "react";
import type { GeneratedMediaItem, GeneratedMediaKind } from "../../shared/rpc/media";
import type { CodexPetCatalogEntry } from "../../shared/rpc/pets";
import { rpc } from "../rpc";
import { useDetourTheme } from "../useDetourTheme";

type FilterKind = "all" | GeneratedMediaKind | "pets";

const KIND_OPTIONS: { id: FilterKind; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "image", label: "Pictures" },
	{ id: "video", label: "Videos" },
	{ id: "audio", label: "Audio" },
	{ id: "pets", label: "Pets" },
];

export function GalleryView({ embedded = false }: { embedded?: boolean } = {}) {
	useDetourTheme();
	const [kind, setKind] = useState<FilterKind>("all");
	const [provider, setProvider] = useState("all");
	const [items, setItems] = useState<GeneratedMediaItem[]>([]);
	const [pets, setPets] = useState<CodexPetCatalogEntry[]>([]);
	const [root, setRoot] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			if (kind === "pets") {
				// Pets live in a separate catalog (bundled + ~/.codex/pets/).
				// Calling petsList instead of mediaGalleryList keeps the two
				// paths cleanly separated — pets are sprites + atlas data,
				// generated media are files in the user's media folder.
				const response = await rpc.request.petsList({});
				setItems([]);
				setPets(response.pets);
				setSelectedId((current) =>
					current && response.pets.some((p) => p.id === current)
						? current
						: response.pets[0]?.id ?? null,
				);
				return;
			}
			const response = await rpc.request.mediaGalleryList({
				limit: 300,
				...(kind === "all" ? {} : { kind: kind as GeneratedMediaKind }),
				...(provider === "all" ? {} : { provider }),
			});
			setItems(response.items);
			setPets([]);
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
	const selectedPet = pets.find((p) => p.id === selectedId) ?? null;
	const isPetsTab = kind === "pets";

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
						<strong>{isPetsTab ? pets.length : items.length}</strong>
						<span className="hint">
							{isPetsTab ? " installed pets" : " generated items"}
						</span>
					</div>
					{!isPetsTab && selected && (
						<button
							type="button"
							className="btn ghost small"
							onClick={() => void rpc.request.mediaGalleryReveal({ id: selected.id })}
						>
							Show in Finder
						</button>
					)}
					{isPetsTab && selectedPet && (
						<button
							type="button"
							className="btn ghost small"
							onClick={() =>
								void rpc.request.petSpawn({ pet: selectedPet.id })
							}
						>
							Spawn this pet
						</button>
					)}
				</div>
				{error && <div className="banner error">{error}</div>}
				<div className="gallery-content">
					<section
						className="gallery-grid"
						aria-label={isPetsTab ? "Pets" : "Generated media"}
					>
						{isPetsTab
							? pets.map((p) => (
									<button
										key={p.id}
										type="button"
										className={p.id === selectedId ? "gallery-tile active" : "gallery-tile"}
										onClick={() => setSelectedId(p.id)}
									>
										<PetSpritePreview pet={p} compact />
										<span className="gallery-tile-meta">
											<strong>{p.displayName}</strong>
											<span>
												{p.bundled ? "bundled" : "user"} · {p.animations.length} animations
											</span>
										</span>
									</button>
								))
							: items.map((item) => (
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
						{!loading && !isPetsTab && items.length === 0 && (
							<div className="empty gallery-empty">No generated media yet.</div>
						)}
						{!loading && isPetsTab && pets.length === 0 && (
							<div className="empty gallery-empty">
								No pets installed. Drop a pet folder into{" "}
								<code>build-assets/pets/&lt;id&gt;/</code> and rebuild, or
								place one in <code>~/.codex/pets/&lt;id&gt;/</code>.
							</div>
						)}
					</section>
					<aside className="gallery-detail">
						{isPetsTab && selectedPet ? (
							<PetDetail pet={selectedPet} />
						) : !isPetsTab && selected ? (
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

/**
 * Compact tile-side preview for a pet. Shows just the first frame of
 * the idle row (the most representative neutral pose).
 */
function PetSpritePreview({
	pet,
	compact = false,
}: {
	pet: CodexPetCatalogEntry;
	compact?: boolean;
}) {
	const atlas = pet.atlas;
	const cellW = atlas.cellWidth;
	const cellH = atlas.cellHeight;
	const idleRow = pet.animations.find((a) => a.state === "idle") ?? pet.animations[0];
	if (!idleRow) {
		return <div className="gallery-audio">Sprite</div>;
	}
	const previewSize = compact ? 96 : 192;
	const scale = previewSize / cellW;
	return (
		<div
			className="gallery-media"
			style={{
				width: previewSize,
				height: previewSize * (cellH / cellW),
				backgroundImage: `url(${pet.spritesheetUrl})`,
				backgroundSize: `${atlas.width * scale}px ${atlas.height * scale}px`,
				backgroundPosition: `0px -${idleRow.row * cellH * scale}px`,
				backgroundRepeat: "no-repeat",
				imageRendering: "pixelated",
			}}
			aria-label={`${pet.displayName} idle frame`}
		/>
	);
}

/**
 * Detail pane for a selected pet. Renders the full spritesheet, every
 * animation row labelled with its purpose, atlas geometry, and the
 * pet.json metadata. Lets the user inspect what a pet has BEFORE
 * spawning it. The "Spawn this pet" button in the toolbar is the
 * action surface; this pane is read-only.
 */
function PetDetail({ pet }: { pet: CodexPetCatalogEntry }) {
	const atlas = pet.atlas;
	const cellW = atlas.cellWidth;
	const cellH = atlas.cellHeight;
	const stripWidth = 320;
	return (
		<div className="gallery-detail-copy">
			<h3>{pet.displayName}</h3>
			<div
				className="gallery-media"
				style={{
					backgroundImage: `url(${pet.spritesheetUrl})`,
					backgroundSize: "contain",
					backgroundRepeat: "no-repeat",
					backgroundPosition: "center",
					width: "100%",
					aspectRatio: `${atlas.width} / ${atlas.height}`,
					imageRendering: "pixelated",
					marginBottom: 12,
				}}
				aria-label={`${pet.displayName} full spritesheet`}
			/>
			<dl>
				<dt>ID</dt>
				<dd><code>{pet.id}</code></dd>
				<dt>Source</dt>
				<dd>{pet.bundled ? "Bundled with Detour" : "User (~/.codex/pets)"}</dd>
				{pet.description && (
					<>
						<dt>Description</dt>
						<dd>{pet.description}</dd>
					</>
				)}
				<dt>Atlas</dt>
				<dd>
					{atlas.columns}×{atlas.rows} grid, {atlas.cellWidth}×{atlas.cellHeight} cells (
					{atlas.width}×{atlas.height} total)
				</dd>
				<dt>Spritesheet</dt>
				<dd style={{ wordBreak: "break-all" }}>
					<code>{pet.spritesheetUrl}</code>
				</dd>
				<dt>Path on disk</dt>
				<dd style={{ wordBreak: "break-all" }}>
					<code>{pet.spritesheetPath}</code>
				</dd>
			</dl>
			<h4 style={{ marginTop: 16 }}>Animations</h4>
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				{pet.animations.map((row) => {
					const scale = stripWidth / (cellW * row.frames);
					return (
						<div
							key={row.state}
							style={{
								display: "flex",
								gap: 12,
								alignItems: "center",
							}}
						>
							<div
								aria-label={`${row.state} animation row`}
								style={{
									backgroundImage: `url(${pet.spritesheetUrl})`,
									backgroundSize: `${atlas.width * scale}px ${atlas.height * scale}px`,
									backgroundPosition: `0px -${row.row * cellH * scale}px`,
									backgroundRepeat: "no-repeat",
									width: stripWidth,
									height: cellH * scale,
									imageRendering: "pixelated",
									flexShrink: 0,
								}}
							/>
							<div style={{ fontSize: 12, lineHeight: 1.4 }}>
								<div>
									<strong>{row.state}</strong>{" "}
									<span style={{ opacity: 0.6 }}>
										· row {row.row} · {row.frames}f
									</span>
								</div>
								<div style={{ opacity: 0.7 }}>{row.purpose}</div>
							</div>
						</div>
					);
				})}
			</div>
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
