import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "../rpc";
import type { SkillSourceTag, SkillSummary } from "../../shared/rpc/skills";

const SOURCE_LABEL: Record<SkillSourceTag, string> = {
	bundled: "Bundled",
	managed: "Installed",
	curated: "Curated",
	project: "Project",
	unknown: "—",
};

const SOURCE_HINT: Record<SkillSourceTag, string> = {
	bundled: "Ships with Detour; read-only.",
	managed: "Installed via INSTALL_SKILL from the agent's registry.",
	curated: "Locally promoted / actively used by the agent.",
	project: "Workspace-specific, in this project's skills folder.",
	unknown: "Source unknown.",
};

function shortPath(path: string | null): string {
	if (!path) return "";
	const home = (typeof window !== "undefined" ? (window as unknown as { __HOME?: string }).__HOME : undefined) ?? "";
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

export function SkillsTab() {
	const [skills, setSkills] = useState<SkillSummary[] | null>(null);
	const [bundledDir, setBundledDir] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [sourceFilter, setSourceFilter] = useState<"all" | SkillSourceTag>("all");
	const [toast, setToast] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const out = await rpc.request.skillsList({});
			setSkills(out.skills);
			setBundledDir(out.bundledDir);
			setErr(null);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const filtered = useMemo(() => {
		const list = skills ?? [];
		const q = filter.trim().toLowerCase();
		return list.filter((s) => {
			if (sourceFilter !== "all" && s.source !== sourceFilter) return false;
			if (!q) return true;
			return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
		});
	}, [skills, filter, sourceFilter]);

	const counts = useMemo(() => {
		const c: Record<SkillSourceTag, number> = { bundled: 0, managed: 0, curated: 0, project: 0, unknown: 0 };
		for (const s of skills ?? []) c[s.source] += 1;
		return c;
	}, [skills]);

	const openPath = useCallback(async (path: string | null) => {
		if (!path) return;
		try {
			await rpc.request.skillsOpenDir({ path });
			setToast(`Opened ${path}`);
			setTimeout(() => setToast(null), 1500);
		} catch (e) {
			setToast(`Open failed: ${e instanceof Error ? e.message : String(e)}`);
			setTimeout(() => setToast(null), 3000);
		}
	}, []);

	return (
		<div className="settings-pane" style={{ padding: 16, maxWidth: 880 }}>
			<h3 style={{ margin: "0 0 8px" }}>Skills</h3>
			<p className="hint" style={{ marginBottom: 12 }}>
				Skills are SKILL.md packages the agent can invoke. The agent uses{" "}
				<code>SEARCH_SKILLS</code> to find new ones, <code>INSTALL_SKILL</code> to add from the
				registry, <code>TOGGLE_SKILL</code> to enable/disable, and <code>USE_SKILL</code> to
				run one. The bundled <code>skill-creator</code> skill walks the agent through authoring
				a new one. This panel is read-only — say so in chat and the agent will take action.
			</p>

			{toast && (
				<div className="banner success" style={{ marginBottom: 12 }}>
					{toast}
				</div>
			)}
			{err && (
				<div className="banner error" style={{ marginBottom: 12 }}>
					{err}
				</div>
			)}

			{bundledDir && (
				<section className="card" style={{ marginBottom: 12 }}>
					<div className="provider-header">
						<span className="name">Bundled skills folder</span>
						<button type="button" className="btn small secondary" onClick={() => void openPath(bundledDir)}>
							Open in Finder
						</button>
					</div>
					<code style={{ wordBreak: "break-all", display: "block" }}>{bundledDir}</code>
				</section>
			)}

			<div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
				<input
					type="search"
					placeholder="Filter by name or description…"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					style={{ flex: 1, minWidth: 220, padding: "6px 10px" }}
				/>
				<select
					value={sourceFilter}
					onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
					style={{ padding: "6px 10px" }}
				>
					<option value="all">All sources ({skills?.length ?? 0})</option>
					{(["bundled", "managed", "curated", "project", "unknown"] as SkillSourceTag[]).map((s) => (
						<option key={s} value={s} disabled={counts[s] === 0}>
							{SOURCE_LABEL[s]} ({counts[s]})
						</option>
					))}
				</select>
				<button type="button" className="btn small secondary" onClick={() => void load()}>
					Refresh
				</button>
			</div>

			{skills === null ? (
				<p className="hint">Loading…</p>
			) : filtered.length === 0 ? (
				<p className="hint" style={{ margin: 0 }}>
					{(skills.length === 0)
						? "No skills found. Bundled skills should ship with Detour — check the bundled-skills env."
						: "No skills match the current filter."}
				</p>
			) : (
				<ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
					{filtered.map((s) => (
						<li key={`${s.source}:${s.name}:${s.filePath ?? ""}`}>
							<section className="card">
								<div className="provider-header" style={{ alignItems: "flex-start" }}>
									<span className="name" style={{ display: "flex", gap: 6, alignItems: "center" }}>
										{s.emoji ? <span aria-hidden="true">{s.emoji}</span> : null}
										<code>{s.name}</code>
									</span>
									<span className="badge" title={SOURCE_HINT[s.source]}>
										{SOURCE_LABEL[s.source]}
									</span>
								</div>
								<p style={{ margin: "6px 0 8px", fontSize: 13, lineHeight: 1.4 }}>
									{s.description || <em className="hint">(no description)</em>}
								</p>
								{s.baseDir && (
									<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
										<code style={{ wordBreak: "break-all", fontSize: 11, flex: 1 }}>
											{shortPath(s.baseDir)}
										</code>
										<button
											type="button"
											className="btn small secondary"
											onClick={() => void openPath(s.baseDir)}
										>
											Open
										</button>
									</div>
								)}
							</section>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
