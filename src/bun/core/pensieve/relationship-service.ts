/**
 * Relationship + entity wrapper for Pensieve > Relationships.
 *
 * Reads through the runtime's IDatabaseAdapter (`getRelationships`,
 * `getEntityById`, `getEntitiesForRoom`). Writes go through
 * `createRelationships` / `updateRelationships`. Identity merges are recorded
 * through the core relationships service and read back as canonical clusters.
 */

import { logger, type Entity, type IAgentRuntime, type Memory, type Relationship, type UUID } from "@elizaos/core";

export interface PensieveEntitySummary {
	id: string;
	name?: string;
	relationshipCount: number;
	memoryCount: number;
	lastSeen?: number;
	importanceScore?: number;
	messageCount?: number;
	tags: string[];
	memberEntityIds: string[];
	tracked: boolean;
	trackedAt?: string;
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

interface ContactInfoShape {
	entityId: UUID;
	tags?: string[];
	trackingEnabled?: boolean;
	trackedAt?: string;
}

interface RelationshipsServiceShape {
	getContact?: (entityId: UUID) => Promise<ContactInfoShape | null>;
	setContactTracking?: (entityId: UUID, trackingEnabled: boolean) => Promise<ContactInfoShape>;
	getMemberEntityIds?: (entityId: UUID) => Promise<UUID[]>;
	resolvePrimaryEntityId?: (entityId: UUID) => Promise<UUID>;
	proposeMerge?: (entityA: UUID, entityB: UUID, evidence: Record<string, unknown>) => Promise<UUID>;
	acceptMerge?: (candidateId: UUID) => Promise<void>;
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

function relationshipsService(runtime: IAgentRuntime): RelationshipsServiceShape | null {
	const service = runtime.getService("relationships");
	return service ? service as RelationshipsServiceShape : null;
}

function uniqueStrings(values: Iterable<string | undefined | null>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function normalizePersonName(name: string | undefined): string | null {
	const normalized = name?.trim().toLowerCase().replace(/\s+/g, " ");
	if (!normalized || normalized.length < 3) return null;
	if (normalized === "unknown" || normalized === "user" || normalized === "agent") return null;
	return normalized;
}

const PERSON_MEMORY_TABLES = ["messages", "facts", "memories"] as const;

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
		const relService = relationshipsService(runtime);

		const agentId = String(runtime.agentId);
		const rels = await a.getRelationships({ entityIds: [runtime.agentId], limit: Math.max(limit * 10, 500) });
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
		await this.consolidateDuplicateNamedEntities(runtime, ids, counts);
		const groups = new Map<string, { primaryId: UUID; memberIds: Set<UUID> }>();
		for (const id of ids) {
			const primaryId = relService?.resolvePrimaryEntityId
				? await relService.resolvePrimaryEntityId(id).catch(() => id)
				: id;
			const memberIds = relService?.getMemberEntityIds
				? await relService.getMemberEntityIds(primaryId).catch(() => [primaryId])
				: [primaryId];
			const key = String(primaryId);
			const group = groups.get(key) ?? { primaryId, memberIds: new Set<UUID>() };
			group.memberIds.add(id);
			for (const memberId of memberIds) group.memberIds.add(memberId);
			groups.set(key, group);
		}

		const allEntityIds = Array.from(new Set(Array.from(groups.values()).flatMap((group) => Array.from(group.memberIds)))) as UUID[];
		const entities = typeof a.getEntitiesByIds === "function" ? await a.getEntitiesByIds(allEntityIds) : [];
		const byId = new Map(entities.map((e) => [String(e.id), e]));

		const out: PensieveEntitySummary[] = [];
		for (const group of groups.values()) {
			let rel = 0;
			let lastSeen = 0;
			let importance = 0;
			let messages = 0;
			const tags = new Set<string>();
			const contacts = await Promise.all(
				Array.from(group.memberIds).map((id) => relService?.getContact?.(id).catch(() => null) ?? null),
			);
			for (const memberId of group.memberIds) {
				const c = counts.get(String(memberId));
				if (!c) continue;
				rel += c.rel;
				if (c.lastSeen > lastSeen) lastSeen = c.lastSeen;
				if (c.importance > importance) importance = c.importance;
				messages += c.messages;
				for (const tag of c.tags) tags.add(tag);
			}
			for (const contact of contacts) {
				for (const tag of contact?.tags ?? []) tags.add(tag);
			}
			const primary = byId.get(String(group.primaryId));
			const fallback = Array.from(group.memberIds)
				.map((memberId) => byId.get(String(memberId)))
				.find((entity) => entity?.names?.[0]);
			const trackedContacts = contacts.filter((contact): contact is ContactInfoShape => contact?.trackingEnabled === true);
			out.push({
				id: String(group.primaryId),
				...(primary?.names?.[0] || fallback?.names?.[0] ? { name: primary?.names?.[0] ?? fallback?.names?.[0] } : {}),
				relationshipCount: rel,
				memoryCount: 0, // filled by getPerson()
				...(lastSeen > 0 ? { lastSeen } : {}),
				...(importance > 0 ? { importanceScore: importance } : {}),
				...(messages > 0 ? { messageCount: messages } : {}),
				tags: Array.from(tags),
				memberEntityIds: Array.from(group.memberIds).map(String),
				tracked: trackedContacts.length > 0,
				...(trackedContacts[0]?.trackedAt ? { trackedAt: trackedContacts[0].trackedAt } : {}),
			});
		}

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
		const relService = relationshipsService(runtime);
		const primaryEntityId = relService?.resolvePrimaryEntityId
			? await relService.resolvePrimaryEntityId(entityId).catch(() => entityId)
			: entityId;
		const memberIds = relService?.getMemberEntityIds
			? await relService.getMemberEntityIds(primaryEntityId).catch(() => [primaryEntityId])
			: [primaryEntityId];
		const canonicalMemberIds = Array.from(new Set([primaryEntityId, entityId, ...memberIds])) as UUID[];
		const entities = typeof a.getEntitiesByIds === "function" ? await a.getEntitiesByIds(canonicalMemberIds) : [];
		const byId = new Map(entities.map((entity) => [String(entity.id), entity]));
		const entity = byId.get(String(primaryEntityId)) ?? byId.get(String(entityId)) ?? null;
		if (!entity) return null;

		const rels = typeof a.getRelationships === "function"
			? await a.getRelationships({ entityIds: canonicalMemberIds })
			: [];

		const memories = await this.loadPersonMemories(a, canonicalMemberIds, 75);
		const importanceScore = rels.reduce((max, rel) => {
			const metadata = rel.metadata as Record<string, unknown> | undefined;
			return Math.max(max, numberField(metadata?.importanceScore) ?? 0);
		}, 0);
		const messageCount = rels.reduce((total, rel) => {
			const metadata = rel.metadata as Record<string, unknown> | undefined;
			return total + (numberField(metadata?.messageCount) ?? 0);
		}, 0);
		const contacts = await Promise.all(
			canonicalMemberIds.map((id) => relService?.getContact?.(id).catch(() => null) ?? null),
		);
		const trackedContacts = contacts.filter((contact): contact is ContactInfoShape => contact?.trackingEnabled === true);
		const contactTags = contacts.flatMap((contact) => contact?.tags ?? []);
		const relationshipTags = rels.flatMap((rel) => rel.tags ?? []);
		const names = uniqueStrings([
			...(entity.names ?? []),
			...canonicalMemberIds.flatMap((id) => byId.get(String(id))?.names ?? []),
		]);

		return {
			entity: {
				id: String(entity.id),
				...(names[0] ? { name: names[0] } : {}),
				relationshipCount: rels.length,
				memoryCount: memories.length,
				...(importanceScore > 0 ? { importanceScore } : {}),
				...(messageCount > 0 ? { messageCount } : {}),
				tags: uniqueStrings([...relationshipTags, ...contactTags]),
				memberEntityIds: canonicalMemberIds.map(String),
				tracked: trackedContacts.length > 0,
				...(trackedContacts[0]?.trackedAt ? { trackedAt: trackedContacts[0].trackedAt } : {}),
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

	async setTracked(entityId: UUID, tracked: boolean): Promise<PensievePersonDetail | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const relService = relationshipsService(runtime);
		if (typeof relService?.setContactTracking !== "function") return null;
		await relService.setContactTracking(entityId, tracked);
		return this.getPerson(entityId);
	}

	async mergeEntities(primaryId: UUID, secondaryIds: UUID[]): Promise<PensievePersonDetail | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const relService = relationshipsService(runtime);
		if (
			typeof relService?.proposeMerge !== "function" ||
			typeof relService.acceptMerge !== "function"
		) {
			return null;
		}
		for (const secondaryId of secondaryIds) {
			if (secondaryId === primaryId) continue;
			const candidateId = await relService.proposeMerge(primaryId, secondaryId, {
				source: "pensieve.manual-merge",
				confidence: 1,
			});
			await relService.acceptMerge(candidateId);
		}
		return this.getPerson(primaryId);
	}

	private async loadPersonMemories(
		a: AdapterShape,
		entityIds: UUID[],
		limit: number,
	): Promise<Memory[]> {
		if (typeof a.getMemories !== "function") return [];
		const rows: Memory[] = [];
		for (const tableName of PERSON_MEMORY_TABLES) {
			for (const entityId of entityIds) {
				try {
					const memories = await a.getMemories({ tableName, entityId, count: Math.max(20, limit) });
					rows.push(...memories);
				} catch {
					continue;
				}
			}
		}
		const byId = new Map<string, Memory>();
		for (const memory of rows) {
			if (!memory.id) continue;
			byId.set(String(memory.id), memory);
		}
		return Array.from(byId.values())
			.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
			.slice(0, limit);
	}

	private async consolidateDuplicateNamedEntities(
		runtime: IAgentRuntime,
		entityIds: UUID[],
		counts: Map<string, { importance: number; messages: number }>,
	): Promise<void> {
		const relService = relationshipsService(runtime);
		if (
			typeof relService?.proposeMerge !== "function" ||
			typeof relService.acceptMerge !== "function" ||
			typeof runtime.getEntitiesByIds !== "function"
		) {
			return;
		}
		const entities = await runtime.getEntitiesByIds(entityIds);
		const groups = new Map<string, Entity[]>();
		for (const entity of entities) {
			const name = normalizePersonName(entity.names?.[0]);
			if (!name || entity.id === runtime.agentId) continue;
			const group = groups.get(name) ?? [];
			group.push(entity);
			groups.set(name, group);
		}

		for (const [name, group] of groups) {
			if (group.length < 2) continue;
			const ranked = await Promise.all(
				group.map(async (entity) => {
					const contact = entity.id ? await relService.getContact?.(entity.id).catch(() => null) : null;
					const count = entity.id ? counts.get(String(entity.id)) : undefined;
					return {
						entity,
						score:
							(contact?.trackingEnabled ? 1000 : 0) +
							(contact ? 100 : 0) +
							(count?.importance ?? 0) +
							(count?.messages ?? 0),
					};
				}),
			);
			ranked.sort((left, right) => right.score - left.score || String(left.entity.id).localeCompare(String(right.entity.id)));
			const primaryId = ranked[0]?.entity.id;
			if (!primaryId) continue;
			const members = typeof relService.getMemberEntityIds === "function"
				? await relService.getMemberEntityIds(primaryId).catch(() => [primaryId])
				: [primaryId];
			const memberSet = new Set(members.map(String));
			for (const item of ranked.slice(1)) {
				const secondaryId = item.entity.id;
				if (!secondaryId || memberSet.has(String(secondaryId))) continue;
				try {
					const candidateId = await relService.proposeMerge(primaryId, secondaryId, {
						source: "pensieve.name-consolidation",
						confidence: 0.9,
						name,
					});
					await relService.acceptMerge(candidateId);
					memberSet.add(String(secondaryId));
				} catch (err) {
					logger.warn(
						{
							src: "pensieve:relationships",
							err: err instanceof Error ? err.message : err,
							primaryId,
							secondaryId,
						},
						"[PensieveRelationshipService] duplicate-name consolidation failed",
					);
				}
			}
		}
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

	// ── Phase 2: Cross-channel identity consolidation ─────────────────────

	/**
	 * Discover and merge entities that represent the same person across
	 * different channels (Discord, X, Telegram, iMessage).
	 *
	 * Matching strategies (in order of confidence):
	 * 1. Exact username match across platforms (confidence: 0.9)
	 * 2. Phone number match between iMessage and Telegram (confidence: 0.85)
	 * 3. Gateway identity candidates — same external handle seen under
	 *    multiple entity IDs (confidence: 0.95 — most reliable)
	 *
	 * Returns the number of merges performed.
	 */
	async consolidateCrossChannelIdentities(
		gatewayIdentities?: Array<{
			channel: string;
			externalHandle: string;
			entityIds: string[];
		}>,
	): Promise<{ mergesPerformed: number; candidates: Array<{ primary: string; merged: string[]; reason: string }> }> {
		const runtime = this.resolveRuntime();
		if (!runtime) return { mergesPerformed: 0, candidates: [] };
		const relService = relationshipsService(runtime);
		if (
			typeof relService?.proposeMerge !== "function" ||
			typeof relService.acceptMerge !== "function" ||
			typeof runtime.getRelationships !== "function"
		) {
			return { mergesPerformed: 0, candidates: [] };
		}

		const mergeLog: Array<{ primary: string; merged: string[]; reason: string }> = [];
		let mergesPerformed = 0;

		// Strategy 1: Gateway identity candidates — same handle, multiple entity IDs
		if (gatewayIdentities) {
			for (const identity of gatewayIdentities) {
				if (identity.entityIds.length < 2) continue;
				const [primaryId, ...secondaryIds] = identity.entityIds;
				for (const secondaryId of secondaryIds) {
					try {
						const candidateId = await relService.proposeMerge(
							primaryId as UUID,
							secondaryId as UUID,
							{
								source: "pensieve.cross-channel.gateway-handle",
								confidence: 0.95,
								channel: identity.channel,
								handle: identity.externalHandle,
							},
						);
						await relService.acceptMerge(candidateId);
						mergesPerformed++;
						mergeLog.push({
							primary: primaryId,
							merged: [secondaryId],
							reason: `Same ${identity.channel} handle: ${identity.externalHandle}`,
						});
					} catch (err) {
						logger.warn(
							{
								src: "pensieve:relationships",
								err: err instanceof Error ? err.message : err,
								primaryId,
								secondaryId,
							},
							"[PensieveRelationshipService] cross-channel gateway merge failed",
						);
					}
				}
			}
		}

		// Strategy 2: Username-based matching across platforms
		const agentId = String(runtime.agentId);
		const rels = await (runtime as unknown as AdapterShape).getRelationships!({
			entityIds: [runtime.agentId],
			limit: 1000,
		});
		const entityIds = new Set<string>();
		for (const rel of rels) {
			for (const id of [String(rel.sourceEntityId), String(rel.targetEntityId)]) {
				if (id !== agentId) entityIds.add(id);
			}
		}
		if (entityIds.size === 0) return { mergesPerformed, candidates: mergeLog };

		const allIds = Array.from(entityIds) as UUID[];
		const entities = typeof (runtime as unknown as AdapterShape).getEntitiesByIds === "function"
			? await (runtime as unknown as AdapterShape).getEntitiesByIds!(allIds)
			: [];

		// Build a handle→entityId index
		const handleIndex = new Map<string, Set<string>>();
		for (const entity of entities) {
			const metadata = entity.metadata as Record<string, unknown> | undefined;
			const handles = metadata?.handles as string[] | undefined;
			const source = typeof metadata?.source === "string" ? metadata.source : null;

			// Collect all possible usernames for this entity
			const usernames = new Set<string>();
			for (const name of entity.names ?? []) {
				const normalized = name?.trim().toLowerCase().replace(/^@/, "");
				if (normalized && normalized.length >= 3 && normalized !== "unknown" && normalized !== "user") {
					usernames.add(normalized);
				}
			}
			if (handles) {
				for (const handle of handles) {
					const normalized = handle?.trim().toLowerCase().replace(/^@/, "").replace(/^\+/, "");
					if (normalized && normalized.length >= 3) {
						usernames.add(normalized);
					}
				}
			}

			for (const username of usernames) {
				const existing = handleIndex.get(username) ?? new Set();
				existing.add(String(entity.id));
				handleIndex.set(username, existing);
			}
		}

		// Find clusters of entity IDs sharing a username
		for (const [username, ids] of handleIndex) {
			if (ids.size < 2) continue;
			const sorted = Array.from(ids);
			const primaryId = sorted[0];
			// Check if already merged
			const primaryResolved = relService.resolvePrimaryEntityId
				? await relService.resolvePrimaryEntityId(primaryId as UUID).catch(() => primaryId)
				: primaryId;
			const memberIds = relService.getMemberEntityIds
				? await relService.getMemberEntityIds(primaryResolved as UUID).catch(() => [primaryResolved])
				: [primaryResolved];
			const memberSet = new Set(memberIds.map(String));

			for (const secondaryId of sorted.slice(1)) {
				if (memberSet.has(secondaryId)) continue;
				try {
					const candidateId = await relService.proposeMerge(
						primaryResolved as UUID,
						secondaryId as UUID,
						{
							source: "pensieve.cross-channel.username-match",
							confidence: 0.9,
							matchedUsername: username,
						},
					);
					await relService.acceptMerge(candidateId);
					mergesPerformed++;
					memberSet.add(secondaryId);
					mergeLog.push({
						primary: primaryResolved,
						merged: [secondaryId],
						reason: `Shared username: ${username}`,
					});
				} catch (err) {
					logger.warn(
						{
							src: "pensieve:relationships",
							err: err instanceof Error ? err.message : err,
							primaryId: primaryResolved,
							secondaryId,
							username,
						},
						"[PensieveRelationshipService] cross-channel username merge failed",
					);
				}
			}
		}

		return { mergesPerformed, candidates: mergeLog };
	}

	// ── Phase 4: Stale contact pruning ────────────────────────────────────

	/**
	 * Prune stale contacts that have low importance and haven't been seen
	 * recently. This doesn't delete entities — it archives their memories
	 * and demotes them so they don't clutter context.
	 *
	 * Rules:
	 * - Tracked contacts are NEVER pruned regardless of inactivity
	 * - importanceScore < 10 AND lastSeen > 90 days → mark as stale
	 * - importanceScore < 5 AND lastSeen > 180 days → mark as archived
	 */
	async pruneStaleContacts(opts?: {
		staleDays?: number;
		archiveDays?: number;
		staleThreshold?: number;
		archiveThreshold?: number;
		dryRun?: boolean;
	}): Promise<{
		staleCount: number;
		archivedCount: number;
		skippedTracked: number;
		details: Array<{ entityId: string; name?: string; action: "stale" | "archived"; reason: string }>;
	}> {
		const staleDays = opts?.staleDays ?? 90;
		const archiveDays = opts?.archiveDays ?? 180;
		const staleThreshold = opts?.staleThreshold ?? 10;
		const archiveThreshold = opts?.archiveThreshold ?? 5;
		const dryRun = opts?.dryRun ?? false;

		const runtime = this.resolveRuntime();
		if (!runtime) return { staleCount: 0, archivedCount: 0, skippedTracked: 0, details: [] };
		const a = adapter(runtime);
		const relService = relationshipsService(runtime);

		const persons = await this.listPersons(500);
		const now = Date.now();
		const staleMs = staleDays * 86_400_000;
		const archiveMs = archiveDays * 86_400_000;

		let staleCount = 0;
		let archivedCount = 0;
		let skippedTracked = 0;
		const details: Array<{ entityId: string; name?: string; action: "stale" | "archived"; reason: string }> = [];

		for (const person of persons) {
			// Never prune tracked contacts
			if (person.tracked) {
				skippedTracked++;
				continue;
			}

			const importance = person.importanceScore ?? 0;
			const lastSeen = person.lastSeen ?? 0;
			const age = now - lastSeen;

			// Archive: very low importance + very old
			if (importance < archiveThreshold && age > archiveMs) {
				if (!dryRun && typeof a.updateEntity === "function") {
					const entity = typeof a.getEntityById === "function"
						? await a.getEntityById(person.id as UUID)
						: null;
					if (entity) {
						const metadata = (entity.metadata ?? {}) as Record<string, unknown>;
						metadata.archivedAt = now;
						metadata.archiveReason = `importance=${importance}, lastSeen=${Math.floor(age / 86_400_000)}d ago`;
						await a.updateEntity({ ...entity, metadata } as Entity);
					}
				}
				archivedCount++;
				details.push({
					entityId: person.id,
					name: person.name,
					action: "archived",
					reason: `Importance ${importance} < ${archiveThreshold}, last seen ${Math.floor(age / 86_400_000)}d ago > ${archiveDays}d`,
				});
				continue;
			}

			// Stale: low importance + old
			if (importance < staleThreshold && age > staleMs) {
				if (!dryRun && typeof a.updateEntity === "function") {
					const entity = typeof a.getEntityById === "function"
						? await a.getEntityById(person.id as UUID)
						: null;
					if (entity) {
						const metadata = (entity.metadata ?? {}) as Record<string, unknown>;
						metadata.staleAt = now;
						metadata.staleReason = `importance=${importance}, lastSeen=${Math.floor(age / 86_400_000)}d ago`;
						await a.updateEntity({ ...entity, metadata } as Entity);
					}
				}
				staleCount++;
				details.push({
					entityId: person.id,
					name: person.name,
					action: "stale",
					reason: `Importance ${importance} < ${staleThreshold}, last seen ${Math.floor(age / 86_400_000)}d ago > ${staleDays}d`,
				});
			}
		}

		return { staleCount, archivedCount, skippedTracked, details };
	}
}
