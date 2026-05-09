import type { PortlessRoute, PortlessSnapshot } from "../index";

export type PortlessRequests = {
	portlessStatus: {
		params: Record<string, never>;
		response: PortlessSnapshot;
	};
	portlessAddRoute: {
		params: { hostname: string; port: number; force?: boolean };
		response: { ok: true; killedPid?: number; snapshot: PortlessSnapshot };
	};
	portlessRemoveRoute: {
		params: { hostname: string };
		response: { ok: true; snapshot: PortlessSnapshot };
	};
	portlessPrune: {
		params: Record<string, never>;
		response: { ok: true; removed: PortlessRoute[]; snapshot: PortlessSnapshot };
	};
};
