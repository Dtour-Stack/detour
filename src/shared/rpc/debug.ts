/**
 * Dev-only diagnostic RPC, replacing the last two HTTP endpoints:
 *
 *   POST /api/debug/embedding → debugEmbedding (LocalAI tab probe)
 *   POST /api/debug/action    → debugAction (gated to dev .app builds;
 *                               override via DETOUR_ALLOW_DEBUG_API=1)
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

export type DebugActionResult = {
	ok: true;
	action: string;
	durationMs: number;
	emits: { text: string; action: string }[];
	result: unknown;
};

export type DebugRequests = {
	debugEmbedding: {
		params: { text?: string; storeAs?: string };
		response: DebugEmbeddingResult;
	};
	debugAction: {
		params: { name: string; options?: Record<string, unknown> };
		response: DebugActionResult;
	};
};
