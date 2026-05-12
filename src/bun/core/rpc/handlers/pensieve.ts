/**
 * Pensieve handlers — knowledge surface (templates, memories, knowledge,
 * embeddings, chronicler, relationships, graph).
 *
 * Mirrors the HTTP routes in src/bun/core/api/server.ts. Key invariants:
 *
 *   - Mutations that the service returns as `boolean` are projected to
 *     `void` on the wire; we throw on `false` so the UI sees the same
 *     error semantic the HTTP route produced via `error(...)`.
 *   - UUID-branded ids cross the wire as `string`; we cast with `as never`
 *     when calling services (same shape as HTTP did via decodeURIComponent
 *     + `as never`).
 *   - `pensieveAudit(...)` is preserved on every mutation — observability
 *     for write operations and downstream consumers may depend on it.
 *   - `pensieveMemoryGet` merges `backlinks` from a separate
 *     `graph.backlinksForMemory()` call, identical to the HTTP route.
 *   - `pensieveChroniclerSetConfig` reads current config and merges with
 *     `??` defaults before calling `configure(...)` — the service expects
 *     a full `ChroniclerConfig`, not a partial.
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
	PensieveTemplateDetail,
	PensieveTemplateRenderResult,
	PensieveTemplateSummary,
} from "../../../../shared/index";
import { pensieveAudit } from "../../pensieve";
import type { GraphFilter } from "../../pensieve";
import type { RpcDeps } from "../types";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function pensieveRequests(deps: RpcDeps) {
	const { pensieve } = deps;

	return {
		// ── Templates ──────────────────────────────────────────────────

		pensieveTemplatesList: async (
			_params: Record<string, never>,
		): Promise<PensieveTemplateSummary[]> => {
			return pensieve.templates.listTemplates();
		},

		pensieveTemplateGet: async (params: { id: string }): Promise<PensieveTemplateDetail> => {
			const detail = await pensieve.templates.getTemplate(params.id);
			if (!detail) throw new Error("not found");
			return detail;
		},

		pensieveTemplateCreate: async (params: {
			name: string;
			body: string;
			tags?: string[];
		}): Promise<{ id: string }> => {
			let success = false;
			let id: string | undefined;
			let errMsg: string | undefined;
			try {
				const created = await pensieve.templates.createTemplate(params);
				success = !!created;
				id = created?.id;
			} catch (err) {
				errMsg = errMessage(err);
			}
			pensieveAudit({
				action: "template.create",
				...(id ? { target: id } : {}),
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success || !id) throw new Error(errMsg ?? "create failed");
			return { id };
		},

		pensieveTemplateUpdate: async (params: {
			id: string;
			patch: { body?: string; tags?: string[]; path?: string };
		}): Promise<void> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await pensieve.templates.updateTemplate(params.id, params.patch);
			} catch (err) {
				errMsg = errMessage(err);
			}
			pensieveAudit({
				action: "template.update",
				target: params.id,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "update failed");
		},

		pensieveTemplateDelete: async (params: { id: string }): Promise<void> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await pensieve.templates.deleteTemplate(params.id);
			} catch (err) {
				errMsg = errMessage(err);
			}
			pensieveAudit({
				action: "template.delete",
				target: params.id,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "delete failed");
		},

		pensieveTemplateRender: async (params: {
			id: string;
			vars?: Record<string, string>;
		}): Promise<PensieveTemplateRenderResult> => {
			const result = await pensieve.templates.renderTemplate(params.id, params.vars ?? {});
			pensieveAudit({
				action: "template.render",
				target: params.id,
				success: !!result,
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!result) throw new Error("not found");
			return result;
		},

		// ── Template variables ─────────────────────────────────────────

		pensieveTemplateVarsList: async (
			_params: Record<string, never>,
		): Promise<PensievePromptVariable[]> => {
			return pensieve.templates.listVariables();
		},

		pensieveTemplateVarSet: async (params: { name: string; value: string }): Promise<void> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				const v = await pensieve.templates.setVariable(params.name, params.value);
				success = !!v;
			} catch (err) {
				errMsg = errMessage(err);
			}
			pensieveAudit({
				action: "promptvar.set",
				target: params.name,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "set failed");
		},

		pensieveTemplateVarDelete: async (params: { name: string }): Promise<void> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await pensieve.templates.deleteVariable(params.name);
			} catch (err) {
				errMsg = errMessage(err);
				pensieveAudit({
					action: "promptvar.delete",
					target: params.name,
					success: false,
					error: errMsg,
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				throw new Error(errMsg);
			}
			pensieveAudit({
				action: "promptvar.delete",
				target: params.name,
				success,
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success) throw new Error("not found");
		},

		// ── Memories ───────────────────────────────────────────────────

		pensieveMemoryTree: async (
			_params: Record<string, never>,
		): Promise<PensieveMemoryTree> => {
			return pensieve.memories.tree({});
		},

		pensieveMemoriesList: async (params: {
			limit?: number;
			type?: string;
			roomId?: string;
			entityId?: string;
			tag?: string;
			q?: string;
			pathPrefix?: string;
		}): Promise<PensieveMemorySummary[]> => {
			return pensieve.memories.list(params);
		},

		pensieveMemoriesSearch: async (params: {
			text: string;
			limit?: number;
		}): Promise<PensieveMemorySummary[]> => {
			return pensieve.memories.search(params.text, params.limit ?? 30);
		},

		pensieveMemoryGet: async (params: { id: string }): Promise<PensieveMemoryDetail> => {
			const detail = await pensieve.memories.get(params.id as never);
			if (!detail) throw new Error("not found");
			const backlinks = await pensieve.graph.backlinksForMemory(params.id);
			// Wire shape mirrors HTTP: `{ ...detail, backlinks }`. The bun
			// service's MemoryMetadata and BacklinksResult are structurally
			// compatible with the shared wire types but TS doesn't infer
			// that automatically (DocumentMetadata lacks index signature;
			// GraphSnapshot.stats lacks `trajectories`). HTTP avoided this
			// by returning through `json()` which erases the type. We cast.
			return { ...detail, backlinks } as unknown as PensieveMemoryDetail;
		},

		pensieveMemoryCreate: async (params: {
			text: string;
			path?: string;
			type?: string;
			tags?: string[];
			extraMetadata?: Record<string, unknown>;
		}): Promise<{ id: string }> => {
			let success = false;
			let errMsg: string | undefined;
			let createdId: string | undefined;
			try {
				const created = await pensieve.memories.create(params);
				success = !!created;
				createdId = created?.id;
			} catch (err) {
				errMsg = errMessage(err);
			}
			pensieveAudit({
				action: "memory.create",
				...(createdId ? { target: createdId } : {}),
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success || !createdId) throw new Error(errMsg ?? "create failed");
			return { id: createdId };
		},

		pensieveMemoryUpdate: async (params: {
			id: string;
			patch: { contentText?: string; tags?: string[]; path?: string };
		}): Promise<void> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await pensieve.memories.update(params.id as never, params.patch);
			} catch (err) {
				errMsg = errMessage(err);
			}
			pensieveAudit({
				action: "memory.update",
				target: params.id,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "update failed");
		},

		pensieveMemoryDelete: async (params: { id: string }): Promise<void> => {
			let success = false;
			let errMsg: string | undefined;
			try {
				success = await pensieve.memories.remove(params.id as never);
			} catch (err) {
				errMsg = errMessage(err);
			}
			pensieveAudit({
				action: "memory.delete",
				target: params.id,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success) throw new Error(errMsg ?? "delete failed");
		},

		// ── Knowledge ──────────────────────────────────────────────────

		pensieveKnowledgeStatus: async (
			_params: Record<string, never>,
		): Promise<{ available: boolean }> => {
			return { available: pensieve.knowledge.available() };
		},

		pensieveKnowledgeIngest: async (params: {
			filename: string;
			content: string;
			contentType?: string;
			metadata?: Record<string, unknown>;
		}): Promise<{
			clientDocumentId: string;
			storedDocumentMemoryId: string;
			fragmentCount: number;
		}> => {
			let success = false;
			let result: {
				clientDocumentId: string;
				storedDocumentMemoryId: string;
				fragmentCount: number;
			} | null = null;
			let errMsg: string | undefined;
			try {
				result = await pensieve.knowledge.ingest({
					filename: params.filename,
					contentType: params.contentType ?? "text/plain",
					content: params.content,
					...(params.metadata ? { metadata: params.metadata } : {}),
				});
				success = !!result;
			} catch (err) {
				errMsg = errMessage(err);
			}
			pensieveAudit({
				action: "knowledge.ingest",
				target: params.filename,
				success,
				...(errMsg ? { error: errMsg } : {}),
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			if (!success || !result) throw new Error(errMsg ?? "knowledge service not available");
			return result;
		},

		// ── Embeddings ─────────────────────────────────────────────────

		pensieveEmbeddingMap: async (
			_params: Record<string, never>,
		): Promise<PensieveEmbeddingMap> => {
			return pensieve.embeddingMap.snapshot();
		},

		// ── Chronicler ─────────────────────────────────────────────────

		pensieveChroniclerStatus: async (
			_params: Record<string, never>,
		): Promise<ChroniclerStatus> => {
			return pensieve.chronicler.status();
		},

		pensieveChroniclerSetConfig: async (
			params: Partial<ChroniclerConfig>,
		): Promise<ChroniclerConfig> => {
			const current = pensieve.chronicler.getConfig();
			const next = await pensieve.chronicler.configure({
				enabled: params.enabled ?? current.enabled,
				intervalMs: params.intervalMs ?? current.intervalMs,
				includeWindowTitles: params.includeWindowTitles ?? current.includeWindowTitles,
				maxWindowsPerScreen: params.maxWindowsPerScreen ?? current.maxWindowsPerScreen,
			});
			pensieveAudit({
				action: "chronicler.configure",
				success: true,
				target: next.enabled ? "enabled" : "disabled",
				caller: "ui-pensieve",
				ts: Date.now(),
			});
			return next;
		},

		pensieveChroniclerSample: async (
			_params: Record<string, never>,
		): Promise<ChroniclerObservation> => {
			try {
				const observation = await pensieve.chronicler.sampleNow();
				pensieveAudit({
					action: "chronicler.sample",
					target: observation.id,
					success: true,
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				return observation;
			} catch (err) {
				const msg = errMessage(err);
				pensieveAudit({
					action: "chronicler.sample",
					success: false,
					error: msg,
					caller: "ui-pensieve",
					ts: Date.now(),
				});
				throw new Error(msg);
			}
		},

		pensieveChroniclerRecent: async (params: {
			limit?: number;
		}): Promise<ChroniclerObservation[]> => {
			return pensieve.chronicler.recent(params.limit ?? 20);
		},

		// ── Relationships ──────────────────────────────────────────────

		pensievePersonsList: async (params: {
			limit?: number;
		}): Promise<PensieveEntitySummary[]> => {
			return pensieve.relationships.listPersons(params.limit ?? 100);
		},

		pensievePersonGet: async (params: { id: string }): Promise<PensievePersonDetail> => {
			const detail = await pensieve.relationships.getPerson(params.id as never);
			if (!detail) throw new Error("not found");
			return detail;
		},

		pensievePersonTrackSet: async (params: {
			id: string;
			tracked: boolean;
		}): Promise<PensievePersonDetail> => {
			const detail = await pensieve.relationships.setTracked(params.id as never, params.tracked);
			if (!detail) throw new Error("track update failed");
			return detail;
		},

		// ── Graph ──────────────────────────────────────────────────────

		pensieveGraph: async (params: {
			dateFrom?: number;
			dateTo?: number;
			entityIds?: string[];
			types?: string[];
			tags?: string[];
		}): Promise<PensieveGraphSnapshot> => {
			const filter: GraphFilter = {};
			if (params.dateFrom !== undefined) filter.dateFrom = params.dateFrom;
			if (params.dateTo !== undefined) filter.dateTo = params.dateTo;
			if (params.entityIds && params.entityIds.length > 0) filter.entityIds = params.entityIds;
			if (params.types && params.types.length > 0) filter.types = params.types;
			if (params.tags && params.tags.length > 0) filter.tags = params.tags;
			// Bun-side `GraphSnapshot.stats` lacks `trajectories` while the
			// wire `PensieveGraphSnapshot.stats` requires it. HTTP route
			// returned via `json()` which erased the type; we cast through
			// unknown for parity with that wire shape.
			return (await pensieve.graph.snapshot(filter)) as unknown as PensieveGraphSnapshot;
		},
	};
}
