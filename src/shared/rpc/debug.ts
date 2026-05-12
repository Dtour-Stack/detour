/**
 * Dev-only diagnostic RPC:
 *
 *   POST /api/debug/embedding → debugEmbedding (LocalAI tab probe)
 */

export type DebugEmbeddingResult = {
	hasModel: boolean;
	adapterEmbeddingDimension: string | null;
	embeddingServiceRegistered: boolean;
	embeddingServiceDisabled: boolean | null;
	queueStarted: boolean | null;
	queueSize: number | null;
	durationMs: number;
	dim: number;
	nonZero: number;
	first5: number[];
	modelErr: string | null;
	writeResult: { ok: boolean; memoryId?: string; error?: string } | null;
};

export type DebugRequests = {
	debugEmbedding: {
		params: { text?: string; storeAs?: string };
		response: DebugEmbeddingResult;
	};
};
