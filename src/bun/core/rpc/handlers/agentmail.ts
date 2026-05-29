import type { RpcDeps } from "../types";
import type { AgentMailConfig, AgentMailStatus } from "../../../../shared/index";

export function agentMailRequests(deps: RpcDeps) {
	return {
		agentMailStatus: async (_params: Record<string, never>): Promise<AgentMailStatus> => {
			return deps.agentMail.status();
		},

		agentMailEnable: async (params: { apiKey: string }): Promise<{ ok: true; inboxAddress: string } | { ok: false; error: string }> => {
			if (!params.apiKey || typeof params.apiKey !== "string") {
				return { ok: false, error: "apiKey is required" };
			}
			return deps.agentMail.enable(params.apiKey);
		},

		agentMailDisable: async (_params: Record<string, never>): Promise<{ ok: true }> => {
			await deps.agentMail.disable();
			return { ok: true };
		},

		agentMailSend: async (params: { to: string; subject: string; text: string }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> => {
			if (!params.to || !params.subject || !params.text) {
				return { ok: false, error: "to, subject, and text are required" };
			}
			return deps.agentMail.sendEmail(params.to, params.subject, params.text);
		},

		agentMailGetConfig: async (_params: Record<string, never>): Promise<AgentMailConfig> => {
			return deps.config.getAgentMail();
		},

		agentMailSetConfig: async (params: Partial<AgentMailConfig>): Promise<AgentMailConfig> => {
			const current = await deps.config.getAgentMail();
			return deps.config.setAgentMail({ ...current, ...params });
		},
	};
}
