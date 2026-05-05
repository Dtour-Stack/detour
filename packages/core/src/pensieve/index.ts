/**
 * Pensieve composition root.
 *
 * Pensieve is the *knowledge* surface: memories, relationships, the
 * cross-corpus graph, and templates/prompt variables. Operational/runtime
 * concerns (logs, trajectories, tasks, runtime introspection) live in
 * `ActivityService` (../activity) and are exposed under `/api/activity/*` —
 * they have no business inside Pensieve.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { RuntimeService } from "../runtime";
import { PensieveMemoryService } from "./memory-service";
import { PensieveRelationshipService } from "./relationship-service";
import { PensieveGraphService } from "./graph-service";
import { PensieveTemplatesService } from "./templates-service";
import { PensieveKnowledgeService } from "./knowledge-service";
import { PensieveEmbeddingMapService } from "./embedding-map-service";

export class PensieveService {
	readonly memories: PensieveMemoryService;
	readonly relationships: PensieveRelationshipService;
	readonly graph: PensieveGraphService;
	readonly templates: PensieveTemplatesService;
	readonly knowledge: PensieveKnowledgeService;
	readonly embeddingMap: PensieveEmbeddingMapService;

	constructor(private readonly runtimeService: RuntimeService) {
		const resolve = (): IAgentRuntime | null => {
			// Use the cached runtime — never trigger a build from a Pensieve query.
			return this.runtimeService.peek();
		};
		this.memories = new PensieveMemoryService(resolve);
		this.relationships = new PensieveRelationshipService(resolve);
		this.graph = new PensieveGraphService(resolve);
		this.templates = new PensieveTemplatesService(this.memories, resolve);
		this.knowledge = new PensieveKnowledgeService(resolve);
		this.embeddingMap = new PensieveEmbeddingMapService(resolve);
	}

	start(): void {}
	stop(): void {}
}

export type {
	PensieveMemorySummary,
	PensieveMemoryDetail,
	ListMemoriesOptions,
	PensieveMemoryTree,
	PensieveMemoryTreeNode,
} from "./memory-service";
export { DEFAULT_MEMORY_PATH } from "./memory-service";
export type {
	PensieveEntitySummary,
	PensieveRelationshipSummary,
	PensievePersonDetail,
} from "./relationship-service";
export type {
	PensieveTemplateSummary,
	PensieveTemplateDetail,
	PensievePromptVariable,
	PensieveTemplateRenderResult,
} from "./templates-service";
export { extractTemplateVariables, PensieveTemplatesService } from "./templates-service";
export type { PensieveKnowledgeIngestInput, PensieveKnowledgeIngestResult } from "./knowledge-service";
export type { EmbeddingPoint, EmbeddingMapResult } from "./embedding-map-service";
export type { GraphNode, GraphEdge, GraphSnapshot, GraphFilter, BacklinksResult } from "./graph-service";
export { pensieveAudit, type PensieveAuditEvent, type PensieveAuditAction } from "./audit";
