/**
 * Pensieve > Templates pane.
 *
 * Templates and prompt-variables are both stored as memories so they share the
 * same indexing, search, audit, and graph machinery as everything else in
 * Pensieve. Conventions:
 *
 *  - Template memory: tag includes "template", path defaults to /templates/<name>.
 *  - Variable memory: tag includes "prompt-var" plus "prompt-var:<NAME>", path
 *    defaults to /prompt-vars/<name>. Body = current value.
 *
 * This service exposes read/write/render operations and the {{var}} regex
 * extractor. We don't hook into elizaOS's composePromptFromState — there's no
 * variable-source extension point — instead the agent calls renderTemplate
 * (which substitutes from prompt-var memories + caller-provided overrides)
 * and feeds the rendered text into composePromptFromState as a static prompt.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { PensieveMemoryService, type PensieveMemorySummary } from "./memory-service";

const TEMPLATE_TAG = "template";
const VAR_TAG_PREFIX = "prompt-var";
const RUNTIME_PROMPT_VARS_TEMPLATE_KEY = "__pensievePromptVars";

const VAR_REGEX = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;

export interface PensieveTemplateSummary {
	id: string;
	name: string;
	path: string;
	preview: string;
	variables: string[];
	tags: string[];
	updatedAt?: number;
}

export interface PensieveTemplateDetail extends PensieveTemplateSummary {
	body: string;
	currentValues: Record<string, string>;
	missingVariables: string[];
}

export interface PensievePromptVariable {
	name: string;
	value: string;
	memoryId: string;
	updatedAt?: number;
}

export interface PensieveTemplateRenderResult {
	rendered: string;
	usedValues: Record<string, string>;
	missing: string[];
}

function nameFromPath(path: string, prefix: string, fallback: string): string {
	if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1) || fallback;
	return fallback;
}

function extractVariables(body: string): string[] {
	const set = new Set<string>();
	for (const match of body.matchAll(VAR_REGEX)) {
		if (match[1]) set.add(match[1]);
	}
	return Array.from(set).sort();
}

function pickFirstTagAfter(tags: string[], prefix: string): string | undefined {
	const exact = `${prefix}:`;
	for (const t of tags) {
		if (t.startsWith(exact)) return t.slice(exact.length);
	}
	return undefined;
}

export class PensieveTemplatesService {
	private readonly memories: PensieveMemoryService;

	constructor(memories: PensieveMemoryService, _resolveRuntime: () => IAgentRuntime | null) {
		this.memories = memories;
	}

	async listTemplates(): Promise<PensieveTemplateSummary[]> {
		const rows = await this.memories.list({ tag: TEMPLATE_TAG, limit: 500 });
		const out: PensieveTemplateSummary[] = [];
		for (const row of rows) {
			const detail = await this.memories.get(row.id as UUID);
			const body = (detail?.content?.text ?? row.preview) ?? "";
			out.push({
				id: row.id,
				name: nameFromPath(row.path, "/templates", row.id.slice(0, 8)),
				path: row.path,
				preview: row.preview,
				variables: extractVariables(body),
				tags: row.tags ?? [],
				...(row.createdAt ? { updatedAt: row.createdAt } : {}),
			});
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	}

	async getTemplate(id: string): Promise<PensieveTemplateDetail | null> {
		const detail = await this.memories.get(id as UUID);
		if (!detail) return null;
		const body = detail.content?.text ?? "";
		const variables = extractVariables(body);
		const allVars = await this.listVariables();
		const valuesMap: Record<string, string> = {};
		for (const v of allVars) valuesMap[v.name] = v.value;
		const currentValues: Record<string, string> = {};
		const missing: string[] = [];
		for (const v of variables) {
			if (v in valuesMap) currentValues[v] = valuesMap[v]!;
			else missing.push(v);
		}
		return {
			id: detail.id,
			name: nameFromPath(detail.path, "/templates", detail.id.slice(0, 8)),
			path: detail.path,
			preview: detail.preview,
			variables,
			tags: detail.tags ?? [],
			...(detail.createdAt ? { updatedAt: detail.createdAt } : {}),
			body,
			currentValues,
			missingVariables: missing,
		};
	}

	async createTemplate(input: { name: string; body: string; tags?: string[] }): Promise<PensieveTemplateSummary | null> {
		const slug = input.name.trim().replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
		if (!slug) return null;
		const created = await this.memories.create({
			text: input.body,
			path: `/templates/${slug}`,
			type: "custom",
			tags: [TEMPLATE_TAG, ...(input.tags ?? [])],
			extraMetadata: { templateName: input.name },
		});
		if (!created) return null;
		const detail = await this.getTemplate(created.id);
		return detail;
	}

	async updateTemplate(id: string, patch: { body?: string; tags?: string[]; path?: string }): Promise<boolean> {
		const updateInput: { contentText?: string; tags?: string[]; path?: string } = {};
		if (typeof patch.body === "string") updateInput.contentText = patch.body;
		if (Array.isArray(patch.tags)) updateInput.tags = patch.tags;
		if (typeof patch.path === "string") updateInput.path = patch.path;
		return this.memories.update(id as never, updateInput);
	}

	async deleteTemplate(id: string): Promise<boolean> {
		return this.memories.remove(id as UUID);
	}

	async renderTemplate(id: string, overrides: Record<string, string> = {}): Promise<PensieveTemplateRenderResult | null> {
		const detail = await this.getTemplate(id);
		if (!detail) return null;
		const stored = { ...detail.currentValues };
		const merged: Record<string, string> = { ...stored, ...overrides };
		const missing: string[] = [];
		const used: Record<string, string> = {};
		const rendered = detail.body.replace(VAR_REGEX, (match, name: string) => {
			if (name in merged) {
				used[name] = merged[name]!;
				return merged[name]!;
			}
			missing.push(name);
			return match;
		});
		return { rendered, usedValues: used, missing };
	}

	// ── Variables ──────────────────────────────────────────────────────────

	async listVariables(): Promise<PensievePromptVariable[]> {
		const rows = await this.memories.list({ tag: VAR_TAG_PREFIX, limit: 500 });
		const out: PensievePromptVariable[] = [];
		for (const row of rows) {
			const detail = await this.memories.get(row.id as UUID);
			if (!detail) continue;
			const value = detail.content?.text ?? "";
			const name =
				pickFirstTagAfter(detail.tags ?? [], VAR_TAG_PREFIX) ??
				nameFromPath(detail.path, "/prompt-vars", detail.id.slice(0, 8));
			out.push({
				name,
				value,
				memoryId: detail.id,
				...(detail.createdAt ? { updatedAt: detail.createdAt } : {}),
			});
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	}

	async getVariable(name: string): Promise<PensievePromptVariable | null> {
		const all = await this.listVariables();
		return all.find((v) => v.name === name) ?? null;
	}

	async setVariable(name: string, value: string): Promise<PensievePromptVariable | null> {
		const slug = name.trim().replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
		if (!slug) return null;
		const existing = await this.getVariable(slug);
		if (existing) {
			await this.memories.update(existing.memoryId as never, { contentText: value });
			return { ...existing, value };
		}
		const created = await this.memories.create({
			text: value,
			path: `/prompt-vars/${slug}`,
			type: "custom",
			tags: [VAR_TAG_PREFIX, `${VAR_TAG_PREFIX}:${slug}`],
			extraMetadata: { promptVar: slug },
		});
		if (!created) return null;
		return { name: slug, value, memoryId: created.id };
	}

	async deleteVariable(name: string): Promise<boolean> {
		const existing = await this.getVariable(name);
		if (!existing) return false;
		return this.memories.remove(existing.memoryId as UUID);
	}

	/** Pure helper exposed for tests / agent-side code. */
	static extractVariables(body: string): string[] {
		return extractVariables(body);
	}

	/**
	 * Read every persisted template and merge their bodies into
	 * `runtime.character.templates` keyed by the template's `name` slug.
	 *
	 * elizaOS subsystems (basic-capabilities, advanced-capabilities, message
	 * service, etc.) all read prompts via `runtime.character.templates?.<name>`
	 * with a fallback to their built-in default — so any Pensieve template
	 * with a recognised name (messageHandlerTemplate, replyTemplate,
	 * shouldRespondTemplate, reflectionTemplate, thinkTemplate, …) takes
	 * effect immediately. This is the "Eliza is actually using all of this"
	 * integration point for the templates surface.
	 *
	 * Called from the RuntimeService.onAfterBuild hook on every build/rebuild,
	 * so user edits in the Pensieve UI persist across restarts.
	 */
	async applyTemplatesToRuntime(runtime: IAgentRuntime): Promise<{ applied: number; names: string[] }> {
		const character = runtime.character as { templates?: Record<string, string> } | undefined;
		if (!character) return { applied: 0, names: [] };
		if (!character.templates) character.templates = {};
		const list = await this.listTemplates();
		const names: string[] = [];
		for (const t of list) {
			const detail = await this.getTemplate(t.id);
			if (!detail) continue;
			character.templates[t.name] = detail.body;
			names.push(t.name);
		}
		const variables = await this.listVariables();
		const values: Record<string, string> = {};
		for (const v of variables) values[v.name] = v.value;
		if (Object.keys(values).length > 0) {
			character.templates[RUNTIME_PROMPT_VARS_TEMPLATE_KEY] = JSON.stringify(values);
		} else {
			delete character.templates[RUNTIME_PROMPT_VARS_TEMPLATE_KEY];
		}
		return { applied: names.length, names };
	}
}

// Re-export for convenience.
export { extractVariables as extractTemplateVariables };
export type { PensieveMemorySummary };
