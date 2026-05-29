/**
 * Email (AgentMail) settings — configure the agent's email channel.
 * Enabling provisions an inbox from your API key (console.agentmail.to).
 * Also sets RECAP_EMAIL, the address the nightly recap is sent to.
 * Talks only via typed RPC.
 */
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../rpc";
import type { AgentMailConfig, AgentMailStatus } from "../../shared/index";

export function AgentMailTab() {
	const [status, setStatus] = useState<AgentMailStatus | null>(null);
	const [config, setConfig] = useState<AgentMailConfig | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [recapEmail, setRecapEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setStatus(await rpc.request.agentMailStatus({}));
		} catch {
			/* ignore */
		}
		try {
			setConfig(await rpc.request.agentMailGetConfig({}));
		} catch {
			/* ignore */
		}
		try {
			const r = await rpc.request.vaultGetKey({ key: "RECAP_EMAIL", reveal: true });
			setRecapEmail(r.value ?? "");
		} catch {
			/* ignore */
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const enable = useCallback(async () => {
		if (!apiKey.trim()) {
			setMsg("Enter your AgentMail API key (am_…) from console.agentmail.to.");
			return;
		}
		setBusy(true);
		setMsg(null);
		try {
			const res = await rpc.request.agentMailEnable({ apiKey: apiKey.trim() });
			setMsg(res.ok ? `Enabled — inbox ${res.inboxAddress}` : `Failed: ${res.error}`);
			if (res.ok) setApiKey("");
			await refresh();
		} finally {
			setBusy(false);
		}
	}, [apiKey, refresh]);

	const disable = useCallback(async () => {
		setBusy(true);
		try {
			await rpc.request.agentMailDisable({});
			setMsg("Disabled.");
			await refresh();
		} finally {
			setBusy(false);
		}
	}, [refresh]);

	const saveRecapEmail = useCallback(async () => {
		setBusy(true);
		try {
			await rpc.request.vaultSetKey({ key: "RECAP_EMAIL", value: recapEmail.trim() });
			setMsg("Recap email saved.");
		} finally {
			setBusy(false);
		}
	}, [recapEmail]);

	const toggle = useCallback(
		async (patch: Partial<AgentMailConfig>) => {
			setBusy(true);
			try {
				setConfig(await rpc.request.agentMailSetConfig(patch));
			} finally {
				setBusy(false);
			}
		},
		[],
	);

	const connected = status?.connected ?? false;

	return (
		<div style={{ padding: 16, color: "#e8e8ea", fontSize: 14, maxWidth: 620 }}>
			<h2 style={{ marginTop: 0 }}>Email (AgentMail)</h2>
			<p style={{ color: "#9a9ca5" }}>
				Give the agent its own inbox to send/receive email (e.g. the nightly recap). Get an API key from{" "}
				<a href="https://console.agentmail.to" style={{ color: "#5b8cff" }} target="_blank" rel="noreferrer">
					console.agentmail.to
				</a>
				.
			</p>

			<div style={rowStyle}>
				<strong>Status:</strong>{" "}
				{connected ? (
					<span style={{ color: "#4ade80" }}>connected — {status?.inboxAddress ?? "inbox provisioned"}</span>
				) : status?.enabled ? (
					<span style={{ color: "#fbbf24" }}>enabled, not connected{status?.lastError ? ` (${status.lastError})` : ""}</span>
				) : (
					<span style={{ color: "#9a9ca5" }}>disabled</span>
				)}
			</div>

			{!connected && (
				<div style={sectionStyle}>
					<label style={labelStyle}>AgentMail API key</label>
					<input
						type="password"
						style={inputStyle}
						placeholder="am_…"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
					/>
					<button style={primaryBtn} disabled={busy} onClick={() => void enable()}>
						{busy ? "Enabling…" : "Enable & provision inbox"}
					</button>
				</div>
			)}
			{connected && (
				<div style={sectionStyle}>
					<button style={secondaryBtn} disabled={busy} onClick={() => void disable()}>
						Disable
					</button>
					<label style={{ ...rowStyle, marginTop: 12 }}>
						<input type="checkbox" checked={config?.autoReply ?? false} onChange={(e) => void toggle({ autoReply: e.target.checked })} /> Auto-reply to incoming email
					</label>
					<label style={rowStyle}>
						<input type="checkbox" checked={config?.draftMode ?? false} onChange={(e) => void toggle({ draftMode: e.target.checked })} /> Draft mode (don't auto-send)
					</label>
				</div>
			)}

			<div style={sectionStyle}>
				<label style={labelStyle}>Recap email (where the nightly recap is sent)</label>
				<div style={{ display: "flex", gap: 8 }}>
					<input
						type="email"
						style={{ ...inputStyle, flex: 1 }}
						placeholder="you@example.com"
						value={recapEmail}
						onChange={(e) => setRecapEmail(e.target.value)}
					/>
					<button style={secondaryBtn} disabled={busy} onClick={() => void saveRecapEmail()}>
						Save
					</button>
				</div>
				<p style={{ color: "#7c7e87", fontSize: 12, margin: "6px 0 0" }}>
					Requires AgentMail connected. The recap also pops up in the app regardless.
				</p>
			</div>

			{msg && <div style={{ marginTop: 12, color: "#9a9ca5" }}>{msg}</div>}
		</div>
	);
}

const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "8px 0" };
const sectionStyle: React.CSSProperties = { borderTop: "1px solid #2a2c33", paddingTop: 14, marginTop: 14, display: "flex", flexDirection: "column", gap: 8 };
const labelStyle: React.CSSProperties = { fontWeight: 600 };
const inputStyle: React.CSSProperties = {
	background: "#0e0f12", color: "#e8e8ea", border: "1px solid #2a2c33", borderRadius: 8, padding: "8px 10px", fontSize: 13,
};
const primaryBtn: React.CSSProperties = { background: "#5b8cff", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontWeight: 600, alignSelf: "flex-start" };
const secondaryBtn: React.CSSProperties = { background: "transparent", color: "#e8e8ea", border: "1px solid #2a2c33", borderRadius: 8, padding: "8px 14px", cursor: "pointer", alignSelf: "flex-start" };
