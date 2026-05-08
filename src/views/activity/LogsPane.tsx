import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityLogEntry } from "@detour/shared";
import type { WebClient } from "../_shared/api/client";
import { usePoller } from "./usePoller";

const LEVEL_COLORS: Record<string, string> = {
	trace: "var(--fg-subtle)",
	debug: "var(--fg-muted)",
	info: "var(--fg)",
	warn: "var(--warn)",
	error: "var(--error)",
	fatal: "var(--error)",
};

export function LogsPane({ client }: { client: WebClient }) {
	const [level, setLevel] = useState("info");
	const [q, setQ] = useState("");
	const fetcher = useCallback(() => client.activityLogs({ level, q: q || undefined, limit: 500 }), [client, level, q]);
	const { data, error } = usePoller<ActivityLogEntry[]>(fetcher, 5000, [level, q]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);

	useEffect(() => {
		if (autoScroll && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [data, autoScroll]);

	return (
		<div className="pensieve-logs">
			<div className="pensieve-toolbar">
				<select value={level} onChange={(e) => setLevel(e.target.value)} className="pensieve-select">
					<option value="trace">trace+</option>
					<option value="debug">debug+</option>
					<option value="info">info+</option>
					<option value="warn">warn+</option>
					<option value="error">error+</option>
				</select>
				<input
					type="text"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Filter messages…"
					className="pensieve-input"
				/>
				<label className="pensieve-toolbar-toggle">
					<input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
					Auto-scroll
				</label>
			</div>
			{error && <div className="banner error">{error}</div>}
			<div className="pensieve-logs-list" ref={scrollRef}>
				{(data ?? []).map((e, i) => (
					<div key={`${e.time}-${i}`} className="pensieve-log-row">
						<span className="pensieve-log-time">{new Date(e.time).toLocaleTimeString(undefined, { hour12: false })}</span>
						<span className="pensieve-log-level" style={{ color: LEVEL_COLORS[e.levelName] }}>{e.levelName}</span>
						{e.source && <span className="pensieve-log-source">{e.source}</span>}
						<span className="pensieve-log-msg">{e.msg}</span>
					</div>
				))}
				{!data?.length && <div className="hint" style={{ padding: 12 }}>No log entries (yet).</div>}
			</div>
		</div>
	);
}
