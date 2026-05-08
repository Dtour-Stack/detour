/**
 * Folder-tree sidebar for the Memories pane. Renders the path hierarchy
 * computed by the backend (`memory.metadata.path`) with per-folder counts
 * (count at exactly this path + totalCount including descendants).
 *
 * Click a folder → MemoriesPane filters its list by pathPrefix.
 */

import { useState } from "react";
import type { PensieveMemoryTree, PensieveMemoryTreeNode } from "@detour/shared";

export function MemoryTree({
	tree,
	selectedPath,
	onSelectPath,
}: {
	tree: PensieveMemoryTree | null;
	selectedPath: string;
	onSelectPath: (path: string) => void;
}) {
	if (!tree) return <div className="hint" style={{ padding: 12 }}>Loading folders…</div>;
	if (tree.total === 0) return <div className="empty" style={{ margin: 12 }}>No memories yet.</div>;

	return (
		<div className="memory-tree">
			<TreeNode
				node={tree.root}
				depth={0}
				selectedPath={selectedPath}
				onSelectPath={onSelectPath}
				rootLabel="All memories"
				defaultOpen
			/>
		</div>
	);
}

function TreeNode({
	node,
	depth,
	selectedPath,
	onSelectPath,
	rootLabel,
	defaultOpen,
}: {
	node: PensieveMemoryTreeNode;
	depth: number;
	selectedPath: string;
	onSelectPath: (path: string) => void;
	rootLabel?: string;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen ?? depth < 2);
	const hasChildren = node.children.length > 0;
	const label = rootLabel ?? node.name;
	const isSelected = node.path === selectedPath;
	const total = node.totalCount;
	const exact = node.count;
	return (
		<div className="memory-tree-node">
			<div
				className={`memory-tree-row ${isSelected ? "active" : ""}`}
				style={{ paddingLeft: 6 + depth * 12 }}
			>
				{hasChildren ? (
					<button
						type="button"
						className="memory-tree-twirl"
						onClick={() => setOpen((o) => !o)}
						aria-label={open ? "Collapse" : "Expand"}
					>
						{open ? "▾" : "▸"}
					</button>
				) : (
					<span className="memory-tree-twirl" aria-hidden>·</span>
				)}
				<button
					type="button"
					className="memory-tree-label"
					onClick={() => onSelectPath(node.path)}
					title={node.path}
				>
					<span className="memory-tree-name">{label}</span>
					<span className="memory-tree-count">
						{hasChildren ? `${exact}/${total}` : `${exact}`}
					</span>
				</button>
			</div>
			{open && hasChildren && (
				<div className="memory-tree-children">
					{node.children.map((c) => (
						<TreeNode
							key={c.path}
							node={c}
							depth={depth + 1}
							selectedPath={selectedPath}
							onSelectPath={onSelectPath}
						/>
					))}
				</div>
			)}
		</div>
	);
}
