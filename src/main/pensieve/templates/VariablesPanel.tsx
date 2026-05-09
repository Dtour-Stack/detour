/**
 * Side panel for editing the persisted prompt-variable namespace.
 *
 * Variables are stored as memories under /prompt-vars/<name> with tag
 * `prompt-var:<name>`. The detail panel shows variables for the currently-
 * selected template first (in the order they appear in the body), then any
 * other persisted variables underneath.
 */

import { useEffect, useState } from "react";
import type { PensievePromptVariable, PensieveTemplateDetail } from "../../../shared/index";

export function VariablesPanel({
	detail,
	allVars,
	orderedNames,
	onSet,
	onDelete,
}: {
	detail: PensieveTemplateDetail | null;
	allVars: PensievePromptVariable[];
	orderedNames: string[];
	onSet: (name: string, value: string) => Promise<void>;
	onDelete: (name: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [adding, setAdding] = useState(false);
	const [newName, setNewName] = useState("");
	const [newValue, setNewValue] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const next: Record<string, string> = {};
		for (const v of allVars) next[v.name] = v.value;
		setDraft(next);
	}, [allVars]);

	const valueByName = (name: string): string => draft[name] ?? "";
	const dirtyFor = (name: string): boolean => {
		const current = allVars.find((v) => v.name === name)?.value ?? "";
		return draft[name] !== undefined && draft[name] !== current;
	};

	const save = async (name: string) => {
		setBusy(name);
		setError(null);
		try {
			await onSet(name, valueByName(name));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	const remove = async (name: string) => {
		setBusy(name);
		setError(null);
		try {
			await onDelete(name);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	const create = async () => {
		const slug = newName.trim();
		if (!slug) return;
		setBusy(slug);
		setError(null);
		try {
			await onSet(slug, newValue);
			setNewName(""); setNewValue(""); setAdding(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	const isMissing = (name: string): boolean => {
		if (!detail) return false;
		return detail.missingVariables.includes(name);
	};

	return (
		<div className="vars-panel">
			<div className="pensieve-toolbar" style={{ padding: "8px 12px" }}>
				<span className="hint" style={{ flex: 1, fontWeight: 600 }}>Variables</span>
				<button type="button" className="link" onClick={() => setAdding((a) => !a)}>
					{adding ? "cancel" : "＋ add"}
				</button>
			</div>

			{adding && (
				<div className="vars-row vars-row-new">
					<input
						type="text"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						placeholder="variable name"
						className="pensieve-input"
					/>
					<textarea
						value={newValue}
						onChange={(e) => setNewValue(e.target.value)}
						placeholder="value"
						className="pensieve-textarea"
						rows={3}
					/>
					<div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
						<button type="button" className="link" onClick={() => { setAdding(false); setNewName(""); setNewValue(""); }}>cancel</button>
						<button type="button" className="btn small" disabled={!newName.trim() || busy === newName.trim()} onClick={create}>
							create
						</button>
					</div>
				</div>
			)}

			{error && <div className="banner error" style={{ margin: "8px 12px 0" }}>{error}</div>}

			{orderedNames.length === 0 ? (
				<div className="empty" style={{ margin: 12 }}>No variables yet.</div>
			) : (
				<div className="vars-list">
					{orderedNames.map((name) => {
						const used = detail ? detail.variables.includes(name) : false;
						const missing = isMissing(name);
						return (
							<div key={name} className={`vars-row ${used ? "used" : ""} ${missing ? "missing" : ""}`}>
								<div className="vars-row-name">
									<span className="badge muted">{`{{${name}}}`}</span>
									{used && !missing && <span className="badge ok">used</span>}
									{missing && <span className="badge warn">no value</span>}
								</div>
								<textarea
									value={valueByName(name)}
									onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
									className="pensieve-textarea"
									rows={3}
									placeholder={missing ? "(unset)" : ""}
								/>
								<div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
									<button
										type="button"
										className="link danger"
										disabled={busy === name}
										onClick={() => remove(name)}
									>
										delete
									</button>
									<button
										type="button"
										className="btn small"
										disabled={!dirtyFor(name) || busy === name}
										onClick={() => save(name)}
									>
										{busy === name ? "saving…" : dirtyFor(name) ? "save" : "saved"}
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
