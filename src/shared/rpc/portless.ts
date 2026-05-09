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
	/** Open the standalone Portless window. Implemented by broadcasting
	 * `uiOpenPortless`; the kernel listens and emits the
	 * `ui:open-portless` event handled by portlessFeature. */
	portlessOpen: {
		params: Record<string, never>;
		response: { ok: true };
	};
};
