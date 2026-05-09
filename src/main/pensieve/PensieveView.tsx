import { useEffect, useState } from "react";
import { useDetourTheme } from "../useDetourTheme";
import { SidebarIcon } from "../SidebarIcon";
import { MemoriesPane } from "./memories/MemoriesPane";
import { RelationshipsPane } from "./relationships/RelationshipsPane";
import { GraphPane } from "./graph/GraphPane";
import { TemplatesPane } from "./templates/TemplatesPane";
import { EmbeddingMapPane } from "./embeddings/EmbeddingMapPane";
import { InboxPane } from "./inbox/InboxPane";
import { GatewayPane } from "./gateway/GatewayPane";
import { ChroniclerPane } from "./chronicler/ChroniclerPane";

type Section =
	| "inbox"
	| "gateway"
	| "chronicler"
	| "notes"
	| "knowledge"
	| "memories"
	| "templates"
	| "relationships"
	| "graph"
	| "embeddings";

const LIVE_SECTIONS: { id: Section; label: string }[] = [
	{ id: "inbox", label: "Inbox" },
	{ id: "gateway", label: "Channel feed" },
	{ id: "chronicler", label: "Chronicler" },
];

const KNOWLEDGE_SECTIONS: { id: Section; label: string }[] = [
	{ id: "notes", label: "Notes" },
	{ id: "knowledge", label: "Knowledge" },
	{ id: "memories", label: "Memories" },
	{ id: "templates", label: "Templates" },
	{ id: "relationships", label: "Relationships" },
	{ id: "graph", label: "Graph" },
	{ id: "embeddings", label: "Embedding map" },
];

/**
 * Top-level Pensieve window: agent memory + relationships + cross-corpus graph.
 * Mounts when the React app is loaded with location.hash === "#pensieve".
 *
 * Layout matches settings-shell — left sidebar with section + sub-nav buttons,
 * main content area for the active pane.
 */
export function PensieveView() {
	useDetourTheme();
	const [section, setSection] = useState<Section>(() => {
		try {
			return (localStorage.getItem("pensieve.section") as Section) ?? "inbox";
		} catch {
			return "inbox";
		}
	});

	useEffect(() => {
		try { localStorage.setItem("pensieve.section", section); } catch { /* ignore */ }
	}, [section]);

	return (
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<div className="window-brand">Pensieve</div>
				<div className="sidebar-section">
					<div className="section-btn active" aria-hidden title="Live">
						<SidebarIcon name="wave" />
						<span className="section-btn-label">Live</span>
					</div>
					<div className="sub-nav">
						{LIVE_SECTIONS.map((s) => (
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
				<div className="sidebar-section">
					<div className="section-btn active" aria-hidden title="Knowledge">
						<SidebarIcon name="book" />
						<span className="section-btn-label">Knowledge</span>
					</div>
					<div className="sub-nav">
						{KNOWLEDGE_SECTIONS.map((s) => (
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
			</aside>
			<main className="settings-main settings-main-flush">
				{section === "inbox" && <InboxPane />}
				{section === "gateway" && <GatewayPane />}
				{section === "chronicler" && <ChroniclerPane />}
				{section === "notes" && <MemoriesPane scope="notes" />}
				{section === "knowledge" && <MemoriesPane scope="knowledge" />}
				{section === "memories" && <MemoriesPane />}
				{section === "templates" && <TemplatesPane />}
				{section === "relationships" && <RelationshipsPane />}
				{section === "graph" && <GraphPane />}
				{section === "embeddings" && <EmbeddingMapPane />}
			</main>
		</div>
	);
}
