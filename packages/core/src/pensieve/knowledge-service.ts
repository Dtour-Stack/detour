/**
 * Pensieve > Knowledge ingest.
 *
 * Thin wrapper around elizaOS's KnowledgeService.addKnowledge() — the heavy
 * lifting (chunking, embedding, fragment storage in the `knowledge` table) is
 * already implemented there. We just hand off content + metadata so the rest
 * of the agent's RAG machinery picks it up.
 */

import type { IAgentRuntime } from "@elizaos/core";

const KNOWLEDGE_SERVICE_TYPE = "knowledge";

export interface PensieveKnowledgeIngestInput {
	filename: string;
	contentType: string;
	content: string;
	roomId?: string;
	entityId?: string;
	worldId?: string;
	metadata?: Record<string, unknown>;
}

export interface PensieveKnowledgeIngestResult {
	clientDocumentId: string;
	storedDocumentMemoryId: string;
	fragmentCount: number;
}

interface KnowledgeServiceShape {
	addKnowledge?: (opts: {
		agentId?: string;
		worldId: string;
		roomId: string;
		entityId: string;
		clientDocumentId: string;
		contentType: string;
		originalFilename: string;
		content: string;
		metadata?: Record<string, unknown>;
	}) => Promise<{
		clientDocumentId: string;
		storedDocumentMemoryId: string;
		fragmentCount: number;
	}>;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function findService(runtime: IAgentRuntime): KnowledgeServiceShape | null {
	const r = runtime as unknown as {
		getService?: (t: string) => unknown;
		getServicesByType?: (t: string) => unknown[];
	};
	const first = r.getService?.(KNOWLEDGE_SERVICE_TYPE);
	if (first) return first as KnowledgeServiceShape;
	const all = r.getServicesByType?.(KNOWLEDGE_SERVICE_TYPE) ?? [];
	return (all[0] as KnowledgeServiceShape) ?? null;
}

export class PensieveKnowledgeService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	available(): boolean {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		return !!findService(runtime)?.addKnowledge;
	}

	async ingest(input: PensieveKnowledgeIngestInput): Promise<PensieveKnowledgeIngestResult | null> {
		const runtime = this.resolveRuntime();
		if (!runtime) return null;
		const svc = findService(runtime);
		if (!svc?.addKnowledge) return null;
		const r = runtime as unknown as { agentId?: string };
		// addKnowledge generates its own clientDocumentId from content hash; we
		// pass a placeholder it will overwrite. (Required by the type signature.)
		const result = await svc.addKnowledge({
			agentId: r.agentId,
			worldId: input.worldId ?? ZERO_UUID,
			roomId: input.roomId ?? ZERO_UUID,
			entityId: input.entityId ?? r.agentId ?? ZERO_UUID,
			clientDocumentId: ZERO_UUID,
			contentType: input.contentType,
			originalFilename: input.filename,
			content: input.content,
			...(input.metadata ? { metadata: input.metadata } : {}),
		});
		return {
			clientDocumentId: result.clientDocumentId,
			storedDocumentMemoryId: result.storedDocumentMemoryId,
			fragmentCount: result.fragmentCount,
		};
	}
}
