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

/**
 * elizaOS doesn't write everything to a single `memories` table — different
 * subsystems use their own (messages, knowledge fragments, knowledge documents,
 * experience evaluator, character evolution, fact extraction). We fan out
 * across all of them so Pensieve mirrors what the agent actually records.
 *
 * Discovered by grepping eliza/packages/core/src/features/**\/*.ts for
 * `tableName: "..."`. Add to this list if a future plugin introduces another.
 */
export const KNOWN_MEMORY_TABLES = [
	"memories",
	"messages",
	"facts",
	"documents",
	"knowledge",
	"experiences",
	"character_evolution",
] as const;
export type KnownMemoryTable = (typeof KNOWN_MEMORY_TABLES)[number];

export interface PensieveMemorySummary {
	id: string;
	type?: string;
	createdAt?: number;
	roomId?: string;
	entityId?: string;
	worldId?: string;
	tags?: string[];
	/** Folder-style path stored in metadata.path; defaults derived from type/table. */
	path: string;
	/** Source table this row came from — useful when fanning out across all tables. */
	tableName: string;
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
	/** Match memories whose path equals this OR descends from it. */
	pathPrefix?: string;
}

export interface PensieveMemoryTreeNode {
	path: string;
	name: string;
	/** Memories stored at exactly this path. */
	count: number;
	/** Memories at this path or any descendant. */
	totalCount: number;
	children: PensieveMemoryTreeNode[];
}

type MemoryWriteRuntime = {
	agentId?: string;
	createMemory?: (m: Memory, table?: string) => Promise<UUID>;
	addEmbeddingToMemory?: (m: Memory) => Promise<Memory>;
	getRoomsForParticipant?: (entityId: string) => Promise<string[]>;
};
type MemoryCreateRuntime = MemoryWriteRuntime & {
	createMemory: (m: Memory, table?: string) => Promise<UUID>;
};

export interface PensieveMemoryTree {
	root: PensieveMemoryTreeNode;
	total: number;
}

/** Default folder when a memory has no metadata.path. Visible as the "uncategorised" root entry. */
export const DEFAULT_MEMORY_PATH = "/uncategorized";

/**
 * Heuristic auto-categorisation when a memory has no metadata.path.
 * The source table is the primary signal (eliza enforces table-per-domain),
 * with type as a tiebreak inside the generic `memories` table.
 */
function autoPathFor(type: string | undefined, tableName: string | undefined): string {
	switch (tableName) {
		case "messages":            return "/messages";
		case "facts":               return "/facts";
		case "documents":           return "/knowledge/documents";
		case "knowledge":           return "/knowledge/fragments";
		case "experiences":         return "/observations/experiences";
		case "character_evolution": return "/character/evolution";
	}
	switch (type) {
		case "description": return "/observations";
		case "document":    return "/knowledge/documents";
		case "fragment":    return "/knowledge/fragments";
		case "message":     return "/messages";
		case "custom":      return "/custom";
		default:            return DEFAULT_MEMORY_PATH;
	}
}

function normalisePath(p: unknown, type: string | undefined, tableName?: string): string {
	if (typeof p !== "string" || p.length === 0) return autoPathFor(type, tableName);
	const cleaned = `/${p.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/")}`;
	return cleaned === "/" ? autoPathFor(type, tableName) : cleaned;
}

function pathSegments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

const PREVIEW_LEN = 240;

function preview(content: Content | undefined): string {
	if (!content) return "(empty)";
	const text = typeof content.text === "string" ? content.text : "";
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > PREVIEW_LEN ? `${compact.slice(0, PREVIEW_LEN)}…` : compact || "(no text)";
}

function summarise(m: Memory, tableName: string): PensieveMemorySummary {
	const md = m.metadata as (MemoryMetadata & { path?: unknown; tags?: unknown }) | undefined;
	return {
		id: String(m.id),
		type: md?.type,
		...(typeof m.createdAt === "number" ? { createdAt: m.createdAt } : {}),
		...(m.roomId ? { roomId: String(m.roomId) } : {}),
		...(m.entityId ? { entityId: String(m.entityId) } : {}),
		...(m.worldId ? { worldId: String(m.worldId) } : {}),
		...(Array.isArray(md?.tags) ? { tags: md.tags as string[] } : {}),
		path: normalisePath(md?.path, md?.type, tableName),
		tableName,
		preview: preview(m.content),
	};
}

export class PensieveMemoryService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	private async resolveWriteRoom(inputRoomId: string | undefined, runtime: MemoryWriteRuntime): Promise<string | null> {
		if (inputRoomId) return inputRoomId;
		if (typeof runtime.getRoomsForParticipant !== "function" || !runtime.agentId) return null;
		try {
			const rooms = await runtime.getRoomsForParticipant(runtime.agentId);
			return rooms[0] ?? null;
		} catch {
			return null;
		}
	}

	private async writeMemory(runtime: MemoryCreateRuntime, memory: Memory, tableName: string): Promise<{ id: string }> {
		if (typeof runtime.addEmbeddingToMemory === "function") {
			try {
				const enriched = await runtime.addEmbeddingToMemory(memory);
				const id = await runtime.createMemory(enriched, tableName);
				return { id: String(id) };
			} catch {
				// fall back to write without embedding
			}
		}
		const id = await runtime.createMemory(memory, tableName);
		return { id: String(id) };
	}

	/**
	 * Fetch from one table. Best-effort — adapters that don't recognise a
	 * given table name throw; we swallow and return [] so the fan-out keeps
	 * going for the tables that DO exist.
	 */
	private async fetchTable(runtime: IAgentRuntime, tableName: string, count: number, params: Record<string, unknown>): Promise<Memory[]> {
		const adapter = (runtime as unknown as {
			getMemories: (p: Record<string, unknown>) => Promise<Memory[]>;
		}).getMemories;
		if (typeof adapter !== "function") return [];
		try {
			return await adapter.call(runtime, { tableName, count, ...params });
		} catch {
			return [];
		}
	}

	async list(opts: ListMemoriesOptions = {}): Promise<PensieveMemorySummary[]> {
		const runtime = this.resolveRuntime();
		if (!runtime) return [];
		const { tableName, limit = 100, roomId, entityId, type, q, tag, pathPrefix } = opts;
		const tables = tableName ? [tableName] : [...KNOWN_MEMORY_TABLES];
		const fetchParams: Record<string, unknown> = {};
		if (roomId) fetchParams.roomId = roomId;
		if (entityId) fetchParams.entityId = entityId;
		const perTable = Math.max(20, Math.ceil((limit * 4) / Math.max(1, tables.length)));
		const all: Array<{ m: Memory; t: string }> = [];
		for (const t of tables) {
			const rows = await this.fetchTable(runtime, t, perTable, fetchParams);
			for (const m of rows) all.push({ m, t });
		}
		// dedupe by id (some tables may shadow ids in adapter implementations)
		const seen = new Set<string>();
		const deduped: typeof all = [];
		for (const r of all) {
			const id = String(r.m.id);
			if (seen.has(id)) continue;
			seen.add(id);
			deduped.push(r);
		}
		const prefix = pathPrefix ? normalisePath(pathPrefix, undefined) : null;
		const filtered = deduped.filter(({ m, t }) => {
			const md = m.metadata as (MemoryMetadata & { path?: unknown; tags?: unknown }) | undefined;
			if (type && md?.type !== type) return false;
			if (tag) {
				if (!Array.isArray(md?.tags) || !(md.tags as string[]).includes(tag)) return false;
			}
			if (prefix) {
				const p = normalisePath(md?.path, md?.type, t);
				if (p !== prefix && !p.startsWith(`${prefix}/`)) return false;
			}
			if (q) {
				const text = (m.content?.text ?? "").toString().toLowerCase();
				if (!text.includes(q.toLowerCase())) return false;
			}
			return true;
		});
		// Sort newest first across tables.
		filtered.sort((a, b) => (b.m.createdAt ?? 0) - (a.m.createdAt ?? 0));
		return filtered.slice(0, limit).map(({ m, t }) => summarise(m, t));
	}

	/** Build a folder hierarchy by fanning out across every known memory table. */
	async tree(opts: { tableName?: string; max?: number } = {}): Promise<PensieveMemoryTree> {
		const runtime = this.resolveRuntime();
		const root: PensieveMemoryTreeNode = { path: "/", name: "/", count: 0, totalCount: 0, children: [] };
		if (!runtime) return { root, total: 0 };
		const tables = opts.tableName ? [opts.tableName] : [...KNOWN_MEMORY_TABLES];
		const perTable = opts.max ?? 5000;
		const all: Array<{ m: Memory; t: string }> = [];
		for (const t of tables) {
			const rows = await this.fetchTable(runtime, t, perTable, {});
			for (const m of rows) all.push({ m, t });
		}

		const nodeAt = (path: string): PensieveMemoryTreeNode => {
			if (path === "/") return root;
			const segments = pathSegments(path);
			let cur = root;
			let acc = "";
			for (const seg of segments) {
				acc += `/${seg}`;
				let next = cur.children.find((c) => c.path === acc);
				if (!next) {
					next = { path: acc, name: seg, count: 0, totalCount: 0, children: [] };
					cur.children.push(next);
				}
				cur = next;
			}
			return cur;
		};

		const seen = new Set<string>();
		for (const { m, t } of all) {
			const id = String(m.id);
			if (seen.has(id)) continue;
			seen.add(id);
			const md = m.metadata as { path?: unknown; type?: string } | undefined;
			const path = normalisePath(md?.path, md?.type, t);
			const node = nodeAt(path);
			node.count += 1;
			let acc = "";
			root.totalCount += 1;
			for (const seg of pathSegments(path)) {
				acc += `/${seg}`;
				const cur = nodeAt(acc);
				cur.totalCount += 1;
			}
		}

		const sortChildren = (n: PensieveMemoryTreeNode): void => {
			n.children.sort((a, b) => a.name.localeCompare(b.name));
			n.children.forEach(sortChildren);
		};
		sortChildren(root);

		return { root, total: seen.size };
	}

	/** Create a memory at a path. Used by the agent's PENSIEVE_WRITE action and by ad-hoc UI imports.
	 *
	 *  Foreign-key safety: the `memories` table requires roomId/entityId to
	 *  reference existing rows. We default to the agent's primary room (set
	 *  up by RuntimeService.ensureConnection at build time) and the agent
	 *  itself as the entity so writes from the UI/agent always succeed
	 *  without the caller having to thread roomId through every call. */
	async create(input: {
		text: string;
		path?: string;
		type?: string;
		tags?: string[];
		roomId?: string;
		entityId?: string;
		worldId?: string;
		extraMetadata?: Record<string, unknown>;
		tableName?: string;
	}): Promise<{ id: string } | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const r = runtime as unknown as MemoryWriteRuntime;
		if (typeof r.createMemory !== "function") return null;
		const writer = r as MemoryCreateRuntime;
		const type = input.type ?? "custom";
		const path = normalisePath(input.path, type);
		const meta = {
			type,
			path,
			...(Array.isArray(input.tags) ? { tags: input.tags } : {}),
			...input.extraMetadata,
		} as unknown as MemoryMetadata;

		// Pick a real room: caller-provided > agent's first known room > fail.
		// Zero-UUID would fail FK constraint on the memories.room_id column.
		const roomId = await this.resolveWriteRoom(input.roomId, writer);
		if (!roomId) {
			console.warn("[pensieve.memory.create] no room available for write — agent has no rooms yet");
			return null;
		}
		const entityId = input.entityId ?? r.agentId;
		if (!entityId) return null;

		const memory: Memory = {
			entityId: entityId as UUID,
			roomId: roomId as UUID,
			...(input.worldId ? { worldId: input.worldId as UUID } : {}),
			content: { text: input.text } as Content,
			createdAt: Date.now(),
			metadata: meta,
		};
		return this.writeMemory(writer, memory, input.tableName ?? DEFAULT_TABLE);
	}

	async get(id: UUID): Promise<PensieveMemoryDetail | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const r = runtime as unknown as {
			getMemoryById?: (id: UUID) => Promise<Memory | null>;
			getMemoriesByIds?: (ids: UUID[], tableName?: string) => Promise<Memory[]>;
		};
		// Try the global lookup first; if it doesn't reveal the table, fan out.
		let found: { m: Memory; t: string } | null = null;
		if (typeof r.getMemoryById === "function") {
			const m = await r.getMemoryById(id);
			if (m) found = { m, t: DEFAULT_TABLE };
		}
		if (!found && typeof r.getMemoriesByIds === "function") {
			for (const t of KNOWN_MEMORY_TABLES) {
				try {
					const rows = await r.getMemoriesByIds([id], t);
					if (rows.length > 0 && rows[0]) { found = { m: rows[0], t }; break; }
				} catch { /* skip table */ }
			}
		}
		if (!found) return null;
		return {
			...summarise(found.m, found.t),
			content: found.m.content,
			metadata: found.m.metadata as MemoryMetadata | undefined,
			hasEmbedding: Array.isArray(found.m.embedding) && found.m.embedding.length > 0,
		};
	}

	/**
	 * Vector search when an embedding model is registered; otherwise substring
	 * fallback over .list(). Searches across all known tables and merges.
	 */
	async search(text: string, limit = 30): Promise<PensieveMemorySummary[]> {
		const runtime = this.resolveRuntime();
		if (!runtime || !text.trim()) return [];

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
						const out: Array<{ m: Memory; t: string }> = [];
						for (const t of KNOWN_MEMORY_TABLES) {
							try {
								const hits = await adapter.call(runtime, {
									tableName: t,
									embedding,
									count: Math.ceil(limit / 2),
									match_threshold: 0.7,
								});
								for (const m of hits) out.push({ m, t });
							} catch { /* skip table */ }
						}
						const seen = new Set<string>();
						const dedup = out.filter(({ m }) => {
							const id = String(m.id);
							if (seen.has(id)) return false;
							seen.add(id);
							return true;
						});
						return dedup.slice(0, limit).map(({ m, t }) => summarise(m, t));
					}
				}
			}
		} catch {
			// fall through to substring
		}

		return this.list({ q: text, limit });
	}

	async update(id: UUID, patch: { contentText?: string; tags?: string[]; path?: string }): Promise<boolean> {
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
			next.content = { ...existing.content, text: patch.contentText } as Content;
		}
		const md = ((existing.metadata ?? {}) as Record<string, unknown>);
		const nextMd: Record<string, unknown> = { ...md };
		let touchedMd = false;
		if (Array.isArray(patch.tags)) {
			nextMd.tags = patch.tags;
			touchedMd = true;
		}
		if (typeof patch.path === "string") {
			nextMd.path = normalisePath(patch.path, existing.type);
			touchedMd = true;
		}
		if (touchedMd) next.metadata = nextMd as MemoryMetadata;
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
