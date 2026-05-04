/**
 * Memory wrapper used by the Pensieve > Memories pane.
 *
 * Read paths use the runtime's IDatabaseAdapter directly so we get the same
 * memories the agent itself sees (no parallel store). Writes go through the
 * runtime's `updateMemory` / `deleteMemory` to keep embeddings + audit hooks
 * consistent with the rest of the system.
 *
 * Search supports both plain substring + true vector via runtime.useModel for
 * the embedding step. When no provider is configured for embeddings (our
 * default — embedding-stub plugin), search degrades to substring-only.
 */

import type { IAgentRuntime, Memory, MemoryMetadata, UUID, Content } from "@elizaos/core";
import { ModelType } from "@elizaos/core";

const DEFAULT_TABLE = "memories";

export interface PensieveMemorySummary {
	id: string;
	type?: string;
	createdAt?: number;
	roomId?: string;
	entityId?: string;
	worldId?: string;
	tags?: string[];
	preview: string;
}

export interface PensieveMemoryDetail extends PensieveMemorySummary {
	content: Content;
	metadata?: MemoryMetadata;
	hasEmbedding: boolean;
}

export interface ListMemoriesOptions {
	roomId?: string;
	entityId?: string;
	type?: string;
	q?: string;
	limit?: number;
	offset?: number;
	tag?: string;
	tableName?: string;
}

const PREVIEW_LEN = 240;

function preview(content: Content | undefined): string {
	if (!content) return "(empty)";
	const text = typeof content.text === "string" ? content.text : "";
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > PREVIEW_LEN ? `${compact.slice(0, PREVIEW_LEN)}…` : compact || "(no text)";
}

function summarise(m: Memory): PensieveMemorySummary {
	const md = m.metadata as MemoryMetadata | undefined;
	return {
		id: String(m.id),
		type: md?.type,
		...(typeof m.createdAt === "number" ? { createdAt: m.createdAt } : {}),
		...(m.roomId ? { roomId: String(m.roomId) } : {}),
		...(m.entityId ? { entityId: String(m.entityId) } : {}),
		...(m.worldId ? { worldId: String(m.worldId) } : {}),
		...(Array.isArray((md as { tags?: unknown } | undefined)?.tags)
			? { tags: ((md as { tags?: unknown }).tags as string[]) }
			: {}),
		preview: preview(m.content),
	};
}

export class PensieveMemoryService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	async list(opts: ListMemoriesOptions = {}): Promise<PensieveMemorySummary[]> {
		const runtime = this.resolveRuntime();
		if (!runtime) return [];
		const adapter = (runtime as unknown as {
			getMemories: (p: Record<string, unknown>) => Promise<Memory[]>;
		}).getMemories;
		if (typeof adapter !== "function") return [];

		const { tableName = DEFAULT_TABLE, limit = 100, roomId, entityId, type, q, tag } = opts;
		const params: Record<string, unknown> = { tableName, count: limit };
		if (roomId) params.roomId = roomId;
		if (entityId) params.entityId = entityId;
		const memories: Memory[] = await adapter.call(runtime, params);
		const filtered = memories.filter((m) => {
			if (type) {
				const t = (m.metadata as MemoryMetadata | undefined)?.type;
				if (t !== type) return false;
			}
			if (tag) {
				const tags = (m.metadata as { tags?: unknown } | undefined)?.tags;
				if (!Array.isArray(tags) || !tags.includes(tag)) return false;
			}
			if (q) {
				const text = (m.content?.text ?? "").toString().toLowerCase();
				if (!text.includes(q.toLowerCase())) return false;
			}
			return true;
		});
		return filtered.slice(0, limit).map(summarise);
	}

	async get(id: UUID): Promise<PensieveMemoryDetail | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const r = runtime as unknown as { getMemoryById?: (id: UUID) => Promise<Memory | null> };
		const m = typeof r.getMemoryById === "function" ? await r.getMemoryById(id) : null;
		if (!m) return null;
		return {
			...summarise(m),
			content: m.content,
			metadata: m.metadata as MemoryMetadata | undefined,
			hasEmbedding: Array.isArray(m.embedding) && m.embedding.length > 0,
		};
	}

	/**
	 * Vector search when an embedding model is registered; otherwise substring
	 * fallback over .list().
	 */
	async search(text: string, limit = 30): Promise<PensieveMemorySummary[]> {
		const runtime = this.resolveRuntime();
		if (!runtime || !text.trim()) return [];

		// Try real embedding search.
		try {
			const useModel = (runtime as unknown as {
				useModel: (type: string, params: Record<string, unknown>) => Promise<unknown>;
			}).useModel;
			if (typeof useModel === "function") {
				const embedding = (await useModel.call(runtime, ModelType.TEXT_EMBEDDING, { text })) as number[];
				const allZero = Array.isArray(embedding) && embedding.length > 0 && embedding.every((n) => n === 0);
				if (Array.isArray(embedding) && !allZero) {
					const adapter = (runtime as unknown as {
						searchMemories: (p: Record<string, unknown>) => Promise<Memory[]>;
					}).searchMemories;
					if (typeof adapter === "function") {
						const hits: Memory[] = await adapter.call(runtime, {
							tableName: DEFAULT_TABLE,
							embedding,
							count: limit,
							match_threshold: 0.7,
						});
						return hits.map(summarise);
					}
				}
			}
		} catch {
			// fall through to substring
		}

		// Substring fallback.
		return this.list({ q: text, limit });
	}

	async update(id: UUID, patch: { contentText?: string; tags?: string[] }): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const update = (runtime as unknown as {
			updateMemory: (m: Partial<Memory> & { id: UUID }) => Promise<boolean>;
		}).updateMemory;
		if (typeof update !== "function") return false;
		const existing = await this.get(id);
		if (!existing) return false;
		const next: Partial<Memory> & { id: UUID } = { id };
		if (typeof patch.contentText === "string") {
			next.content = { ...(existing.content ?? {}), text: patch.contentText } as Content;
		}
		if (Array.isArray(patch.tags)) {
			const md = (existing.metadata ?? {}) as Record<string, unknown>;
			next.metadata = { ...md, tags: patch.tags } as MemoryMetadata;
		}
		return update.call(runtime, next);
	}

	async remove(id: UUID): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const del = (runtime as unknown as { deleteMemory: (id: UUID) => Promise<void> }).deleteMemory;
		if (typeof del !== "function") return false;
		await del.call(runtime, id);
		return true;
	}
}
