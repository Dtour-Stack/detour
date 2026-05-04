import { useEffect, useMemo, useState } from "react";
import { WebClient } from "../../api/client";
import { MemoriesPane } from "./memories/MemoriesPane";
import { RelationshipsPane } from "./relationships/RelationshipsPane";
import { GraphPane } from "./graph/GraphPane";
import { TemplatesPane } from "./templates/TemplatesPane";

type Section = "memories" | "relationships" | "templates" | "graph";

const SECTIONS: { id: Section; label: string }[] = [
	{ id: "memories", label: "Memories" },
	{ id: "relationships", label: "Relationships" },
	{ id: "templates", label: "Templates" },
	{ id: "graph", label: "Graph" },
];

/**
 * Top-level Pensieve window: agent memory + relationships + cross-corpus graph.
 * Mounts when the React app is loaded with location.hash === "#pensieve".
 *
 * Layout matches settings-shell — left sidebar with section + sub-nav buttons,
 * main content area for the active pane.
 */
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
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<div className="window-brand">Pensieve</div>
				<div className="sidebar-section">
					<div className="section-btn active" aria-hidden>Knowledge</div>
					<div className="sub-nav">
						{SECTIONS.map((s) => (
							<button
								key={s.id}
								type="button"
								className={section === s.id ? "sub-nav-btn active" : "sub-nav-btn"}
								onClick={() => setSection(s.id)}
							>
								{s.label}
							</button>
						))}
					</div>
				</div>
				<div style={{ flex: 1 }} />
				<div className="window-status">
					{connected ? "● connected" : "○ connecting…"}
				</div>
			</aside>
			<main className="settings-main settings-main-flush">
				{section === "memories" && <MemoriesPane client={client} />}
				{section === "relationships" && <RelationshipsPane client={client} />}
				{section === "templates" && <TemplatesPane client={client} />}
				{section === "graph" && <GraphPane client={client} />}
			</main>
		</div>
	);
}
