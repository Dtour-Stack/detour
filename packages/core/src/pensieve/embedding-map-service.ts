/**
 * Pensieve > Embedding Map.
 *
 * Reads embeddings from the agent's `embeddings` table and projects them to
 * 2D for a scatter-plot visualisation. We use deterministic random projection
 * (Achlioptas, sqrt(3) scaled +1/0/-1 matrix) — fast, reproducible, no
 * external library, decent at preserving large-scale cluster structure for
 * the inspection UX. Not meant to replace t-SNE/UMAP for serious analysis.
 *
 * Pulls from any of the dim_* columns the elizaOS schema exposes:
 *   dim_384, dim_512, dim_768, dim_1024, dim_1536, dim_3072
 *
 * Joined to `memories` so each point carries its memory id, type, path,
 * and a content preview the UI can show on hover.
 */

import { sql } from "drizzle-orm";
import type { IAgentRuntime } from "@elizaos/core";

const DIM_COLUMNS = ["dim_384", "dim_512", "dim_768", "dim_1024", "dim_1536", "dim_3072"] as const;
const MAX_POINTS = 5000;

export interface EmbeddingPoint {
	memoryId: string;
	type?: string;
	path: string;
	preview: string;
	createdAt?: number;
	x: number;
	y: number;
	dim: number;
}

export interface EmbeddingMapResult {
	available: boolean;
	count: number;
	points: EmbeddingPoint[];
	source: "random-projection";
}

interface AdapterDb {
	execute(query: ReturnType<typeof sql.raw>): Promise<{ rows?: Record<string, unknown>[]; fields?: { name: string }[] }>;
}

function getDb(runtime: IAgentRuntime): AdapterDb | null {
	const r = runtime as unknown as { adapter?: { db?: unknown } };
	const db = r.adapter?.db;
	if (!db || typeof (db as AdapterDb).execute !== "function") return null;
	return db as AdapterDb;
}

async function exec(db: AdapterDb, raw: string): Promise<Record<string, unknown>[]> {
	const r = await db.execute(sql.raw(raw));
	return Array.isArray(r.rows) ? r.rows : [];
}

/** Mulberry32 PRNG — small, deterministic, fast. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Achlioptas random projection matrix (D x 2). Entries: +1 with p=1/6, -1 with p=1/6, 0 with p=2/3, scaled by sqrt(3). */
function buildProjection(dim: number, seed: number): number[][] {
	const r = rng(seed);
	const scale = Math.sqrt(3);
	const matrix: number[][] = [];
	for (let i = 0; i < dim; i++) {
		const row = new Array(2);
		for (let j = 0; j < 2; j++) {
			const x = r();
			row[j] = x < 1 / 6 ? scale : x < 1 / 3 ? -scale : 0;
		}
		matrix.push(row);
	}
	return matrix;
}

function project(embedding: number[], matrix: number[][]): [number, number] {
	let x = 0;
	let y = 0;
	const dim = Math.min(embedding.length, matrix.length);
	for (let i = 0; i < dim; i++) {
		x += embedding[i]! * matrix[i]![0]!;
		y += embedding[i]! * matrix[i]![1]!;
	}
	return [x, y];
}

function parseVector(raw: unknown): number[] | null {
	// Postgres vector columns serialize as "[1.2,3.4,...]" strings or arrays.
	if (Array.isArray(raw)) return raw.map(Number).filter((n) => Number.isFinite(n));
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
	const parts = trimmed.slice(1, -1).split(",");
	const out = new Array<number>(parts.length);
	for (let i = 0; i < parts.length; i++) {
		const n = Number(parts[i]);
		if (!Number.isFinite(n)) return null;
		out[i] = n;
	}
	return out;
}

export class PensieveEmbeddingMapService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	async snapshot(): Promise<EmbeddingMapResult> {
		const runtime = this.resolveRuntime();
		if (!runtime) return { available: false, count: 0, points: [], source: "random-projection" };
		const db = getDb(runtime);
		if (!db) return { available: false, count: 0, points: [], source: "random-projection" };

		// Pull embeddings + joined memory metadata in one query.
		// Use COALESCE to pick whichever dim_* column is populated.
		const cols = DIM_COLUMNS.map((c) => `e."${c}"::text AS ${c}`).join(", ");
		const rows = await exec(db, `
			SELECT
				e.memory_id::text AS memory_id,
				EXTRACT(EPOCH FROM e.created_at)::bigint * 1000 AS created_at_ms,
				m.type AS type,
				m.metadata AS metadata,
				m.content AS content,
				${cols}
			FROM embeddings e
			LEFT JOIN memories m ON m.id = e.memory_id
			ORDER BY e.created_at DESC
			LIMIT ${MAX_POINTS}
		`);

		// First pass: parse vectors, group by dimension. We project only the
		// dominant dim — mixing dimensions in one projection would be wrong.
		const byDim = new Map<number, Array<{ memoryId: string; embedding: number[]; row: Record<string, unknown> }>>();
		for (const r of rows) {
			const memoryId = String(r.memory_id ?? "");
			if (!memoryId) continue;
			let embedding: number[] | null = null;
			for (const col of DIM_COLUMNS) {
				const parsed = parseVector(r[col]);
				if (parsed && parsed.length > 0) { embedding = parsed; break; }
			}
			if (!embedding) continue;
			const dim = embedding.length;
			if (!byDim.has(dim)) byDim.set(dim, []);
			byDim.get(dim)!.push({ memoryId, embedding, row: r });
		}

		// Pick the largest cohort; project that one. (UI can show "showing dim X" hint.)
		let chosenDim = 0;
		let chosenGroup: Array<{ memoryId: string; embedding: number[]; row: Record<string, unknown> }> | undefined;
		for (const [dim, group] of byDim) {
			if (!chosenGroup || group.length > chosenGroup.length) {
				chosenDim = dim;
				chosenGroup = group;
			}
		}
		if (!chosenGroup || chosenGroup.length === 0) {
			return { available: true, count: 0, points: [], source: "random-projection" };
		}

		const matrix = buildProjection(chosenDim, 42);
		const raw = chosenGroup.map(({ memoryId, embedding, row }) => {
			const [px, py] = project(embedding, matrix);
			const meta = parseMetadata(row.metadata);
			const content = parseMetadata(row.content);
			const text = (content?.text as string | undefined) ?? "";
			return {
				memoryId,
				type: typeof row.type === "string" ? row.type : undefined,
				path: typeof meta?.path === "string" ? meta.path : "/uncategorized",
				preview: text.replace(/\s+/g, " ").slice(0, 120) || "(no text)",
				...(typeof row.created_at_ms === "string" || typeof row.created_at_ms === "number"
					? { createdAt: Number(row.created_at_ms) }
					: {}),
				rawX: px,
				rawY: py,
				dim: chosenDim,
			};
		});

		// Normalise to roughly [-1, 1] for the UI to scale into its canvas.
		const xs = raw.map((p) => p.rawX);
		const ys = raw.map((p) => p.rawY);
		const xMin = Math.min(...xs);
		const xMax = Math.max(...xs);
		const yMin = Math.min(...ys);
		const yMax = Math.max(...ys);
		const xRange = xMax - xMin || 1;
		const yRange = yMax - yMin || 1;

		const points: EmbeddingPoint[] = raw.map((p) => ({
			memoryId: p.memoryId,
			...(p.type !== undefined && { type: p.type }),
			path: p.path,
			preview: p.preview,
			...(p.createdAt !== undefined && { createdAt: p.createdAt }),
			x: ((p.rawX - xMin) / xRange) * 2 - 1,
			y: ((p.rawY - yMin) / yRange) * 2 - 1,
			dim: p.dim,
		}));

		return { available: true, count: points.length, points, source: "random-projection" };
	}
}

function parseMetadata(v: unknown): Record<string, unknown> | null {
	if (!v) return null;
	if (typeof v === "object") return v as Record<string, unknown>;
	if (typeof v === "string") {
		try { return JSON.parse(v); } catch { return null; }
	}
	return null;
}
