import type { RPCSchema } from "electrobun/bun";
import type { ProviderId } from "../../../shared/index";

export type ChatRPC = {
	bun: RPCSchema<{
		requests: {
			sendMessage: {
				params: { text: string; convId: string };
				response: { ok: true };
			};
			hideWindow: {
				params: Record<string, never>;
				response: { ok: true };
			};
			openSettings: {
				params: Record<string, never>;
				response: { ok: true };
			};
			isReady: {
				params: Record<string, never>;
				response: { ready: boolean; activeProvider: ProviderId | null };
			};
		};
		messages: Record<string, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			tokenDelta: { convId: string; delta: string };
			messageComplete: { convId: string };
			error: { convId: string; message: string };
			providerChanged: { activeProvider: ProviderId | null };
		};
	}>;
};
