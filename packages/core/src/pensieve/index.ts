/**
 * Pensieve composition root.
 *
 * Holds all the per-domain services and resolves the AgentRuntime lazily so
 * Pensieve can be queried even before the user has sent their first chat
 * (resolution returns null gracefully → empty results).
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { RuntimeService } from "../runtime";
import { PensieveLogService } from "./log-service";
import { PensieveMemoryService } from "./memory-service";
import { PensieveRelationshipService } from "./relationship-service";
import { PensieveTrajectoryService } from "./trajectory-service";
import { PensieveGraphService } from "./graph-service";
import { snapshotRuntime, type PensieveRuntimeSnapshot } from "./runtime-introspect";

export class PensieveService {
	readonly logs: PensieveLogService;
	readonly memories: PensieveMemoryService;
	readonly relationships: PensieveRelationshipService;
	readonly trajectories: PensieveTrajectoryService;
	readonly graph: PensieveGraphService;

	constructor(private readonly runtimeService: RuntimeService) {
		const resolve = (): IAgentRuntime | null => {
			// Use the cached runtime — never trigger a build from a Pensieve query.
			return this.runtimeService.peek();
		};
		this.logs = new PensieveLogService();
		this.memories = new PensieveMemoryService(resolve);
		this.relationships = new PensieveRelationshipService(resolve);
		this.trajectories = new PensieveTrajectoryService(resolve);
		this.graph = new PensieveGraphService(resolve);
	}

	start(): void {
		this.logs.start();
	}

	stop(): void {
		this.logs.stop();
	}

	runtimeSnapshot(): PensieveRuntimeSnapshot {
		return snapshotRuntime(this.runtimeService.peek());
	}
}

export type { PensieveLogEntry, ListLogsOptions } from "./log-service";
export type { PensieveMemorySummary, PensieveMemoryDetail, ListMemoriesOptions } from "./memory-service";
export type {
	PensieveEntitySummary,
	PensieveRelationshipSummary,
	PensievePersonDetail,
} from "./relationship-service";
export type {
	PensieveTrajectoryListItem,
	PensieveTrajectoryListResult,
	PensieveTrajectoryDetail,
	PensieveTrajectoryListOptions,
} from "./trajectory-service";
export type { GraphNode, GraphEdge, GraphSnapshot, GraphFilter, BacklinksResult } from "./graph-service";
export type { PensieveRuntimeSnapshot, RuntimeRegistryItem } from "./runtime-introspect";
export { pensieveAudit, type PensieveAuditEvent, type PensieveAuditAction } from "./audit";
