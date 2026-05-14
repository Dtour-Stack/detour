import { useEffect, useState } from "react";
import { useDetourTheme } from "../useDetourTheme";
import { SidebarIcon } from "../SidebarIcon";
import { MemoriesPane } from "./memories/MemoriesPane";
import { RelationshipsPane } from "./relationships/RelationshipsPane";
import { GraphPane } from "./graph/GraphPane";
import { TemplatesPane } from "./templates/TemplatesPane";
import { EmbeddingMapPane } from "./embeddings/EmbeddingMapPane";
import { ChroniclerPane } from "./chronicler/ChroniclerPane";
import { DreamsPane } from "./dreams/DreamsPane";

type Section =
	| "chronicler"
	| "notes"
	| "knowledge"
	| "memories"
	| "templates"
	| "relationships"
	| "graph"
	| "embeddings"
	| "dreams";

const KNOWLEDGE_SECTIONS: { id: Section; label: string }[] = [
	{ id: "notes", label: "Notes" },
	{ id: "knowledge", label: "Knowledge" },
	{ id: "memories", label: "Memories" },
	{ id: "dreams", label: "Dreams" },
	{ id: "chronicler", label: "Chronicler" },
	{ id: "templates", label: "Templates" },
	{ id: "relationships", label: "Relationships" },
	{ id: "graph", label: "Graph" },
	{ id: "embeddings", label: "Embedding map" },
];

const SECTION_IDS = new Set<Section>(KNOWLEDGE_SECTIONS.map((section) => section.id));

function storedSection(): Section {
	try {
		const stored = localStorage.getItem("pensieve.section") as Section | null;
		return stored && SECTION_IDS.has(stored) ? stored : "memories";
	} catch {
		return "memories";
	}
}

/**
 * Top-level Pensieve view: agent memory + relationships + cross-corpus graph.
 *
 * Two render modes:
 *   - standalone window (the legacy `views://main/pensieve.html` entrypoint):
 *     left-side `.settings-sidebar` nav. Same as Settings windows.
 *   - embedded inside the Detour hub (App.tsx mounts <PensieveView embedded />):
 *     section nav becomes a right-side `.embedded-right-rail`, collapsed to a
 *     thin icon strip by default and expanding to show labels on hover. This
 *     keeps the unified left rail (channels + tools) as the single source of
 *     top-level navigation.
 *
 * Section state is persisted to localStorage so picking a section in one mode
 * carries over when the user switches to the other.
 */
export function PensieveView({ embedded = false }: { embedded?: boolean } = {}) {
	useDetourTheme();
	const [section, setSection] = useState<Section>(storedSection);

	useEffect(() => {
		try { localStorage.setItem("pensieve.section", section); } catch { /* ignore */ }
	}, [section]);

	const content = (
		<>
			{section === "chronicler" && <ChroniclerPane />}
			{section === "notes" && <MemoriesPane scope="notes" />}
			{section === "knowledge" && <MemoriesPane scope="knowledge" />}
			{section === "memories" && <MemoriesPane />}
			{section === "dreams" && <DreamsPane />}
			{section === "templates" && <TemplatesPane />}
			{section === "relationships" && <RelationshipsPane />}
			{section === "graph" && <GraphPane />}
			{section === "embeddings" && <EmbeddingMapPane />}
		</>
	);

	if (embedded) {
		return (
			<div className="embedded-view">
				<main className="embedded-main">{content}</main>
				<aside className="embedded-right-rail" aria-label="Pensieve sections">
					<div className="embedded-right-rail-section-label">Knowledge</div>
					{KNOWLEDGE_SECTIONS.map((s) => (
						<button
							key={s.id}
							type="button"
							className={section === s.id ? "embedded-right-rail-btn active" : "embedded-right-rail-btn"}
							onClick={() => setSection(s.id)}
							title={s.label}
						>
							<span className="embedded-right-rail-glyph">{s.label.slice(0, 2).toUpperCase()}</span>
							<span className="embedded-right-rail-label">{s.label}</span>
						</button>
					))}
				</aside>
			</div>
		);
	}

	return (
		<div className="settings-shell">
			<aside className="settings-sidebar">
				<div className="window-brand">Pensieve</div>
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
			<main className="settings-main settings-main-flush">{content}</main>
		</div>
	);
}
