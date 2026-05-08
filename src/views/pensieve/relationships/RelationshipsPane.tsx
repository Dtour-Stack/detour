import { useEffect, useState } from "react";
import type { PensieveEntitySummary, PensievePersonDetail } from "@detour/shared";
import type { WebClient } from "../../_shared/api/client";

export function RelationshipsPane({ client }: { client: WebClient }) {
	const [persons, setPersons] = useState<PensieveEntitySummary[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		client.pensievePersons(200).then(setPersons).catch((e) => setError(e.message));
	}, [client]);

	return (
		<div className="pensieve-split">
			<div className="pensieve-split-list">
				<div className="pensieve-toolbar">
					<span className="hint">{persons.length} person(s) / entities</span>
				</div>
				{error && <div className="banner error">{error}</div>}
				<div className="pensieve-list">
					{persons.map((p) => (
						<button
							key={p.id}
							type="button"
							className={selected === p.id ? "pensieve-list-row active" : "pensieve-list-row"}
							onClick={() => setSelected(p.id)}
						>
							<div className="pensieve-list-row-header">
								<strong>{p.name ?? p.id.slice(0, 8)}</strong>
								<span className="hint">{p.relationshipCount} rel</span>
								{p.lastSeen && <span className="hint">{new Date(p.lastSeen).toLocaleDateString()}</span>}
							</div>
							{p.tags.length > 0 && (
								<div className="row" style={{ flexWrap: "wrap", gap: 3, marginTop: 4 }}>
									{p.tags.slice(0, 5).map((t) => <span key={t} className="badge info">{t}</span>)}
								</div>
							)}
						</button>
					))}
					{persons.length === 0 && (
						<div className="empty">No relationships recorded yet.</div>
					)}
				</div>
			</div>
			<div className="pensieve-split-detail">
				{selected ? <PersonDetail client={client} entityId={selected} /> : (
					<div className="empty">Select a person to view their memories + relationships.</div>
				)}
			</div>
		</div>
	);
}

function PersonDetail({ client, entityId }: { client: WebClient; entityId: string }) {
	const [detail, setDetail] = useState<PensievePersonDetail | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setDetail(null); setError(null);
		client.pensievePerson(entityId).then(setDetail).catch((e) => setError(e.message));
	}, [client, entityId]);

	if (error) return <div className="banner error">{error}</div>;
	if (!detail) return <div className="hint">Loading…</div>;

	return (
		<div className="pensieve-detail">
			<div className="pensieve-detail-header">
				<div>
					<div className="pensieve-detail-title">{detail.entity.name ?? "(unnamed)"}</div>
					<div className="hint">{detail.entity.id}</div>
				</div>
			</div>

			<section className="pensieve-detail-section">
				<label>Stats</label>
				<div className="hint">
					{detail.entity.relationshipCount} relationship(s) · {detail.entity.memoryCount} memory(ies)
				</div>
				{detail.entity.tags.length > 0 && (
					<div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 6 }}>
						{detail.entity.tags.map((t) => <span key={t} className="badge info">{t}</span>)}
					</div>
				)}
			</section>

			<section className="pensieve-detail-section">
				<label>Relationships ({detail.relationships.length})</label>
				<div className="pensieve-detail-list">
					{detail.relationships.map((r) => (
						<div key={`${r.sourceEntityId}-${r.targetEntityId}`} className="pensieve-detail-list-row">
							<div className="hint" style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 }}>
								{r.sourceEntityId.slice(0, 8)} ↔ {r.targetEntityId.slice(0, 8)}
							</div>
							{r.tags.length > 0 && (
								<div className="row" style={{ flexWrap: "wrap", gap: 3, marginTop: 2 }}>
									{r.tags.map((t) => <span key={t} className="badge muted">{t}</span>)}
								</div>
							)}
						</div>
					))}
					{detail.relationships.length === 0 && <div className="hint">No relationships.</div>}
				</div>
			</section>

			<section className="pensieve-detail-section">
				<label>Memories ({detail.memories.length})</label>
				<div className="pensieve-detail-list">
					{detail.memories.map((m) => (
						<div key={m.id} className="pensieve-detail-list-row">
							<div className="pensieve-list-row-preview">{m.preview}</div>
							{m.createdAt && <div className="hint" style={{ marginTop: 2 }}>{new Date(m.createdAt).toLocaleString()}</div>}
						</div>
					))}
					{detail.memories.length === 0 && <div className="hint">No memories tied to this entity.</div>}
				</div>
			</section>
		</div>
	);
}
