/**
 * Tasks RPC schema — orchestrator-spawned coding subagent sessions.
 *
 * Backed by the @elizaos/plugin-agent-orchestrator's PTY_SERVICE +
 * SwarmCoordinator. When the orchestrator isn't loaded, every endpoint
 * returns an empty/no-op result so the dashboard renders a quiet empty
 * Tasks tab instead of erroring.
 */

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

export type TasksRequests = {
	tasksList: {
		params: Record<string, never>;
		response: { tasks: TaskRow[] };
	};
	tasksTail: {
		params: { sessionId: string; lines?: number };
		response: { output: string };
	};
	tasksSend: {
		params: { sessionId: string; input: string };
		response: { ok: boolean; error?: string };
	};
	tasksStop: {
		params: { sessionId: string };
		response: { ok: boolean; error?: string };
	};
};

export type TasksMessages = {
	ptySessionEvent: { eventType?: string } & Record<string, unknown>;
};
