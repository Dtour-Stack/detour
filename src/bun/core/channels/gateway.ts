/**
 * ChannelGateway — unified inbound/outbound message recorder across all
 * channels (Discord, Telegram, iMessage, in-app chat).
 *
 * Why: each channel plugin already routes its messages through the central
 * AgentRuntime via EventType.MESSAGE_RECEIVED / MESSAGE_SENT, but there's no
 * single place that captures every cross-channel turn for inspection,
 * identity unification, or replay. The gateway hooks those events at the
 * runtime layer and emits a normalized GatewayMessage stream.
 *
 * Storage:
 *   - Ring buffer (in-memory, capped) for fast UI polling.
 *   - JSONL file at `${stateDir}/gateway/messages.jsonl` for long-term audit.
 *   - identities.json mapping `${channel}:${externalHandle}` → entityId
 *     for cross-channel identity unification.
 *
 * Identity unification (best-effort, opt-in):
 *   - Each inbound message carries a `from` (external handle) and an
 *     `entityId` (Memory.entityId). We record the mapping. When the same
 *     `${channel}:${handle}` appears with a different entityId later, that's
 *     a "merge candidate" the user can resolve in the UI.
 *
 * The gateway is purely observational — it doesn't modify routing or
 * intercept messages. Channel plugins continue to handle send/receive as
 * before; we only record.
 */

import { EventType, logger, type IAgentRuntime, type Memory, type UUID } from "@elizaos/core";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyedAsyncLock } from "../async-lock";
// Defined in the shared RPC contract (single source of truth — shared is a
// leaf); re-exported so existing bun-side consumers keep importing them here.
import type {
	GatewayChannel,
	GatewayDirection,
	GatewayMessage,
	IdentityCandidate,
} from "../../../shared/rpc/gateway";
export type { GatewayChannel, GatewayDirection, GatewayMessage, IdentityCandidate };

const RING_BUFFER_CAP = 2000;
const PERSISTED_LIST_CAP = 5000;

export interface ListOptions {
	channel?: GatewayChannel;
	direction?: GatewayDirection;
	roomId?: string;
	entityId?: string;
	q?: string;
	since?: number;
	limit?: number;
}

interface IdentityRecord {
	channel: string;
	handle: string;
	entityIds: string[];
	firstSeen: number;
	lastSeen: number;
	messageCount: number;
}

interface RelationshipShape {
	id?: string;
	sourceEntityId: string;
	targetEntityId: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
}

interface RuntimeGraphShape {
	agentId: string;
	getService?: (serviceType: string) => unknown;
	upsertEntities?: (entities: Array<{ id: string; agentId?: string; names: string[]; metadata?: Record<string, unknown> }>) => Promise<void>;
	createEntity?: (entity: { id: string; agentId?: string; names: string[]; metadata?: Record<string, unknown> }) => Promise<boolean>;
	getRelationshipsByPairs?: (pairs: Array<{ sourceEntityId: string; targetEntityId: string }>) => Promise<Array<RelationshipShape | null>>;
	createRelationships?: (rels: Array<{ sourceEntityId: string; targetEntityId: string; tags?: string[]; metadata?: Record<string, unknown> }>) => Promise<string[]>;
	updateRelationships?: (rels: RelationshipShape[]) => Promise<void>;
}

interface RelationshipsServiceShape {
	upsertIdentity?: (
		entityId: UUID,
		identity: {
			platform: string;
			handle: string;
			verified?: boolean;
			confidence: number;
			source?: string;
		},
		evidenceMessageIds?: UUID[],
	) => Promise<void>;
}

function resolveStateDir(): string {
	return (
		process.env.ELIZA_STATE_DIR?.trim() ||
		join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`)
	);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function textValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function uniqueTexts(values: unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const text = textValue(value);
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

function inferChannel(source: string | undefined, memory?: Memory): GatewayChannel {
	const candidates: string[] = [];
	if (typeof source === "string") candidates.push(source.toLowerCase());
	if (memory?.content?.source) candidates.push(String(memory.content.source).toLowerCase());
	const metadata = asRecord(memory?.metadata);
	if (typeof metadata?.source === "string") candidates.push(metadata.source.toLowerCase());
	if (typeof metadata?.provider === "string") candidates.push(metadata.provider.toLowerCase());
	const text = candidates.join("|");
	if (text.includes("discord")) return "discord";
	if (text.includes("telegram")) return "telegram";
	if (text.includes("imessage") || text.includes("messages")) return "imessage";
	if (text.includes("tray-app") || text.includes("chat") || text.includes("client_chat")) return "chat";
	if (text.includes("agentmail") || text.includes("email")) return "agentmail";
	if (text.includes("twitter") || text.includes("x_autonomy") || text.includes("tweet") || text.includes("x.com")) return "twitter";
	return "unknown";
}

function inferExternalHandle(memory: Memory | undefined, channel: GatewayChannel): string | undefined {
	if (!memory) return undefined;
	const content = asRecord(memory.content);
	const contentMeta = asRecord(content?.metadata);
	const metadata = asRecord(memory.metadata);
	const author = asRecord(contentMeta?.author);
	const sender = asRecord(metadata?.sender) ?? asRecord(contentMeta?.sender);
	const discord = asRecord(metadata?.discord) ?? asRecord(contentMeta?.discord);
	const telegram = asRecord(metadata?.telegram) ?? asRecord(contentMeta?.telegram);
	const imessage = asRecord(metadata?.imessage) ?? asRecord(contentMeta?.imessage);
	const common: unknown[] = [
		metadata?.fromId,
		metadata?.entityUserName,
		metadata?.imessageHandle,
		metadata?.discordUserId,
		metadata?.telegramUserId,
		content?.username,
		content?.handle,
		content?.userScreenName,
		contentMeta?.username,
		contentMeta?.handle,
		contentMeta?.userScreenName,
		author?.username,
		contentMeta?.from,
		sender?.id,
		sender?.username,
	];
	const channelCandidates =
		channel === "discord" ? [
			discord?.userId,
			discord?.id,
			metadata?.originalId,
			metadata?.fromId,
			discord?.username,
			...common,
		] : channel === "telegram" ? [
			metadata?.telegramUserId,
			metadata?.fromId,
			sender?.id,
			telegram?.userId,
			telegram?.id,
			metadata?.entityUserName,
			...common,
		] : channel === "imessage" ? [
			metadata?.imessageHandle,
			imessage?.userId,
			imessage?.id,
			metadata?.fromId,
			sender?.id,
			...common,
		] : channel === "twitter" ? [
			metadata?.twitterUserId,
			metadata?.twitterScreenName,
			content?.userScreenName,
			content?.screenName,
			...common,
		] : common;
	for (const c of channelCandidates) {
		const text = textValue(c);
		if (text) return text;
	}
	return undefined;
}

function inferNames(memory: Memory, fallback: string): string[] {
	const content = asRecord(memory.content);
	const contentMeta = asRecord(content?.metadata);
	const metadata = asRecord(memory.metadata);
	const sender = asRecord(metadata?.sender) ?? asRecord(contentMeta?.sender);
	const discord = asRecord(metadata?.discord) ?? asRecord(contentMeta?.discord);
	const telegram = asRecord(metadata?.telegram) ?? asRecord(contentMeta?.telegram);
	const imessage = asRecord(metadata?.imessage) ?? asRecord(contentMeta?.imessage);
	const names = uniqueTexts([
		metadata?.entityName,
		metadata?.imessageContactName,
		sender?.name,
		discord?.name,
		telegram?.name,
		imessage?.name,
		content?.name,
		content?.username,
		metadata?.entityUserName,
		sender?.username,
		discord?.username,
		telegram?.username,
		imessage?.username,
		fallback,
	]);
	return names.length > 0 ? names : [fallback];
}

function entityMetadata(entry: GatewayMessage, memory: Memory): Record<string, unknown> {
	const metadata = asRecord(memory.metadata);
	const sender = asRecord(metadata?.sender);
	const discord = asRecord(metadata?.discord);
	const telegram = asRecord(metadata?.telegram);
	const imessage = asRecord(metadata?.imessage);
	return {
		source: "channels:gateway",
		lastSeenAt: entry.time,
		lastRoomId: entry.roomId,
		handles: { [entry.channel]: entry.externalHandle },
		channels: [entry.channel],
		...(metadata?.entityAvatarUrl ? { avatarUrl: metadata.entityAvatarUrl } : {}),
		...(sender ? { sender } : {}),
		...(discord ? { discord } : {}),
		...(telegram ? { telegram } : {}),
		...(imessage ? { imessage } : {}),
	};
}

function relationshipTags(channel: GatewayChannel): string[] {
	const tags = ["channel-contact", "observed-sender"];
	if (channel !== "unknown") {
		tags.push(channel, `${channel}-user`);
	}
	return tags;
}

function mergeTags(a: string[] | undefined, b: string[]): string[] {
	return Array.from(new Set([...(a ?? []), ...b]));
}

function isGatewayMessage(value: unknown): value is GatewayMessage {
	const item = asRecord(value);
	return Boolean(
		item &&
		typeof item.id === "string" &&
		typeof item.time === "number" &&
		typeof item.direction === "string" &&
		typeof item.channel === "string" &&
		typeof item.source === "string" &&
		typeof item.roomId === "string" &&
		typeof item.entityId === "string" &&
		typeof item.text === "string",
	);
}

export class ChannelGatewayService {
	private readonly stateDir: string;
	private readonly logPath: string;
	private readonly identitiesPath: string;
	private readonly buffer: GatewayMessage[] = [];
	private identities = new Map<string, IdentityRecord>();
	private currentRuntime: IAgentRuntime | null = null;
	/** Per-pair lock for relationship upserts — replaces the ad-hoc
	 * relationship lock map. Same KeyedAsyncLock used by cron / inbox. */
	private readonly relationshipLocks = new KeyedAsyncLock();
	/** Per-handle lock so concurrent `record()` calls for the same
	 * `${channel}:${handle}` cannot lose entityIds / messageCount updates
	 * in the in-memory `identities` Map. */
	private readonly identityLocks = new KeyedAsyncLock();

	constructor() {
		this.stateDir = join(resolveStateDir(), "gateway");
		this.logPath = join(this.stateDir, "messages.jsonl");
		this.identitiesPath = join(this.stateDir, "identities.json");
		try {
			mkdirSync(this.stateDir, { recursive: true });
			this.loadIdentities();
		} catch (err) {
			logger.warn(
				{ src: "channels:gateway", err: err instanceof Error ? err.message : err },
				"failed to initialize gateway state dir",
			);
		}
	}

	/** Bind to a freshly-built runtime. Idempotent — safe to call on every rebuild. */
	attach(runtime: IAgentRuntime): void {
		if (this.currentRuntime === runtime) return;
		this.currentRuntime = runtime;
		const r = runtime as unknown as {
			registerEvent?: (event: string, handler: (params: unknown) => Promise<void>) => void;
		};
		if (typeof r.registerEvent !== "function") {
			logger.warn({ src: "channels:gateway" }, "runtime has no registerEvent — gateway disabled");
			return;
		}
		r.registerEvent(EventType.MESSAGE_RECEIVED, async (payload: unknown) => {
			await this.record("in", payload);
		});
		r.registerEvent(EventType.MESSAGE_SENT, async (payload: unknown) => {
			await this.record("out", payload);
		});
		r.registerEvent(EventType.MESSAGE_DELETED, async (payload: unknown) => {
			await this.record("deleted", payload);
		});
		r.registerEvent(EventType.INTERACTION_RECEIVED, async (payload: unknown) => {
			await this.record("interaction", payload);
		});
		logger.info({ src: "channels:gateway" }, "attached to runtime — recording inbound + outbound across channels");
	}

	private async record(direction: GatewayDirection, payload: unknown): Promise<void> {
		try {
			const parsed = this.recordPayload(direction, payload);
			if (!parsed) return;
			const { entry, message } = parsed;
			this.append(entry);
			if (entry.externalHandle && entry.entityId) {
				await this.recordIdentity(entry.channel, entry.externalHandle, entry.entityId as UUID, entry.time);
				if (direction === "in") await this.upsertObservedRelationship(entry, message);
				if (direction === "in") await this.upsertObservedIdentity(entry, message);
			}
		} catch (err) {
			logger.debug(
				{ src: "channels:gateway", err: err instanceof Error ? err.message : err },
				"record failed",
			);
		}
	}

	private recordPayload(direction: GatewayDirection, payload: unknown): { entry: GatewayMessage; message: Memory } | null {
		const p = payload as { message?: Memory; source?: string };
		const message = p.message;
		if (!message) return null;
		const channel = inferChannel(p.source, message);
		const text = typeof message.content?.text === "string" ? message.content.text : "";
		if (text.length === 0 && direction !== "deleted") return null;
		return { entry: this.gatewayEntry(direction, message, channel, p.source, text), message };
	}

	private gatewayEntry(
		direction: GatewayDirection,
		message: Memory,
		channel: GatewayChannel,
		source: string | undefined,
		text: string,
	): GatewayMessage {
		const externalHandle = inferExternalHandle(message, channel);
		// Surface the trajectory id (and step id when present) on every
		// outbound agent message. The chat hub's per-channel feed renders
		// thumbs-up/down on direction=out rows; the rating handler takes
		// a trajectoryId-style id as `traceId`, which lets feedback
		// memories cross-reference the trajectory log.
		const md = (message.metadata ?? {}) as Record<string, unknown>;
		const trajectoryId = typeof md.trajectoryId === "string" ? md.trajectoryId : undefined;
		const trajectoryStepId = typeof md.trajectoryStepId === "string" ? md.trajectoryStepId : undefined;
		const action = message.content?.action;
		const metaParts: Record<string, unknown> = {};
		if (action) metaParts.action = action;
		if (trajectoryId) metaParts.trajectoryId = trajectoryId;
		if (trajectoryStepId) metaParts.trajectoryStepId = trajectoryStepId;
		const hasMeta = Object.keys(metaParts).length > 0;
		return {
			id: typeof message.id === "string" ? message.id : `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			time: typeof message.createdAt === "number" ? message.createdAt : Date.now(),
			direction,
			channel,
			source: typeof source === "string" ? source : message.content?.source ?? "unknown",
			roomId: String(message.roomId ?? ""),
			entityId: String(message.entityId ?? ""),
			...(externalHandle ? { externalHandle } : {}),
			text,
			...(hasMeta ? { meta: metaParts } : {}),
		};
	}

	private append(entry: GatewayMessage): void {
		this.buffer.push(entry);
		if (this.buffer.length > RING_BUFFER_CAP) this.buffer.shift();
		try {
			appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch (err) {
			logger.debug({ src: "channels:gateway", err: err instanceof Error ? err.message : err }, "append failed");
		}
	}

	private loadIdentities(): void {
		if (!existsSync(this.identitiesPath)) return;
		try {
			const raw = readFileSync(this.identitiesPath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, IdentityRecord>;
			this.identities = new Map(Object.entries(parsed));
		} catch (err) {
			logger.warn({ src: "channels:gateway", err: err instanceof Error ? err.message : err }, "identities reload failed");
		}
	}

	private saveIdentities(): void {
		try {
			const obj = Object.fromEntries(this.identities.entries());
			writeFileSync(this.identitiesPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
		} catch {
			// best effort
		}
	}

	private async recordIdentity(
		channel: GatewayChannel,
		handle: string,
		entityId: UUID,
		now: number,
	): Promise<void> {
		const key = `${channel}:${handle}`;
		await this.identityLocks.run(key, async () => {
			const existing = this.identities.get(key);
			if (!existing) {
				this.identities.set(key, {
					channel,
					handle,
					entityIds: [String(entityId)],
					firstSeen: now,
					lastSeen: now,
					messageCount: 1,
				});
				this.saveIdentities();
				return;
			}
			if (!existing.entityIds.includes(String(entityId))) {
				existing.entityIds.push(String(entityId));
			}
			existing.lastSeen = now;
			existing.messageCount += 1;
			// Throttle disk writes — only persist on every Nth update.
			if (existing.messageCount % 10 === 0) this.saveIdentities();
		});
	}

	private async upsertObservedRelationship(entry: GatewayMessage, memory: Memory): Promise<void> {
		if (!entry.externalHandle || !entry.entityId) return;
		const runtime = this.currentRuntime as unknown as RuntimeGraphShape | null;
		const agentId = textValue(runtime?.agentId);
		if (!runtime || !agentId || entry.entityId === agentId) return;
		const entityId = entry.entityId;
		await this.upsertObservedEntity(runtime, agentId, entityId, entry.externalHandle, entry, memory);
		await this.withRelationshipLock(agentId, entityId, () =>
			this.upsertObservedRelationshipRecord(runtime, agentId, entityId, entry),
		);
	}

	private async upsertObservedIdentity(entry: GatewayMessage, memory: Memory): Promise<void> {
		if (!entry.externalHandle || !entry.entityId || entry.channel === "unknown") return;
		const runtime = this.currentRuntime as unknown as RuntimeGraphShape | null;
		const service = runtime?.getService?.("relationships") as RelationshipsServiceShape | undefined;
		if (typeof service?.upsertIdentity !== "function") return;
		const evidenceMessageIds =
			typeof memory.id === "string" && memory.id.length > 0 ? [memory.id as UUID] : [];
		try {
			await service.upsertIdentity(
				entry.entityId as UUID,
				{
					platform: entry.channel,
					handle: entry.externalHandle,
					verified: true,
					confidence: 0.95,
					source: "channels:gateway",
				},
				evidenceMessageIds,
			);
		} catch (err) {
			logger.debug(
				{ src: "channels:gateway", err: err instanceof Error ? err.message : err, channel: entry.channel },
				"identity upsert failed",
			);
		}
	}

	private async withRelationshipLock(agentId: string, entityId: string, fn: () => Promise<void>): Promise<void> {
		await this.relationshipLocks.run(`${agentId}:${entityId}`, fn);
	}

	private async upsertObservedEntity(
		runtime: RuntimeGraphShape,
		agentId: string,
		entityId: string,
		externalHandle: string,
		entry: GatewayMessage,
		memory: Memory,
	): Promise<void> {
		try {
			const entity = {
					id: entityId,
					agentId,
					names: inferNames(memory, externalHandle),
				metadata: entityMetadata(entry, memory),
			};
			if (typeof runtime.upsertEntities === "function") {
				await runtime.upsertEntities([entity]);
			} else if (typeof runtime.createEntity === "function") {
				await runtime.createEntity(entity);
			}
		} catch (err) {
			logger.debug(
				{ src: "channels:gateway", err: err instanceof Error ? err.message : err, channel: entry.channel },
				"entity upsert failed",
			);
		}
	}

	private async upsertObservedRelationshipRecord(
		runtime: RuntimeGraphShape,
		agentId: string,
		entityId: string,
		entry: GatewayMessage,
	): Promise<void> {
		try {
			const pair = { sourceEntityId: agentId, targetEntityId: entityId };
			const existing = typeof runtime.getRelationshipsByPairs === "function"
				? (await runtime.getRelationshipsByPairs([pair]))[0] ?? null
				: null;
			const metadata = {
				source: "channels:gateway",
				channel: entry.channel,
				externalHandle: entry.externalHandle,
				lastSeenAt: entry.time,
				lastRoomId: entry.roomId,
			};
			const tags = relationshipTags(entry.channel);
			if (existing) {
				if (typeof runtime.updateRelationships !== "function") return;
				const currentMetadata = asRecord(existing.metadata) ?? {};
				const currentCount =
					typeof currentMetadata.messageCount === "number"
						? currentMetadata.messageCount
						: 0;
				await runtime.updateRelationships([{
					...existing,
					tags: mergeTags(existing.tags, tags),
					metadata: {
						...currentMetadata,
						...metadata,
						firstSeenAt: currentMetadata.firstSeenAt ?? entry.time,
						messageCount: currentCount + 1,
					},
				}]);
				return;
			}
			if (typeof runtime.createRelationships === "function") {
				await runtime.createRelationships([{
					...pair,
					tags,
					metadata: {
						...metadata,
						firstSeenAt: entry.time,
						messageCount: 1,
					},
				}]);
			}
		} catch (err) {
			logger.debug(
				{ src: "channels:gateway", err: err instanceof Error ? err.message : err, channel: entry.channel },
				"relationship upsert failed",
			);
		}
	}

	list(opts: ListOptions = {}): { messages: GatewayMessage[]; total: number } {
		const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));
		const since = opts.since ?? 0;
		const byId = new Map<string, GatewayMessage>();
		for (const entry of this.readPersistedEntries()) byId.set(entry.id, entry);
		for (const entry of this.buffer) byId.set(entry.id, entry);
		const entries = [...byId.values()].sort((a, b) => a.time - b.time);
		const filtered = entries.filter((m) => {
			if (m.time < since) return false;
			if (opts.channel && m.channel !== opts.channel) return false;
			if (opts.direction && m.direction !== opts.direction) return false;
			if (opts.roomId && m.roomId !== opts.roomId) return false;
			if (opts.entityId && m.entityId !== opts.entityId) return false;
			if (opts.q && !m.text.toLowerCase().includes(opts.q.toLowerCase())) return false;
			return true;
		});
		const sliced = filtered.slice(-limit);
		return { messages: sliced, total: filtered.length };
	}

	private readPersistedEntries(): GatewayMessage[] {
		if (!existsSync(this.logPath)) return [];
		try {
			const lines = readFileSync(this.logPath, "utf8").trim().split("\n").slice(-PERSISTED_LIST_CAP);
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
		} catch (err) {
			logger.debug({ src: "channels:gateway", err: err instanceof Error ? err.message : err }, "persisted list read failed");
			return [];
		}
	}

	identityCandidates(): IdentityCandidate[] {
		const out: IdentityCandidate[] = [];
		for (const [key, rec] of this.identities.entries()) {
			if (rec.entityIds.length < 2) continue; // only emit when we've seen >1 entity for the same handle
			out.push({
				key,
				channel: rec.channel as GatewayChannel,
				externalHandle: rec.handle,
				entityIds: rec.entityIds,
				firstSeen: rec.firstSeen,
				lastSeen: rec.lastSeen,
				messageCount: rec.messageCount,
			});
		}
		out.sort((a, b) => b.lastSeen - a.lastSeen);
		return out;
	}

	allIdentities(): IdentityCandidate[] {
		const out: IdentityCandidate[] = [];
		for (const [key, rec] of this.identities.entries()) {
			out.push({
				key,
				channel: rec.channel as GatewayChannel,
				externalHandle: rec.handle,
				entityIds: rec.entityIds,
				firstSeen: rec.firstSeen,
				lastSeen: rec.lastSeen,
				messageCount: rec.messageCount,
			});
		}
		out.sort((a, b) => b.lastSeen - a.lastSeen);
		return out;
	}

	/**
	 * Record an outbound reply that bypasses the runtime's MESSAGE_SENT event
	 * — currently used for in-app chat replies, where the agent streams its
	 * response back through the WebSocket callback without going through a
	 * Discord/Telegram-style send action that would normally emit the event.
	 */
	recordChatReply(opts: {
		text: string;
		roomId: string;
		entityId: string;
		channel?: GatewayChannel;
		source?: string;
	}): void {
		if (!opts.text || opts.text.length === 0) return;
		const entry: GatewayMessage = {
			id: `gw-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			time: Date.now(),
			direction: "out",
			channel: opts.channel ?? "chat",
			source: opts.source ?? "tray-app",
			roomId: opts.roomId,
			entityId: opts.entityId,
			text: opts.text,
		};
		this.append(entry);
	}

	flush(): void {
		this.saveIdentities();
	}
}
