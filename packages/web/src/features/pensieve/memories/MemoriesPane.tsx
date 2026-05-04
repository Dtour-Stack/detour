import { useCallback, useEffect, useState } from "react";
import type { PensieveMemorySummary } from "@detour/shared";
import type { WebClient } from "../../../api/client";
import { MemoryDetail } from "./MemoryDetail";

const MEMORY_TYPES = [
	{ value: "", label: "All types" },
	{ value: "message", label: "Messages" },
	{ value: "fact", label: "Facts" },
	{ value: "document", label: "Documents" },
	{ value: "fragment", label: "Fragments" },
	{ value: "description", label: "Descriptions" },
	{ value: "custom", label: "Custom" },
];

export function MemoriesPane({ client }: { client: WebClient }) {
	const [items, setItems] = useState<PensieveMemorySummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [type, setType] = useState("");
	const [q, setQ] = useState("");
	const [searchMode, setSearchMode] = useState<"text" | "vector">("text");
	const [selected, setSelected] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			let rows: PensieveMemorySummary[];
			if (searchMode === "vector" && q.trim().length > 0) {
				rows = await client.pensieveSearchMemories(q, 50);
			} else {
				rows = await client.pensieveMemories({
					limit: 200,
					...(type ? { type } : {}),
					...(q ? { q } : {}),
				});
			}
			setItems(rows);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [client, type, q, searchMode]);

	useEffect(() => {
		const t = setTimeout(load, q ? 250 : 0);
		return () => clearTimeout(t);
	}, [load, q]);

	return (
		<div className="pensieve-split">
			<div className="pensieve-split-list">
				<div className="pensieve-toolbar">
					<select value={type} onChange={(e) => setType(e.target.value)} className="pensieve-select">
						{MEMORY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
					</select>
					<input
						type="text"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Search memories…"
						className="pensieve-input"
						style={{ flex: 1 }}
					/>
					<select
						value={searchMode}
						onChange={(e) => setSearchMode(e.target.value as "text" | "vector")}
						className="pensieve-select"
						title="Search mode"
					>
						<option value="text">Text</option>
						<option value="vector">Vector</option>
					</select>
				</div>
				{error && <div className="banner error">{error}</div>}
				{loading && items.length === 0 && <div className="hint" style={{ padding: 12 }}>Loading…</div>}
				<div className="pensieve-list">
					{items.map((m) => (
						<button
							key={m.id}
							type="button"
							className={selected === m.id ? "pensieve-list-row active" : "pensieve-list-row"}
							onClick={() => setSelected(m.id)}
						>
							<div className="pensieve-list-row-header">
								{m.type && <span className="badge muted">{m.type}</span>}
								{m.tags?.slice(0, 3).map((t) => <span key={t} className="badge info">{t}</span>)}
								{m.createdAt && <span className="hint">{new Date(m.createdAt).toLocaleDateString()}</span>}
							</div>
							<div className="pensieve-list-row-preview">{m.preview}</div>
							{(m.entityId || m.roomId) && (
								<div className="hint" style={{ marginTop: 4, fontSize: 10 }}>
									{m.entityId && `entity:${m.entityId.slice(0, 8)} `}
									{m.roomId && `room:${m.roomId.slice(0, 8)}`}
								</div>
							)}
						</button>
					))}
					{!loading && items.length === 0 && (
						<div className="empty">No memories match — try a different filter.</div>
					)}
				</div>
			</div>
			<div className="pensieve-split-detail">
				{selected ? (
					<MemoryDetail
						client={client}
						memoryId={selected}
						onDelete={() => { setSelected(null); load(); }}
						onUpdate={() => load()}
					/>
				) : (
					<div className="empty">Select a memory to view details.</div>
				)}
			</div>
		</div>
	);
}
