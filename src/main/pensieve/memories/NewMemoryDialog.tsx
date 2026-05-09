/**
 * Modal for creating a new memory at a specific path.
 *
 * Used by the Memories pane "+ New" button. Type defaults to "custom" so
 * user-authored notes show up under /custom (or wherever the user chose).
 */

import { useState } from "react";
import type { WebClient } from "../../api/client";
import { rpc } from "../../rpc";

const TYPE_OPTIONS = [
	{ value: "custom", label: "Custom (note)" },
	{ value: "description", label: "Observation" },
	{ value: "document", label: "Document" },
	{ value: "fragment", label: "Fragment" },
];

export function NewMemoryDialog({
	client,
	initialPath,
	initialType,
	onClose,
	onCreated,
}: {
	client: WebClient;
	initialPath: string;
	initialType?: string;
	onClose: () => void;
	onCreated: (id: string) => void;
}) {
	const [text, setText] = useState("");
	const [path, setPath] = useState(initialPath);
	const [type, setType] = useState(initialType ?? "custom");
	const [tagsRaw, setTagsRaw] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		if (!text.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const tags = tagsRaw
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			const result = await rpc.request.pensieveMemoryCreate({
				text,
				path,
				type,
				...(tags.length > 0 ? { tags } : {}),
			});
			onCreated(result.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="modal-backdrop" onClick={onClose} role="presentation">
			<div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
				<h3 style={{ margin: "0 0 12px" }}>New memory</h3>
				<label className="form-row">
					<span className="form-label">Path</span>
					<input
						type="text"
						value={path}
						onChange={(e) => setPath(e.target.value)}
						placeholder="/notes/projects/detour"
						className="pensieve-input"
					/>
				</label>
				<label className="form-row">
					<span className="form-label">Type</span>
					<select value={type} onChange={(e) => setType(e.target.value)} className="pensieve-select">
						{TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
					</select>
				</label>
				<label className="form-row">
					<span className="form-label">Tags (comma-separated)</span>
					<input
						type="text"
						value={tagsRaw}
						onChange={(e) => setTagsRaw(e.target.value)}
						placeholder="lore, character, draft"
						className="pensieve-input"
					/>
				</label>
				<label className="form-row">
					<span className="form-label">Content</span>
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder="Memory body…"
						className="pensieve-textarea"
						rows={8}
					/>
				</label>
				{error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
				<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
					<button type="button" className="btn ghost small" onClick={onClose}>Cancel</button>
					<button type="button" className="btn small" disabled={busy || !text.trim()} onClick={submit}>
						{busy ? "Saving…" : "Create"}
					</button>
				</div>
			</div>
		</div>
	);
}
