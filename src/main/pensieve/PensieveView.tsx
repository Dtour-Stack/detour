import { useEffect, useState } from "react";
import { useDetourTheme } from "../useDetourTheme";
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
 * Rendered as a tab inside the Detour hub (App.tsx → renderToolView): section
 * nav is a right-side `.embedded-right-rail` (a thin icon strip that expands to
 * labels on hover), keeping the unified left rail (channels + tools) as the
 * single source of top-level navigation.
 *
 * Section state is persisted to localStorage so picking a section in one mode
 * carries over when the user switches to the other.
 */
export function PensieveView() {
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
