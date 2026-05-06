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
	const [draftPath, setDraftPath] = useState("");
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
				setDraftPath(d.path);
			})
			.catch((e) => { if (!cancelled) setError(e.message); });
		return () => { cancelled = true; };
	}, [client, memoryId]);

	async function save() {
		if (!detail) return;
		setSaving(true);
		try {
			const tags = draftTags.split(",").map((s) => s.trim()).filter(Boolean);
			await client.pensieveUpdateMemory(memoryId, { contentText: draftText, tags, path: draftPath });
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

			<ContentSection
				detail={detail}
				draftText={draftText}
				editing={editing}
				onDraftText={setDraftText}
			/>
			<PathSection
				detail={detail}
				draftPath={draftPath}
				editing={editing}
				onDraftPath={setDraftPath}
			/>
			<TagsSection
				detail={detail}
				draftTags={draftTags}
				editing={editing}
				onDraftTags={setDraftTags}
			/>
			<ProvenanceSection detail={detail} />
			<BacklinksSection detail={detail} memoryId={memoryId} />
		</div>
	);
}

function ContentSection({
	detail,
	draftText,
	editing,
	onDraftText,
}: {
	detail: PensieveMemoryDetail;
	draftText: string;
	editing: boolean;
	onDraftText: (value: string) => void;
}) {
	return (
		<section className="pensieve-detail-section">
			<label>Content</label>
			{editing ? (
				<textarea value={draftText} onChange={(e) => onDraftText(e.target.value)} rows={8} className="pensieve-textarea" />
			) : (
				<div className="pensieve-detail-content">{detail.content?.text ?? "(no text)"}</div>
			)}
		</section>
	);
}

function PathSection({
	detail,
	draftPath,
	editing,
	onDraftPath,
}: {
	detail: PensieveMemoryDetail;
	draftPath: string;
	editing: boolean;
	onDraftPath: (value: string) => void;
}) {
	return (
		<section className="pensieve-detail-section">
			<label>Path</label>
			{editing ? (
				<input type="text" value={draftPath} onChange={(e) => onDraftPath(e.target.value)} placeholder="/notes/projects" className="pensieve-input" />
			) : (
				<div className="pensieve-detail-content" style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
					{detail.path}
				</div>
			)}
		</section>
	);
}

function TagsSection({
	detail,
	draftTags,
	editing,
	onDraftTags,
}: {
	detail: PensieveMemoryDetail;
	draftTags: string;
	editing: boolean;
	onDraftTags: (value: string) => void;
}) {
	return (
		<section className="pensieve-detail-section">
			<label>Tags</label>
			{editing ? (
				<input type="text" value={draftTags} onChange={(e) => onDraftTags(e.target.value)} placeholder="comma, separated, tags" className="pensieve-input" />
			) : (
				<TagBadges tags={detail.tags ?? []} />
			)}
		</section>
	);
}

function TagBadges({ tags }: { tags: string[] }) {
	return (
		<div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
			{tags.length === 0
				? <span className="hint">no tags</span>
				: tags.map((tag) => <span key={tag} className="badge info">{tag}</span>)}
		</div>
	);
}

function ProvenanceSection({ detail }: { detail: PensieveMemoryDetail }) {
	return (
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
	);
}

function BacklinksSection({ detail, memoryId }: { detail: PensieveMemoryDetail; memoryId: string }) {
	if (!detail.backlinks || detail.backlinks.nodes.length <= 1) return null;
	return (
		<section className="pensieve-detail-section">
			<label>Backlinks</label>
			<div className="hint" style={{ marginBottom: 6 }}>
				{detail.backlinks.edges.length} link(s) to {detail.backlinks.nodes.length - 1} other node(s)
			</div>
			<div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
				{detail.backlinks.nodes
					.filter((node) => node.id !== `memory:${memoryId}`)
					.slice(0, 30)
					.map((node) => (
						<span key={node.id} className="badge muted" title={node.id}>
							{node.kind}: {node.label.slice(0, 40)}
						</span>
					))}
			</div>
		</section>
	);
}
