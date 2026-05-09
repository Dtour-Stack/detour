/**
 * Local llama-server status. Mirrors the wire shape of `GET /api/llama/status`
 * (returned by `LlamaServerService.status()`); see
 * src/bun/core/llama/server-service.ts.
 */
export type LlamaServerStatusWire = {
	readonly running: boolean;
	readonly url: string | null;
	readonly modelPath: string | null;
	readonly pid: number | null;
	readonly startedAt: number | null;
	readonly lastError: string | null;
	readonly downloadProgress?: {
		downloadedBytes: number;
		totalBytes: number;
		percent: number;
	} | null;
};

export type LlamaRequests = {
	llamaStatus: {
		params: Record<string, never>;
		response: LlamaServerStatusWire;
	};
};
