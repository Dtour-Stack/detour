/**
 * Drag-drop upload area for the Pensieve > Knowledge pane.
 *
 * Each dropped file's text is read in the browser, then POSTed to
 * /api/pensieve/knowledge/ingest, which delegates to elizaOS's
 * KnowledgeService.addKnowledge — fragmenting + embedding so the agent's
 * existing RAG pipeline picks it up.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebClient } from "../../api/client";

interface UploadStatus {
	filename: string;
	state: "uploading" | "done" | "error";
	fragmentCount?: number;
	error?: string;
}

const TEXT_MIMES = [
	"text/plain", "text/markdown", "text/csv", "text/html", "text/xml", "text/x-yaml",
	"application/json", "application/xml", "application/yaml",
];

function isTextLike(file: File): boolean {
	if (TEXT_MIMES.includes(file.type)) return true;
	if (file.type.startsWith("text/")) return true;
	return /\.(md|markdown|txt|json|yaml|yml|xml|html|csv|log|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|scss)$/i.test(file.name);
}

async function readAsText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
		r.onerror = () => reject(r.error ?? new Error("read failed"));
		r.readAsText(file);
	});
}

export function KnowledgeUploadDropzone({
	client,
	onIngested,
}: {
	client: WebClient;
	onIngested: () => void;
}) {
	const [available, setAvailable] = useState<boolean | null>(null);
	const [dragActive, setDragActive] = useState(false);
	const [items, setItems] = useState<UploadStatus[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		client.pensieveKnowledgeStatus()
			.then((s) => setAvailable(s.available))
			.catch(() => setAvailable(false));
	}, [client]);

	const ingest = useCallback(async (files: FileList | File[]) => {
		const arr = Array.from(files);
		for (const file of arr) {
			if (!isTextLike(file)) {
				setItems((s) => [...s, { filename: file.name, state: "error", error: "Binary file — only text/markdown/json/code currently supported." }]);
				continue;
			}
			setItems((s) => [...s, { filename: file.name, state: "uploading" }]);
			try {
				const content = await readAsText(file);
				const result = await client.pensieveIngestKnowledge({
					filename: file.name,
					contentType: file.type || "text/plain",
					content,
				});
				setItems((s) => s.map((it) =>
					it.filename === file.name && it.state === "uploading"
						? { ...it, state: "done", fragmentCount: result.fragmentCount }
						: it,
				));
				onIngested();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				setItems((s) => s.map((it) =>
					it.filename === file.name && it.state === "uploading"
						? { ...it, state: "error", error: msg }
						: it,
				));
			}
		}
	}, [client, onIngested]);

	if (available === false) {
		return (
			<div className="banner warn" style={{ margin: "10px 14px" }}>
				KnowledgeService isn't loaded — upload disabled. Add @elizaos/plugin-knowledge to the runtime to enable RAG ingestion.
			</div>
		);
	}

	return (
		<div className="knowledge-upload">
			<button
				type="button"
				className={`knowledge-dropzone ${dragActive ? "active" : ""}`}
				onClick={() => inputRef.current?.click()}
				onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
				onDragLeave={() => setDragActive(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragActive(false);
					if (e.dataTransfer?.files) void ingest(e.dataTransfer.files);
				}}
			>
				<div className="knowledge-dropzone-title">Drop files to ingest as knowledge</div>
				<div className="hint">
					Markdown · text · JSON · code. Files are chunked, embedded, and stored as elizaOS knowledge fragments.
				</div>
				<input
					ref={inputRef}
					type="file"
					multiple
					style={{ display: "none" }}
					onChange={(e) => {
						if (e.target.files) void ingest(e.target.files);
						e.target.value = "";
					}}
				/>
			</button>
			{items.length > 0 && (
				<div className="knowledge-upload-list">
					{items.map((it, i) => (
						<div key={`${it.filename}-${i}`} className="knowledge-upload-row">
							<span className={`badge ${it.state === "done" ? "ok" : it.state === "error" ? "err" : "info"}`}>
								{it.state === "done" ? `${it.fragmentCount} frags` : it.state}
							</span>
							<span className="knowledge-upload-name">{it.filename}</span>
							{it.error && <span className="hint" style={{ color: "var(--error)" }}>{it.error}</span>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
