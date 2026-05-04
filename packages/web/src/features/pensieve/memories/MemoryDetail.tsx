import { useEffect, useState } from "react";
import type { PensieveMemoryDetail } from "@detour/shared";
import type { WebClient } from "../../../api/client";

export function MemoryDetail({
	client,
	memoryId,
	onDelete,
	onUpdate,
}: {
	client: WebClient;
	memoryId: string;
	onDelete: () => void;
	onUpdate: () => void;
}) {
	const [detail, setDetail] = useState<PensieveMemoryDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [draftText, setDraftText] = useState("");
	const [draftTags, setDraftTags] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setDetail(null); setError(null); setEditing(false);
		client
			.pensieveMemory(memoryId)
			.then((d) => {
				if (cancelled) return;
				setDetail(d);
				setDraftText(d.content?.text ?? "");
				setDraftTags((d.tags ?? []).join(", "));
			})
			.catch((e) => { if (!cancelled) setError(e.message); });
		return () => { cancelled = true; };
	}, [client, memoryId]);

	async function save() {
		if (!detail) return;
		setSaving(true);
		try {
			const tags = draftTags.split(",").map((s) => s.trim()).filter(Boolean);
			await client.pensieveUpdateMemory(memoryId, { contentText: draftText, tags });
			setEditing(false);
			onUpdate();
			const fresh = await client.pensieveMemory(memoryId);
			setDetail(fresh);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}

	async function remove() {
		if (!confirm("Delete this memory? It can't be recovered.")) return;
		try {
			await client.pensieveDeleteMemory(memoryId);
			onDelete();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	if (error) return <div className="banner error">{error}</div>;
	if (!detail) return <div className="hint">Loading…</div>;

	return (
		<div className="pensieve-detail">
			<div className="pensieve-detail-header">
				<div>
					<div className="pensieve-detail-title">{detail.type ?? "memory"}</div>
					<div className="hint">{detail.id}</div>
				</div>
				<div className="row" style={{ gap: 6 }}>
					{!editing && (
						<>
							<button type="button" className="btn ghost small" onClick={() => setEditing(true)}>Edit</button>
							<button type="button" className="btn danger small" onClick={remove}>Delete</button>
						</>
					)}
					{editing && (
						<>
							<button type="button" className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
							<button type="button" className="btn small" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
						</>
					)}
				</div>
			</div>

			<section className="pensieve-detail-section">
				<label>Content</label>
				{editing ? (
					<textarea
						value={draftText}
						onChange={(e) => setDraftText(e.target.value)}
						rows={8}
						className="pensieve-textarea"
					/>
				) : (
					<div className="pensieve-detail-content">{detail.content?.text ?? "(no text)"}</div>
				)}
			</section>

			<section className="pensieve-detail-section">
				<label>Tags</label>
				{editing ? (
					<input
						type="text"
						value={draftTags}
						onChange={(e) => setDraftTags(e.target.value)}
						placeholder="comma, separated, tags"
						className="pensieve-input"
					/>
				) : (
					<div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
						{(detail.tags ?? []).length === 0
							? <span className="hint">no tags</span>
							: (detail.tags ?? []).map((t) => <span key={t} className="badge info">{t}</span>)}
					</div>
				)}
			</section>

			<section className="pensieve-detail-section">
				<label>Provenance</label>
				<div className="pensieve-detail-meta">
					{detail.entityId && <div><strong>entity</strong> {detail.entityId}</div>}
					{detail.roomId && <div><strong>room</strong> {detail.roomId}</div>}
					{detail.worldId && <div><strong>world</strong> {detail.worldId}</div>}
					{detail.createdAt && <div><strong>created</strong> {new Date(detail.createdAt).toLocaleString()}</div>}
					<div><strong>embedding</strong> {detail.hasEmbedding ? "✓ stored" : "—"}</div>
				</div>
			</section>

			{detail.backlinks && detail.backlinks.nodes.length > 1 && (
				<section className="pensieve-detail-section">
					<label>Backlinks</label>
					<div className="hint" style={{ marginBottom: 6 }}>
						{detail.backlinks.edges.length} link(s) to {detail.backlinks.nodes.length - 1} other node(s)
					</div>
					<div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
						{detail.backlinks.nodes
							.filter((n) => n.id !== `memory:${memoryId}`)
							.slice(0, 30)
							.map((n) => (
								<span key={n.id} className="badge muted" title={n.id}>
									{n.kind}: {n.label.slice(0, 40)}
								</span>
							))}
					</div>
				</section>
			)}
		</div>
	);
}
