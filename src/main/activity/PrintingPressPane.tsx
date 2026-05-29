/**
 * PrintingPressPane — "Tools" tab in the Activity window.
 *
 * Browse the full 181 CLI catalog, grouped by category, with per-CLI
 * toggle switches to control which CLIs the agent has access to.
 * Install, uninstall, search, and configure agent CLI access.
 */

import { useCallback, useEffect, useState, useMemo } from "react";
import { rpc } from "../rpc";
import type {
	PrintingPressConfig,
	PrintingPressCatalogEntry,
	PrintingPressCatalogSnapshot,
} from "../../shared/index";

const POLL_MS = 10_000;

// ── Subcomponents ─────────────────────────────────────────────────────

function CliToggle({
	label,
	value,
	disabled,
	onChange,
}: {
	label: string;
	value: boolean;
	disabled: boolean;
	onChange: () => void;
}) {
	return (
		<div className="pp-toggle-row">
			<span>{label}</span>
			<button
				type="button"
				className={`channel-toggle ${value ? "on" : "off"}`}
				disabled={disabled}
				onClick={onChange}
				aria-label={`${value ? "Disable" : "Enable"} ${label}`}
				title={`${value ? "Disable" : "Enable"} ${label}`}
			>
				<span className="channel-toggle-knob" />
			</button>
		</div>
	);
}

function CliRow({
	entry,
	busy,
	onToggle,
	onInstall,
	onUninstall,
}: {
	entry: PrintingPressCatalogEntry;
	busy: boolean;
	onToggle: (slug: string, enabled: boolean) => void;
	onInstall: (slug: string) => void;
	onUninstall: (slug: string) => void;
}) {
	return (
		<div className={`pp-cli-row ${entry.enabled ? "pp-cli-enabled" : ""}`}>
			<div className="pp-cli-main">
				<div className="pp-cli-header">
					<span className="pp-cli-name">{entry.slug}</span>
					{entry.hasMcp && (
						<span className="badge info" title={`${entry.toolCount} MCP tools`}>
							MCP {entry.toolCount}
						</span>
					)}
					{entry.installed && <span className="badge ok">installed</span>}
					{!entry.installed && <span className="badge muted">not installed</span>}
				</div>
				<div className="pp-cli-desc">{entry.description}</div>
				<div className="pp-cli-api hint">{entry.api}</div>
			</div>
			<div className="pp-cli-actions">
				{entry.installed ? (
					<>
						<button
							type="button"
							className={`channel-toggle ${entry.enabled ? "on" : "off"}`}
							disabled={busy}
							onClick={() => onToggle(entry.slug, !entry.enabled)}
							title={entry.enabled ? "Disable for agent" : "Enable for agent"}
						>
							<span className="channel-toggle-knob" />
						</button>
						<button
							type="button"
							className="btn small ghost"
							disabled={busy}
							onClick={() => onUninstall(entry.slug)}
							title="Uninstall CLI"
						>
							×
						</button>
					</>
				) : (
					<button
						type="button"
						className="btn small"
						disabled={busy}
						onClick={() => onInstall(entry.slug)}
					>
						Install
					</button>
				)}
			</div>
		</div>
	);
}

function CategoryAccordion({
	category,
	count,
	enabledCount,
	entries,
	busy,
	expanded,
	onExpand,
	onToggle,
	onToggleCategory,
	onInstall,
	onUninstall,
}: {
	category: string;
	count: number;
	enabledCount: number;
	entries: PrintingPressCatalogEntry[];
	busy: boolean;
	expanded: boolean;
	onExpand: () => void;
	onToggle: (slug: string, enabled: boolean) => void;
	onToggleCategory: (category: string, enabled: boolean) => void;
	onInstall: (slug: string) => void;
	onUninstall: (slug: string) => void;
}) {
	const allEnabled = enabledCount === count;
	return (
		<div className="pp-category">
			<button type="button" className="pp-category-header" onClick={onExpand}>
				<span className={`pp-category-arrow ${expanded ? "expanded" : ""}`}>▸</span>
				<span className="pp-category-name">{category}</span>
				<span className="pp-category-counts">
					<span className="badge muted">{count}</span>
					{enabledCount > 0 && (
						<span className="badge ok">{enabledCount} on</span>
					)}
				</span>
				<span style={{ flex: 1 }} />
				<button
					type="button"
					className="btn small ghost"
					disabled={busy}
					onClick={(e) => {
						e.stopPropagation();
						onToggleCategory(category, !allEnabled);
					}}
					title={allEnabled ? "Disable all in category" : "Enable all in category"}
				>
					{allEnabled ? "Disable All" : "Enable All"}
				</button>
			</button>
			{expanded && (
				<div className="pp-category-list">
					{entries.map((e) => (
						<CliRow
							key={e.slug}
							entry={e}
							busy={busy}
							onToggle={onToggle}
							onInstall={onInstall}
							onUninstall={onUninstall}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ── Main pane ─────────────────────────────────────────────────────────

export function PrintingPressPane() {
	const [data, setData] = useState<PrintingPressCatalogSnapshot | null>(null);
	const [config, setConfig] = useState<PrintingPressConfig | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [search, setSearch] = useState("");
	const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
	const [installing, setInstalling] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [cat, cfg] = await Promise.all([
				rpc.request.printingPressCatalog({ search: search || undefined }),
				rpc.request.printingPressGetConfig({}),
			]);
			setData(cat as PrintingPressCatalogSnapshot);
			setConfig(cfg as PrintingPressConfig);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [search]);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), POLL_MS);
		return () => clearInterval(timer);
	}, [load]);

	// Group entries by category
	const grouped = useMemo(() => {
		if (!data) return new Map<string, PrintingPressCatalogEntry[]>();
		const map = new Map<string, PrintingPressCatalogEntry[]>();
		for (const e of data.entries) {
			const list = map.get(e.category) ?? [];
			list.push(e);
			map.set(e.category, list);
		}
		return map;
	}, [data]);

	const handleToggle = useCallback(async (slug: string, enabled: boolean) => {
		setBusy(true);
		try {
			await rpc.request.printingPressToggleCli({ slug, enabled });
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [load]);

	const handleToggleCategory = useCallback(async (category: string, enabled: boolean) => {
		setBusy(true);
		try {
			await rpc.request.printingPressToggleCategory({ category, enabled });
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [load]);

	const handleInstall = useCallback(async (slug: string) => {
		setBusy(true);
		setInstalling(slug);
		try {
			const result = await rpc.request.printingPressInstallCli({ slug }) as { ok: boolean; output: string };
			if (!result.ok) setError(`Install failed: ${result.output}`);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
			setInstalling(null);
		}
	}, [load]);

	const handleUninstall = useCallback(async (slug: string) => {
		setBusy(true);
		try {
			await rpc.request.printingPressUninstallCli({ slug });
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [load]);

	const handleConfigChange = useCallback(async (patch: Partial<PrintingPressConfig>) => {
		setBusy(true);
		try {
			const updated = await rpc.request.printingPressSetConfig(patch) as PrintingPressConfig;
			setConfig(updated);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);

	if (error) {
		return <div className="banner error" style={{ margin: 18 }}>{error}</div>;
	}
	if (!data || !config) {
		return <div className="empty" style={{ margin: 24 }}>Loading Printing Press catalog...</div>;
	}

	return (
		<div className="pp-pane">
			{/* Header */}
			<div className="pensieve-toolbar">
				<span className="badge muted">{data.entries.length} CLIs</span>
				<span className="badge ok">{data.totalInstalled} installed</span>
				<span className="badge info">{data.totalEnabled} enabled</span>
				<span style={{ flex: 1 }} />
				<input
					type="text"
					className="pensieve-input"
					placeholder="Search CLIs..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					style={{ width: 200 }}
				/>
			</div>

			{/* Installing indicator */}
			{installing && (
				<div className="pp-installing-bar">
					Installing <strong>{installing}</strong>... this may take a minute.
				</div>
			)}

			{/* Config toggles */}
			<div className="pp-config-section">
				<CliToggle
					label="Auto-install when agent needs a CLI"
					value={config.autoInstall}
					disabled={busy}
					onChange={() => void handleConfigChange({ autoInstall: !config.autoInstall })}
				/>
				<CliToggle
					label="Allow agent to create new CLIs"
					value={config.allowCreate}
					disabled={busy}
					onChange={() => void handleConfigChange({ allowCreate: !config.allowCreate })}
				/>
			</div>

			{/* Category list */}
			<div className="pp-catalog">
				{data.categories.map((cat) => {
					const entries = grouped.get(cat.category) ?? [];
					if (entries.length === 0) return null;
					return (
						<CategoryAccordion
							key={cat.category}
							category={cat.category}
							count={cat.count}
							enabledCount={cat.enabledCount}
							entries={entries}
							busy={busy}
							expanded={expandedCats.has(cat.category)}
							onExpand={() => {
								setExpandedCats((prev) => {
									const next = new Set(prev);
									if (next.has(cat.category)) next.delete(cat.category);
									else next.add(cat.category);
									return next;
								});
							}}
							onToggle={handleToggle}
							onToggleCategory={handleToggleCategory}
							onInstall={handleInstall}
							onUninstall={handleUninstall}
						/>
					);
				})}
			</div>
		</div>
	);
}
