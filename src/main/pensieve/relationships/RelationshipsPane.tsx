import { useCallback, useEffect, useState } from "react";
import type { PensieveEntitySummary, PensievePersonDetail } from "../../../shared/index";
import { rpc } from "../../rpc";

export function RelationshipsPane() {
	const [persons, setPersons] = useState<PensieveEntitySummary[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [version, setVersion] = useState(0);
	const [busyId, setBusyId] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const next = await rpc.request.pensievePersonsList({ limit: 200 });
		setPersons(next);
	}, []);

	useEffect(() => {
		refresh().catch((e) => setError(e.message));
	}, [refresh]);

	const setTracked = useCallback(async (id: string, tracked: boolean) => {
		setBusyId(id);
		setError(null);
		try {
			await rpc.request.pensievePersonTrackSet({ id, tracked });
			await refresh();
			setVersion((value) => value + 1);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyId(null);
		}
	}, [refresh]);

	return (
		<div className="pensieve-split">
			<div className="pensieve-split-list">
				<div className="pensieve-toolbar">
					<span className="hint">{persons.length} person(s) / entities</span>
				</div>
				{error && <div className="banner error">{error}</div>}
				<div className="pensieve-list">
					{persons.map((p) => (
						<div
							key={p.id}
							className={selected === p.id ? "pensieve-list-row pensieve-person-row active" : "pensieve-list-row pensieve-person-row"}
						>
							<button type="button" className="pensieve-person-main" onClick={() => setSelected(p.id)}>
								<div className="pensieve-list-row-header">
									<strong>{p.name ?? p.id.slice(0, 8)}</strong>
									{p.tracked && <span className="badge ok">tracked</span>}
									{p.memberEntityIds.length > 1 && <span className="badge info">{p.memberEntityIds.length} ids</span>}
									{p.importanceScore !== undefined && <span className="badge ok">rank {p.importanceScore}</span>}
									<span className="hint">{p.relationshipCount} rel</span>
									{p.messageCount !== undefined && <span className="hint">{p.messageCount} msg</span>}
									{p.lastSeen && <span className="hint">{new Date(p.lastSeen).toLocaleDateString()}</span>}
								</div>
								{p.tags.length > 0 && (
									<div className="row" style={{ flexWrap: "wrap", gap: 3, marginTop: 4 }}>
										{p.tags.slice(0, 5).map((t) => <span key={t} className="badge info">{t}</span>)}
									</div>
								)}
							</button>
							<button
								type="button"
								className={p.tracked ? "btn small secondary" : "btn small"}
								disabled={busyId === p.id}
								onClick={() => void setTracked(p.id, !p.tracked)}
							>
								{p.tracked ? "Untrack" : "Track"}
							</button>
						</div>
					))}
					{persons.length === 0 && (
						<div className="empty">No relationships recorded yet.</div>
					)}
				</div>
			</div>
			<div className="pensieve-split-detail">
				{selected ? <PersonDetail entityId={selected} version={version} onTrackChange={setTracked} busy={busyId === selected} /> : (
					<div className="empty">Select a person to view their memories + relationships.</div>
				)}
			</div>
		</div>
	);
}

function PersonDetail({ entityId, version, onTrackChange, busy }: {
	entityId: string;
	version: number;
	onTrackChange: (id: string, tracked: boolean) => Promise<void>;
	busy: boolean;
}) {
	const [detail, setDetail] = useState<PensievePersonDetail | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setDetail(null);
		setError(null);
		let cancelled = false;
		void rpc.request
			.pensievePersonGet({ id: entityId })
			.then((d) => {
				if (!cancelled) setDetail(d);
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [entityId, version]);

	if (error) return <div className="banner error">{error}</div>;
	if (!detail) return <div className="hint">Loading…</div>;

	return (
		<div className="pensieve-detail">
			<div className="pensieve-detail-header">
				<div>
					<div className="pensieve-detail-title">{detail.entity.name ?? "(unnamed)"}</div>
					<div className="hint">{detail.entity.id}</div>
				</div>
				<button
					type="button"
					className={detail.entity.tracked ? "btn small secondary" : "btn small"}
					disabled={busy}
					onClick={() => void onTrackChange(detail.entity.id, !detail.entity.tracked)}
				>
					{detail.entity.tracked ? "Untrack" : "Track"}
				</button>
			</div>

			<section className="pensieve-detail-section">
				<label>Stats</label>
				<div className="hint">
					{detail.entity.relationshipCount} relationship(s) · {detail.entity.memoryCount} memory(ies)
					{detail.entity.memberEntityIds.length > 1 && ` · ${detail.entity.memberEntityIds.length} linked identities`}
					{detail.entity.importanceScore !== undefined && ` · rank ${detail.entity.importanceScore}`}
					{detail.entity.messageCount !== undefined && ` · ${detail.entity.messageCount} message(s)`}
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
