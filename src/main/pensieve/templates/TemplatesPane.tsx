/**
 * Pensieve > Templates pane.
 *
 * Templates are stored as memories with `tag: template`; their bodies hold
 * `{{variableName}}` placeholders. The editor auto-detects variables via the
 * backend's regex, surfaces them in a side panel against the persisted
 * prompt-var memory namespace, and renders a preview with the current values.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	PensievePromptVariable,
	PensieveTemplateDetail,
	PensieveTemplateSummary,
} from "../../../shared/index";
import type { WebClient } from "../../api/client";
import { rpc } from "../../rpc";
import { TemplateEditor } from "./TemplateEditor";
import { VariablesPanel } from "./VariablesPanel";

export function TemplatesPane({ client }: { client: WebClient }) {
	const [items, setItems] = useState<PensieveTemplateSummary[]>([]);
	const [vars, setVars] = useState<PensievePromptVariable[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [detail, setDetail] = useState<PensieveTemplateDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const loadList = useCallback(async () => {
		try {
			const [list, vlist] = await Promise.all([
				rpc.request.pensieveTemplatesList({}),
				rpc.request.pensieveTemplateVarsList({}),
			]);
			setItems(list);
			setVars(vlist);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [client]);

	const loadDetail = useCallback(async (id: string) => {
		try {
			const d = await rpc.request.pensieveTemplateGet({ id });
			setDetail(d);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [client]);

	useEffect(() => { void loadList(); }, [loadList]);
	useEffect(() => {
		if (!selected) { setDetail(null); return; }
		void loadDetail(selected);
	}, [selected, loadDetail]);

	const create = useCallback(async () => {
		const name = window.prompt("Template name (e.g. squirrel-mode-system)");
		if (!name) return;
		setCreating(true);
		try {
			const { id } = await rpc.request.pensieveTemplateCreate({
				name,
				body: `# ${name}\n\nWrite your prompt here. Use {{variableName}} for substitutions.\n`,
			});
			await loadList();
			setSelected(id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreating(false);
		}
	}, [client, loadList]);

	const handleSaveVar = useCallback(async (name: string, value: string) => {
		await rpc.request.pensieveTemplateVarSet({ name, value });
		await loadList();
		if (selected) await loadDetail(selected);
	}, [client, loadList, loadDetail, selected]);

	const handleDeleteVar = useCallback(async (name: string) => {
		if (!confirm(`Delete prompt variable {{${name}}}?`)) return;
		await rpc.request.pensieveTemplateVarDelete({ name });
		await loadList();
		if (selected) await loadDetail(selected);
	}, [client, loadList, loadDetail, selected]);

	const detailVars = useMemo(() => {
		if (!detail) return [];
		// merge: variables from this template (in order) + any other persisted vars
		const seen = new Set(detail.variables);
		const ordered = [...detail.variables];
		for (const v of vars) if (!seen.has(v.name)) { ordered.push(v.name); seen.add(v.name); }
		return ordered;
	}, [detail, vars]);

	if (error) return <div className="banner error">{error}</div>;

	return (
		<div className="pensieve-tri">
			<aside className="pensieve-tri-tree">
				<div className="pensieve-toolbar" style={{ padding: "8px 10px" }}>
					<span className="hint" style={{ flex: 1, fontWeight: 600 }}>Templates</span>
					<button type="button" className="link" disabled={creating} onClick={create}>＋ New</button>
				</div>
				<div className="memory-tree">
					{items.length === 0 ? (
						<div className="empty" style={{ margin: 8 }}>
							No templates yet. Use “New” to create one or import a character sheet.
						</div>
					) : (
						items.map((t) => (
							<div
								key={t.id}
								className={`memory-tree-row ${selected === t.id ? "active" : ""}`}
								style={{ paddingLeft: 8 }}
							>
								<button
									type="button"
									className="memory-tree-label"
									onClick={() => setSelected(t.id)}
									title={t.path}
								>
									<span className="memory-tree-name">{t.name}</span>
									<span className="memory-tree-count">{t.variables.length} var{t.variables.length === 1 ? "" : "s"}</span>
								</button>
							</div>
						))
					)}
				</div>
			</aside>

			<div className="pensieve-tri-list" style={{ minWidth: 0 }}>
				{!detail ? (
					<div className="empty" style={{ margin: 30 }}>
						Select a template on the left, or create a new one.
					</div>
				) : (
					<TemplateEditor
						client={client}
						detail={detail}
						onSaved={async () => { await loadList(); if (selected) await loadDetail(selected); }}
						onDeleted={async () => { setSelected(null); setDetail(null); await loadList(); }}
					/>
				)}
			</div>

			<aside className="pensieve-tri-detail">
				<VariablesPanel
					detail={detail}
					allVars={vars}
					orderedNames={detailVars}
					onSet={handleSaveVar}
					onDelete={handleDeleteVar}
				/>
			</aside>
		</div>
	);
}
