/**
 * Minimal interface of the orchestrator's SwarmCoordinator that detour
 * touches when wiring chat/ws bridges. Avoids depending on the
 * orchestrator's full type tree (which pulls node-pty native types).
 */

export interface OrchestratorChatRouting {
	sessionId?: string;
	threadId?: string;
	roomId?: string | null;
}

export interface OrchestratorTaskSummary {
	sessionId: string;
	label: string;
	agentType: string;
	originalTask: string;
	status: string;
	completionSummary: string;
	roomId?: string | null;
	workdir?: string;
}

export interface OrchestratorSwarmCompletePayload {
	tasks: OrchestratorTaskSummary[];
	total: number;
	completed: number;
	stopped: number;
	errored: number;
}

export interface OrchestratorCoordinator {
	setChatCallback?: (
		cb: (
			text: string,
			source?: string,
			routing?: OrchestratorChatRouting,
		) => void | Promise<void>,
	) => void;
	setWsBroadcast?: (
		cb: (event: { type?: string } & Record<string, unknown>) => void,
	) => void;
	setSwarmCompleteCallback?: (
		cb: (payload: OrchestratorSwarmCompletePayload) => void | Promise<void>,
	) => void;
	getTaskContext?: (
		sessionId: string,
	) => { threadId?: string | null; label?: string } | null | undefined;
	getAllTaskContexts?: () => Array<{
		sessionId?: string;
		threadId?: string;
		label?: string;
	}>;
	getTaskThread?: (
		threadId: string,
	) => Promise<{ roomId?: string | null } | null>;
}
