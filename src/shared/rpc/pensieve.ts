/**
 * Pensieve RPC schema — knowledge surface (templates, memories, knowledge,
 * embeddings, chronicler, relationships, graph).
 *
 * Wire shapes return the unwrapped service result (no `{ ok: true, ... }`
 * envelope — handlers throw on failure, the RPC layer surfaces it).
 *
 * UUID-branded ids (memory id, entity id, relationship source/target) cross
 * the wire as plain `string`; handlers cast via `as never` when calling
 * services. Mutations that return `boolean` from the service are projected
 * to `void` here; the handler throws on `false` to preserve the HTTP
 * semantic where `false` returned a 400.
 */

import type {
	ChroniclerConfig,
	ChroniclerObservation,
	ChroniclerStatus,
	PensieveEmbeddingMap,
	PensieveEntitySummary,
	PensieveGraphSnapshot,
	PensieveMemoryDetail,
	PensieveMemorySummary,
	PensieveMemoryTree,
	PensievePersonDetail,
	PensievePromptVariable,
	PensieveRelationshipSummary,
	PensieveTemplateDetail,
	PensieveTemplateRenderResult,
	PensieveTemplateSummary,
} from "../index";

export type PensieveRequests = {
	// --- Templates -------------------------------------------------------
	pensieveTemplatesList: {
		params: Record<string, never>;
		response: PensieveTemplateSummary[];
	};
	pensieveTemplateGet: {
		params: { id: string };
		response: PensieveTemplateDetail;
	};
	pensieveTemplateCreate: {
		params: { name: string; body: string; tags?: string[] };
		response: { id: string };
	};
	pensieveTemplateUpdate: {
		params: {
			id: string;
			patch: { body?: string; tags?: string[]; path?: string };
		};
		response: void;
	};
	pensieveTemplateDelete: {
		params: { id: string };
		response: void;
	};
	pensieveTemplateRender: {
		params: { id: string; vars?: Record<string, string> };
		response: PensieveTemplateRenderResult;
	};

	// --- Template variables ---------------------------------------------
	pensieveTemplateVarsList: {
		params: Record<string, never>;
		response: PensievePromptVariable[];
	};
	pensieveTemplateVarSet: {
		params: { name: string; value: string };
		response: void;
	};
	pensieveTemplateVarDelete: {
		params: { name: string };
		response: void;
	};

	// --- Memories --------------------------------------------------------
	pensieveMemoryTree: {
		params: Record<string, never>;
		response: PensieveMemoryTree;
	};
	pensieveMemoriesList: {
		params: {
			limit?: number;
			type?: string;
			roomId?: string;
			entityId?: string;
			tag?: string;
			q?: string;
			pathPrefix?: string;
		};
		response: PensieveMemorySummary[];
	};
	pensieveMemoriesSearch: {
		params: { text: string; limit?: number };
		response: PensieveMemorySummary[];
	};
	pensieveMemoryGet: {
		params: { id: string };
		response: PensieveMemoryDetail;
	};
	pensieveMemoryCreate: {
		params: {
			text: string;
			path?: string;
			type?: string;
			tags?: string[];
			extraMetadata?: Record<string, unknown>;
		};
		response: { id: string };
	};
	pensieveMemoryUpdate: {
		params: {
			id: string;
			patch: { contentText?: string; tags?: string[]; path?: string };
		};
		response: void;
	};
	pensieveMemoryDelete: {
		params: { id: string };
		response: void;
	};

	// --- Knowledge -------------------------------------------------------
	pensieveKnowledgeStatus: {
		params: Record<string, never>;
		response: { available: boolean };
	};
	pensieveKnowledgeIngest: {
		params: {
			filename: string;
			content: string;
			contentType?: string;
			metadata?: Record<string, unknown>;
		};
		response: {
			clientDocumentId: string;
			storedDocumentMemoryId: string;
			fragmentCount: number;
		};
	};

	// --- Embeddings ------------------------------------------------------
	pensieveEmbeddingMap: {
		params: Record<string, never>;
		response: PensieveEmbeddingMap;
	};

	// --- Chronicler ------------------------------------------------------
	pensieveChroniclerStatus: {
		params: Record<string, never>;
		response: ChroniclerStatus;
	};
	pensieveChroniclerGetConfig: {
		params: Record<string, never>;
		response: ChroniclerConfig;
	};
	pensieveChroniclerSetConfig: {
		params: Partial<ChroniclerConfig>;
		response: ChroniclerConfig;
	};
	pensieveChroniclerSample: {
		params: Record<string, never>;
		response: ChroniclerObservation;
	};
	pensieveChroniclerRecent: {
		params: { limit?: number };
		response: ChroniclerObservation[];
	};

	// --- Relationships ---------------------------------------------------
	pensievePersonsList: {
		params: { limit?: number };
		response: PensieveEntitySummary[];
	};
	pensievePersonGet: {
		params: { id: string };
		response: PensievePersonDetail;
	};
	pensieveRelationshipsList: {
		params: { entityIds?: string[]; tags?: string[]; limit?: number };
		response: PensieveRelationshipSummary[];
	};
	pensieveRelationshipCreate: {
		params: {
			sourceEntityId: string;
			targetEntityId: string;
			tags?: string[];
			metadata?: Record<string, unknown>;
		};
		response: void;
	};
	pensieveRelationshipUpdate: {
		params: {
			source: string;
			target: string;
			patch: { tags?: string[]; metadata?: Record<string, unknown> };
		};
		response: void;
	};
	pensieveRelationshipDelete: {
		params: { source: string; target: string };
		response: void;
	};

	// --- Graph -----------------------------------------------------------
	pensieveGraph: {
		params: {
			dateFrom?: number;
			dateTo?: number;
			entityIds?: string[];
			types?: string[];
			tags?: string[];
		};
		response: PensieveGraphSnapshot;
	};
};
