import { useEffect, useMemo, useState } from "react";
import { WebClient } from "../../api/client";
import { MemoriesPane } from "./memories/MemoriesPane";
import { RelationshipsPane } from "./relationships/RelationshipsPane";
import { GraphPane } from "./graph/GraphPane";

type Section = "memories" | "relationships" | "graph";

const SECTIONS: { id: Section; label: string; icon: string }[] = [
	{ id: "memories", label: "Memories", icon: "📝" },
	{ id: "relationships", label: "Relationships", icon: "🔗" },
	{ id: "graph", label: "Graph", icon: "🕸️" },
];

export function PensieveView() {
	const client = useMemo(() => new WebClient(), []);
	const [connected, setConnected] = useState(false);
	const [section, setSection] = useState<Section>(() => {
		try {
			return (localStorage.getItem("pensieve.section") as Section) ?? "memories";
		} catch {
			return "memories";
		}
	});

	useEffect(() => {
		client.connect().then(() => setConnected(true)).catch(() => setConnected(true));
	}, [client]);

	useEffect(() => {
		try { localStorage.setItem("pensieve.section", section); } catch { /* ignore */ }
	}, [section]);

	return (
		<div className="pensieve-shell">
			<aside className="pensieve-sidebar">
				<div className="pensieve-brand">Pensieve</div>
				<div className="hint" style={{ padding: "0 14px 8px", lineHeight: 1.5 }}>
					Your agent's memory + relationships, indexed and linked.
				</div>
				{SECTIONS.map((s) => (
					<button
						key={s.id}
						type="button"
						className={section === s.id ? "pensieve-nav-btn active" : "pensieve-nav-btn"}
						onClick={() => setSection(s.id)}
					>
						<span className="pensieve-nav-icon" aria-hidden>{s.icon}</span>
						{s.label}
					</button>
				))}
				<div style={{ flex: 1 }} />
				<div className="pensieve-status">
					{connected ? "● connected" : "○ connecting…"}
				</div>
			</aside>
			<main className="pensieve-main">
				{section === "memories" && <MemoriesPane client={client} />}
				{section === "relationships" && <RelationshipsPane client={client} />}
				{section === "graph" && <GraphPane client={client} />}
			</main>
		</div>
	);
}
