import { useEffect, useState } from "react";
import type { WindowConfig } from "../../shared/index";
import type { WebClient } from "../api/client";
import { rpc } from "../rpc";

export function WindowTab({ client }: { client: WebClient }) {
	const [cfg, setCfg] = useState<WindowConfig | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		void rpc.request.configGetWindow({}).then(setCfg);
	}, [client]);

	async function save(next: WindowConfig) {
		setSaving(true);
		try {
			await rpc.request.configSetWindow(next);
			setCfg(next);
			setSavedAt(Date.now());
			setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 2000 ? null : t)), 2200);
			if (next.width !== cfg?.width || next.height !== cfg?.height) {
				await rpc.request.windowResize({ width: next.width, height: next.height }).catch(() => {});
			}
		} finally {
			setSaving(false);
		}
	}

	if (!cfg) return <div className="hint">Loading…</div>;

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Window behavior</h3>
			<p className="hint">Tray popup size + dismiss behavior. Restart not required for size changes.</p>

			<div className="card">
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
					<div>
						<label>Width (px)</label>
						<input
							type="number"
							value={cfg.width}
							min={320}
							max={1600}
							onChange={(e) => save({ ...cfg, width: Math.max(320, Math.min(1600, Number(e.target.value) || 0)) })}
						/>
					</div>
					<div>
						<label>Height (px)</label>
						<input
							type="number"
							value={cfg.height}
							min={320}
							max={1600}
							onChange={(e) => save({ ...cfg, height: Math.max(320, Math.min(1600, Number(e.target.value) || 0)) })}
						/>
					</div>
				</div>
			</div>

			<div className="card">
				<label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, cursor: "pointer" }}>
					<input
						type="checkbox"
						checked={cfg.hideOnBlur}
						onChange={(e) => save({ ...cfg, hideOnBlur: e.target.checked })}
					/>
					<div>
						<div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>Hide on blur</div>
						<div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
							Auto-dismiss popup when you click outside it. Useful for menubar feel; annoying for password-manager flows. Off by default — close with the X button.
						</div>
					</div>
				</label>
			</div>

			<div className="card">
				<label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, cursor: "pointer" }}>
					<input
						type="checkbox"
						checked={cfg.alwaysOnTop}
						onChange={(e) => save({ ...cfg, alwaysOnTop: e.target.checked })}
					/>
					<div>
						<div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>Always on top</div>
						<div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
							Keep popup above other windows.
						</div>
					</div>
				</label>
			</div>

			{saving && <div className="hint">Saving…</div>}
			{!saving && savedAt && <div className="hint" style={{ color: "var(--ok)" }}>Saved.</div>}
		</div>
	);
}
