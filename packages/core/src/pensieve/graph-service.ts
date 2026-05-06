/**
 * Cross-link / graph computation for the Pensieve > Graph view.
 *
 * Pensieve is the *knowledge* surface — runtime/operational nodes
 * (trajectories, logs, tasks) belong in Activity, not here.
 *
 * Nodes:
 *   - memory:<id>     (color = memory type)
 *   - entity:<id>     (color = green)
 *
 * Edges:
 *   - memory → entity (entityId / metadata.actorId)
 *   - memory ↔ memory (shared tag, threshold ≥ 1)
 *   - entity ↔ entity (Relationship rows)
 *
 * Backlinks for a single memory are derived on demand: any node that has
 * an edge ending at the memory id.
 */

import type { IAgentRuntime, Memory, Relationship } from "@elizaos/core";

export type GraphNodeKind = "memory" | "entity";

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
	kind: "memory-entity" | "memory-tag" | "entity-relationship";
	weight?: number;
}

export interface GraphSnapshot {
	nodes: GraphNode[];
	edges: GraphEdge[];
	stats: {
		memories: number;
		entities: number;
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

async function loadGraphRows(
	runtime: IAgentRuntime,
	limit: number,
): Promise<{ memories: Memory[]; relationships: Relationship[] }> {
	const adapter = runtime as unknown as AdapterShape;
	const memories = typeof adapter.getMemories === "function"
		? await adapter.getMemories({ tableName: "memories", count: limit })
		: [];
	const relationships = typeof adapter.getRelationships === "function"
		? await adapter.getRelationships({ limit })
		: [];
	return { memories, relationships };
}

function memoryMatchesFilter(memory: Memory, filter: GraphFilter): boolean {
	const metadata = memory.metadata as { type?: string; tags?: unknown } | undefined;
	if (filter.dateFrom && (memory.createdAt ?? 0) < filter.dateFrom) return false;
	if (filter.dateTo && (memory.createdAt ?? 0) > filter.dateTo) return false;
	if (filter.entityIds?.length && (!memory.entityId || !filter.entityIds.includes(String(memory.entityId)))) return false;
	if (filter.types?.length && metadata?.type && !filter.types.includes(metadata.type)) return false;
	if (!filter.tags?.length) return true;
	return memoryTags(memory).some((tag) => filter.tags!.includes(tag));
}

function memoryTags(memory: Memory): string[] {
	const tags = (memory.metadata as { tags?: unknown } | undefined)?.tags;
	return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function entityIdsFor(memories: Memory[], relationships: Relationship[]): Set<string> {
	const ids = new Set<string>();
	for (const memory of memories) if (memory.entityId) ids.add(String(memory.entityId));
	for (const relationship of relationships) {
		ids.add(String(relationship.sourceEntityId));
		ids.add(String(relationship.targetEntityId));
	}
	return ids;
}

function graphNodesFor(memories: Memory[], entityIds: Set<string>): GraphNode[] {
	return [
		...memories.map(memoryNode),
		...[...entityIds].map((id) => ({ id: `entity:${id}`, kind: "entity" as const, label: id.slice(0, 8) })),
	];
}

function memoryNode(memory: Memory): GraphNode {
	const tags = memoryTags(memory);
	return {
		id: `memory:${memory.id}`,
		kind: "memory",
		label: memoryLabel(memory),
		...(typeof memory.createdAt === "number" ? { createdAt: memory.createdAt } : {}),
		...(tags.length > 0 ? { tags } : {}),
	};
}

function memoryEntityEdges(memories: Memory[]): GraphEdge[] {
	return memories.flatMap((memory) =>
		memory.entityId
			? [{ source: `memory:${memory.id}`, target: `entity:${memory.entityId}`, kind: "memory-entity" as const }]
			: [],
	);
}

function relationshipEdges(relationships: Relationship[]): GraphEdge[] {
	return relationships.map((relationship) => ({
		source: `entity:${relationship.sourceEntityId}`,
		target: `entity:${relationship.targetEntityId}`,
		kind: "entity-relationship",
		weight: Math.max(1, relationship.tags?.length ?? 1),
	}));
}

function memoryTagEdges(memories: Memory[]): GraphEdge[] {
	const byTag = new Map<string, string[]>();
	for (const memory of memories) {
		for (const tag of memoryTags(memory)) {
			const bucket = byTag.get(tag) ?? [];
			bucket.push(`memory:${memory.id}`);
			byTag.set(tag, bucket);
		}
	}
	return [...byTag.values()].flatMap(memoryTagEdgesForGroup);
}

function memoryTagEdgesForGroup(ids: string[]): GraphEdge[] {
	const edges: GraphEdge[] = [];
	const cap = Math.min(ids.length, 10);
	for (let i = 0; i < cap; i++) {
		for (let j = i + 1; j < cap; j++) {
			edges.push({ source: ids[i]!, target: ids[j]!, kind: "memory-tag", weight: 1 });
		}
	}
	return edges;
}

export class PensieveGraphService {
	constructor(
		private readonly resolveRuntime: () => IAgentRuntime | null,
		private readonly hardLimit = 5000,
	) {}

	async snapshot(filter: GraphFilter = {}): Promise<GraphSnapshot> {
		const runtime = this.resolveRuntime();
		if (!runtime) return { nodes: [], edges: [], stats: { memories: 0, entities: 0, edges: 0 } };
		const { memories, relationships } = await loadGraphRows(runtime, this.hardLimit);
		const memoriesFiltered = memories.filter((memory) => memoryMatchesFilter(memory, filter));
		const entityIds = entityIdsFor(memoriesFiltered, relationships);
		const nodes = graphNodesFor(memoriesFiltered, entityIds);
		const edges = [
			...memoryEntityEdges(memoriesFiltered),
			...relationshipEdges(relationships),
			...memoryTagEdges(memoriesFiltered),
		];

		return {
			nodes,
			edges,
			stats: {
				memories: memoriesFiltered.length,
				entities: entityIds.size,
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
