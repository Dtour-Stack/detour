import type { Memory, UUID } from "@elizaos/core";
import type { DebugEmbeddingResult } from "../../../../shared/rpc/debug";
import type { RpcDeps } from "../types";

/**
 * Dev-only diagnostic handlers. Replaces:
 *   POST /api/debug/embedding (LocalAI tab probe)
 */

type DebugEmbeddingRuntime = {
	useModel?: (type: string, params: { text: string }) => Promise<unknown>;
	getModel?: (type: string) => unknown;
	getService?: (type: string) => unknown;
	adapter?: { embeddingDimension?: string };
	createMemory?: (memory: Memory, table: string) => Promise<string>;
	updateMemory?: (memory: { id: string; embedding: number[] }) => Promise<boolean>;
	agentId?: UUID;
};

function embeddingVector(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

export function debugRequests(deps: RpcDeps) {
	return {
		debugEmbedding: async (
			params: { text?: string; storeAs?: string },
		): Promise<DebugEmbeddingResult> => {
			const text = params.text ?? "hello world";
			const live = deps.runtime.peek();
			if (!live) throw new Error("runtime not built");
			const runtime = live as DebugEmbeddingRuntime;
			let raw: unknown = null;
			let modelErr: string | null = null;
			const t0 = Date.now();
			try {
				if (runtime.useModel) raw = await runtime.useModel("TEXT_EMBEDDING", { text });
			} catch (err) {
				modelErr = err instanceof Error ? err.message : String(err);
			}
			const vector = embeddingVector(raw);
			const durationMs = Date.now() - t0;
			const embSvc = runtime.getService?.("embedding-generation") as {
				isDisabled?: boolean;
				batchQueue?: { size?: number; isStarted?: boolean } | null;
			} | null | undefined;
			let writeResult: DebugEmbeddingResult["writeResult"] = null;
			if (params.storeAs && runtime.createMemory && runtime.updateMemory && runtime.agentId) {
				try {
					const memId = await runtime.createMemory({
						entityId: runtime.agentId,
						roomId: runtime.agentId,
						agentId: runtime.agentId,
						content: { text, source: "debug" },
						createdAt: Date.now(),
					}, params.storeAs);
					await runtime.updateMemory({ id: memId, embedding: vector });
					writeResult = { ok: true, memoryId: String(memId) };
				} catch (err) {
					writeResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			}
			return {
				hasModel: runtime.getModel?.("TEXT_EMBEDDING") !== undefined,
				adapterEmbeddingDimension: runtime.adapter?.embeddingDimension ?? null,
				embeddingServiceRegistered: embSvc !== null && embSvc !== undefined,
				embeddingServiceDisabled: embSvc?.isDisabled ?? null,
				queueStarted: embSvc?.batchQueue?.isStarted ?? null,
				queueSize: embSvc?.batchQueue?.size ?? null,
				durationMs,
				dim: vector.length,
				nonZero: vector.filter((n) => Math.abs(n) > 1e-9).length,
				first5: vector.slice(0, 5),
				modelErr,
				writeResult,
			};
		},

	};
}
