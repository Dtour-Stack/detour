/**
 * @detour/plugin-contact-dossier
 *
 * Gives the agent cross-channel awareness of who it's talking to by injecting
 * a rich "dossier" into every turn's state composition. The dossier includes:
 *
 *   - All known names/handles across channels (Discord, X, Telegram, iMessage)
 *   - Importance score + message count + last seen
 *   - Recent cross-channel conversation snippets
 *   - Saved notes/observations about the person from Pensieve
 *
 * Without this, the agent treats every message as coming from an anonymous
 * entity. With it, the agent knows "this is Shaw, the ElizaOS core
 * maintainer, who I was discussing runtime refactoring with on Discord
 * yesterday and who texted me about deployment on iMessage last week."
 *
 * Also registers CONTACT_UPDATE — lets the agent proactively note things
 * about contacts ("remember that Shaw prefers technical detail").
 */

import {
	type Action,
	type ActionResult,
	type Entity,
	type Handler,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type Plugin,
	type Provider,
	type ProviderResult,
	type Relationship,
	type State,
	type UUID,
} from "@elizaos/core";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PensieveMemoryService } from "../../core/pensieve/memory-service";
import { PensieveRelationshipService } from "../../core/pensieve/relationship-service";

// ── Gateway message reading (same pattern as discord-context-provider) ─────

interface GatewayMessage {
	readonly id: string;
	readonly time: number;
	readonly direction: "in" | "out" | "deleted" | "interaction";
	readonly channel: string;
	readonly source: string;
	readonly roomId: string;
	readonly entityId: string;
	readonly externalHandle?: string;
	readonly text: string;
	readonly meta?: Record<string, unknown>;
}

const MAX_GATEWAY_LINES = 5000;
const MAX_RECENT_MESSAGES = 8;
const MAX_DOSSIER_NOTES = 5;
const MAX_SNIPPET_LEN = 160;
const CACHE_TTL_MS = 30_000;

function resolveStateDir(): string {
	return (
		process.env.ELIZA_STATE_DIR?.trim() ||
		join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`)
	);
}

function isGatewayMessage(value: unknown): value is GatewayMessage {
	const item = value as Record<string, unknown> | null;
	return Boolean(
		item &&
		typeof item === "object" &&
		typeof item.id === "string" &&
		typeof item.time === "number" &&
		typeof item.direction === "string" &&
		typeof item.channel === "string" &&
		typeof item.entityId === "string" &&
		typeof item.text === "string",
	);
}

function readGatewayMessages(): GatewayMessage[] {
	const path = join(resolveStateDir(), "gateway", "messages.jsonl");
	if (!existsSync(path)) return [];
	try {
		const lines = readFileSync(path, "utf8").trim().split("\n").slice(-MAX_GATEWAY_LINES);
		const out: GatewayMessage[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (isGatewayMessage(parsed)) out.push(parsed);
			} catch {
				continue;
			}
		}
		return out;
	} catch {
		return [];
	}
}

function compactText(text: string, limit = MAX_SNIPPET_LEN): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, limit - 1).trim()}…` : compact;
}

function timeAgo(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
	return `${Math.floor(diff / 604_800_000)}w ago`;
}

function stripMetaPrefix(text: string): string {
	// Strip [Discord #channel] @username (...): prefix and similar
	return text
		.replace(/^\[Discord\s[^\]]+\]\s+@.+?\([^)]+\)(?:\s+replying\sto\s@[^:]+)?:\s*/s, "")
		.replace(/^\[source=[^\]]+\]\n?/s, "")
		.trim();
}

function internalText(text: string): boolean {
	return /dynamicPromptExecFromState|generation_failed|provider\spath|server_is_overloaded|apiKey=|x-api-key|authorization/i.test(text);
}

// ── Adapter types for runtime ducktyping ──────────────────────────────────

interface AdapterShape {
	getRelationships?: (p: Record<string, unknown>) => Promise<Relationship[]>;
	getEntityById?: (id: UUID) => Promise<Entity | null>;
	getEntitiesByIds?: (ids: UUID[]) => Promise<Entity[]>;
	getMemories?: (p: Record<string, unknown>) => Promise<Memory[]>;
}

interface RelationshipsServiceShape {
	resolvePrimaryEntityId?: (entityId: UUID) => Promise<UUID>;
	getMemberEntityIds?: (entityId: UUID) => Promise<UUID[]>;
	getContact?: (entityId: UUID) => Promise<{ entityId: UUID; tags?: string[]; trackingEnabled?: boolean } | null>;
}

function adapter(runtime: IAgentRuntime): AdapterShape {
	return runtime as unknown as AdapterShape;
}

function relationshipsService(runtime: IAgentRuntime): RelationshipsServiceShape | null {
	const service = runtime.getService("relationships");
	return service ? service as RelationshipsServiceShape : null;
}

// ── Dossier construction ──────────────────────────────────────────────────

interface DossierData {
	name: string | null;
	allNames: string[];
	handles: Array<{ channel: string; handle: string }>;
	importanceScore: number;
	messageCount: number;
	lastSeen: number | null;
	tags: string[];
	memberEntityIds: string[];
	tracked: boolean;
	recentMessages: Array<{ channel: string; time: number; direction: string; text: string }>;
	notes: Array<{ preview: string; createdAt?: number }>;
}

/**
 * Per-runtime cache. The dossier provider fires on every planner turn.
 * Building a dossier is expensive (relationship queries + gateway file read).
 * Cache for CACHE_TTL_MS keyed on entityId.
 */
const dossierCache = new WeakMap<
	object,
	Map<string, { at: number; text: string; data: DossierData }>
>();

async function buildDossier(
	runtime: IAgentRuntime,
	entityId: UUID,
): Promise<{ text: string; data: DossierData }> {
	const a = adapter(runtime);
	const relService = relationshipsService(runtime);

	// 1. Resolve primary entity + all member IDs (cross-channel aliases)
	const primaryId = relService?.resolvePrimaryEntityId
		? await relService.resolvePrimaryEntityId(entityId).catch(() => entityId)
		: entityId;
	const memberIds = relService?.getMemberEntityIds
		? await relService.getMemberEntityIds(primaryId).catch(() => [primaryId])
		: [primaryId];
	const allIds = Array.from(new Set([primaryId, entityId, ...memberIds]));
	const allIdStrings = new Set(allIds.map(String));

	// 2. Load entities for all member IDs
	const entities = typeof a.getEntitiesByIds === "function"
		? await a.getEntitiesByIds(allIds as UUID[])
		: [];
	const byId = new Map(entities.map((e) => [String(e.id), e]));

	// 3. Gather names
	const allNames: string[] = [];
	const nameSet = new Set<string>();
	for (const entity of entities) {
		for (const name of entity.names ?? []) {
			const n = name?.trim();
			if (n && !nameSet.has(n.toLowerCase())) {
				nameSet.add(n.toLowerCase());
				allNames.push(n);
			}
		}
	}
	const primaryName = allNames[0] ?? null;

	// 4. Gather handles from gateway identities
	const handles: Array<{ channel: string; handle: string }> = [];
	const handleSet = new Set<string>();
	const gwMessages = readGatewayMessages();
	for (const msg of gwMessages) {
		if (!allIdStrings.has(msg.entityId) || !msg.externalHandle) continue;
		const key = `${msg.channel}:${msg.externalHandle}`;
		if (handleSet.has(key)) continue;
		handleSet.add(key);
		handles.push({ channel: msg.channel, handle: msg.externalHandle });
	}
	// Also gather from entity metadata
	for (const entity of entities) {
		const metadata = entity.metadata as Record<string, unknown> | undefined;
		if (metadata?.handles && Array.isArray(metadata.handles)) {
			for (const h of metadata.handles as string[]) {
				const source = typeof metadata.source === "string" ? metadata.source : "unknown";
				const key = `${source}:${h}`;
				if (!handleSet.has(key)) {
					handleSet.add(key);
					handles.push({ channel: source, handle: h });
				}
			}
		}
	}

	// 5. Compute importance, message count, last seen from relationships
	const rels = typeof a.getRelationships === "function"
		? await a.getRelationships({ entityIds: allIds })
		: [];
	let importanceScore = 0;
	let messageCount = 0;
	let lastSeen: number | null = null;
	const tags = new Set<string>();
	for (const rel of rels) {
		const metadata = rel.metadata as Record<string, unknown> | undefined;
		const relImportance = typeof metadata?.importanceScore === "number" ? metadata.importanceScore : 0;
		const relMessages = typeof metadata?.messageCount === "number" ? metadata.messageCount : 0;
		const relLastSeen = typeof metadata?.lastSeenAt === "number" ? metadata.lastSeenAt : 0;
		if (relImportance > importanceScore) importanceScore = relImportance;
		messageCount += relMessages;
		if (relLastSeen > (lastSeen ?? 0)) lastSeen = relLastSeen;
		for (const tag of rel.tags ?? []) tags.add(tag);
	}
	// Contact tags
	const contacts = await Promise.all(
		allIds.map((id) => relService?.getContact?.(id as UUID).catch(() => null) ?? null),
	);
	const tracked = contacts.some((c) => c?.trackingEnabled);
	for (const contact of contacts) {
		for (const tag of contact?.tags ?? []) tags.add(tag);
	}

	// 6. Recent cross-channel messages for this person
	const personMessages = gwMessages
		.filter((msg) => allIdStrings.has(msg.entityId) && msg.text.length > 0)
		.sort((a2, b) => b.time - a2.time)
		.slice(0, MAX_RECENT_MESSAGES * 3); // pre-filter more, then take best

	const recentMessages: DossierData["recentMessages"] = [];
	for (const msg of personMessages) {
		const stripped = stripMetaPrefix(msg.text);
		if (internalText(stripped)) continue;
		recentMessages.push({
			channel: msg.channel,
			time: msg.time,
			direction: msg.direction,
			text: compactText(stripped),
		});
		if (recentMessages.length >= MAX_RECENT_MESSAGES) break;
	}

	// 7. Saved notes/observations about this person from Pensieve
	const memories = new PensieveMemoryService(() => runtime);
	const notes: DossierData["notes"] = [];
	try {
		// Search across contact-specific paths and general facts
		const results = await memories.list({
			limit: MAX_DOSSIER_NOTES,
			pathPrefix: `/contacts/`,
		});
		for (const row of results) {
			notes.push({
				preview: compactText(row.preview, 200),
				...(row.createdAt ? { createdAt: row.createdAt } : {}),
			});
		}
	} catch {
		// Pensieve may not be ready
	}

	// 8. Build member entity IDs list
	const memberEntityIds = allIds.map(String);

	const data: DossierData = {
		name: primaryName,
		allNames,
		handles,
		importanceScore,
		messageCount,
		lastSeen,
		tags: Array.from(tags),
		memberEntityIds,
		tracked,
		recentMessages,
		notes,
	};

	// 9. Format dossier text for prompt injection
	const text = formatDossier(data, runtime.agentId);

	return { text, data };
}

function formatDossier(data: DossierData, agentId: UUID): string {
	// Don't inject dossier for the agent itself
	if (!data.name && data.handles.length === 0 && data.messageCount === 0) {
		return "";
	}

	const sections: string[] = ["# Current Speaker Dossier"];

	// Identity line
	const identityParts: string[] = [];
	if (data.name) identityParts.push(`Name: ${data.name}`);
	if (data.allNames.length > 1) {
		identityParts.push(`Also known as: ${data.allNames.slice(1, 4).join(", ")}`);
	}
	for (const h of data.handles.slice(0, 6)) {
		identityParts.push(`${h.channel}: ${h.handle}`);
	}
	if (identityParts.length > 0) sections.push(identityParts.join(" | "));

	// Stats line
	const statsParts: string[] = [];
	if (data.importanceScore > 0) statsParts.push(`Importance: ${Math.round(data.importanceScore)}/100`);
	if (data.messageCount > 0) statsParts.push(`Messages: ${data.messageCount}`);
	if (data.lastSeen) statsParts.push(`Last seen: ${timeAgo(data.lastSeen)}`);
	if (data.tracked) statsParts.push("⭐ Tracked contact");
	if (statsParts.length > 0) sections.push(statsParts.join(" | "));

	// Tags
	const filteredTags = data.tags.filter((t) => !["discord", "telegram", "imessage", "chat", "contact", "user-acquaintance"].includes(t));
	if (filteredTags.length > 0) {
		sections.push(`Tags: ${filteredTags.slice(0, 8).join(", ")}`);
	}

	// Recent cross-channel context
	if (data.recentMessages.length > 0) {
		const lines = data.recentMessages.map((msg) => {
			const dir = msg.direction === "out" ? "→ agent" : "← them";
			return `- [${msg.channel} ${timeAgo(msg.time)}] ${dir}: ${msg.text}`;
		});
		sections.push(`Recent cross-channel context:\n${lines.join("\n")}`);
	}

	// Saved notes
	if (data.notes.length > 0) {
		const lines = data.notes.map((note) => {
			const when = note.createdAt ? ` (${timeAgo(note.createdAt)})` : "";
			return `- ${note.preview}${when}`;
		});
		sections.push(`Saved notes:\n${lines.join("\n")}`);
	}

	// Instruction
	sections.push(
		"Use this dossier as factual context about the current speaker. " +
		"Maintain continuity with prior conversations across channels. " +
		"Do not invent details beyond what is listed here.",
	);

	return sections.join("\n\n").slice(0, 4000);
}

// ── Provider: CONTACT_DOSSIER ─────────────────────────────────────────────

export const contactDossierProvider: Provider = {
	name: "CONTACT_DOSSIER",
	description:
		"Cross-channel identity dossier for the current speaker. " +
		"Injects known names, handles (Discord/X/Telegram/iMessage), " +
		"importance score, recent conversation snippets across all channels, " +
		"and saved notes about the person from Pensieve.",
	dynamic: true,
	position: 52, // Between CHARACTER_ANCHOR (50) and DISCORD_CONTEXT (54)
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const entityId = message.entityId;
		if (!entityId || entityId === runtime.agentId) {
			return { text: "", values: { hasContactDossier: false }, data: {} };
		}

		try {
			// Check cache
			let cache = dossierCache.get(runtime as object);
			if (!cache) {
				cache = new Map();
				dossierCache.set(runtime as object, cache);
			}
			const key = String(entityId);
			const cached = cache.get(key);
			const now = Date.now();
			if (cached && now - cached.at < CACHE_TTL_MS) {
				return {
					text: cached.text,
					values: { hasContactDossier: cached.text.length > 0, contactName: cached.data.name },
					data: { dossier: cached.data },
				};
			}

			const { text, data } = await buildDossier(runtime, entityId);
			cache.set(key, { at: now, text, data });

			return {
				text,
				values: {
					hasContactDossier: text.length > 0,
					contactName: data.name,
					contactImportance: data.importanceScore,
					contactTracked: data.tracked,
				},
				data: { dossier: data },
			};
		} catch (err) {
			return {
				text: `Contact dossier unavailable: ${err instanceof Error ? err.message : String(err)}`,
				values: { hasContactDossier: false },
				data: {},
			};
		}
	},
};

// ── Action: CONTACT_UPDATE ────────────────────────────────────────────────

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

async function emit(callback: HandlerCallback | undefined, text: string, actionName: string): Promise<void> {
	if (!callback) return;
	try {
		await callback({ text, source: "contact-dossier" } as never, actionName);
	} catch { /* ignore */ }
}

const contactUpdateHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const entityId = pickString(opts, ["entityId", "entity_id", "id"]);
	const note = pickString(opts, ["note", "observation", "text"]);
	const addTags = pickStringArray(opts, "tags") ?? pickStringArray(opts, "addTags");
	const track = opts ? paramsBag(opts).track : undefined;

	if (!entityId && !note) {
		return { success: false, text: "CONTACT_UPDATE requires `entityId` and at least one of: `note`, `tags`, `track`." } as ActionResult;
	}

	const results: string[] = [];
	const relService = new PensieveRelationshipService(() => runtime);

	// Save note about the contact
	if (note && entityId) {
		const memories = new PensieveMemoryService(() => runtime);
		try {
			const created = await memories.create({
				text: note,
				path: `/contacts/${entityId}/notes`,
				type: "custom",
				tags: ["contact-note", ...(addTags ?? [])],
			});
			if (created) {
				results.push(`Saved note about ${entityId}.`);
			}
		} catch (err) {
			results.push(`Note save failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Set tracking
	if (typeof track === "boolean" && entityId) {
		try {
			await relService.setTracked(entityId as UUID, track);
			results.push(`${track ? "Enabled" : "Disabled"} tracking for ${entityId}.`);
		} catch (err) {
			results.push(`Tracking update failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Update relationship tags
	if (addTags && addTags.length > 0 && entityId) {
		try {
			const success = await relService.update(
				runtime.agentId,
				entityId as UUID,
				{ tags: addTags },
			);
			if (success) results.push(`Updated tags for ${entityId}.`);
		} catch (err) {
			results.push(`Tag update failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const summary = results.length > 0 ? results.join(" ") : "No updates applied.";
	await emit(callback, summary, "CONTACT_UPDATE");

	// Invalidate dossier cache for this entity
	const cache = dossierCache.get(runtime as object);
	if (cache && entityId) cache.delete(entityId);

	return { success: results.length > 0, text: summary } as ActionResult;
};

export const contactUpdateAction: Action = {
	name: "CONTACT_UPDATE",
	similes: ["UPDATE_CONTACT", "NOTE_ABOUT_PERSON", "REMEMBER_ABOUT_PERSON", "TAG_CONTACT", "TRACK_CONTACT"],
	description:
		"Update a contact's dossier: save a note/observation about them, add tags, or enable/disable tracking. " +
		"Use when the user tells you something about a person, or when you observe something worth remembering " +
		"about a contact (e.g., their role, preferences, relationship to the user).",
	validate: async () => true,
	handler: contactUpdateHandler,
	examples: [],
	parameters: [
		{ name: "entityId", description: "Entity UUID of the contact.", required: true, schema: { type: "string" as const } },
		{ name: "note", description: "Text observation to save about this contact.", required: false, schema: { type: "string" as const } },
		{ name: "tags", description: "Tags to add to the relationship (string array).", required: false, schema: { type: "array" as const } },
		{ name: "track", description: "Enable (true) or disable (false) contact tracking.", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── Action: CONTACT_MERGE ─────────────────────────────────────────────────

const contactMergeHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const primaryId = pickString(opts, ["primaryId", "primary", "into"]);
	const secondaryId = pickString(opts, ["secondaryId", "secondary", "from", "merge"]);

	if (!primaryId || !secondaryId) {
		return { success: false, text: "CONTACT_MERGE requires `primaryId` and `secondaryId`." } as ActionResult;
	}

	const relService = new PensieveRelationshipService(() => runtime);
	try {
		const result = await relService.mergeEntities(primaryId as UUID, [secondaryId as UUID]);
		if (!result) {
			return { success: false, text: "Merge failed — relationships service may not support merge." } as ActionResult;
		}
		const name = result.entity.name ?? primaryId;
		await emit(callback, `Merged ${secondaryId} into ${name}'s identity cluster.`, "CONTACT_MERGE");

		// Invalidate cache
		const cache = dossierCache.get(runtime as object);
		if (cache) {
			cache.delete(primaryId);
			cache.delete(secondaryId);
		}

		return {
			success: true,
			text: `Merged ${secondaryId} into ${name}'s identity. Member entities: ${result.entity.memberEntityIds.join(", ")}`,
		} as ActionResult;
	} catch (err) {
		return { success: false, text: `Merge failed: ${err instanceof Error ? err.message : String(err)}` } as ActionResult;
	}
};

export const contactMergeAction: Action = {
	name: "CONTACT_MERGE",
	similes: ["MERGE_CONTACTS", "LINK_IDENTITIES", "SAME_PERSON"],
	description:
		"Merge two entity IDs into one identity cluster when you discover they're the same person " +
		"across channels (e.g., Discord user X is the same as Telegram user Y). The secondary entity's " +
		"memories and relationships are absorbed into the primary entity.",
	validate: async () => true,
	handler: contactMergeHandler,
	examples: [],
	parameters: [
		{ name: "primaryId", description: "Entity UUID to keep as the primary identity.", required: true, schema: { type: "string" as const } },
		{ name: "secondaryId", description: "Entity UUID to merge into the primary.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── Plugin export ─────────────────────────────────────────────────────────

export const contactDossierPlugin: Plugin = {
	name: "@detour/plugin-contact-dossier",
	description:
		"Cross-channel identity + relationship context for the agent. " +
		"Injects a rich dossier of the current speaker into every turn, " +
		"lets the agent update contact notes/tags, and merge identities.",
	providers: [contactDossierProvider],
	actions: [contactUpdateAction, contactMergeAction],
};

export default contactDossierPlugin;
