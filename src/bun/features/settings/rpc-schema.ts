import type { RPCSchema } from "electrobun/bun";
import type { BackendStatus, ProviderId, ProviderInfo } from "@detour/shared";

export type { ProviderId, ProviderInfo, BackendStatus };

export type SettingsRPC = {
	bun: RPCSchema<{
		requests: {
			listProviders: {
				params: Record<string, never>;
				response: ProviderInfo[];
			};
			setProviderKey: {
				params: { id: ProviderId; key: string };
				response: { ok: true };
			};
			removeProviderKey: {
				params: { id: ProviderId };
				response: { ok: true };
			};
			setActiveProvider: {
				params: { id: ProviderId };
				response: { ok: true };
			};
			detectBackends: {
				params: Record<string, never>;
				response: BackendStatus[];
			};
			getEnabledBackends: {
				params: Record<string, never>;
				response: string[];
			};
			setEnabledBackends: {
				params: { enabled: string[] };
				response: { ok: true };
			};
			closeSettings: {
				params: Record<string, never>;
				response: { ok: true };
			};
		};
		messages: Record<string, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: Record<string, never>;
	}>;
};
