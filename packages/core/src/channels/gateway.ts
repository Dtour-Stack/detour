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

const RING_BUFFER_CAP = 2000;

export type GatewayDirection = "in" | "out" | "deleted" | "interaction";
export type GatewayChannel = "discord" | "telegram" | "imessage" | "chat" | "unknown";

export interface GatewayMessage {
	readonly id: string;
	readonly time: number;
	readonly direction: GatewayDirection;
	readonly channel: GatewayChannel;
	readonly source: string;
	readonly roomId: string;
	readonly entityId: string;
	readonly externalHandle?: string;
	readonly text: string;
	readonly meta?: Record<string, unknown>;
}

export interface ListOptions {
	channel?: GatewayChannel;
	direction?: GatewayDirection;
	roomId?: string;
	entityId?: string;
	q?: string;
	since?: number;
	limit?: number;
}

export interface IdentityCandidate {
	readonly key: string;
	readonly channel: GatewayChannel;
	readonly externalHandle: string;
	readonly entityIds: string[];
	readonly firstSeen: number;
	readonly lastSeen: number;
	readonly messageCount: number;
}

interface IdentityRecord {
	channel: string;
	handle: string;
	entityIds: string[];
	firstSeen: number;
	lastSeen: number;
	messageCount: number;
}

function resolveStateDir(): string {
	return (
		process.env.ELIZA_STATE_DIR?.trim() ||
		join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`)
	);
}

function inferChannel(source: string | undefined, memory?: Memory): GatewayChannel {
	const candidates: string[] = [];
	if (typeof source === "string") candidates.push(source.toLowerCase());
	if (memory?.content?.source) candidates.push(String(memory.content.source).toLowerCase());
	const text = candidates.join("|");
	if (text.includes("discord")) return "discord";
	if (text.includes("telegram")) return "telegram";
	if (text.includes("imessage") || text.includes("messages")) return "imessage";
	if (text.includes("tray-app") || text.includes("chat") || text.includes("client_chat")) return "chat";
	return "unknown";
}

function inferExternalHandle(memory: Memory | undefined): string | undefined {
	if (!memory) return undefined;
	const content = memory.content as Record<string, unknown> | undefined;
	if (!content) return undefined;
	const fromMeta = content.metadata as Record<string, unknown> | undefined;
	const author = (fromMeta?.author as Record<string, unknown> | undefined);
	const candidates: unknown[] = [
		content.username,
		content.handle,
		content.userScreenName,
		fromMeta?.username,
		fromMeta?.handle,
		fromMeta?.userScreenName,
		author?.username,
		fromMeta?.from,
	];
	for (const c of candidates) {
		if (typeof c === "string" && c.length > 0) return c;
	}
	return undefined;
}

export class ChannelGatewayService {
	private readonly stateDir: string;
	private readonly logPath: string;
	private readonly identitiesPath: string;
	private readonly buffer: GatewayMessage[] = [];
	private identities = new Map<string, IdentityRecord>();
	private currentRuntime: IAgentRuntime | null = null;

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
			this.record("in", payload);
		});
		r.registerEvent(EventType.MESSAGE_SENT, async (payload: unknown) => {
			this.record("out", payload);
		});
		r.registerEvent(EventType.MESSAGE_DELETED, async (payload: unknown) => {
			this.record("deleted", payload);
		});
		r.registerEvent(EventType.INTERACTION_RECEIVED, async (payload: unknown) => {
			this.record("interaction", payload);
		});
		logger.info({ src: "channels:gateway" }, "attached to runtime — recording inbound + outbound across channels");
	}

	private record(direction: GatewayDirection, payload: unknown): void {
		try {
			const p = payload as { message?: Memory; source?: string; runtime?: IAgentRuntime };
			const message = p.message;
			if (!message) return;
			const channel = inferChannel(p.source, message);
			const text = typeof message.content?.text === "string" ? message.content.text : "";
			if (text.length === 0 && direction !== "deleted") return; // skip noisy non-text events
			const externalHandle = inferExternalHandle(message);
			const entry: GatewayMessage = {
				id: typeof message.id === "string" ? message.id : `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				time: typeof message.createdAt === "number" ? message.createdAt : Date.now(),
				direction,
				channel,
				source: typeof p.source === "string" ? p.source : message.content?.source ?? "unknown",
				roomId: String(message.roomId ?? ""),
				entityId: String(message.entityId ?? ""),
				...(externalHandle ? { externalHandle } : {}),
				text,
				...(message.content?.action ? { meta: { action: message.content.action } } : {}),
			};
			this.append(entry);
			if (externalHandle && entry.entityId) {
				this.recordIdentity(channel, externalHandle, entry.entityId as UUID, entry.time);
			}
		} catch (err) {
			logger.debug(
				{ src: "channels:gateway", err: err instanceof Error ? err.message : err },
				"record failed",
			);
		}
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

	private recordIdentity(
		channel: GatewayChannel,
		handle: string,
		entityId: UUID,
		now: number,
	): void {
		const key = `${channel}:${handle}`;
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
		} else {
			if (!existing.entityIds.includes(String(entityId))) {
				existing.entityIds.push(String(entityId));
			}
			existing.lastSeen = now;
			existing.messageCount += 1;
		}
		// Throttle disk writes — only persist on every Nth update or after 30s.
		if ((existing?.messageCount ?? 1) % 10 === 0) this.saveIdentities();
	}

	list(opts: ListOptions = {}): { messages: GatewayMessage[]; total: number } {
		const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));
		const since = opts.since ?? 0;
		const filtered = this.buffer.filter((m) => {
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
