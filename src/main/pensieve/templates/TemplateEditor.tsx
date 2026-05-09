/**
 * Template body editor + render-preview pane.
 *
 * Auto-extract `{{var}}` references from the body, highlight unsatisfied ones,
 * and render a live preview by calling /api/pensieve/templates/:id/render
 * with the persisted variable values.
 */

import { useEffect, useMemo, useState } from "react";
import type { PensieveTemplateDetail, PensieveTemplateRenderResult } from "../../../shared/index";
import type { WebClient } from "../../api/client";

const VAR_REGEX = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;

export function TemplateEditor({
	client,
	detail,
	onSaved,
	onDeleted,
}: {
	client: WebClient;
	detail: PensieveTemplateDetail;
	onSaved: () => Promise<void> | void;
	onDeleted: () => Promise<void> | void;
}) {
	const [body, setBody] = useState(detail.body);
	const [tagsRaw, setTagsRaw] = useState((detail.tags ?? []).filter((t) => t !== "template").join(", "));
	const [path, setPath] = useState(detail.path);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<PensieveTemplateRenderResult | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [showPreview, setShowPreview] = useState(true);

	useEffect(() => {
		setBody(detail.body);
		setTagsRaw((detail.tags ?? []).filter((t) => t !== "template").join(", "));
		setPath(detail.path);
		setPreview(null);
	}, [detail.id, detail.body, detail.tags, detail.path]);

	const draftVars = useMemo(() => {
		const set = new Set<string>();
		for (const m of body.matchAll(VAR_REGEX)) if (m[1]) set.add(m[1]);
		return Array.from(set);
	}, [body]);

	const draftMissing = useMemo(() => {
		return draftVars.filter((v) => !(v in detail.currentValues));
	}, [draftVars, detail.currentValues]);

	const dirty =
		body !== detail.body ||
		path !== detail.path ||
		tagsRaw !== (detail.tags ?? []).filter((t) => t !== "template").join(", ");

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const tags = ["template", ...tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)];
			await client.pensieveUpdateTemplate(detail.id, { body, tags, path });
			await onSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	const render = async () => {
		setPreviewLoading(true);
		setError(null);
		try {
			const r = await client.pensieveRenderTemplate(detail.id);
			setPreview(r);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPreviewLoading(false);
		}
	};

	const remove = async () => {
		if (!confirm(`Delete template "${detail.name}"? This can't be undone.`)) return;
		try {
			await client.pensieveDeleteTemplate(detail.id);
			await onDeleted();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const copy = async (text: string) => {
		try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
	};

	return (
		<div className="template-editor">
			<div className="pensieve-toolbar">
				<span className="hint" style={{ fontWeight: 600 }}>{detail.name}</span>
				<span style={{ flex: 1 }} />
				<button type="button" className="link" onClick={() => setShowPreview((s) => !s)}>
					{showPreview ? "hide preview" : "show preview"}
				</button>
				<button type="button" className="link" disabled={previewLoading} onClick={render}>
					{previewLoading ? "rendering…" : "render"}
				</button>
				<button type="button" className="btn small" disabled={!dirty || saving} onClick={save}>
					{saving ? "saving…" : "save"}
				</button>
				<button type="button" className="btn small ghost" onClick={remove}>delete</button>
			</div>

			{error && <div className="banner error" style={{ margin: "8px 12px 0" }}>{error}</div>}

			<div className="template-editor-meta">
				<label className="form-row">
					<span className="form-label">Path</span>
					<input
						type="text"
						value={path}
						onChange={(e) => setPath(e.target.value)}
						className="pensieve-input"
					/>
				</label>
				<label className="form-row">
					<span className="form-label">Tags (in addition to “template”)</span>
					<input
						type="text"
						value={tagsRaw}
						onChange={(e) => setTagsRaw(e.target.value)}
						placeholder="character, system, squirrel-mode"
						className="pensieve-input"
					/>
				</label>
			</div>

			<div className="template-editor-body">
				<div className="template-editor-section">
					<div className="template-editor-section-header">
						<span>Body</span>
						<span className="hint">
							{draftVars.length} variable{draftVars.length === 1 ? "" : "s"}
							{draftMissing.length > 0 && (
								<> · <span style={{ color: "var(--warn)" }}>{draftMissing.length} missing values</span></>
							)}
						</span>
					</div>
					<textarea
						value={body}
						onChange={(e) => setBody(e.target.value)}
						className="pensieve-textarea template-editor-textarea"
						spellCheck={false}
					/>
					{draftVars.length > 0 && (
						<div className="template-vars-strip">
							{draftVars.map((v) => {
								const has = v in detail.currentValues;
								return (
									<span
										key={v}
										className={`badge ${has ? "info" : "warn"}`}
										title={has ? detail.currentValues[v] : "no value set — see Variables panel"}
									>
										{`{{${v}}}`}
									</span>
								);
							})}
						</div>
					)}
				</div>

				{showPreview && (
					<div className="template-editor-section">
						<div className="template-editor-section-header">
							<span>Preview</span>
							{preview && (
								<button type="button" className="link" onClick={() => copy(preview.rendered)}>
									copy
								</button>
							)}
						</div>
						{!preview ? (
							<div className="empty" style={{ margin: 0, padding: 18 }}>
								Click <strong>render</strong> to substitute current variable values into the body.
							</div>
						) : (
							<>
								<pre className="trajectory-pre" style={{ maxHeight: 320 }}>
									{preview.rendered}
								</pre>
								{preview.missing.length > 0 && (
									<div className="banner warn" style={{ marginTop: 6 }}>
										Missing values: {preview.missing.map((m) => `{{${m}}}`).join(", ")}
									</div>
								)}
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
