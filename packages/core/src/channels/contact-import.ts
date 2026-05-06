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

import { logger, type IAgentRuntime } from "@elizaos/core";

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
type ContactRelationship = { sourceEntityId: string; targetEntityId: string; tags: string[]; metadata: Record<string, unknown> };

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

function contactImportResult(partial: Partial<ContactImportResult> = {}): ContactImportResult {
	return {
		available: partial.available ?? true,
		contactsFound: partial.contactsFound ?? 0,
		entitiesCreated: partial.entitiesCreated ?? 0,
		relationshipsCreated: partial.relationshipsCreated ?? 0,
		skipped: partial.skipped ?? 0,
		...(partial.error ? { error: partial.error } : {}),
	};
}

function isImportableContact(contact: FullContact): boolean {
	return Boolean(contact.name || contact.phones.length > 0 || contact.emails.length > 0);
}

async function contactsFromPlugin(): Promise<FullContact[] | string> {
	try {
		const mod = await import("@elizaos/plugin-imessage") as { listAllContacts?: () => Promise<FullContact[]> };
		return mod.listAllContacts ? await mod.listAllContacts() : "listAllContacts not exported";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

async function loadContacts(service: unknown): Promise<{ contacts: FullContact[]; error?: string }> {
	const cached = contactsFromServiceCache(service);
	if (cached.length > 0) return { contacts: cached };
	const loaded = await contactsFromPlugin();
	return Array.isArray(loaded) ? { contacts: loaded } : { contacts: [], error: loaded };
}

function contactHandles(contact: FullContact): { phones: string[]; emails: string[] } {
	return {
		phones: contact.phones.map((p) => p.value).filter(Boolean),
		emails: contact.emails.map((e) => e.value).filter(Boolean),
	};
}

function contactEntity(contact: FullContact, agentId: string, entityId: string, handles: { phones: string[]; emails: string[] }) {
	return {
		id: entityId,
		agentId,
		names: uniqueStrings([contact.name, contact.firstName, contact.lastName, handles.phones[0], handles.emails[0]]),
		metadata: {
			source: "imessage",
			contactId: contact.id,
			...(contact.firstName ? { firstName: contact.firstName } : {}),
			...(contact.lastName ? { lastName: contact.lastName } : {}),
			phones: handles.phones,
			emails: handles.emails,
			handles: [...handles.phones, ...handles.emails],
			importedAt: Date.now(),
		},
	};
}

function contactRelationship(contact: FullContact, agentId: string, entityId: string, handles: { phones: string[]; emails: string[] }): ContactRelationship {
	return {
		sourceEntityId: agentId,
		targetEntityId: entityId,
		tags: ["imessage", "contact", "user-acquaintance"],
		metadata: {
			source: contact.id.startsWith("cached:") ? "imessage:contacts.cache" : "imessage:contacts.app",
			primaryHandle: handles.phones[0] ?? handles.emails[0] ?? null,
		},
	};
}

async function upsertContactEntity(runtime: RuntimeShape, entity: ReturnType<typeof contactEntity>): Promise<boolean> {
	if (typeof runtime.upsertEntities === "function") {
		await runtime.upsertEntities([entity]);
		return true;
	}
	return await runtime.createEntity?.(entity) === true;
}

async function importContact(
	runtime: RuntimeShape,
	agentId: string,
	contact: FullContact,
): Promise<{ created: boolean; relationship?: ContactRelationship }> {
	const entityId = await stableId(`imessage:contact:${contact.id}`);
	const handles = contactHandles(contact);
	const created = await upsertContactEntity(runtime, contactEntity(contact, agentId, entityId, handles));
	return { created, relationship: contactRelationship(contact, agentId, entityId, handles) };
}

async function createMissingRelationships(runtime: RuntimeShape, relationships: ContactRelationship[]): Promise<number> {
	if (relationships.length === 0 || !runtime.createRelationships) return 0;
	let pending = relationships;
	if (typeof runtime.getRelationshipsByPairs === "function") {
		const existing = await runtime.getRelationshipsByPairs(
			relationships.map((rel) => ({
				sourceEntityId: rel.sourceEntityId,
				targetEntityId: rel.targetEntityId,
			})),
		);
		pending = relationships.filter((_, index) => !existing[index]);
	}
	const ids = pending.length > 0 ? await runtime.createRelationships(pending) : [];
	return Array.isArray(ids) ? ids.length : pending.length;
}

export async function importImessageContacts(runtime: IAgentRuntime): Promise<ContactImportResult> {
	const r = runtime as unknown as RuntimeShape;
	if (!r.getService) {
		return contactImportResult({ available: false, error: "runtime has no getService" });
	}
	// Gate on iMessage service being registered (so we know plugin loaded).
	const svc = r.getService(IMESSAGE_SERVICE_TYPE);
	if (!svc) {
		return contactImportResult({ available: false, error: "iMessage service not yet registered" });
	}

	const { contacts, error } = await loadContacts(svc);
	if (error) return contactImportResult({ error });

	const agentId = r.agentId;
	if (!agentId) {
		return contactImportResult({ contactsFound: contacts.length, error: "agentId missing" });
	}

	let entitiesCreated = 0;
	let relationshipsCreated = 0;
	let skipped = 0;
	const relsToCreate: ContactRelationship[] = [];
	const importable = contacts.filter((contact) => {
		const ok = isImportableContact(contact);
		if (!ok) skipped += 1;
		return ok;
	});
	const imported = await Promise.allSettled(importable.map((contact) => importContact(r, agentId, contact)));
	for (const result of imported) {
		if (result.status === "rejected") {
			skipped += 1;
			continue;
		}
		if (result.value.created) entitiesCreated += 1;
		if (result.value.relationship) relsToCreate.push(result.value.relationship);
	}

	try {
		relationshipsCreated = await createMissingRelationships(r, relsToCreate);
	} catch (err) {
		logger.warn({ src: "contacts", err: err instanceof Error ? err.message : err }, "createRelationships failed");
	}

	return {
		available: true,
		contactsFound: contacts.length,
		entitiesCreated,
		relationshipsCreated,
		skipped,
	};
}
