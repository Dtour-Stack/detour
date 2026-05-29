/**
 * AgentMail RPC — configure the agent's email channel (https://docs.agentmail.to).
 * Backed by AgentMailService; the Settings → Email (AgentMail) tab consumes these.
 * Enabling provisions an inbox (`@agentmail.to`) from the supplied API key.
 */
import type { AgentMailConfig, AgentMailStatus } from "../index";

export type AgentMailRequests = {
	agentMailStatus: { params: Record<never, never>; response: AgentMailStatus };
	agentMailEnable: {
		params: { apiKey: string };
		response: { ok: true; inboxAddress: string } | { ok: false; error: string };
	};
	agentMailDisable: { params: Record<never, never>; response: { ok: true } };
	agentMailSend: {
		params: { to: string; subject: string; text: string };
		response: { ok: true; messageId: string } | { ok: false; error: string };
	};
	agentMailGetConfig: { params: Record<never, never>; response: AgentMailConfig };
	agentMailSetConfig: { params: Partial<AgentMailConfig>; response: AgentMailConfig };
};
