import { useCallback, useEffect, useMemo, useState } from "react";
import type { PensieveMemorySummary, PensieveMemoryTree, PensieveMemoryTreeNode } from "../../../shared/index";
import { UI_DELAY_MS } from "../../../shared/timing";
import { rpc } from "../../rpc";
import { KnowledgeUploadDropzone } from "./KnowledgeUploadDropzone";
import { MemoryDetail } from "./MemoryDetail";
import { MemoryTree } from "./MemoryTree";
import { NewMemoryDialog } from "./NewMemoryDialog";

const ALL_TYPES = [
	{ value: "", label: "All types" },
	{ value: "message", label: "Messages" },
	{ value: "fact", label: "Facts" },
	{ value: "document", label: "Documents" },
	{ value: "fragment", label: "Fragments" },
	{ value: "description", label: "Observations" },
	{ value: "custom", label: "Custom" },
];

/**
 * Generic memory browser. Three Pensieve sidebar entries reuse this:
 *
 *   - <MemoriesPane />                  (the catch-all "Memories" entry)
 *   - <MemoriesPane scope="notes" />    (user-authored notes under /notes)
 *   - <MemoriesPane scope="knowledge"/> (DOCUMENT/FRAGMENT — elizaOS knowledge surface)
 *
 * Scope tweaks the path tree filter, the type-dropdown menu, and the
 * defaults used by "+ New". The underlying store is the same memories table.
 */
export type MemoriesScope = "all" | "notes" | "knowledge";

export function MemoriesPane({ scope = "all" }: { scope?: MemoriesScope }) {
	const config = useMemo(() => scopeConfig(scope), [scope]);

	const [items, setItems] = useState<PensieveMemorySummary[]>([]);
	const [tree, setTree] = useState<PensieveMemoryTree | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [type, setType] = useState(config.defaultType);
	const [q, setQ] = useState("");
	const [searchMode, setSearchMode] = useState<"text" | "vector">("text");
	const [selected, setSelected] = useState<string | null>(null);
	const [pathFilter, setPathFilter] = useState<string>(config.rootPath);
	const [newOpen, setNewOpen] = useState(false);

	const loadTree = useCallback(async () => {
		try {
			const t = await rpc.request.pensieveMemoryTree({});
			setTree(scopeTree(t, config.rootPath));
		} catch (e) {
			console.warn(`[${scope}] tree load failed`, e);
		}
	}, [config.rootPath, scope]);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			let rows: PensieveMemorySummary[];
			const effectivePath = pathFilter && pathFilter !== "/" ? pathFilter : config.rootPath;
			const usePathFilter = effectivePath !== "/";
			if (searchMode === "vector" && q.trim().length > 0) {
				rows = await rpc.request.pensieveMemoriesSearch({ text: q, limit: 100 });
				if (usePathFilter) {
					rows = rows.filter((m) => m.path === effectivePath || m.path.startsWith(`${effectivePath}/`));
				}
			} else {
				rows = await rpc.request.pensieveMemoriesList({
					limit: 200,
					...(type ? { type } : {}),
					...(q ? { q } : {}),
					...(usePathFilter ? { pathPrefix: effectivePath } : {}),
				});
			}
			if (config.allowedTypes) {
				rows = rows.filter((m) => !m.type || config.allowedTypes!.includes(m.type));
			}
			setItems(rows);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [type, q, searchMode, pathFilter, config.rootPath, config.allowedTypes]);

	useEffect(() => { void loadTree(); }, [loadTree]);
	useEffect(() => {
		const t = setTimeout(load, q ? UI_DELAY_MS.pensieveSearchDebounce : 0);
		return () => clearTimeout(t);
	}, [load, q]);

	const typeOptions = useMemo(() => {
		if (!config.typeOptions) return ALL_TYPES;
		return config.typeOptions;
	}, [config.typeOptions]);

	return (
		<>
			<div className="pensieve-tri">
				<aside className="pensieve-tri-tree">
					<div className="pensieve-toolbar" style={{ padding: "8px 10px" }}>
						<span className="hint" style={{ flex: 1, fontWeight: 600 }}>{config.treeLabel}</span>
						<button
							type="button"
							className="link"
							onClick={() => setNewOpen(true)}
							title={`Create a new ${config.newButtonLabel} at the selected folder`}
						>
							＋ New
						</button>
					</div>
					<MemoryTree
						tree={tree}
						selectedPath={pathFilter}
						onSelectPath={setPathFilter}
					/>
				</aside>
				<div className="pensieve-tri-list">
					<div className="pensieve-toolbar">
						<select value={type} onChange={(e) => setType(e.target.value)} className="pensieve-select">
							{typeOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
						</select>
						<input
							type="text"
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder={`Search ${config.searchPlaceholder}…`}
							className="pensieve-input"
							style={{ flex: 1 }}
						/>
						<select
							value={searchMode}
							onChange={(e) => setSearchMode(e.target.value as "text" | "vector")}
							className="pensieve-select"
							title="Search mode"
						>
							<option value="text">Text</option>
							<option value="vector">Vector</option>
						</select>
					</div>
					<div className="pensieve-tri-path">
						<span className="hint">{pathFilter === config.rootPath ? config.rootLabel : pathFilter}</span>
						{pathFilter !== config.rootPath && (
							<button type="button" className="link" onClick={() => setPathFilter(config.rootPath)}>clear</button>
						)}
						<span className="hint" style={{ marginLeft: "auto" }}>{items.length} shown</span>
					</div>
					{scope === "knowledge" && (
						<KnowledgeUploadDropzone
							onIngested={() => { void load(); void loadTree(); }}
						/>
					)}
					{error && <div className="banner error">{error}</div>}
					{loading && items.length === 0 && <div className="hint" style={{ padding: 12 }}>Loading…</div>}
					<div className="pensieve-list">
						{items.map((m) => (
							<button
								key={m.id}
								type="button"
								className={selected === m.id ? "pensieve-list-row active" : "pensieve-list-row"}
								onClick={() => setSelected(m.id)}
							>
								<div className="pensieve-list-row-header">
									{m.type && <span className="badge muted">{m.type}</span>}
									<span className="badge info" title="path">{m.path}</span>
									{m.tags?.slice(0, 3).map((t) => <span key={t} className="badge muted">{t}</span>)}
									{m.createdAt && <span className="hint">{new Date(m.createdAt).toLocaleDateString()}</span>}
								</div>
								<div className="pensieve-list-row-preview">{m.preview}</div>
							</button>
						))}
						{!loading && items.length === 0 && (
							<div className="empty">{config.emptyText}</div>
						)}
					</div>
				</div>
				<div className="pensieve-tri-detail">
					{selected ? (
						<MemoryDetail
							memoryId={selected}
							onDelete={() => { setSelected(null); load(); loadTree(); }}
							onUpdate={() => { load(); loadTree(); }}
						/>
					) : (
						<div className="empty" style={{ marginTop: 30 }}>Select a {config.newButtonLabel} to view details.</div>
					)}
				</div>
			</div>
			{newOpen && (
				<NewMemoryDialog
					initialPath={pathFilter && pathFilter !== "/" ? pathFilter : config.newDefaultPath}
					initialType={config.newDefaultType}
					onClose={() => setNewOpen(false)}
					onCreated={() => { setNewOpen(false); load(); loadTree(); }}
				/>
			)}
		</>
	);
}

interface ScopeConfig {
	rootPath: string;
	rootLabel: string;
	treeLabel: string;
	newButtonLabel: string;
	newDefaultPath: string;
	newDefaultType: string;
	searchPlaceholder: string;
	emptyText: string;
	defaultType: string;
	allowedTypes?: string[];
	typeOptions?: { value: string; label: string }[];
}

function scopeConfig(scope: MemoriesScope): ScopeConfig {
	if (scope === "notes") {
		return {
			rootPath: "/notes",
			rootLabel: "/notes (all)",
			treeLabel: "Notes",
			newButtonLabel: "note",
			newDefaultPath: "/notes",
			newDefaultType: "custom",
			searchPlaceholder: "notes",
			emptyText: "No notes yet — use “New” to create your first.",
			defaultType: "",
			typeOptions: [
				{ value: "", label: "All notes" },
				{ value: "custom", label: "Custom" },
				{ value: "description", label: "Observations" },
			],
		};
	}
	if (scope === "knowledge") {
		return {
			rootPath: "/knowledge",
			rootLabel: "/knowledge (all)",
			treeLabel: "Knowledge",
			newButtonLabel: "document",
			newDefaultPath: "/knowledge/documents",
			newDefaultType: "document",
			searchPlaceholder: "knowledge",
			emptyText: "No knowledge yet. Add documents below or via the agent's plugin-knowledge ingest.",
			defaultType: "",
			allowedTypes: ["document", "fragment"],
			typeOptions: [
				{ value: "", label: "All knowledge" },
				{ value: "document", label: "Documents" },
				{ value: "fragment", label: "Fragments" },
			],
		};
	}
	return {
		rootPath: "/",
		rootLabel: "All folders",
		treeLabel: "Folders",
		newButtonLabel: "memory",
		newDefaultPath: "/notes",
		newDefaultType: "custom",
		searchPlaceholder: "memories",
		emptyText: "No memories match — try a different filter.",
		defaultType: "",
	};
}

/** Restrict a memory tree to a sub-path so /notes shows only the /notes subtree, etc. */
function scopeTree(tree: PensieveMemoryTree, rootPath: string): PensieveMemoryTree {
	if (rootPath === "/") return tree;
	const node = findNode(tree.root, rootPath);
	if (!node) {
		return {
			root: { path: rootPath, name: rootPath.replace(/^\//, ""), count: 0, totalCount: 0, children: [] },
			total: 0,
		};
	}
	return { root: node, total: node.totalCount };
}

function findNode(node: PensieveMemoryTreeNode, path: string): PensieveMemoryTreeNode | null {
	if (node.path === path) return node;
	for (const c of node.children) {
		const hit = findNode(c, path);
		if (hit) return hit;
	}
	return null;
}
