/**
 * Ring-buffered log capture for the Pensieve Activity > Logs view.
 *
 * elizaOS already exposes `addLogListener(fn)` — we subscribe and push entries
 * into a fixed-size ring (default 5000). The UI polls /api/pensieve/logs every
 * 5 seconds and gets back the slice matching its filters.
 */

import { addLogListener, type LogEntry } from "@elizaos/core";

const DEFAULT_CAP = 5000;

export interface PensieveLogEntry {
	readonly time: number;
	/** Numeric Pino-style level (10–60). */
	readonly level: number;
	/** Resolved level name for the UI (debug|info|warn|error|fatal). */
	readonly levelName: string;
	readonly msg: string;
	readonly source?: string;
	readonly agentName?: string;
	readonly agentId?: string;
	/** Any extra structured fields the logger received. */
	readonly extras?: Record<string, unknown>;
}

const LEVEL_NAMES: Record<number, string> = {
	10: "trace",
	20: "debug",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal",
};

function resolveLevelName(level: number | undefined): string {
	if (typeof level !== "number") return "info";
	const exact = LEVEL_NAMES[level];
	if (exact) return exact;
	if (level >= 60) return "fatal";
	if (level >= 50) return "error";
	if (level >= 40) return "warn";
	if (level >= 30) return "info";
	if (level >= 20) return "debug";
	return "trace";
}

function normalize(entry: LogEntry): PensieveLogEntry {
	const { time, level, msg, agentName, agentId, ...rest } = entry;
	const extrasEntries = Object.entries(rest).filter(([k]) => !k.startsWith("_"));
	const out: PensieveLogEntry = {
		time: typeof time === "number" ? time : Date.now(),
		level: typeof level === "number" ? level : 30,
		levelName: resolveLevelName(typeof level === "number" ? level : 30),
		msg: typeof msg === "string" ? msg : String(msg ?? ""),
		...(agentName ? { agentName: String(agentName) } : {}),
		...(agentId ? { agentId: String(agentId) } : {}),
		...(extrasEntries.length > 0 ? { extras: Object.fromEntries(extrasEntries) } : {}),
	};
	// Source is a common convention key — surface it if present.
	const sourceCandidate = (rest.src ?? rest.source ?? rest.module) as string | undefined;
	if (typeof sourceCandidate === "string") {
		(out as { source?: string }).source = sourceCandidate;
	}
	return out;
}

export interface ListLogsOptions {
	level?: string; // "info" → matches info+; or exact: "==info"
	source?: string;
	q?: string; // case-insensitive substring on msg
	limit?: number;
	since?: number; // ts ms
}

export class PensieveLogService {
	private buf: PensieveLogEntry[] = [];
	private off: (() => void) | null = null;

	constructor(private readonly capacity = DEFAULT_CAP) {}

	start(): void {
		if (this.off) return;
		this.off = addLogListener((entry) => {
			this.push(normalize(entry));
		});
	}

	stop(): void {
		this.off?.();
		this.off = null;
	}

	private push(e: PensieveLogEntry): void {
		this.buf.push(e);
		if (this.buf.length > this.capacity) {
			// Drop the oldest 5% in one go to amortise the splice cost.
			this.buf.splice(0, Math.ceil(this.capacity * 0.05));
		}
	}

	list(opts: ListLogsOptions = {}): PensieveLogEntry[] {
		const { level, source, q, limit = 200, since } = opts;
		const lvlExact = level?.startsWith("==");
		const lvlName = lvlExact ? level!.slice(2) : level;
		const lvlMin = lvlName ? minLevel(lvlName) : 0;
		const qLower = q?.toLowerCase();
		const out: PensieveLogEntry[] = [];
		// Walk newest-first so the limit hits recent entries.
		for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
			const e = this.buf[i]!;
			if (since && e.time < since) break;
			if (lvlName) {
				if (lvlExact ? e.levelName !== lvlName : e.level < lvlMin) continue;
			}
			if (source && e.source !== source) continue;
			if (qLower && !e.msg.toLowerCase().includes(qLower)) continue;
			out.push(e);
		}
		return out.reverse(); // chronological for the UI
	}

	clear(): void {
		this.buf.length = 0;
	}
}

function minLevel(name: string): number {
	switch (name) {
		case "trace": return 10;
		case "debug": return 20;
		case "info": return 30;
		case "warn": return 40;
		case "error": return 50;
		case "fatal": return 60;
		default: return 30;
	}
}
