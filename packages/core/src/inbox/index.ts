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

const RING_CAP = 1000;
const INBOX_TAG = "inbox";

export type InboxKind = "message" | "notification" | "identity-conflict" | "task" | "event";
export type InboxStatus = "pending" | "acknowledged" | "acted" | "dismissed";

export interface InboxItem {
	readonly id: string;
	readonly time: number;
	readonly kind: InboxKind;
	readonly status: InboxStatus;
	readonly title: string;
	readonly body: string;
	readonly source: string;
	readonly channel?: string;
	readonly fromHandle?: string;
	readonly entityId?: string;
	readonly prompted?: boolean;
	readonly replyText?: string;
	readonly meta?: Record<string, unknown>;
}

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
}

export interface ListOptions {
	status?: InboxStatus;
	kind?: InboxKind;
	source?: string;
	channel?: string;
	since?: number;
	limit?: number;
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
			// Read the last RING_CAP items only — older history stays on disk.
			for (const line of lines.slice(-RING_CAP)) {
				try {
					const item = JSON.parse(line) as InboxItem;
					this.buffer.push(item);
				} catch {
					// skip malformed
				}
			}
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
		return "unknown";
	}

	async post(opts: PostOptions): Promise<InboxItem> {
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

		// Persist to eliza Memory so Pensieve can index/search it. Best-effort
		// — failure here doesn't block the inbox itself.
		await this.persistAsMemory(item).catch((err) => {
			logger.debug({ src: "inbox", err: err instanceof Error ? err.message : err }, "memory persist failed");
		});

		const shouldPrompt = opts.prompt ?? (opts.kind === "notification" || opts.kind === "task");
		if (shouldPrompt) {
			await this.promptAgent(item).catch((err) => {
				logger.debug({ src: "inbox", err: err instanceof Error ? err.message : err }, "agent prompt failed");
			});
		}
		return item;
	}

	private append(item: InboxItem): void {
		this.buffer.push(item);
		if (this.buffer.length > RING_CAP) this.buffer.shift();
		try {
			appendFileSync(this.logPath, `${JSON.stringify(item)}\n`, { mode: 0o600 });
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
				text: `${item.title}\n\n${item.body}`,
				source: `inbox:${item.source}`,
				attachments: [],
			},
			createdAt: item.time,
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
				this.statusOverrides.set(item.id, "acted");
				this.replyTexts.set(item.id, replyText);
			}
		}).catch((err) => {
			logger.warn(
				{ src: "inbox", err: err instanceof Error ? err.message : err },
				"agent processing of inbox item failed",
			);
		});
		(item as unknown as { prompted: boolean }).prompted = true;
	}

	private readonly replyTexts = new Map<string, string>();

	getReply(id: string): string | undefined {
		return this.replyTexts.get(id);
	}

	list(opts: ListOptions = {}): { items: InboxItem[]; total: number } {
		const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
		const since = opts.since ?? 0;
		const filtered = this.buffer
			.map((m) => {
				const status = this.statusOverrides.get(m.id) ?? m.status;
				const replyText = this.replyTexts.get(m.id);
				if (status === m.status && !replyText) return m;
				return { ...m, status, ...(replyText ? { replyText } : {}) };
			})
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

	updateStatus(id: string, status: InboxStatus): InboxItem | null {
		const item = this.buffer.find((i) => i.id === id);
		if (!item) return null;
		this.statusOverrides.set(id, status);
		try {
			appendFileSync(
				this.logPath,
				`${JSON.stringify({ id, statusUpdate: status, time: Date.now() })}\n`,
				{ mode: 0o600 },
			);
		} catch {
			// best effort
		}
		return { ...item, status };
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
