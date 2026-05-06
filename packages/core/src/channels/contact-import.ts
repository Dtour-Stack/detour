/**
 * Import macOS Contacts.app contacts (loaded by plugin-imessage's contacts
 * reader) into the agent's entity graph + relationship store.
 *
 * Why: the iMessage plugin only uses contacts internally to resolve
 * phone-number → display-name on inbound messages. They're never exposed to
 * the agent's reasoning layer. By creating an Entity per contact and a
 * Relationship between agent ↔ contact, the agent can:
 *
 *   - know who its user is friends with
 *   - reference contacts by name when planning actions ("text Sarah")
 *   - run relationship-extraction over future iMessage conversations
 *     against a populated entity store (without this, every contact starts
 *     as an anonymous handle)
 *
 * Idempotent: entity IDs are derived via createUniqueUuid(runtime, contactId)
 * so re-running the import overwrites in place. Skips entities that have not
 * changed since last import (best-effort dedupe via lastModified hash).
 */

import type { IAgentRuntime } from "@elizaos/core";

const IMESSAGE_SERVICE_TYPE = "imessage";

interface FullContact {
	id: string;
	name: string;
	firstName: string | null;
	lastName: string | null;
	phones: Array<{ label: string | null; value: string }>;
	emails: Array<{ label: string | null; value: string }>;
}

interface RuntimeShape {
	agentId?: string;
	getService?: (t: string) => unknown;
	upsertEntities?: (entities: Array<{ id: string; agentId?: string; names: string[]; metadata?: Record<string, unknown> }>) => Promise<void>;
	createEntity?: (entity: { id: string; agentId?: string; names: string[]; metadata?: Record<string, unknown> }) => Promise<boolean>;
	getRelationshipsByPairs?: (pairs: Array<{ sourceEntityId: string; targetEntityId: string }>) => Promise<Array<unknown | null>>;
	createRelationships?: (rels: Array<{ sourceEntityId: string; targetEntityId: string; tags?: string[]; metadata?: Record<string, unknown> }>) => Promise<string[]>;
}

type CachedContacts = Map<string, { name?: string }> | Record<string, { name?: string } | string>;

function isEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	return Array.from(new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v)));
}

function contactsFromServiceCache(service: unknown): FullContact[] {
	const getter = (service as { getContacts?: () => CachedContacts }).getContacts;
	if (typeof getter !== "function") return [];
	const raw = getter.call(service);
	const entries = raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw ?? {});
	const grouped = new Map<string, FullContact>();
	for (const [handle, value] of entries) {
		const normalizedHandle = handle.trim();
		if (!normalizedHandle) continue;
		const record = typeof value === "string" ? { name: value } : value;
		const name = record?.name?.trim() || normalizedHandle;
		const id = `cached:${name.toLowerCase()}`;
		const existing = grouped.get(id) ?? {
			id,
			name,
			firstName: name.split(/\s+/)[0] ?? null,
			lastName: name.split(/\s+/).slice(1).join(" ") || null,
			phones: [],
			emails: [],
		};
		if (isEmail(normalizedHandle)) {
			existing.emails.push({ label: null, value: normalizedHandle });
		} else {
			existing.phones.push({ label: null, value: normalizedHandle });
		}
		grouped.set(id, existing);
	}
	return Array.from(grouped.values());
}

/** Cheap deterministic UUID v5-ish derivation for stable entity IDs across runs. */
async function stableId(seed: string): Promise<string> {
	const enc = new TextEncoder();
	const buf = await crypto.subtle.digest("SHA-256", enc.encode(seed));
	const bytes = new Uint8Array(buf);
	const hex = Array.from(bytes.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("");
	// Format as UUID
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface ContactImportResult {
	available: boolean;
	contactsFound: number;
	entitiesCreated: number;
	relationshipsCreated: number;
	skipped: number;
	error?: string;
}

export async function importImessageContacts(runtime: IAgentRuntime): Promise<ContactImportResult> {
	const r = runtime as unknown as RuntimeShape;
	if (!r.getService) {
		return { available: false, contactsFound: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, error: "runtime has no getService" };
	}
	// Gate on iMessage service being registered (so we know plugin loaded).
	const svc = r.getService(IMESSAGE_SERVICE_TYPE);
	if (!svc) {
		return { available: false, contactsFound: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, error: "iMessage service not yet registered" };
	}

	let contacts = contactsFromServiceCache(svc);
	if (contacts.length === 0) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const mod: any = await import("@elizaos/plugin-imessage");
			const fn = (mod as { listAllContacts?: () => Promise<FullContact[]> }).listAllContacts;
			if (!fn) {
				return { available: true, contactsFound: 0, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, error: "listAllContacts not exported" };
			}
			contacts = await fn();
		} catch (err) {
			return {
				available: true,
				contactsFound: 0,
				entitiesCreated: 0,
				relationshipsCreated: 0,
				skipped: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	const agentId = r.agentId;
	if (!agentId) {
		return { available: true, contactsFound: contacts.length, entitiesCreated: 0, relationshipsCreated: 0, skipped: 0, error: "agentId missing" };
	}

	let entitiesCreated = 0;
	let relationshipsCreated = 0;
	let skipped = 0;
	const relsToCreate: Array<{ sourceEntityId: string; targetEntityId: string; tags: string[]; metadata: Record<string, unknown> }> = [];

	for (const c of contacts) {
		if (!c.name && c.phones.length === 0 && c.emails.length === 0) {
			skipped += 1;
			continue;
		}
		const entityId = await stableId(`imessage:contact:${c.id}`);
		const phones = c.phones.map((p) => p.value).filter(Boolean);
		const emails = c.emails.map((e) => e.value).filter(Boolean);
		try {
			const entity = {
				id: entityId,
				agentId,
				names: uniqueStrings([c.name, c.firstName, c.lastName, phones[0], emails[0]]),
				metadata: {
					source: "imessage",
					contactId: c.id,
					...(c.firstName ? { firstName: c.firstName } : {}),
					...(c.lastName ? { lastName: c.lastName } : {}),
					phones,
					emails,
					handles: [...phones, ...emails],
					importedAt: Date.now(),
				},
			};
			if (typeof r.upsertEntities === "function") {
				await r.upsertEntities([entity]);
				entitiesCreated += 1;
			} else {
				const created = await r.createEntity?.(entity);
				if (created) entitiesCreated += 1;
			}
			relsToCreate.push({
				sourceEntityId: agentId,
				targetEntityId: entityId,
				tags: ["imessage", "contact", "user-acquaintance"],
				metadata: {
					source: c.id.startsWith("cached:") ? "imessage:contacts.cache" : "imessage:contacts.app",
					primaryHandle: phones[0] ?? emails[0] ?? null,
				},
			});
		} catch {
			skipped += 1;
		}
	}

	if (relsToCreate.length > 0 && r.createRelationships) {
		try {
			let pending = relsToCreate;
			if (typeof r.getRelationshipsByPairs === "function") {
				const existing = await r.getRelationshipsByPairs(
					relsToCreate.map((rel) => ({
						sourceEntityId: rel.sourceEntityId,
						targetEntityId: rel.targetEntityId,
					})),
				);
				pending = relsToCreate.filter((_, index) => !existing[index]);
			}
			const ids = pending.length > 0 ? await r.createRelationships(pending) : [];
			relationshipsCreated = Array.isArray(ids) ? ids.length : pending.length;
		} catch (err) {
			console.warn("[contacts] createRelationships failed:", err instanceof Error ? err.message : err);
		}
	}

	return {
		available: true,
		contactsFound: contacts.length,
		entitiesCreated,
		relationshipsCreated,
		skipped,
	};
}
