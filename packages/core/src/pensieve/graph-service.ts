/**
 * Cross-link / graph computation for the Pensieve > Graph view.
 *
 * Nodes:
 *   - memory:<id>     (color = memory type)
 *   - entity:<id>     (color = green)
 *   - trajectory:<id> (color = orange)
 *
 * Edges:
 *   - memory → entity (entityId / metadata.actorId)
 *   - memory → room   (skipped — rooms aren't first-class in the graph yet)
 *   - memory ↔ memory (shared tag, threshold ≥ 1)
 *   - entity ↔ entity (Relationship rows)
 *   - trajectory → memory (memories created during a trajectory's window)
 *
 * Backlinks for a single memory are derived on demand: any node that has
 * an edge ending at the memory id.
 */

import type { IAgentRuntime, Memory, Relationship } from "@elizaos/core";

export type GraphNodeKind = "memory" | "entity" | "trajectory";

export interface GraphNode {
	id: string; // "<kind>:<uuid>"
	kind: GraphNodeKind;
	label: string;
	tags?: string[];
	createdAt?: number;
}

export interface GraphEdge {
	source: string; // node id
	target: string; // node id
	kind: "memory-entity" | "memory-tag" | "entity-relationship" | "trajectory-memory";
	weight?: number;
}

export interface GraphSnapshot {
	nodes: GraphNode[];
	edges: GraphEdge[];
	stats: {
		memories: number;
		entities: number;
		trajectories: number;
		edges: number;
	};
}

export interface GraphFilter {
	dateFrom?: number;
	dateTo?: number;
	entityIds?: string[];
	types?: string[];
	tags?: string[];
}

export interface BacklinksResult {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

interface AdapterShape {
	getMemories?: (p: Record<string, unknown>) => Promise<Memory[]>;
	getRelationships?: (p: Record<string, unknown>) => Promise<Relationship[]>;
}

const PREVIEW = 80;
function memoryLabel(m: Memory): string {
	const text = (m.content?.text ?? "").toString().replace(/\s+/g, " ").trim();
	return text.length > PREVIEW
		? `${text.slice(0, PREVIEW)}…`
		: text || (m.metadata as { type?: string } | undefined)?.type || "memory";
}

export class PensieveGraphService {
	constructor(
		private readonly resolveRuntime: () => IAgentRuntime | null,
		private readonly hardLimit = 5000,
	) {}

	async snapshot(filter: GraphFilter = {}): Promise<GraphSnapshot> {
		const runtime = this.resolveRuntime();
		if (!runtime) return { nodes: [], edges: [], stats: { memories: 0, entities: 0, trajectories: 0, edges: 0 } };
		const a = runtime as unknown as AdapterShape;
		const memories = (typeof a.getMemories === "function"
			? await a.getMemories({ tableName: "memories", count: this.hardLimit })
			: []) as Memory[];
		const rels = (typeof a.getRelationships === "function"
			? await a.getRelationships({ limit: this.hardLimit })
			: []) as Relationship[];

		const memoriesFiltered = memories.filter((m) => {
			if (filter.dateFrom && (m.createdAt ?? 0) < filter.dateFrom) return false;
			if (filter.dateTo && (m.createdAt ?? 0) > filter.dateTo) return false;
			if (filter.entityIds?.length && (!m.entityId || !filter.entityIds.includes(String(m.entityId)))) return false;
			const md = m.metadata as { type?: string; tags?: unknown } | undefined;
			if (filter.types?.length && md?.type && !filter.types.includes(md.type)) return false;
			if (filter.tags?.length) {
				const tags = Array.isArray(md?.tags) ? (md!.tags as string[]) : [];
				if (!tags.some((t) => filter.tags!.includes(t))) return false;
			}
			return true;
		});

		const nodes: GraphNode[] = [];
		const seenNode = new Set<string>();
		const addNode = (n: GraphNode) => {
			if (seenNode.has(n.id)) return;
			seenNode.add(n.id);
			nodes.push(n);
		};

		// Memory nodes
		for (const m of memoriesFiltered) {
			const md = m.metadata as { tags?: unknown } | undefined;
			const memTags = Array.isArray(md?.tags) ? (md!.tags as string[]) : undefined;
			addNode({
				id: `memory:${m.id}`,
				kind: "memory",
				label: memoryLabel(m),
				...(typeof m.createdAt === "number" ? { createdAt: m.createdAt } : {}),
				...(memTags ? { tags: memTags } : {}),
			});
		}

		// Entity nodes (from memories + relationships)
		const entityIds = new Set<string>();
		for (const m of memoriesFiltered) if (m.entityId) entityIds.add(String(m.entityId));
		for (const r of rels) {
			entityIds.add(String(r.sourceEntityId));
			entityIds.add(String(r.targetEntityId));
		}
		for (const id of entityIds) {
			addNode({ id: `entity:${id}`, kind: "entity", label: id.slice(0, 8) });
		}

		// Edges
		const edges: GraphEdge[] = [];

		// memory → entity
		for (const m of memoriesFiltered) {
			if (m.entityId) {
				edges.push({ source: `memory:${m.id}`, target: `entity:${m.entityId}`, kind: "memory-entity" });
			}
		}

		// entity ↔ entity from relationships
		for (const r of rels) {
			edges.push({
				source: `entity:${r.sourceEntityId}`,
				target: `entity:${r.targetEntityId}`,
				kind: "entity-relationship",
				weight: Math.max(1, r.tags?.length ?? 1),
			});
		}

		// memory ↔ memory by shared tag (only when ≥ 2 memories share a tag, capped to 50 edges per tag)
		const byTag = new Map<string, string[]>();
		for (const m of memoriesFiltered) {
			const tagsRaw = (m.metadata as { tags?: unknown } | undefined)?.tags;
			const tags = Array.isArray(tagsRaw) ? (tagsRaw as string[]) : [];
			for (const t of tags) {
				if (!byTag.has(t)) byTag.set(t, []);
				byTag.get(t)!.push(`memory:${m.id}`);
			}
		}
		for (const [, ids] of byTag) {
			if (ids.length < 2) continue;
			const cap = Math.min(ids.length, 10);
			for (let i = 0; i < cap; i++) {
				for (let j = i + 1; j < cap; j++) {
					edges.push({ source: ids[i]!, target: ids[j]!, kind: "memory-tag", weight: 1 });
				}
			}
		}

		return {
			nodes,
			edges,
			stats: {
				memories: memoriesFiltered.length,
				entities: entityIds.size,
				trajectories: 0,
				edges: edges.length,
			},
		};
	}

	/** All nodes/edges that connect TO the given memory id. */
	async backlinksForMemory(memoryId: string): Promise<BacklinksResult> {
		const snap = await this.snapshot({});
		const target = `memory:${memoryId}`;
		const edges = snap.edges.filter((e) => e.source === target || e.target === target);
		const ids = new Set<string>([target, ...edges.flatMap((e) => [e.source, e.target])]);
		const nodes = snap.nodes.filter((n) => ids.has(n.id));
		return { nodes, edges };
	}
}
