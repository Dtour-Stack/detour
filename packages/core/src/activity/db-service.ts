/**
 * Activity > DB pane.
 *
 * Read-only inspector over the agent's PGlite database. Lists tables, schema
 * (columns + types), row counts, sample rows, and provides a SAFE SQL console
 * (SELECT-only). Mirrors milady's SqlEditorPanel/DatabaseView pattern but
 * scoped to inspection — never mutating.
 *
 * Uses the same `runtime.adapter.db.execute(sql.raw(...))` path that
 * TrajectoriesService uses, so we run inside the same connection / engine
 * elizaOS already opened.
 */

import { sql } from "drizzle-orm";
import type { IAgentRuntime } from "@elizaos/core";

export interface DbColumn {
	name: string;
	type: string;
	nullable: boolean;
	default?: string;
}

export interface DbTable {
	schema: string;
	name: string;
	rowCount: number;
	columnCount: number;
}

export interface DbTableDetail {
	schema: string;
	name: string;
	rowCount: number;
	columns: DbColumn[];
	sample: { rows: Record<string, unknown>[]; truncated: boolean };
}

export interface DbQueryResult {
	columns: string[];
	rows: Record<string, unknown>[];
	durationMs: number;
	truncated: boolean;
}

interface AdapterDb {
	execute(query: ReturnType<typeof sql.raw>): Promise<{
		rows?: Record<string, unknown>[];
		fields?: { name: string }[];
	}>;
}

const SAMPLE_LIMIT = 25;
const QUERY_HARD_LIMIT = 200;

function getDb(runtime: IAgentRuntime): AdapterDb | null {
	const r = runtime as unknown as { adapter?: { db?: unknown } };
	const db = r.adapter?.db;
	if (!db || typeof (db as AdapterDb).execute !== "function") return null;
	return db as AdapterDb;
}

async function exec(db: AdapterDb, raw: string): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
	const result = await db.execute(sql.raw(raw));
	const rows = Array.isArray(result.rows) ? result.rows : [];
	const columns = Array.isArray(result.fields) && result.fields.length > 0
		? result.fields.map((f) => f.name)
		: rows.length > 0 ? Object.keys(rows[0]!) : [];
	return { rows, columns };
}

function isReadOnly(stmt: string): boolean {
	const trimmed = stmt.trim().replace(/^\s*--.*$/gm, "").trim();
	if (!trimmed) return false;
	// Allow at most one statement (no semicolons in the middle).
	const withoutTrailing = trimmed.replace(/;\s*$/, "");
	if (withoutTrailing.includes(";")) return false;
	// Only allow SELECT, EXPLAIN, SHOW, WITH (SELECT-style CTE).
	return /^(select|explain|show|with)\b/i.test(withoutTrailing);
}

export class ActivityDbService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	available(): boolean {
		const runtime = this.resolveRuntime();
		return !!runtime && !!getDb(runtime);
	}

	async listTables(): Promise<DbTable[]> {
		const runtime = this.resolveRuntime();
		if (!runtime) return [];
		const db = getDb(runtime);
		if (!db) return [];
		const { rows } = await exec(db, `
			SELECT table_schema AS schema, table_name AS name
			FROM information_schema.tables
			WHERE table_type = 'BASE TABLE'
			  AND table_schema NOT IN ('pg_catalog', 'information_schema')
			ORDER BY table_schema, table_name
		`);
		const out: DbTable[] = [];
		for (const r of rows) {
			const schema = String(r.schema ?? "public");
			const name = String(r.name ?? "");
			if (!name) continue;
			let rowCount = 0;
			let columnCount = 0;
			try {
				const cnt = await exec(db, `SELECT count(*)::int AS c FROM "${schema}"."${name}"`);
				rowCount = Number(cnt.rows[0]?.c ?? 0);
			} catch { /* ignore */ }
			try {
				const cols = await exec(db, `
					SELECT count(*)::int AS c
					FROM information_schema.columns
					WHERE table_schema = '${schema}' AND table_name = '${name}'
				`);
				columnCount = Number(cols.rows[0]?.c ?? 0);
			} catch { /* ignore */ }
			out.push({ schema, name, rowCount, columnCount });
		}
		return out;
	}

	async describeTable(schema: string, name: string): Promise<DbTableDetail | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const db = getDb(runtime);
		if (!db) return null;
		const safeSchema = schema.replace(/[^a-zA-Z0-9_]/g, "");
		const safeName = name.replace(/[^a-zA-Z0-9_]/g, "");
		if (!safeName) return null;
		const colsRes = await exec(db, `
			SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS def
			FROM information_schema.columns
			WHERE table_schema = '${safeSchema}' AND table_name = '${safeName}'
			ORDER BY ordinal_position
		`);
		const columns: DbColumn[] = colsRes.rows.map((r) => ({
			name: String(r.name ?? ""),
			type: String(r.type ?? ""),
			nullable: r.nullable === "YES",
			...(r.def != null ? { default: String(r.def) } : {}),
		}));
		const cnt = await exec(db, `SELECT count(*)::int AS c FROM "${safeSchema}"."${safeName}"`);
		const rowCount = Number(cnt.rows[0]?.c ?? 0);
		const sampleRes = await exec(db, `SELECT * FROM "${safeSchema}"."${safeName}" LIMIT ${SAMPLE_LIMIT}`);
		return {
			schema: safeSchema,
			name: safeName,
			rowCount,
			columns,
			sample: {
				rows: sampleRes.rows,
				truncated: rowCount > SAMPLE_LIMIT,
			},
		};
	}

	/** SELECT-only console. Throws on writes/multistatements/non-SELECT. */
	async query(sqlText: string): Promise<DbQueryResult> {
		const runtime = this.resolveRuntime();
		if (!runtime) throw new Error("Runtime not built.");
		const db = getDb(runtime);
		if (!db) throw new Error("Database adapter not available.");
		if (!isReadOnly(sqlText)) {
			throw new Error("Only SELECT/EXPLAIN/SHOW/WITH statements are allowed in the read-only console.");
		}
		const limited = /\blimit\s+\d+/i.test(sqlText)
			? sqlText.replace(/;\s*$/, "")
			: `${sqlText.replace(/;\s*$/, "")} LIMIT ${QUERY_HARD_LIMIT}`;
		const t0 = Date.now();
		const { rows, columns } = await exec(db, limited);
		return {
			columns,
			rows,
			durationMs: Date.now() - t0,
			truncated: rows.length === QUERY_HARD_LIMIT && !/\blimit\s+\d+/i.test(sqlText),
		};
	}
}
