/**
 * Tasks RPC — surfaces the orchestrator's PTY sessions + task contexts to
 * the dashboard. Lists running coding-subagent sessions, lets the user
 * tail their output, send follow-up input, or stop them.
 *
 * Soft-fails when the orchestrator isn't loaded (PTY_SERVICE absent):
 * every handler returns an empty/no-op result so the UI just renders an
 * empty Tasks tab instead of erroring.
 */

import type { RpcDeps } from "../types";

interface SessionInfo {
	id: string;
	name: string;
	agentType: string;
	workdir: string;
	status: string;
	createdAt: Date | string;
	lastActivityAt: Date | string;
	metadata?: Record<string, unknown>;
}

interface PtyServiceLike {
	listSessions: () => Promise<SessionInfo[]>;
	getSessionOutput: (sessionId: string, lines?: number) => Promise<string>;
	sendInput?: (sessionId: string, input: string) => Promise<void>;
	stopSession?: (sessionId: string) => Promise<void>;
	coordinator?: {
		getAllTaskContexts?: () => Array<{
			sessionId?: string;
			threadId?: string;
			label?: string;
		}>;
		getTaskContext?: (
			sessionId: string,
		) => { threadId?: string | null; label?: string } | null | undefined;
	};
}

function getPty(deps: RpcDeps): PtyServiceLike | null {
	const rt = deps.runtime.peek();
	const svc = rt?.getService("PTY_SERVICE") as PtyServiceLike | null;
	return svc ?? null;
}

export type TaskRow = {
	sessionId: string;
	label: string;
	agentType: string;
	workdir: string;
	status: string;
	createdAt: string;
	lastActivityAt: string;
	threadId?: string;
};

export function tasksRequests(deps: RpcDeps) {
	return {
		tasksList: async (): Promise<{ tasks: TaskRow[] }> => {
			const pty = getPty(deps);
			if (!pty) return { tasks: [] };
			try {
				const sessions = await pty.listSessions();
				const contexts = pty.coordinator?.getAllTaskContexts?.() ?? [];
				const labelBySession = new Map<string, string>();
				const threadBySession = new Map<string, string>();
				for (const c of contexts) {
					if (c.sessionId && c.label) labelBySession.set(c.sessionId, c.label);
					if (c.sessionId && c.threadId) threadBySession.set(c.sessionId, c.threadId);
				}
				const tasks: TaskRow[] = sessions.map((s) => ({
					sessionId: s.id,
					label: labelBySession.get(s.id) ?? s.name ?? s.id,
					agentType: s.agentType,
					workdir: s.workdir,
					status: s.status,
					createdAt: typeof s.createdAt === "string" ? s.createdAt : s.createdAt.toISOString(),
					lastActivityAt: typeof s.lastActivityAt === "string" ? s.lastActivityAt : s.lastActivityAt.toISOString(),
					...(threadBySession.has(s.id) ? { threadId: threadBySession.get(s.id) } : {}),
				}));
				return { tasks };
			} catch (err) {
				console.warn("[tasksList] failed:", err instanceof Error ? err.message : err);
				return { tasks: [] };
			}
		},

		tasksTail: async (params: { sessionId: string; lines?: number }): Promise<{ output: string }> => {
			const pty = getPty(deps);
			if (!pty) return { output: "" };
			try {
				const out = await pty.getSessionOutput(params.sessionId, params.lines ?? 100);
				return { output: out };
			} catch (err) {
				return { output: `(error: ${err instanceof Error ? err.message : String(err)})` };
			}
		},

		tasksSend: async (params: { sessionId: string; input: string }): Promise<{ ok: boolean; error?: string }> => {
			const pty = getPty(deps);
			if (!pty?.sendInput) return { ok: false, error: "Orchestrator not loaded." };
			try {
				await pty.sendInput(params.sessionId, params.input);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},

		tasksStop: async (params: { sessionId: string }): Promise<{ ok: boolean; error?: string }> => {
			const pty = getPty(deps);
			if (!pty?.stopSession) return { ok: false, error: "Orchestrator not loaded." };
			try {
				await pty.stopSession(params.sessionId);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
	};
}
