/**
 * Window control over typed RPC. Replaces POST /api/window/{hide,pin,resize}.
 * The bun handler delegates to the WindowController callback registered by
 * the chat feature on the ApiServer (see src/bun/features/chat/index.ts).
 */
export type WindowRequests = {
	windowHide: {
		params: Record<string, never>;
		response: { ok: true };
	};
	windowPin: {
		params: { on: boolean };
		response: { ok: true };
	};
	windowResize: {
		params: { width: number; height: number };
		response: { ok: true };
	};
};
