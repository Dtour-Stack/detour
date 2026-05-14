/**
 * @detour/plugin-pensieve-tools
 *
 * Gives the agent in-conversation access to the Pensieve (memories,
 * relationships, templates, prompt variables) via eliza Action surface.
 *
 * Every action is audited to ~/.eliza/audit/agent-pensieve-actions.jsonl so
 * the user can review what the agent wrote, linked, or rendered.
 *
 * Action names:
 *   PENSIEVE_WRITE             — create a memory at a path with optional tags
 *   PENSIEVE_READ              — read a memory by id
 *   PENSIEVE_LIST              — list memories under a folder/tag/type
 *   PENSIEVE_SEARCH            — vector + substring search across all tables
 *   PENSIEVE_LINK              — create / merge a relationship between entities
 *   PENSIEVE_TEMPLATE_RENDER   — render a stored template (by name or id)
 *   PENSIEVE_VAR_SET           — set/update a persisted prompt variable
 *
 * Construction: each handler builds a fresh per-call PensieveService against
 * the invoking runtime, so the agent uses the same path normalisation, table
 * fan-out, and audit machinery as the UI.
 */

import {
	PensieveMemoryService,
	PensieveRelationshipService,
	PensieveTemplatesService,
	type PensieveTemplateSummary,
} from "../../core/index";
import {
	type Action,
	type ActionResult,
	type Handler,
	type HandlerCallback,
	type IAgentRuntime,
	type Plugin,
	type Provider,
} from "@elizaos/core";
import { audit } from "./audit";

function caller(runtime: IAgentRuntime): string {
	return `agent:${runtime.character?.name ?? "unknown"}`;
}

/**
 * Eliza's contract delivers extracted action params at `options.parameters`.
 * Some pipeline paths (planner repair, direct invocation, eliza version
 * drift) deliver them top-level or under `params`/`<ACTION>`/`arguments`.
 * Walk all those locations so the agent's chosen action params actually land
 * here instead of returning empty. (Same fix shape as @detour/plugin-x-tweets.)
 */
function paramsBag(opts: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!opts) return {};
	const p = (opts as { parameters?: unknown }).parameters;
	if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
	return {};
}

function pickString(opts: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	if (!opts) return undefined;
	const params = paramsBag(opts);
	for (const k of keys) {
		const v = params[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	const queue: Record<string, unknown>[] = [opts];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const k of keys) {
			const v = cur[k];
			if (typeof v === "string" && v.length > 0) return v;
		}
		for (const v of Object.values(cur)) {
			if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v as Record<string, unknown>);
		}
	}
	return undefined;
}
function pickStringArray(opts: Record<string, unknown> | undefined, key: string): string[] | undefined {
	const tryAt = (bag: Record<string, unknown>): string[] | undefined => {
		const v = bag[key];
		if (!Array.isArray(v)) return undefined;
		const arr = v.map((x) => (typeof x === "string" ? x : null)).filter((x): x is string => !!x);
		return arr.length > 0 ? arr : undefined;
	};
	if (!opts) return undefined;
	return tryAt(paramsBag(opts)) ?? tryAt(opts);
}
function pickRecord(opts: Record<string, unknown> | undefined, key: string): Record<string, string> | undefined {
	const tryAt = (bag: Record<string, unknown>): Record<string, string> | undefined => {
		const v = bag[key];
		if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(v)) {
			if (typeof val === "string") out[k] = val;
			else if (val != null) out[k] = String(val);
		}
		return out;
	};
	if (!opts) return undefined;
	return tryAt(paramsBag(opts)) ?? tryAt(opts);
}
function pickNumber(opts: Record<string, unknown> | undefined, key: string): number | undefined {
	const tryAt = (bag: Record<string, unknown>): number | undefined => {
		const v = bag[key];
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	};
	if (!opts) return undefined;
	return tryAt(paramsBag(opts)) ?? tryAt(opts);
}

function templateSlug(name: string): string {
	return name.trim().replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
}

async function emit(callback: HandlerCallback | undefined, text: string, actionName: string): Promise<void> {
	if (!callback) return;
	try {
		await callback({ text, source: "pensieve-tools" } as never, actionName);
	} catch { /* ignore */ }
}

const alwaysValid: Action["validate"] = async () => true;

function fail(reason: string): ActionResult {
	return { success: false, text: reason };
}
function ok(text: string, values?: Record<string, unknown>): ActionResult {
	return { success: true, text, ...(values ? { values: values as never } : {}) };
}

// We construct services lazily per call against the runtime that's invoking us.
// resolveRuntime always returns the live runtime (vs the lazy global pensieve
// composition root, which may target a different process if the plugin is
// loaded out-of-band).
function services(runtime: IAgentRuntime) {
	const memories = new PensieveMemoryService(() => runtime);
	const relationships = new PensieveRelationshipService(() => runtime);
	const templates = new PensieveTemplatesService(memories, () => runtime);
	return { memories, relationships, templates };
}

/**
 * Per-runtime cache for USER_ACTIVITY_CONTEXT. The provider fires on every
 * planner turn, but the chronicler observation source only writes a new
 * row every ~60s. Re-querying pensieve on each turn (limit:8 across N
 * memory tables) was hitting the DB ~50 times per minute under load.
 *
 * Keying on runtime identity (the agent id is stable per build) lets us
 * cache for `CACHE_TTL_MS` and skip the read when nothing has changed.
 * Cache invalidation: drop on TTL OR when the runtime is rebuilt
 * (cache map is module-scoped — new runtime gets a fresh slot).
 */
const CACHE_TTL_MS = 30_000;
const activityCache = new WeakMap<
	object,
	{ at: number; rows: import("../../core/pensieve/memory-service").PensieveMemorySummary[] }
>();

export const pensieveChroniclerProvider: Provider = {
	name: "USER_ACTIVITY_CONTEXT",
	description: "Recent user activity observations from Pensieve.",
	dynamic: true,
	position: -20,
	get: async (runtime) => {
		const { memories } = services(runtime);
		try {
			const cached = activityCache.get(runtime as object);
			const now = Date.now();
			let rows: Awaited<ReturnType<typeof memories.list>>;
			if (cached && now - cached.at < CACHE_TTL_MS) {
				rows = cached.rows;
			} else {
				rows = await memories.list({
					pathPrefix: "/observations/user-activity",
					limit: 8,
				});
				activityCache.set(runtime as object, { at: now, rows });
			}
			if (rows.length === 0) {
				return {
					text: "",
					values: { hasUserActivityContext: false },
					data: { observations: [] },
				};
			}
			const text = [
				"# Recent User Activity",
				...rows.map((row) => {
					const when = row.createdAt ? new Date(row.createdAt).toLocaleString() : "unknown time";
					return `- ${when}: ${row.preview}`;
				}),
			].join("\n");
			return {
				text,
				values: {
					hasUserActivityContext: true,
					userActivityObservationCount: rows.length,
				},
				data: { observations: rows },
			};
		} catch (err) {
			return {
				text: `Recent user activity context is unavailable: ${err instanceof Error ? err.message : String(err)}`,
				values: { hasUserActivityContext: false },
				data: { observations: [] },
			};
		}
	},
};

// ── PENSIEVE_WRITE ─────────────────────────────────────────────────────────

const writeHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const text = pickString(opts, ["text", "content", "body"]);
	if (!text) return fail("PENSIEVE_WRITE requires `text`.");
	const path = pickString(opts, ["path", "folder"]);
	const type = pickString(opts, ["type"]);
	const tags = pickStringArray(opts, "tags");
	const { memories } = services(runtime);
	try {
		const created = await memories.create({
			text,
			...(path ? { path } : {}),
			...(type ? { type } : {}),
			...(tags ? { tags } : {}),
		});
		const id = created?.id;
		audit({ action: "pensieve_write", target: id, success: !!id, caller: caller(runtime), ts: Date.now() });
		if (!id) return fail("Pensieve write failed.");
		await emit(callback, `Wrote memory ${id} to ${path ?? "(default folder)"}.`, "PENSIEVE_WRITE");
		return ok(`Wrote memory ${id}.`, { memory_id: id, path });
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		audit({ action: "pensieve_write", success: false, error: m, caller: caller(runtime), ts: Date.now() });
		return fail(`Pensieve write failed: ${m}`);
	}
};

export const pensieveWriteAction: Action = {
	name: "PENSIEVE_WRITE",
	similes: ["REMEMBER", "SAVE_NOTE", "ADD_KNOWLEDGE", "WRITE_MEMORY"],
	description:
		"Save a piece of text into the agent's Pensieve at an optional folder path with optional tags. " +
		"Use for: remembering a fact the user told you, jotting an observation about an entity, " +
		"capturing a draft. Path is folder-style (e.g. `/notes/projects/detour`); defaults to /custom.",
	validate: alwaysValid,
	handler: writeHandler,
	examples: [],
	parameters: [
		{ name: "text", description: "The memory body.", required: true, schema: { type: "string" as const } },
		{ name: "path", description: "Folder path, e.g. `/notes/projects`. Defaults to /custom.", required: false, schema: { type: "string" as const } },
		{ name: "tags", description: "Optional tags to attach (string array).", required: false, schema: { type: "array" as const } },
		{ name: "type", description: "Memory type (custom | description | document | fragment). Defaults to `custom`.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── PENSIEVE_READ ──────────────────────────────────────────────────────────

const readHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const id = pickString(opts, ["id", "memoryId"]);
	if (!id) return fail("PENSIEVE_READ requires `id`.");
	const { memories } = services(runtime);
	try {
		const detail = await memories.get(id as never);
		audit({ action: "pensieve_read", target: id, success: !!detail, caller: caller(runtime), ts: Date.now() });
		if (!detail) return fail(`No memory at id ${id}.`);
		await emit(callback, `Read memory ${id}.`, "PENSIEVE_READ");
		return ok(detail.content?.text ?? "(empty)", { memory: detail });
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		audit({ action: "pensieve_read", target: id, success: false, error: m, caller: caller(runtime), ts: Date.now() });
		return fail(`Pensieve read failed: ${m}`);
	}
};

export const pensieveReadAction: Action = {
	name: "PENSIEVE_READ",
	similes: ["RECALL_MEMORY", "FETCH_NOTE"],
	description: "Read a single Pensieve memory by id.",
	validate: alwaysValid,
	handler: readHandler,
	examples: [],
	parameters: [
		{ name: "id", description: "Memory id.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── PENSIEVE_LIST ──────────────────────────────────────────────────────────

const listHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const path = pickString(opts, ["path", "folder", "pathPrefix"]);
	const tag = pickString(opts, ["tag"]);
	const type = pickString(opts, ["type"]);
	const limit = pickNumber(opts, "limit") ?? 50;
	const { memories } = services(runtime);
	try {
		const rows = await memories.list({
			limit,
			...(path ? { pathPrefix: path } : {}),
			...(tag ? { tag } : {}),
			...(type ? { type } : {}),
		});
		audit({ action: "pensieve_list", target: path ?? tag ?? type, success: true, caller: caller(runtime), ts: Date.now() });
		await emit(callback, `Listed ${rows.length} memor${rows.length === 1 ? "y" : "ies"} matching filter.`, "PENSIEVE_LIST");
		return ok(`${rows.length} matched.`, { memories: rows });
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		audit({ action: "pensieve_list", success: false, error: m, caller: caller(runtime), ts: Date.now() });
		return fail(`Pensieve list failed: ${m}`);
	}
};

export const pensieveListAction: Action = {
	name: "PENSIEVE_LIST",
	similes: ["BROWSE_MEMORIES", "LIST_NOTES"],
	description: "List Pensieve memories filtered by folder path, tag, or memory type.",
	validate: alwaysValid,
	handler: listHandler,
	examples: [],
	parameters: [
		{ name: "path", description: "Folder path prefix to filter by.", required: false, schema: { type: "string" as const } },
		{ name: "tag", description: "Tag to filter by.", required: false, schema: { type: "string" as const } },
		{ name: "type", description: "Memory type to filter by.", required: false, schema: { type: "string" as const } },
		{ name: "limit", description: "Max rows to return (default 50).", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── PENSIEVE_SEARCH ────────────────────────────────────────────────────────

const searchHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const query = pickString(opts, ["query", "q", "text"]);
	if (!query) return fail("PENSIEVE_SEARCH requires `query`.");
	const limit = pickNumber(opts, "limit") ?? 30;
	const { memories } = services(runtime);
	try {
		const hits = await memories.search(query, limit);
		audit({ action: "pensieve_search", target: query, success: true, caller: caller(runtime), ts: Date.now() });
		await emit(callback, `Search returned ${hits.length} hit${hits.length === 1 ? "" : "s"}.`, "PENSIEVE_SEARCH");
		return ok(`${hits.length} hits.`, { memories: hits });
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		audit({ action: "pensieve_search", target: query, success: false, error: m, caller: caller(runtime), ts: Date.now() });
		return fail(`Pensieve search failed: ${m}`);
	}
};

export const pensieveSearchAction: Action = {
	name: "PENSIEVE_SEARCH",
	similes: ["FIND_MEMORY", "LOOKUP", "RECALL"],
	description: "Vector + substring search across all Pensieve memories. Use to recall related notes, prior conversations, observations.",
	validate: alwaysValid,
	handler: searchHandler,
	examples: [],
	parameters: [
		{ name: "query", description: "Free-text query.", required: true, schema: { type: "string" as const } },
		{ name: "limit", description: "Max rows to return (default 30).", required: false, schema: { type: "number" as const } },
	],
} as Action;

// ── PENSIEVE_LINK ──────────────────────────────────────────────────────────

const linkHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const source = pickString(opts, ["sourceEntityId", "source", "from"]);
	const target = pickString(opts, ["targetEntityId", "target", "to"]);
	if (!source || !target) return fail("PENSIEVE_LINK requires `sourceEntityId` and `targetEntityId`.");
	const tags = pickStringArray(opts, "tags");
	const { relationships } = services(runtime);
	try {
		const success = await relationships.create({
			sourceEntityId: source,
			targetEntityId: target,
			...(tags ? { tags } : {}),
		});
		audit({ action: "pensieve_link", target: `${source}->${target}`, success, caller: caller(runtime), ts: Date.now() });
		if (!success) return fail("Pensieve link failed.");
		await emit(callback, `Linked ${source} → ${target}.`, "PENSIEVE_LINK");
		return ok(`Linked ${source} → ${target}.`, { source, target, tags });
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		audit({ action: "pensieve_link", target: `${source}->${target}`, success: false, error: m, caller: caller(runtime), ts: Date.now() });
		return fail(`Pensieve link failed: ${m}`);
	}
};

export const pensieveLinkAction: Action = {
	name: "PENSIEVE_LINK",
	similes: ["RELATE_ENTITIES", "CONNECT"],
	description: "Create a relationship edge between two entities in the Pensieve graph.",
	validate: alwaysValid,
	handler: linkHandler,
	examples: [],
	parameters: [
		{ name: "sourceEntityId", description: "Source entity uuid.", required: true, schema: { type: "string" as const } },
		{ name: "targetEntityId", description: "Target entity uuid.", required: true, schema: { type: "string" as const } },
		{ name: "tags", description: "Optional tag list describing the relationship.", required: false, schema: { type: "array" as const } },
	],
} as Action;

// ── PENSIEVE_TEMPLATE_UPSERT ───────────────────────────────────────────────

const templateUpsertHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const name = pickString(opts, ["name", "templateName"]);
	const body = pickString(opts, ["body", "text", "template"]);
	if (!name || !body) return fail("PENSIEVE_TEMPLATE_UPSERT requires `name` and `body`.");
	const inputTags = pickStringArray(opts, "tags") ?? [];
	const tags = Array.from(new Set(["template", ...inputTags]));
	const slug = templateSlug(name);
	const { templates } = services(runtime);
	try {
		const list = await templates.listTemplates();
		const existing = list.find((t: PensieveTemplateSummary) => t.name === slug || t.name === name);
		let summary: PensieveTemplateSummary | null = null;
		if (existing) {
			const ok2 = await templates.updateTemplate(existing.id, { body, tags, path: `/templates/${slug}` });
			summary = ok2 ? await templates.getTemplate(existing.id) : null;
		} else {
			summary = await templates.createTemplate({ name: slug, body, tags: inputTags });
		}
		audit({ action: "pensieve_template_upsert", target: slug, success: !!summary, caller: caller(runtime), ts: Date.now() });
		if (!summary) return fail("Template upsert failed.");
		await emit(callback, `Saved template ${summary.name}.`, "PENSIEVE_TEMPLATE_UPSERT");
		return ok(`Saved template ${summary.name}.`, { id: summary.id, name: summary.name, variables: summary.variables });
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		audit({ action: "pensieve_template_upsert", target: slug, success: false, error: m, caller: caller(runtime), ts: Date.now() });
		return fail(`Template upsert failed: ${m}`);
	}
};

export const pensieveTemplateUpsertAction: Action = {
	name: "PENSIEVE_TEMPLATE_UPSERT",
	similes: ["UPSERT_TEMPLATE", "SAVE_TEMPLATE", "UPDATE_TEMPLATE", "CREATE_TEMPLATE"],
	description:
		"Create or update a stored Pensieve template by name. Use this to hone reusable prompts such as `x-post` and `x-comment`.",
	validate: alwaysValid,
	handler: templateUpsertHandler,
	examples: [],
	parameters: [
		{ name: "name", description: "Template name slug, e.g. `x-post` or `x-comment`.", required: true, schema: { type: "string" as const } },
		{ name: "body", description: "Template body with optional {{prompt_var}} placeholders.", required: true, schema: { type: "string" as const } },
		{ name: "tags", description: "Optional tags to attach.", required: false, schema: { type: "array" as const } },
	],
} as Action;

// ── PENSIEVE_TEMPLATE_RENDER ───────────────────────────────────────────────

const renderHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const id = pickString(opts, ["id", "templateId"]);
	const name = pickString(opts, ["name", "templateName"]);
	if (!id && !name) return fail("PENSIEVE_TEMPLATE_RENDER requires `id` or `name`.");
	const overrides = pickRecord(opts, "vars") ?? {};
	const { templates } = services(runtime);
	try {
		let resolvedId = id;
		if (!resolvedId && name) {
			const list = await templates.listTemplates();
			resolvedId = list.find((t: PensieveTemplateSummary) => t.name === name)?.id;
		}
		if (!resolvedId) return fail(`Template not found: ${id ?? name}`);
		const result = await templates.renderTemplate(resolvedId, overrides);
		audit({ action: "pensieve_template_render", target: resolvedId, success: !!result, caller: caller(runtime), ts: Date.now() });
		if (!result) return fail("Render failed.");
		await emit(callback, `Rendered template ${resolvedId}.`, "PENSIEVE_TEMPLATE_RENDER");
		return ok(result.rendered, { rendered: result.rendered, missing: result.missing, used: result.usedValues });
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		audit({ action: "pensieve_template_render", target: id ?? name, success: false, error: m, caller: caller(runtime), ts: Date.now() });
		return fail(`Render failed: ${m}`);
	}
};

export const pensieveTemplateRenderAction: Action = {
	name: "PENSIEVE_TEMPLATE_RENDER",
	similes: ["RENDER_TEMPLATE", "FILL_PROMPT"],
	description:
		"Render a stored Pensieve template (by id or name) with optional variable overrides; persisted prompt variables fill the rest.",
	validate: alwaysValid,
	handler: renderHandler,
	examples: [],
	parameters: [
		{ name: "id", description: "Template memory id.", required: false, schema: { type: "string" as const } },
		{ name: "name", description: "Template name slug (alternative to id).", required: false, schema: { type: "string" as const } },
		{ name: "vars", description: "Per-call variable overrides as { name: value }.", required: false, schema: { type: "object" as const } },
	],
} as Action;

// ── PENSIEVE_VAR_SET ───────────────────────────────────────────────────────

const varSetHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const name = pickString(opts, ["name"]);
	const value = pickString(opts, ["value"]);
	if (!name || value == null) return fail("PENSIEVE_VAR_SET requires `name` and `value`.");
	const { templates } = services(runtime);
	try {
		const v = await templates.setVariable(name, value);
		audit({ action: "pensieve_var_set", target: name, success: !!v, caller: caller(runtime), ts: Date.now() });
		if (!v) return fail("Set failed.");
		await emit(callback, `Set prompt variable {{${name}}}.`, "PENSIEVE_VAR_SET");
		return ok(`Set ${name}.`, { name: v.name, value: v.value });
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		audit({ action: "pensieve_var_set", target: name, success: false, error: m, caller: caller(runtime), ts: Date.now() });
		return fail(`Set failed: ${m}`);
	}
};

export const pensieveVarSetAction: Action = {
	name: "PENSIEVE_VAR_SET",
	similes: ["SET_PROMPT_VAR", "SAVE_VAR"],
	description: "Set a persisted prompt variable that templates can substitute via {{name}}.",
	validate: alwaysValid,
	handler: varSetHandler,
	examples: [],
	parameters: [
		{ name: "name", description: "Variable name (slug).", required: true, schema: { type: "string" as const } },
		{ name: "value", description: "Value to store.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── Plugin export ──────────────────────────────────────────────────────────

export const pensieveToolsPlugin: Plugin = {
	name: "./index",
	description:
		"Lets the agent read/write/search the Pensieve, link entities, create/update/render templates, and set prompt variables.",
	providers: [pensieveChroniclerProvider],
	actions: [
		pensieveWriteAction,
		pensieveReadAction,
		pensieveListAction,
		pensieveSearchAction,
		pensieveLinkAction,
		pensieveTemplateUpsertAction,
		pensieveTemplateRenderAction,
		pensieveVarSetAction,
	],
};

export default pensieveToolsPlugin;
