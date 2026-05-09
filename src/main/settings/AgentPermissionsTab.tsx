import { useEffect, useState } from "react";
import type { AgentConfig, AgentVaultMode } from "../../shared/index";
import { rpc } from "../rpc";

const MODES: { id: AgentVaultMode; label: string; help: string }[] = [
	{ id: "off", label: "Off", help: "Agent has no vault access at all." },
	{ id: "read", label: "Read-only", help: "Agent can list + read keys and reveal saved logins." },
	{ id: "read-write", label: "Read + write", help: "Agent can also save / overwrite / delete entries." },
];

export function AgentPermissionsTab() {
	const [cfg, setCfg] = useState<AgentConfig | null>(null);
	const [allowedDraft, setAllowedDraft] = useState("");
	const [deniedDraft, setDeniedDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	useEffect(() => {
		void rpc.request.configGetAgent({}).then((c) => {
			setCfg(c);
			setAllowedDraft(c.allowedPrefixes.join(", "));
			setDeniedDraft(c.deniedPrefixes.join(", "));
		});
	}, []);

	async function save(next: AgentConfig) {
		setSaving(true);
		try {
			await rpc.request.configSetAgent(next);
			setCfg(next);
			setSavedAt(Date.now());
			setTimeout(() => setSavedAt((t) => (t && Date.now() - t > 2000 ? null : t)), 2200);
		} finally {
			setSaving(false);
		}
	}

	function setMode(mode: AgentVaultMode) {
		if (!cfg) return;
		void save({ ...cfg, mode });
	}
	function setDeny(deny: boolean) {
		if (!cfg) return;
		void save({ ...cfg, deny });
	}
	function setElevatedCoding(elevatedCoding: boolean) {
		if (!cfg) return;
		void save({ ...cfg, elevatedCoding });
	}
	function commitPrefixes() {
		if (!cfg) return;
		const allowedPrefixes = allowedDraft.split(",").map((s) => s.trim()).filter(Boolean);
		const deniedPrefixes = deniedDraft.split(",").map((s) => s.trim()).filter(Boolean);
		void save({ ...cfg, allowedPrefixes, deniedPrefixes });
	}

	if (!cfg) return <div className="hint">Loading…</div>;

	return (
		<div>
			<h3 style={{ margin: "0 0 4px" }}>Agent vault permissions</h3>
			<p className="hint">
				Controls what the LLM agent (in chat) can do with your encrypted vault and saved logins.
				Every action is logged to <code>~/.eliza/audit/agent-vault-actions.jsonl</code>.
			</p>

			<div className="card">
				<div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
					<span className="name" style={{ fontSize: 13 }}>Kill switch</span>
					<label style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
						<input type="checkbox" checked={cfg.deny} onChange={(e) => setDeny(e.target.checked)} disabled={saving} />
						<span style={{ fontSize: 12, color: cfg.deny ? "var(--error)" : "var(--fg-muted)" }}>
							{cfg.deny ? "ALL access denied" : "off"}
						</span>
					</label>
				</div>
				<div className="hint" style={{ marginBottom: 0 }}>
					When on, every agent vault action is refused regardless of mode.
				</div>
			</div>

			<div className="card">
				<label>Mode</label>
				<div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
					{MODES.map((m) => (
						<label
							key={m.id}
							style={{
								display: "flex",
								alignItems: "flex-start",
								gap: 8,
								padding: 8,
								borderRadius: "var(--radius-sm)",
								background: cfg.mode === m.id ? "var(--accent-soft)" : "transparent",
								cursor: "pointer",
								margin: 0,
							}}
						>
							<input
								type="radio"
								checked={cfg.mode === m.id}
								onChange={() => setMode(m.id)}
								disabled={saving || cfg.deny}
								style={{ marginTop: 2 }}
							/>
							<div>
								<div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>{m.label}</div>
								<div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{m.help}</div>
							</div>
						</label>
					))}
				</div>
			</div>

			<div className="card">
				<label>Allow-list (key prefixes, comma-separated)</label>
				<div className="hint" style={{ marginTop: 4, marginBottom: 6 }}>
					When set, only keys starting with one of these prefixes are accessible. Leave empty to allow all (except deny-list).
				</div>
				<input
					type="text"
					value={allowedDraft}
					placeholder="GITHUB_, agent.dizzy., creds."
					onChange={(e) => setAllowedDraft(e.target.value)}
					onBlur={commitPrefixes}
				/>

				<label style={{ marginTop: 14 }}>Deny-list (additional)</label>
				<div className="hint" style={{ marginTop: 4, marginBottom: 6 }}>
					Always-denied prefixes (in addition to system defaults: <code>_manager.</code>, <code>_meta.</code>, <code>_routing.</code>, <code>pm.</code>, <code>config.</code>, <code>ui.</code>).
				</div>
				<input
					type="text"
					value={deniedDraft}
					placeholder="EVM_PRIVATE_KEY, SOLANA_PRIVATE_KEY"
					onChange={(e) => setDeniedDraft(e.target.value)}
					onBlur={commitPrefixes}
				/>
			</div>

			<h3 style={{ margin: "20px 0 4px" }}>Coding agent</h3>
			<p className="hint">
				Behavior of the FILE / BASH / EDIT / GLOB / GREP / WEB_FETCH actions and the AGENT_PROJECT_NEW
				scaffolder. Toggling elevated permissions tells the agent it's authorized to act broadly
				without extra confirmation gates — useful when you want the agent to drive a real coding session.
			</p>
			<div className="card">
				<div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
					<div>
						<span className="name" style={{ fontSize: 13 }}>Elevated permissions</span>
						<div className="hint" style={{ marginTop: 2 }}>
							When on, the coding-agent brief tells the agent it can run shell commands and write files freely
							without ASK_USER_QUESTION confirmation gates. The system blocklist (<code>~/.ssh</code>,
							<code>~/.aws</code>, <code>~/Library</code>, system dirs) is still enforced regardless.
						</div>
					</div>
					<label style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
						<input
							type="checkbox"
							checked={cfg.elevatedCoding ?? false}
							onChange={(e) => setElevatedCoding(e.target.checked)}
							disabled={saving}
						/>
						<span style={{ fontSize: 12, color: cfg.elevatedCoding ? "var(--accent)" : "var(--fg-muted)" }}>
							{cfg.elevatedCoding ? "ELEVATED" : "off"}
						</span>
					</label>
				</div>
			</div>

			{saving && <div className="hint">Saving…</div>}
			{!saving && savedAt && <div className="hint" style={{ color: "var(--ok)" }}>Saved.</div>}
		</div>
	);
}
