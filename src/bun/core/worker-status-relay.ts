/**
 * Worker status relay — turns PTYService session events into human
 * readable status pings the chat UI can render between turns.
 *
 * The orchestrator's swarm coordinator fires `wsBroadcast(event)` for
 * every internal lifecycle moment: session_ready, tool_running,
 * task_complete, stopped, message, etc. Most of those are too noisy
 * for end-user chat ("session_ready" fires per tool round-trip). We
 * filter to a small set of moments that read as progress + dress
 * them with the spawned worker's name.
 *
 * Output flows through the existing broadcaster as a new
 * `workerStatusUpdate` message type — the chat UI subscribes to it
 * separately from `chatDelta` so worker pings don't interleave with
 * the agent's own streaming reply.
 *
 * Throttling: `tool_running` fires per tool invocation and can spike
 * during heavy code-edit sessions. We rate-limit per (sessionId, tool)
 * to one status every 5 seconds. Other event kinds aren't throttled
 * because they fire rarely.
 */

export type RawPtySessionEvent = {
	type: string;
	sessionId?: string;
	[key: string]: unknown;
};

export type WorkerStatusUpdate = {
	sessionId: string;
	workerName: string;
	eventType: string;
	summary: string;
	timestamp: number;
	tool?: string;
};

type Clock = () => number;

const TOOL_THROTTLE_MS = 5_000;

/** Events we relay to chat. Everything else passes through silently. */
const SURFACED_EVENTS = new Set<string>([
	"session_ready",
	"session_started",
	"session_starting",
	"spawned",
	"tool_running",
	"tool_started",
	"task_complete",
	"completed",
	"stopped",
	"failed",
	"login_required",
	"output_summary",
]);

function asRecord(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Quick rule of thumb: read whichever common field carries a tool name. */
function extractToolName(event: RawPtySessionEvent): string | undefined {
	const rec = asRecord(event);
	return (
		asString(rec.tool) ??
		asString(rec.toolName) ??
		asString(rec.tool_name) ??
		asString(asRecord(rec.data).tool) ??
		asString(asRecord(rec.data).toolName) ??
		asString(asRecord(rec.data).tool_name) ??
		asString(asRecord(rec.data).name)
	);
}

/** Try to find a brief target — filename / arg / path the tool is acting on. */
function extractToolTarget(event: RawPtySessionEvent): string | undefined {
	const rec = asRecord(event);
	const data = asRecord(rec.data);
	const candidates = [
		rec.target,
		rec.path,
		rec.filename,
		rec.file,
		data.target,
		data.path,
		data.filename,
		data.file,
		data.arg,
		asString(data.args) ? data.args : undefined,
	];
	for (const c of candidates) {
		const s = asString(c);
		if (s && s.length < 200) return s;
	}
	return undefined;
}

export function formatStatusSummary(
	workerName: string,
	event: RawPtySessionEvent,
): string {
	switch (event.type) {
		case "session_ready":
		case "session_started":
		case "session_starting":
		case "spawned":
			return `${workerName} is online and ready.`;
		case "tool_running":
		case "tool_started": {
			const tool = extractToolName(event);
			const target = extractToolTarget(event);
			if (tool && target) return `${workerName} is running ${tool} on ${target}.`;
			if (tool) return `${workerName} is using ${tool}.`;
			return `${workerName} is working on something.`;
		}
		case "task_complete":
		case "completed":
			return `${workerName} finished.`;
		case "stopped":
			return `${workerName} stepped away.`;
		case "failed": {
			const err = asString(asRecord(event).error) ?? asString(asRecord(asRecord(event).data).error);
			return err ? `${workerName} hit a snag: ${err}` : `${workerName} hit a snag.`;
		}
		case "login_required":
			return `${workerName} needs you to authenticate.`;
		case "output_summary": {
			const summary =
				asString(asRecord(event).summary) ??
				asString(asRecord(asRecord(event).data).summary);
			return summary ? `${workerName}: ${summary}` : `${workerName} is reporting in.`;
		}
		default:
			return `${workerName} (${event.type}).`;
	}
}

/**
 * Build a status relay. Stateful for throttling — keep one instance
 * per orchestrator-bridge wiring so the `(sessionId, tool)` rate-limit
 * lasts across events.
 */
export function createWorkerStatusRelay(opts: {
	lookupWorkerName: (sessionId: string) => string | undefined;
	now?: Clock;
}) {
	const now = opts.now ?? Date.now;
	const lastEmitByKey = new Map<string, number>();

	function shouldEmit(event: RawPtySessionEvent): boolean {
		if (!SURFACED_EVENTS.has(event.type)) return false;
		if (event.type !== "tool_running" && event.type !== "tool_started") return true;
		const sessionId = event.sessionId ?? "";
		const tool = extractToolName(event) ?? "?";
		const key = `${sessionId}:${tool}`;
		const last = lastEmitByKey.get(key) ?? 0;
		const t = now();
		if (t - last < TOOL_THROTTLE_MS) return false;
		lastEmitByKey.set(key, t);
		return true;
	}

	function relay(event: RawPtySessionEvent): WorkerStatusUpdate | null {
		if (!shouldEmit(event)) return null;
		const sessionId = event.sessionId;
		if (!sessionId) return null;
		const workerName = opts.lookupWorkerName(sessionId);
		if (!workerName) return null;
		const tool = extractToolName(event);
		return {
			sessionId,
			workerName,
			eventType: event.type,
			summary: formatStatusSummary(workerName, event),
			timestamp: now(),
			...(tool ? { tool } : {}),
		};
	}

	return { relay, shouldEmit, _state: lastEmitByKey };
}
