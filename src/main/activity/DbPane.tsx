/**
 * Activity > DB pane.
 *
 * Read-only PGlite inspector. Three-pane: tables list / table detail (schema +
 * sample) / SQL console (SELECT-only, hard-limited to 200 rows).
 *
 * The console rejects anything that isn't SELECT/EXPLAIN/SHOW/WITH so users
 * can't accidentally drop the agent's database.
 */

import { useCallback, useEffect, useState } from "react";
import type {
	ActivityDbQueryResult,
	ActivityDbTable,
	ActivityDbTableDetail,
} from "../../shared/index";
import type { WebClient } from "../api/client";

export function DbPane({ client }: { client: WebClient }) {
	const [tables, setTables] = useState<ActivityDbTable[] | null>(null);
	const [available, setAvailable] = useState<boolean>(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<{ schema: string; name: string } | null>(null);
	const [detail, setDetail] = useState<ActivityDbTableDetail | null>(null);
	const [mode, setMode] = useState<"schema" | "console">("schema");
	const [sqlText, setSqlText] = useState("SELECT id, type, created_at\nFROM memories\nORDER BY created_at DESC\nLIMIT 50;");
	const [queryResult, setQueryResult] = useState<ActivityDbQueryResult | null>(null);
	const [queryRunning, setQueryRunning] = useState(false);
	const [queryError, setQueryError] = useState<string | null>(null);

	const loadTables = useCallback(async () => {
		try {
			const res = await client.activityDbTables();
			setAvailable(res.available);
			setTables(res.tables);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [client]);

	useEffect(() => { void loadTables(); }, [loadTables]);

	useEffect(() => {
		if (!selected) { setDetail(null); return; }
		let cancelled = false;
		setDetail(null);
		client.activityDbTable(selected.schema, selected.name)
			.then((d) => { if (!cancelled) setDetail(d); })
			.catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
		return () => { cancelled = true; };
	}, [client, selected]);

	const runQuery = useCallback(async () => {
		setQueryRunning(true);
		setQueryError(null);
		try {
			const r = await client.activityDbQuery(sqlText);
			setQueryResult(r);
		} catch (e) {
			setQueryError(e instanceof Error ? e.message : String(e));
		} finally {
			setQueryRunning(false);
		}
	}, [client, sqlText]);

	if (error) return <div className="banner error">{error}</div>;
	if (!available) {
		return <div className="empty" style={{ margin: 24 }}>Database adapter not available — runtime not built yet.</div>;
	}
	if (!tables) return <div className="empty">Loading tables…</div>;

	return (
		<div className="pensieve-tri">
			<aside className="pensieve-tri-tree">
				<div className="pensieve-toolbar" style={{ padding: "8px 10px" }}>
					<span className="hint" style={{ flex: 1, fontWeight: 600 }}>Tables ({tables.length})</span>
					<button type="button" className="link" onClick={loadTables}>refresh</button>
				</div>
				<div className="memory-tree">
					{tables.map((t) => {
						const id = `${t.schema}.${t.name}`;
						const sel = selected && selected.schema === t.schema && selected.name === t.name;
						return (
							<div key={id} className={`memory-tree-row ${sel ? "active" : ""}`} style={{ paddingLeft: 8 }}>
								<button
									type="button"
									className="memory-tree-label"
									onClick={() => { setSelected({ schema: t.schema, name: t.name }); setMode("schema"); }}
									title={id}
								>
									<span className="memory-tree-name">{t.name}</span>
									<span className="memory-tree-count">{t.rowCount}</span>
								</button>
							</div>
						);
					})}
				</div>
			</aside>

			<div className="pensieve-tri-list" style={{ minWidth: 0 }}>
				<div className="pensieve-toolbar">
					<button
						type="button"
						className={mode === "schema" ? "btn small" : "btn small ghost"}
						onClick={() => setMode("schema")}
					>
						Schema
					</button>
					<button
						type="button"
						className={mode === "console" ? "btn small" : "btn small ghost"}
						onClick={() => setMode("console")}
					>
						SQL console
					</button>
					<span style={{ flex: 1 }} />
					{mode === "console" && (
						<button type="button" className="btn small" disabled={queryRunning} onClick={runQuery}>
							{queryRunning ? "Running…" : "Run ⌘↵"}
						</button>
					)}
				</div>

				{mode === "schema" && <SchemaPanel detail={detail} selected={selected} />}
				{mode === "console" && (
					<ConsolePanel
						queryError={queryError}
						queryResult={queryResult}
						runQuery={runQuery}
						sqlText={sqlText}
						setSqlText={setSqlText}
					/>
				)}
			</div>

			<div className="pensieve-tri-detail">
				<div className="empty" style={{ marginTop: 30, padding: 20 }}>
					Read-only console — only SELECT/EXPLAIN/SHOW/WITH allowed. Hard limit 200 rows per query.
				</div>
			</div>
		</div>
	);
}

function SchemaPanel({
	detail,
	selected,
}: {
	detail: ActivityDbTableDetail | null;
	selected: { schema: string; name: string } | null;
}) {
	if (!selected) return <div className="empty" style={{ margin: 24 }}>Select a table.</div>;
	if (!detail) return <div className="empty">Loading schema…</div>;
	return (
		<div className="db-detail">
			<div className="db-detail-meta">
				<span className="badge muted">{detail.schema}.{detail.name}</span>
				<span className="hint">{detail.rowCount.toLocaleString()} rows · {detail.columns.length} columns</span>
			</div>
			<SchemaTable detail={detail} />
			{detail.sample.rows.length > 0 && <SampleRows detail={detail} />}
		</div>
	);
}

function SchemaTable({ detail }: { detail: ActivityDbTableDetail }) {
	return (
		<table className="db-schema-table">
			<thead>
				<tr><th>Column</th><th>Type</th><th>Null</th><th>Default</th></tr>
			</thead>
			<tbody>
				{detail.columns.map((column) => (
					<tr key={column.name}>
						<td className="db-col-name">{column.name}</td>
						<td className="db-col-type">{column.type}</td>
						<td>{column.nullable ? "yes" : "—"}</td>
						<td className="db-col-default">{column.default ?? "—"}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function SampleRows({ detail }: { detail: ActivityDbTableDetail }) {
	return (
		<>
			<div className="db-sample-label">
				Sample ({detail.sample.rows.length} of {detail.rowCount})
				{detail.sample.truncated && " (truncated)"}
			</div>
			<DbResultsTable columns={detail.columns.map((column) => column.name)} rows={detail.sample.rows} />
		</>
	);
}

function ConsolePanel({
	queryError,
	queryResult,
	runQuery,
	sqlText,
	setSqlText,
}: {
	queryError: string | null;
	queryResult: ActivityDbQueryResult | null;
	runQuery: () => Promise<void>;
	sqlText: string;
	setSqlText: (value: string) => void;
}) {
	return (
		<div className="db-console">
			<textarea
				value={sqlText}
				onChange={(e) => setSqlText(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						void runQuery();
					}
				}}
				className="pensieve-textarea db-console-textarea"
				spellCheck={false}
				placeholder="SELECT-only. Cmd+Enter to run."
			/>
			{queryError && <div className="banner error" style={{ margin: "8px 0 0" }}>{queryError}</div>}
			{queryResult && !queryError && <QueryResult result={queryResult} />}
		</div>
	);
}

function QueryResult({ result }: { result: ActivityDbQueryResult }) {
	return (
		<div className="db-console-result">
			<div className="hint">
				{result.rows.length} row{result.rows.length === 1 ? "" : "s"} · {result.durationMs}ms
				{result.truncated && " · truncated to 200"}
			</div>
			<DbResultsTable columns={result.columns} rows={result.rows} />
		</div>
	);
}

function DbResultsTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
	if (rows.length === 0) return <div className="empty">(no rows)</div>;
	const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
	return (
		<div className="db-results-wrap">
			<table className="db-results-table">
				<thead>
					<tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
				</thead>
				<tbody>
					{rows.map((r, i) => (
						<tr key={i}>
							{cols.map((c) => (
								<td key={c}>{formatCell(r[c])}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function formatCell(v: unknown): string {
	if (v === null || v === undefined) return "—";
	if (typeof v === "string") {
		return v.length > 120 ? `${v.slice(0, 120)}…` : v;
	}
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	try {
		const s = JSON.stringify(v);
		return s.length > 120 ? `${s.slice(0, 120)}…` : s;
	} catch {
		return String(v);
	}
}
