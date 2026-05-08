/**
 * Ring-buffered log capture for the Activity > Logs view.
 *
 * elizaOS exposes `addLogListener(fn)` from `@elizaos/core`, but bundlers can
 * end up with multiple module instances of `@elizaos/core` in the same
 * process — our subscription registers in one instance's listener Set while
 * the runtime emits via another. Result: silent failure, no logs ever appear.
 *
 * Defence in depth:
 *  1. Subscribe to `addLogListener` (best path when modules are deduped).
 *  2. Also patch the listener registry into a globalThis-keyed Set so any
 *     other module instance routes to us via `globalThis[symbol]`.
 *  3. Emit a startup probe (`logger.info("[activity] log capture started")`)
 *     so we can verify the chain end-to-end at boot.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addLogListener, logger, type LogEntry } from "@elizaos/core";
import { getTraceId } from "../trace";

const DEFAULT_CAP = 5000;
const GLOBAL_KEY = Symbol.for("detour.activity.logSinks");

const LOG_DIR = join(homedir(), ".detour", "logs");
const FILE_RETENTION_DAYS = 7;

type Sink = (entry: LogEntry) => void;

interface GlobalSinkRegistry {
	sinks: Set<Sink>;
}

function getGlobalRegistry(): GlobalSinkRegistry {
	const g = globalThis as unknown as Record<symbol, unknown>;
	if (!g[GLOBAL_KEY]) {
		g[GLOBAL_KEY] = { sinks: new Set<Sink>() };
	}
	return g[GLOBAL_KEY] as GlobalSinkRegistry;
}

export interface ActivityLogEntry {
	readonly time: number;
	readonly level: number;
	readonly levelName: string;
	readonly msg: string;
	readonly source?: string;
	readonly agentName?: string;
	readonly agentId?: string;
	readonly traceId?: string;
	readonly extras?: Record<string, unknown>;
}

const LEVEL_NAMES: Record<number, string> = {
	10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal",
};
function resolveLevelName(level: number | undefined): string {
	if (typeof level !== "number") return "info";
	if (LEVEL_NAMES[level]) return LEVEL_NAMES[level]!;
	if (level >= 60) return "fatal";
	if (level >= 50) return "error";
	if (level >= 40) return "warn";
	if (level >= 30) return "info";
	if (level >= 20) return "debug";
	return "trace";
}
function normalize(entry: LogEntry): ActivityLogEntry {
	const { time, level, msg, agentName, agentId, ...rest } = entry as LogEntry & Record<string, unknown>;
	const sourceCandidate = (rest.src ?? rest.source ?? rest.module) as string | undefined;
	// Trace id can come from explicit log fields (logger.info({ traceId, ... }))
	// OR from the ambient AsyncLocalStorage scope. Explicit wins.
	const explicitTrace = (rest.traceId ?? rest.trace_id) as string | undefined;
	const ambientTrace = getTraceId();
	const traceId = (typeof explicitTrace === "string" && explicitTrace.length > 0) ? explicitTrace : ambientTrace;
	const reserved = new Set(["src", "source", "module", "traceId", "trace_id"]);
	const extrasEntries = Object.entries(rest).filter(([k]) => !k.startsWith("_") && !reserved.has(k));
	const out: ActivityLogEntry = {
		time: typeof time === "number" ? time : Date.now(),
		level: typeof level === "number" ? level : 30,
		levelName: resolveLevelName(typeof level === "number" ? level : 30),
		msg: typeof msg === "string" ? msg : String(msg ?? ""),
		...(agentName ? { agentName: String(agentName) } : {}),
		...(agentId ? { agentId: String(agentId) } : {}),
		...(typeof sourceCandidate === "string" ? { source: sourceCandidate } : {}),
		...(traceId ? { traceId } : {}),
		...(extrasEntries.length > 0 ? { extras: Object.fromEntries(extrasEntries) } : {}),
	};
	return out;
}

export interface ListLogsOptions {
	level?: string;
	source?: string;
	q?: string;
	limit?: number;
	since?: number;
}

export interface ActivityLogServiceOptions {
	capacity?: number;
	/** Minimum level to capture. "trace"=10 captures everything; "info"=30 drops debug/trace. Default "info". */
	minLevel?: string;
	/** When true (default), append every captured entry to a daily JSONL file at ~/.detour/logs/. */
	persistToDisk?: boolean;
}

export class ActivityLogService {
	private buf: ActivityLogEntry[] = [];
	private offDirect: (() => void) | null = null;
	private sink: Sink | null = null;
	private readonly capacity: number;
	private readonly minLevelValue: number;
	private readonly persistToDisk: boolean;
	private currentLogFile: string | null = null;
	private currentLogDate: string | null = null;

	constructor(opts: ActivityLogServiceOptions | number = {}) {
		// Backwards compat: old constructor took just `capacity` as a number.
		if (typeof opts === "number") opts = { capacity: opts };
		this.capacity = opts.capacity ?? DEFAULT_CAP;
		this.minLevelValue = opts.minLevel ? minLevel(opts.minLevel) : 30; // info+
		this.persistToDisk = opts.persistToDisk !== false;
	}

	start(): void {
		if (this.sink) return;
		this.sink = (entry) => this.push(normalize(entry));

		// Path 1: direct subscription via `@elizaos/core` (works when bundler dedupes).
		try {
			this.offDirect = addLogListener(this.sink);
		} catch {
			// best effort
		}

		// Path 2: register on a globalThis-keyed sink set so other module
		// instances of @elizaos/core can find us.
		const reg = getGlobalRegistry();
		reg.sinks.add(this.sink);

		// Verification probe — proves the chain end-to-end at boot.
		try {
			logger.info("[activity] log capture started");
		} catch {
			// some test envs replace logger; ignore
		}
	}

	stop(): void {
		if (this.offDirect) { this.offDirect(); this.offDirect = null; }
		if (this.sink) {
			getGlobalRegistry().sinks.delete(this.sink);
			this.sink = null;
		}
	}

	private push(e: ActivityLogEntry): void {
		// Level filter at write time — drops noise (debug/trace by default) so
		// the ring buffer + the daily file aren't dominated by per-tick warnings.
		if (e.level < this.minLevelValue) return;
		this.buf.push(e);
		if (this.buf.length > this.capacity) {
			this.buf.splice(0, Math.ceil(this.capacity * 0.05));
		}
		if (this.persistToDisk) this.persist(e);
	}

	/**
	 * Append every captured entry to a daily JSONL file under
	 * ~/.detour/logs/detour-YYYY-MM-DD.jsonl. The ring buffer is fast but
	 * evaporates on restart; this gives the user a long-tail log they can
	 * grep after a crash. Old files (>7 days) are pruned lazily on rotation.
	 */
	private persist(e: ActivityLogEntry): void {
		const date = new Date(e.time).toISOString().slice(0, 10); // YYYY-MM-DD
		if (this.currentLogDate !== date) {
			try {
				if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
				this.currentLogFile = join(LOG_DIR, `detour-${date}.jsonl`);
				this.currentLogDate = date;
				this.pruneOldFiles();
			} catch {
				// can't create dir — disable persistence for this run
				this.currentLogFile = null;
			}
		}
		if (!this.currentLogFile) return;
		try {
			appendFileSync(this.currentLogFile, `${JSON.stringify(e)}\n`, { mode: 0o600 });
		} catch {
			// disk full / permission revoked mid-run — silently degrade
		}
	}

	private pruneOldFiles(): void {
		try {
			const cutoff = Date.now() - FILE_RETENTION_DAYS * 86_400_000;
			const fs = require("node:fs") as typeof import("node:fs");
			for (const name of fs.readdirSync(LOG_DIR)) {
				if (!name.startsWith("detour-") || !name.endsWith(".jsonl")) continue;
				const full = join(LOG_DIR, name);
				const st = fs.statSync(full);
				if (st.mtimeMs < cutoff) {
					try { fs.unlinkSync(full); } catch { /* ignore */ }
				}
			}
		} catch {
			// best-effort cleanup
		}
	}

	list(opts: ListLogsOptions = {}): ActivityLogEntry[] {
		const { level, source, q, limit = 200, since } = opts;
		const lvlMin = level ? minLevel(level) : 0;
		const qLower = q?.toLowerCase();
		const out: ActivityLogEntry[] = [];
		for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
			const e = this.buf[i]!;
			if (since && e.time < since) break;
			if (level && e.level < lvlMin) continue;
			if (source && e.source !== source) continue;
			if (qLower && !e.msg.toLowerCase().includes(qLower)) continue;
			out.push(e);
		}
		return out.reverse();
	}

	clear(): void {
		this.buf.length = 0;
	}

	/** Test hook: how many log entries are currently buffered. */
	size(): number {
		return this.buf.length;
	}

	/**
	 * Inject a log entry from a webview console. Lets WKWebView JS errors and
	 * console.log/warn/error in the chat/settings/pensieve windows surface in
	 * the Activity > Logs pane and the persisted JSONL file alongside main-
	 * process logs — otherwise they're invisible until DevTools is opened.
	 */
	captureWebviewLog(entry: {
		level: "trace" | "debug" | "info" | "warn" | "error";
		msg: string;
		source?: string;
		traceId?: string;
		extras?: Record<string, unknown>;
	}): void {
		const lvl = minLevel(entry.level);
		const traceId = entry.traceId ?? getTraceId();
		this.push({
			time: Date.now(),
			level: lvl,
			levelName: entry.level,
			msg: entry.msg,
			source: entry.source ?? "webview",
			...(traceId ? { traceId } : {}),
			...(entry.extras ? { extras: entry.extras } : {}),
		});
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

/**
 * Universal sink invoker — any code in the bundle can call this to push a
 * log entry into every registered sink (including ones in different module
 * instances of @elizaos/core). Mostly used by tests, but bundler-deduped
 * production code can also use it as a belt-and-braces backup if a custom
 * logger transport doesn't fire `addLogListener`.
 */
export function publishLogEntry(entry: LogEntry): void {
	for (const sink of getGlobalRegistry().sinks) {
		try { sink(entry); } catch { /* ignore */ }
	}
}
