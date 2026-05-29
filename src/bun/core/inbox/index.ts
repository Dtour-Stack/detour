/**
 * InboxService — a unified surface for incoming notifications, mentions,
 * and other actionable signals across the agent's surfaces.
 *
 * Why: the ChannelGateway records every channel message but doesn't
 * distinguish "you should look at this" from background chatter. The inbox
 * promotes important items to the user's attention AND optionally fires
 * elizaOS's `INTERACTION_RECEIVED` event so the agent reacts to them
 * through its existing pipeline (no parallel reasoning loop).
 *
 * Storage: every inbox item is also created as an eliza Memory tagged
 * `inbox`, so it shows up in Pensieve search/feed for free. The Memory's
 * metadata carries inbox-specific fields (kind, status, sourceId).
 *
 * "Promotion" rules (initial — extend as we learn):
 *   1. Any inbound MESSAGE_RECEIVED on Discord/Telegram/iMessage where the
 *      sender is NOT the agent is auto-promoted as kind="message".
 *   2. Cross-channel identity-merge candidates (same handle → multiple
 *      entityIds) become kind="identity-conflict" so the user can resolve.
 *   3. Programmatic posts via `POST /api/inbox` (kind="notification").
 *
 * Agent prompting: items with `prompt: true` (default for `kind="message"`
 * and explicit notification posts) emit `INTERACTION_RECEIVED` so the
 * agent's regular processing pipeline picks them up.
 */

import { EventType, type IAgentRuntime, type Memory, logger, stringToUuid } from "@elizaos/core";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelGatewayService, GatewayMessage } from "../channels/gateway";
import type { RuntimeService } from "../runtime";
import { getTraceId, newTraceId, traceScope } from "../trace";
import { KeyedAsyncLock } from "../async-lock";
import { broadcaster } from "../rpc/registry";

const RING_CAP = 1000;
const INBOX_TAG = "inbox";

// Defined in the shared RPC contract (single source of truth — shared is a
// leaf); re-exported so existing bun-side consumers keep importing them here.
import type { InboxItem, InboxKind, InboxStatus } from "../../../shared/rpc/inbox";
export type { InboxItem, InboxKind, InboxStatus };

export interface PostOptions {
	kind: InboxKind;
	title: string;
	body: string;
	source?: string;
	channel?: string;
	fromHandle?: string;
	entityId?: string;
	meta?: Record<string, unknown>;
	/** True (default for messages/notifications) → fire INTERACTION_RECEIVED. */
	prompt?: boolean;
	/**
	 * If true, before creating a new item, look for an existing item with
	 * the same `source` whose effective status is still `pending` or
	 * `acting`. If found:
	 *   - `acting`: skip the post entirely — the previous fire is still
	 *     in flight, no point stacking another.
	 *   - `pending`: reuse it. Refresh `time` and `body`, flip status
	 *     back to `acting`, and re-fire the agent prompt (this is the
	 *     natural retry on the next tick of whatever scheduler called us).
	 *   - terminal (`acted`/`acknowledged`/`dismissed`): fall through and
	 *     create a brand-new item.
	 *
	 * Purpose: stops periodic posters (cron jobs in particular) from
	 * stacking dozens of identical pending items when the agent can't
	 * service them quickly (model 429, network blip, downstream failure).
	 * Without dedup we observed a single 5-minute cron spawn 200+ pending
	 * inbox rows that all said the same thing.
	 */
	dedupeBySource?: boolean;
}

export interface ListOptions {
	status?: InboxStatus;
	kind?: InboxKind;
	source?: string;
	channel?: string;
	since?: number;
	limit?: number;
}

type InboxStatusUpdateLogEntry = {
	id: string;
	statusUpdate: InboxStatus;
	time: number;
};

type InboxReplyLogEntry = {
	id: string;
	replyText: string;
	time: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInboxStatus(value: unknown): value is InboxStatus {
	return value === "pending" || value === "acting" || value === "acknowledged" || value === "acted" || value === "dismissed";
}

function isInboxKind(value: unknown): value is InboxKind {
	return value === "message" || value === "notification" || value === "identity-conflict" || value === "task" || value === "event";
}

function isInboxItemLogEntry(value: unknown): value is InboxItem {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.time === "number" &&
		isInboxKind(value.kind) &&
		isInboxStatus(value.status) &&
		typeof value.title === "string" &&
		typeof value.body === "string" &&
		typeof value.source === "string"
	);
}

function isInboxStatusUpdateLogEntry(value: unknown): value is InboxStatusUpdateLogEntry {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.time === "number" &&
		isInboxStatus(value.statusUpdate)
	);
}

function isInboxReplyLogEntry(value: unknown): value is InboxReplyLogEntry {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.time === "number" &&
		typeof value.replyText === "string"
	);
}

function resolveStateDir(): string {
	return (
		process.env.ELIZA_STATE_DIR?.trim() ||
		join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`)
	);
}

export class InboxService {
	private readonly logPath: string;
	private readonly buffer: InboxItem[] = [];
	private readonly statusOverrides = new Map<string, InboxStatus>();
	private readonly replyTexts = new Map<string, string>();
	/** Callbacks fired when an item gets replyText — channels use this
	 * to route replies back to the originating platform (e.g. AgentMail
	 * sends the reply back as an email thread response). */
	private readonly replyCallbacks: Array<(id: string, replyText: string, item: InboxItem) => void> = [];
	/** Per-inbox-item lock — prevents concurrent `act(id)` calls from
	 * flipping status "pending → acting → pending" out of order, and
	 * keeps the JSONL audit trail in causal order per item. */
	private readonly itemLocks = new KeyedAsyncLock();

	constructor(
		private readonly runtimeService: RuntimeService,
		private readonly gateway: ChannelGatewayService,
	) {
		const stateDir = join(resolveStateDir(), "inbox");
		this.logPath = join(stateDir, "items.jsonl");
		try {
			mkdirSync(stateDir, { recursive: true });
			this.loadHistory();
		} catch (err) {
			logger.warn(
				{ src: "inbox", err: err instanceof Error ? err.message : err },
				"failed to initialize inbox state dir",
			);
		}
	}

	private loadHistory(): void {
		if (!existsSync(this.logPath)) return;
		try {
			const raw = readFileSync(this.logPath, "utf8");
			const lines = raw.split("\n").filter((l) => l.trim().length > 0);
			const items = new Map<string, InboxItem>();
			for (const line of lines.slice(-RING_CAP)) {
				try {
					const entry = JSON.parse(line) as unknown;
					if (isInboxStatusUpdateLogEntry(entry)) {
						this.statusOverrides.set(entry.id, entry.statusUpdate);
						continue;
					}
					if (isInboxReplyLogEntry(entry)) {
						this.replyTexts.set(entry.id, entry.replyText);
						continue;
					}
					if (isInboxItemLogEntry(entry)) {
						items.delete(entry.id);
						items.set(entry.id, entry);
					}
				} catch {
					// skip malformed
				}
			}
			this.buffer.push(...items.values());
		} catch (err) {
			logger.warn({ src: "inbox", err: err instanceof Error ? err.message : err }, "history reload failed");
		}
	}

	/** Subscribe to gateway events so inbound channel messages auto-promote. */
	bindToGateway(): void {
		// Wrap the gateway's record path. We don't want to monkey-patch the
		// gateway, so instead we subscribe to the runtime event directly via
		// onAfterBuild and re-promote there. The gateway already records first.
		this.runtimeService.onAfterBuild((state) => {
			this.attachToRuntime(state.runtime);
		});
	}

	private attachToRuntime(runtime: IAgentRuntime): void {
		const r = runtime as unknown as {
			registerEvent?: (event: string, handler: (params: unknown) => Promise<void>) => void;
			agentId?: string;
		};
		if (typeof r.registerEvent !== "function") return;
		r.registerEvent(EventType.MESSAGE_RECEIVED, async (payload: unknown) => {
			try {
				const p = payload as { message?: Memory; source?: string };
				const message = p.message;
				if (!message) return;
				// Skip messages from the agent itself (shouldn't appear as
				// inbox items — they're outbound).
				if (message.entityId === r.agentId) return;
				const text = typeof message.content?.text === "string" ? message.content.text : "";
				if (text.length === 0) return;
				const source = String(p.source ?? message.content?.source ?? "unknown");
				// Skip messages that ORIGINATE from the inbox itself — those
				// are the agent-prompts we just emitted and re-promoting them
				// would loop forever (inbox post → emit MESSAGE_RECEIVED → this
				// handler → inbox post → ...).
				if (source.startsWith("inbox:")) return;
				// In-app chat already prompts the agent natively; recording it
				// in the inbox would just create noise. Promote only true
				// out-of-band channels.
				const inAppChat = source === "tray-app" || source === "client_chat";
				if (inAppChat) return;
				await this.post({
					kind: "message",
					title: text.slice(0, 80),
					body: text,
					source,
					channel: this.inferChannelFromSource(source),
					...(message.entityId ? { entityId: String(message.entityId) } : {}),
					meta: { messageId: String(message.id ?? ""), roomId: String(message.roomId ?? "") },
					// Don't re-prompt — eliza's MESSAGE_RECEIVED handler already
					// drives the agent. Inbox is observation only for messages.
					prompt: false,
				});
			} catch (err) {
				logger.debug({ src: "inbox", err: err instanceof Error ? err.message : err }, "promote-from-message failed");
			}
		});
		// Identity conflicts: poll the gateway every minute for new merge
		// candidates (cheap — the gateway keeps the map in memory). Anything
		// new since last poll becomes an inbox item.
		const seenConflicts = new Set<string>();
		const pollIdentities = (): void => {
			try {
				const candidates = this.gateway.identityCandidates();
				for (const c of candidates) {
					if (seenConflicts.has(c.key)) continue;
					seenConflicts.add(c.key);
					void this.post({
						kind: "identity-conflict",
						title: `Identity merge: ${c.externalHandle} on ${c.channel}`,
						body: `The handle "${c.externalHandle}" on ${c.channel} maps to ${c.entityIds.length} different entities. Decide whether to merge them.`,
						source: "gateway:identity",
						channel: c.channel,
						fromHandle: c.externalHandle,
						meta: { entityIds: c.entityIds, messageCount: c.messageCount },
						prompt: false,
					});
				}
			} catch (err) {
				logger.debug({ src: "inbox", err: err instanceof Error ? err.message : err }, "poll-identities failed");
			}
		};
		const handle = setInterval(pollIdentities, 60_000);
		(handle as unknown as { unref?: () => void }).unref?.();
		pollIdentities(); // run once now
	}

	private inferChannelFromSource(source: string): string {
		const s = source.toLowerCase();
		if (s.includes("discord")) return "discord";
		if (s.includes("telegram")) return "telegram";
		if (s.includes("imessage") || s.includes("messages")) return "imessage";
		if (s.includes("agentmail") || s.includes("email")) return "agentmail";
		return "unknown";
	}

	async post(opts: PostOptions): Promise<InboxItem> {
		// Source-based dedup. See PostOptions.dedupeBySource for full
		// rationale; in short, this is what stops cron from spamming the
		// inbox with identical pending items every tick when the agent is
		// failing or slow. We serialize the lookup-and-mutate under the
		// item lock so two concurrent posters can't both miss each other
		// and create the duplicate we're trying to avoid.
		if (opts.dedupeBySource && opts.source) {
			const sourceKey = opts.source;
			return this.itemLocks.run(sourceKey, async () => {
				const existing = this.findLatestActiveBySource(sourceKey);
				if (!existing) return this.createNewItem(opts);
				const status = this.statusOverrides.get(existing.id) ?? existing.status;

				// `acting` means the previous fire is still running. Don't
				// disturb it — skip this post entirely. The in-flight call
				// will eventually settle to `acted` or `pending` and a later
				// tick can handle the next refresh.
				if (status === "acting") {
					logger.debug(
						{ src: "inbox", id: existing.id, source: sourceKey },
						"inbox dedup: existing item still acting — skipping new post",
					);
					return this.withRuntimeState(existing);
				}

				// `pending` means either (a) the previous attempt failed or
				// (b) we never tried to prompt. Refresh body/title/time on
				// the existing row, and if the caller wants a prompt fired,
				// flip the row to `acting` and fire it — same shape as the
				// new-item path but reusing the row.
				if (status === "pending") {
					const refreshed: InboxItem = {
						...existing,
						time: Date.now(),
						title: opts.title,
						body: opts.body,
						prompted: false,
					};
					const idx = this.buffer.findIndex((i) => i.id === existing.id);
					if (idx >= 0) this.buffer[idx] = refreshed;
					// In-memory entry already replaced; only persist the
					// updated row so it survives restart. NOT `append()` —
					// that would double-list the item in the buffer.
					this.persistLogEntry(refreshed);
					logger.debug(
						{ src: "inbox", id: refreshed.id, source: sourceKey },
						"inbox dedup: refreshed pending item in place of duplicate post",
					);
					const shouldPrompt = opts.prompt ?? (refreshed.kind === "notification" || refreshed.kind === "task");
					if (shouldPrompt) {
						this.setStatus(refreshed.id, "acting");
						const inheritedTrace = getTraceId() ?? newTraceId();
						await traceScope(inheritedTrace, () =>
							this.promptAgent(refreshed).catch((err) => {
								logger.debug(
									{ src: "inbox", err: err instanceof Error ? err.message : err },
									"agent prompt failed on dedup-refresh",
								);
							}),
						);
					}
					return this.withRuntimeState(refreshed);
				}

				// Terminal (`acted`/`acknowledged`/`dismissed`) — that work
				// is done. A fresh tick from the same source is a fresh job
				// and gets a fresh row.
				return this.createNewItem(opts);
			});
		}

		return this.createNewItem(opts);
	}

	/**
	 * Find the most recently-posted item with this source whose effective
	 * status is still active (pending or acting). Walks the buffer back-
	 * to-front so we don't have to scan everything for the common case.
	 */
	private findLatestActiveBySource(source: string): InboxItem | null {
		for (let i = this.buffer.length - 1; i >= 0; i -= 1) {
			const candidate = this.buffer[i];
			if (!candidate) continue;
			if (candidate.source !== source) continue;
			const effective = this.statusOverrides.get(candidate.id) ?? candidate.status;
			if (effective === "pending" || effective === "acting") return candidate;
		}
		return null;
	}

	private async createNewItem(opts: PostOptions): Promise<InboxItem> {
		const id = `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const item: InboxItem = {
			id,
			time: Date.now(),
			kind: opts.kind,
			status: "pending",
			title: opts.title,
			body: opts.body,
			source: opts.source ?? "manual",
			...(opts.channel ? { channel: opts.channel } : {}),
			...(opts.fromHandle ? { fromHandle: opts.fromHandle } : {}),
			...(opts.entityId ? { entityId: opts.entityId } : {}),
			prompted: false,
			...(opts.meta ? { meta: opts.meta } : {}),
		};
		this.append(item);

		// Surface the new item to subscribers — the pet bubble feed listens
		// for `inboxItemCreated` and announces "📨 @sender · channel:
		// preview…". The payload is minimal on purpose: pet UI doesn't need
		// the full body. Send it fire-and-forget so a slow subscriber can't
		// block inbox persistence.
		try {
			broadcaster.broadcast("inboxItemCreated", {
				id: item.id,
				kind: item.kind,
				channel: item.channel ?? null,
				source: item.source,
				fromHandle: item.fromHandle ?? null,
				title: item.title,
				body: item.body.length > 200 ? `${item.body.slice(0, 200)}…` : item.body,
				time: item.time,
			});
		} catch (err) {
			logger.debug({ src: "inbox", err: err instanceof Error ? err.message : err }, "broadcast inboxItemCreated failed");
		}

		// Persist to eliza Memory so Pensieve can index/search it. Best-effort
		// — failure here doesn't block the inbox itself.
		await this.persistAsMemory(item).catch((err) => {
			logger.debug({ src: "inbox", err: err instanceof Error ? err.message : err }, "memory persist failed");
		});

		const shouldPrompt = opts.prompt ?? (opts.kind === "notification" || opts.kind === "task");
		if (shouldPrompt) {
			this.setStatus(item.id, "acting");
			// Open a trace scope so every log line and downstream message
			// service call carries the same trace id — critical for stitching
			// the whole inbox-driven turn (cron fire → reply pipeline → action
			// execution) under one searchable id.
			const inheritedTrace = getTraceId() ?? newTraceId();
			await traceScope(inheritedTrace, () =>
				this.promptAgent(item).catch((err) => {
					logger.debug({ src: "inbox", err: err instanceof Error ? err.message : err }, "agent prompt failed");
				}),
			);
		}
		return item;
	}

	private append(item: InboxItem): void {
		this.buffer.push(item);
		if (this.buffer.length > RING_CAP) this.buffer.shift();
		this.persistLogEntry(item);
	}

	/**
	 * Append a JSONL entry to the on-disk log WITHOUT touching the in-
	 * memory buffer. Used by the dedup-refresh path, which has already
	 * mutated the existing buffer entry in place and only needs to make
	 * the change durable for crash recovery (loadHistory replays the log
	 * latest-wins per id).
	 */
	private persistLogEntry(entry: unknown): void {
		try {
			appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch (err) {
			logger.debug({ src: "inbox", err: err instanceof Error ? err.message : err }, "append failed");
		}
	}

	private async persistAsMemory(item: InboxItem): Promise<void> {
		const live = this.runtimeService.peek();
		if (!live) return;
		const r = live as unknown as {
			agentId?: string;
			createMemory?: (memory: Memory, tableName: string) => Promise<unknown>;
		};
		if (typeof r.createMemory !== "function") return;
		const memory: Memory = {
			id: stringToUuid(`inbox:${item.id}`),
			entityId: stringToUuid(item.entityId ?? r.agentId ?? "inbox-system"),
			agentId: r.agentId as Memory["agentId"],
			roomId: stringToUuid(`inbox:room:${item.kind}`),
			content: {
				text: `[${item.kind}] ${item.title}\n\n${item.body}`,
				source: `inbox:${item.source}`,
				attachments: [],
			},
			createdAt: item.time,
			metadata: {
				type: "custom",
				inboxId: item.id,
				inboxKind: item.kind,
				inboxStatus: item.status,
				inboxChannel: item.channel,
				tags: [INBOX_TAG, `inbox:${item.kind}`, ...(item.channel ? [`channel:${item.channel}`] : [])],
			} as unknown as Memory["metadata"],
		};
		await r.createMemory(memory, "memories");
	}

	private promptText(item: InboxItem): string {
		const tierHint = item.meta?.modelTier;
		return [
			"Inbox item needs action.",
			`Kind: ${item.kind}`,
			`Source: ${item.source}`,
			item.channel ? `Channel: ${item.channel}` : "",
			item.fromHandle ? `From: ${item.fromHandle}` : "",
			item.meta?.roomId ? `Room: ${String(item.meta.roomId)}` : "",
			tierHint ? `Model tier: ${String(tierHint)}` : "",
			"",
			`Title: ${item.title}`,
			item.body ? `Message:\n${item.body}` : "",
			"",
			"Decide whether to act. If a channel reply is appropriate, use the available message connector action for the relevant channel/contact. Then summarize what you did.",
		].filter((line) => line.length > 0).join("\n");
	}

	private async promptAgent(item: InboxItem): Promise<void> {
		const live = this.runtimeService.peek();
		if (!live) return;
		const r = live as unknown as {
			agentId?: string;
			messageService?: {
				handleMessage: (
					runtime: IAgentRuntime,
					message: Memory,
					callback?: (content: { text?: string } | null) => Promise<unknown[]>,
				) => Promise<unknown>;
			};
			ensureConnection?: (opts: {
				entityId: string;
				roomId: string;
				worldId?: string;
				userName?: string;
				source?: string;
				channelId?: string;
				type?: string;
			}) => Promise<void>;
		};
		if (!r.messageService?.handleMessage) {
			logger.debug({ src: "inbox" }, "messageService not ready — skipping agent prompt");
			return;
		}
		// Use a stable system entity so the agent doesn't read its own id as
		// the sender (which would trigger IGNORE in shouldRespond).
		const systemEntityId = stringToUuid(`inbox:system:${item.kind}`);
		const roomId = stringToUuid(`inbox:room:${item.kind}`);
		const worldId = stringToUuid("inbox:world");
		if (typeof r.ensureConnection === "function") {
			try {
				await r.ensureConnection({
					entityId: systemEntityId,
					roomId,
					worldId,
					userName: "Inbox",
					source: `inbox:${item.source}`,
					channelId: `inbox:${item.kind}`,
					type: "DM",
				});
			} catch {
				// best effort
			}
		}
		const memory: Memory = {
			id: stringToUuid(`inbox-evt:${item.id}`),
			entityId: systemEntityId,
			agentId: r.agentId as Memory["agentId"],
			roomId,
			content: {
				text: this.promptText(item),
				source: `inbox:${item.source}`,
				attachments: [],
			},
			createdAt: item.time,
			// Pass inbox meta (including modelTier) through so downstream
			// model-routing middleware or action guards can read it.
			metadata: item.meta ? { ...item.meta } as unknown as Memory["metadata"] : undefined,
		};
		// Fire-and-forget: handleMessage can take 20-30s for an LLM round-trip,
		// and we don't want POST /api/inbox to block on it. eliza's REPLY action
		// invokes our callback with the reply content (not MESSAGE_SENT for an
		// in-process pipeline), so we capture it here and route it into the
		// gateway feed + update the inbox item's status to acted + replyText.
		let replyText = "";
		void r.messageService.handleMessage(live, memory, async (content) => {
			const text = typeof content?.text === "string" ? content.text : "";
			if (text && text !== replyText) {
				replyText = text;
				try {
					this.gateway.recordChatReply({
						text,
						roomId: String(roomId),
						entityId: String(r.agentId ?? ""),
						channel: "chat",
						source: `inbox:${item.source}`,
					});
				} catch {
					// non-fatal
				}
			}
			return [];
		}).then(() => {
			if (replyText.length > 0) {
				this.setReply(item.id, replyText);
			}
			if ((this.statusOverrides.get(item.id) ?? item.status) !== "dismissed") {
				this.updateStatus(item.id, "acted");
			}
		}).catch((err) => {
			if ((this.statusOverrides.get(item.id) ?? item.status) !== "dismissed") {
				this.updateStatus(item.id, "pending");
			}
			logger.warn(
				{ src: "inbox", err: err instanceof Error ? err.message : err },
				"agent processing of inbox item failed",
			);
		});
		(item as unknown as { prompted: boolean }).prompted = true;
	}

	/**
	 * Register a callback fired whenever an inbox item receives a reply
	 * from the agent. Used by channel services (AgentMail, etc.) to route
	 * the agent's reply back to the originating platform.
	 */
	onReply(cb: (id: string, replyText: string, item: InboxItem) => void): void {
		this.replyCallbacks.push(cb);
	}

	getReply(id: string): string | undefined {
		return this.replyTexts.get(id);
	}

	private withRuntimeState(item: InboxItem): InboxItem {
		const status = this.statusOverrides.get(item.id) ?? item.status;
		const replyText = this.replyTexts.get(item.id);
		return {
			...item,
			status,
			...(replyText ? { replyText } : {}),
		};
	}

	list(opts: ListOptions = {}): { items: InboxItem[]; total: number } {
		const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
		const since = opts.since ?? 0;
		const filtered = this.buffer
			.map((m) => this.withRuntimeState(m))
			.filter((m) => {
				if (m.time < since) return false;
				if (opts.status && m.status !== opts.status) return false;
				if (opts.kind && m.kind !== opts.kind) return false;
				if (opts.source && m.source !== opts.source) return false;
				if (opts.channel && m.channel !== opts.channel) return false;
				return true;
			});
		const sliced = filtered.slice(-limit).reverse();
		return { items: sliced, total: filtered.length };
	}

	private setStatus(id: string, status: InboxStatus): void {
		this.statusOverrides.set(id, status);
		try {
			appendFileSync(
				this.logPath,
				`${JSON.stringify({ id, statusUpdate: status, time: Date.now() })}\n`,
				{ mode: 0o600 },
			);
		} catch {
		}
	}

	private setReply(id: string, replyText: string): void {
		this.replyTexts.set(id, replyText);
		try {
			appendFileSync(
				this.logPath,
				`${JSON.stringify({ id, replyText, time: Date.now() })}\n`,
				{ mode: 0o600 },
			);
		} catch {
		}
		// Fire reply callbacks so external channels can route the reply
		// back to the originating platform.
		const item = this.buffer.find((i) => i.id === id);
		if (item) {
			for (const cb of this.replyCallbacks) {
				try {
					cb(id, replyText, this.withRuntimeState(item));
				} catch (err) {
					logger.debug(
						{ src: "inbox", err: err instanceof Error ? err.message : err },
						"reply callback failed",
					);
				}
			}
		}
	}

	updateStatus(id: string, status: InboxStatus): InboxItem | null {
		const item = this.buffer.find((i) => i.id === id);
		if (!item) return null;
		this.setStatus(id, status);
		return this.withRuntimeState(item);
	}

	async act(id: string): Promise<InboxItem | null> {
		return this.itemLocks.run(id, async () => {
			const item = this.buffer.find((i) => i.id === id);
			if (!item) return null;
			const current = this.statusOverrides.get(id) ?? item.status;
			if (current === "acting" || current === "acted" || current === "dismissed") return this.withRuntimeState(item);
			this.setStatus(id, "acting");
			const inheritedTrace = getTraceId() ?? newTraceId();
			await traceScope(inheritedTrace, () =>
				this.promptAgent(item).catch((err) => {
					this.updateStatus(id, "pending");
					logger.warn(
						{ src: "inbox", err: err instanceof Error ? err.message : err },
						"agent action of inbox item failed",
					);
				}),
			);
			return this.withRuntimeState(item);
		});
	}

	stats(): { total: number; pending: number; byKind: Record<string, number> } {
		const byKind: Record<string, number> = {};
		let pending = 0;
		for (const m of this.buffer) {
			const status = this.statusOverrides.get(m.id) ?? m.status;
			if (status === "pending") pending += 1;
			byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
		}
		return { total: this.buffer.length, pending, byKind };
	}
}
