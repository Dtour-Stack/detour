/**
 * Relationship + entity wrapper for Pensieve > Relationships.
 *
 * Reads through the runtime's IDatabaseAdapter (`getRelationships`,
 * `getEntityById`, `getEntitiesForRoom`). Writes go through
 * `createRelationships` / `updateRelationships`. Merge is implemented as a
 * compound op: rebind every memory + relationship from the merged ids onto the
 * keep id, then drop the merged entities.
 */

import type { Entity, IAgentRuntime, Memory, Relationship, UUID } from "@elizaos/core";

export interface PensieveEntitySummary {
	id: string;
	name?: string;
	relationshipCount: number;
	memoryCount: number;
	lastSeen?: number;
	importanceScore?: number;
	messageCount?: number;
	tags: string[];
}

export interface PensieveRelationshipSummary {
	sourceEntityId: string;
	targetEntityId: string;
	tags: string[];
	createdAt?: number;
	metadata?: Record<string, unknown>;
}

export interface PensievePersonDetail {
	entity: PensieveEntitySummary;
	memories: Array<{ id: string; preview: string; createdAt?: number }>;
	relationships: PensieveRelationshipSummary[];
}

interface AdapterShape {
	getRelationships?: (p: Record<string, unknown>) => Promise<Relationship[]>;
	getEntityById?: (id: UUID) => Promise<Entity | null>;
	getEntitiesByIds?: (ids: UUID[]) => Promise<Entity[]>;
	getMemories?: (p: Record<string, unknown>) => Promise<Memory[]>;
	createRelationships?: (rel: Relationship[]) => Promise<void>;
	updateRelationships?: (rel: Relationship[]) => Promise<void>;
	deleteRelationships?: (pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>) => Promise<void>;
	updateEntity?: (e: Entity) => Promise<void>;
}

function adapter(runtime: IAgentRuntime): AdapterShape {
	return runtime as unknown as AdapterShape;
}

const PREVIEW_LEN = 160;
function previewMem(m: Memory): string {
	const text = (m.content?.text ?? "").toString().replace(/\s+/g, " ").trim();
	return text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text || "(no text)";
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Heuristic importance score (0..100) for an entity when we don't
 * have a stored one. Combines message volume (log-scaled) with
 * recency — older relationships drift down regardless of how many
 * messages they had. Mirrors origin/main 2c86d14b.
 */
function derivedImportance(messageCount: number, lastSeenAt: number): number {
	if (messageCount <= 0) return 0;
	const ageHours = Math.max(0, (Date.now() - lastSeenAt) / 3_600_000);
	const recency = ageHours < 24 ? 14 : ageHours < 168 ? 8 : 2;
	return Math.min(100, Math.round(8 + Math.log1p(messageCount) * 16 + recency));
}

export class PensieveRelationshipService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	async listPersons(limit = 100): Promise<PensieveEntitySummary[]> {
		const runtime = this.resolveRuntime();
		if (!runtime) return [];
		const a = adapter(runtime);
		if (typeof a.getRelationships !== "function") return [];

		const agentId = String(runtime.agentId);
		const rels = await a.getRelationships({ entityIds: [runtime.agentId], limit: Math.max(limit * 10, 500) });
		// Build entity-id → counts/tags
		const counts = new Map<string, { rel: number; tags: Set<string>; lastSeen: number; importance: number; messages: number }>();
		for (const r of rels) {
			const metadata = r.metadata as Record<string, unknown> | undefined;
			const relLastSeen = numberField(metadata?.lastSeenAt) ?? numberField((r as { createdAt?: number }).createdAt) ?? 0;
			const relMessages = numberField(metadata?.messageCount) ?? 0;
			const relImportance = numberField(metadata?.importanceScore) ?? derivedImportance(relMessages, relLastSeen);
			for (const id of [r.sourceEntityId, r.targetEntityId]) {
				const k = String(id);
				if (!counts.has(k)) counts.set(k, { rel: 0, tags: new Set(), lastSeen: 0, importance: 0, messages: 0 });
				const e = counts.get(k)!;
				e.rel++;
				for (const t of r.tags ?? []) e.tags.add(t);
				if (relLastSeen > e.lastSeen) e.lastSeen = relLastSeen;
				if (relImportance > e.importance) e.importance = relImportance;
				e.messages += relMessages;
			}
		}

		const ids = Array.from(counts.keys()).filter((id) => id !== agentId) as UUID[];
		const entities = typeof a.getEntitiesByIds === "function" ? await a.getEntitiesByIds(ids) : [];
		const byId = new Map(entities.map((e) => [String(e.id), e]));

		const out: PensieveEntitySummary[] = ids.map((id) => {
			const c = counts.get(String(id))!;
			const e = byId.get(String(id));
			return {
				id: String(id),
				...(e?.names?.[0] ? { name: e.names[0] } : {}),
				relationshipCount: c.rel,
				memoryCount: 0, // filled by getPerson()
				...(c.lastSeen > 0 ? { lastSeen: c.lastSeen } : {}),
				...(c.importance > 0 ? { importanceScore: c.importance } : {}),
				...(c.messages > 0 ? { messageCount: c.messages } : {}),
				tags: Array.from(c.tags),
			};
		});

		// Order by importance, then recency, then by raw relationship count.
		out.sort((a2, b2) =>
			(b2.importanceScore ?? 0) - (a2.importanceScore ?? 0) ||
			(b2.lastSeen ?? 0) - (a2.lastSeen ?? 0) ||
			b2.relationshipCount - a2.relationshipCount,
		);
		return out.slice(0, limit);
	}

	async getPerson(entityId: UUID): Promise<PensievePersonDetail | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const a = adapter(runtime);
		const entity = typeof a.getEntityById === "function" ? await a.getEntityById(entityId) : null;
		if (!entity) return null;

		const rels = typeof a.getRelationships === "function"
			? await a.getRelationships({ entityIds: [entityId] })
			: [];

		const memories = typeof a.getMemories === "function"
			? await a.getMemories({ tableName: "memories", entityId, count: 50 })
			: [];
		const importanceScore = rels.reduce((max, rel) => {
			const metadata = rel.metadata as Record<string, unknown> | undefined;
			return Math.max(max, numberField(metadata?.importanceScore) ?? 0);
		}, 0);
		const messageCount = rels.reduce((total, rel) => {
			const metadata = rel.metadata as Record<string, unknown> | undefined;
			return total + (numberField(metadata?.messageCount) ?? 0);
		}, 0);

		return {
			entity: {
				id: String(entity.id),
				...(entity.names?.[0] ? { name: entity.names[0] } : {}),
				relationshipCount: rels.length,
				memoryCount: memories.length,
				...(importanceScore > 0 ? { importanceScore } : {}),
				...(messageCount > 0 ? { messageCount } : {}),
				tags: Array.from(new Set(rels.flatMap((r) => r.tags ?? []))),
			},
			memories: memories.map((m) => ({
				id: String(m.id),
				preview: previewMem(m),
				...(typeof m.createdAt === "number" ? { createdAt: m.createdAt } : {}),
			})),
			relationships: rels.map((r) => ({
				sourceEntityId: String(r.sourceEntityId),
				targetEntityId: String(r.targetEntityId),
				tags: r.tags ?? [],
				...(typeof (r as { createdAt?: number }).createdAt === "number"
					? { createdAt: (r as { createdAt?: number }).createdAt }
					: {}),
				...(r.metadata ? { metadata: r.metadata as Record<string, unknown> } : {}),
			})),
		};
	}

	async listRelationships(entityIds: UUID[] = [], tags: string[] = [], limit = 200): Promise<PensieveRelationshipSummary[]> {
		const runtime = this.resolveRuntime();
		if (!runtime) return [];
		const a = adapter(runtime);
		if (typeof a.getRelationships !== "function") return [];
		const rels = await a.getRelationships({
			entityIds: entityIds.length > 0 ? entityIds : [runtime.agentId],
			...(tags.length > 0 ? { tags } : {}),
			limit,
		});
		return rels.map((r) => ({
			sourceEntityId: String(r.sourceEntityId),
			targetEntityId: String(r.targetEntityId),
			tags: r.tags ?? [],
			...(typeof (r as { createdAt?: number }).createdAt === "number"
				? { createdAt: (r as { createdAt?: number }).createdAt }
				: {}),
			...(r.metadata ? { metadata: r.metadata as Record<string, unknown> } : {}),
		}));
	}

	async create(rel: {
		sourceEntityId: UUID;
		targetEntityId: UUID;
		tags?: string[];
		metadata?: Record<string, unknown>;
	}): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const a = adapter(runtime);
		if (typeof a.createRelationships !== "function") return false;
		// Cast through unknown — Relationship's full required shape (id, agentId,
		// createdAt) is filled in by the adapter. Callers from the UI only know
		// the IDs + tags, not the agent-internal fields.
		await a.createRelationships([rel as unknown as Relationship]);
		return true;
	}

	async update(source: UUID, target: UUID, patch: { tags?: string[]; metadata?: Record<string, unknown> }): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const a = adapter(runtime);
		if (typeof a.getRelationships !== "function" || typeof a.updateRelationships !== "function") return false;
		const existing = await a.getRelationships({ entityIds: [source, target] });
		const match = existing.find(
			(r) => String(r.sourceEntityId) === String(source) && String(r.targetEntityId) === String(target),
		);
		if (!match) return false;
		const next = {
			...match,
			...(patch.tags ? { tags: patch.tags } : {}),
			...(patch.metadata ? { metadata: { ...match.metadata, ...patch.metadata } } : {}),
		} as unknown as Relationship;
		await a.updateRelationships([next]);
		return true;
	}

	async remove(source: UUID, target: UUID): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const a = adapter(runtime);
		if (typeof a.deleteRelationships !== "function") return false;
		await a.deleteRelationships([{ sourceEntityId: source, targetEntityId: target }]);
		return true;
	}
}
