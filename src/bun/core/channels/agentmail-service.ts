/**
 * AgentMailService — email-based agent-to-agent communication channel.
 *
 * Integrates AgentMail as a first-class channel alongside Discord, Telegram,
 * and iMessage. The service manages:
 *
 *   - An AgentMail inbox (one per agent, idempotent via clientId)
 *   - A WebSocket subscription for real-time inbound email delivery
 *   - Reply routing: when InboxService marks an agentmail item as `acted`
 *     with `replyText`, we call `client.inboxes.messages.reply()` to send
 *     the response back as an email reply in the same thread
 *   - Manual send via RPC (`sendEmail`)
 *
 * Lifecycle: constructed in core/index.ts, `start()` called after deps are
 * wired. InboxService and RuntimeService are injected via setters because
 * they may not exist at construction time.
 */

import { logger } from "@elizaos/core";
import { AgentMailClient, type AgentMail } from "agentmail";
import type { AgentMailConfig, AgentMailStatus } from "../../../shared/index";
import type { VaultService } from "../vault";
import type { ConfigService } from "../config-service";
import type { ChannelGatewayService } from "./gateway";
import type { InboxService } from "../inbox";
import type { RuntimeService } from "../runtime";

// ── Constants ─────────────────────────────────────────────────────────────────

const VAULT_KEY_API_KEY = "AGENTMAIL_API_KEY";
const VAULT_KEY_INBOX_ID = "AGENTMAIL_INBOX_ID";

const DEFAULT_CONFIG: AgentMailConfig = {
	enabled: false,
	autoReply: true,
	draftMode: false,
};

// ── Service ───────────────────────────────────────────────────────────────────

export class AgentMailService {
	// ── injected late ──────────────────────────────────────────────────
	private inbox: InboxService | null = null;
	private runtime: RuntimeService | null = null;

	// ── internal state ─────────────────────────────────────────────────
	private client: AgentMailClient | null = null;
	private socket: { close(): void } | null = null;
	private inboxId: string | null = null;
	private inboxAddress: string | null = null;
	private connected = false;
	private messageCount = 0;
	private lastMessageAt: number | null = null;
	private lastError: string | null = null;

	constructor(
		private readonly vault: VaultService,
		private readonly config: ConfigService,
		private readonly gateway: ChannelGatewayService,
	) {}

	// ── Late-bound dependency setters ──────────────────────────────────

	setInbox(inbox: InboxService): void {
		this.inbox = inbox;
		// Register reply routing: when an agentmail inbox item gets a reply
		// from the agent, send it back as an email thread response.
		inbox.onReply((id, replyText, item) => {
			// Only route replies for items that originated from agentmail
			if (!item.source?.startsWith("agentmail:")) return;
			void this.replyToInboxItem(id, replyText);
		});
	}

	setRuntime(runtime: RuntimeService): void {
		this.runtime = runtime;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	/**
	 * Called once from core/index.ts after construction and dependency wiring.
	 * Reads config to decide whether to connect.
	 */
	async start(): Promise<void> {
		try {
			const cfg = await this.readConfig();
			if (!cfg.enabled) {
				logger.info({ src: "agentmail" }, "agentmail disabled in config — skipping start");
				return;
			}
			const manager = await this.vault.manager();
			if (!(await manager.has(VAULT_KEY_API_KEY))) {
				logger.info({ src: "agentmail" }, "agentmail enabled but no API key in vault — skipping start");
				return;
			}
			const apiKey = await manager.get(VAULT_KEY_API_KEY);
			await this.connect(apiKey);
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			logger.warn(
				{ src: "agentmail", err: this.lastError },
				"agentmail start failed",
			);
		}
	}

	/**
	 * Tear down WebSocket and clear state.
	 */
	stop(): void {
		this.disconnect();
		logger.info({ src: "agentmail" }, "agentmail stopped");
	}

	// ── Status snapshot ────────────────────────────────────────────────

	status(): AgentMailStatus {
		return {
			enabled: this.client !== null,
			connected: this.connected,
			inboxId: this.inboxId,
			inboxAddress: this.inboxAddress,
			messageCount: this.messageCount,
			lastMessageAt: this.lastMessageAt,
			lastError: this.lastError,
		};
	}

	// ── Enable / Disable ───────────────────────────────────────────────

	/**
	 * Enable AgentMail with the given API key. Stores the key in vault,
	 * creates/retrieves the inbox, and opens the WebSocket.
	 */
	async enable(
		apiKey: string,
	): Promise<{ ok: true; inboxAddress: string } | { ok: false; error: string }> {
		try {
			// Persist API key
			const manager = await this.vault.manager();
			await manager.set(VAULT_KEY_API_KEY, apiKey, { sensitive: true });

			// Update config
			await this.writeConfig({ ...DEFAULT_CONFIG, enabled: true });

			// Connect
			await this.connect(apiKey);

			if (!this.inboxAddress) {
				return { ok: false, error: "inbox created but no email address returned" };
			}
			return { ok: true, inboxAddress: this.inboxAddress };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.lastError = error;
			logger.error({ src: "agentmail", err: error }, "enable failed");
			return { ok: false, error };
		}
	}

	/**
	 * Disable AgentMail. Disconnects the WebSocket, clears config.
	 */
	async disable(): Promise<void> {
		this.disconnect();
		await this.writeConfig({ ...DEFAULT_CONFIG, enabled: false });
		logger.info({ src: "agentmail" }, "agentmail disabled");
	}

	// ── Manual send (RPC) ──────────────────────────────────────────────

	/**
	 * Send a new email from the agent's inbox.
	 */
	async sendEmail(
		to: string,
		subject: string,
		text: string,
	): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
		if (!this.client || !this.inboxId) {
			return { ok: false, error: "agentmail not connected" };
		}
		try {
			const msg = await this.client.inboxes.messages.send(this.inboxId, {
				to,
				subject,
				text,
			});
			this.messageCount += 1;

			// Record outbound in gateway
			this.gateway.recordChatReply({
				text,
				roomId: `agentmail:${this.inboxId}`,
				entityId: this.resolveAgentId(),
				channel: "agentmail",
				source: "agentmail",
			});

			logger.info(
				{ src: "agentmail", to, messageId: msg.messageId },
				"email sent",
			);
			return { ok: true, messageId: msg.messageId };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.lastError = error;
			logger.error({ src: "agentmail", err: error }, "sendEmail failed");
			return { ok: false, error };
		}
	}

	// ── Reply routing ──────────────────────────────────────────────────

	/**
	 * Reply to an inbox item that originated from AgentMail. Called by the
	 * RPC layer or the inbox act() completion flow when the agent produces
	 * a reply for a `source === "agentmail"` item.
	 */
	async replyToInboxItem(inboxItemId: string, replyText: string): Promise<void> {
		if (!this.client || !this.inboxId) {
			logger.warn(
				{ src: "agentmail", inboxItemId },
				"cannot reply — agentmail not connected",
			);
			return;
		}

		// Look up the original message metadata from the inbox item.
		// The inbox stores messageId and threadId in meta when we post().
		const item = this.findInboxItem(inboxItemId);
		if (!item) {
			logger.warn(
				{ src: "agentmail", inboxItemId },
				"cannot reply — inbox item not found",
			);
			return;
		}

		const meta = item.meta as
			| { messageId?: string; threadId?: string; inboxId?: string }
			| undefined;
		const originalMessageId = meta?.messageId;
		if (!originalMessageId) {
			logger.warn(
				{ src: "agentmail", inboxItemId },
				"cannot reply — no messageId in inbox item metadata",
			);
			return;
		}

		try {
			await this.client.inboxes.messages.reply(this.inboxId, originalMessageId, {
				text: replyText,
			});

			// Record outbound reply in gateway
			this.gateway.recordChatReply({
				text: replyText,
				roomId: `agentmail:${this.inboxId}`,
				entityId: this.resolveAgentId(),
				channel: "agentmail",
				source: "agentmail",
			});

			logger.info(
				{ src: "agentmail", inboxItemId, originalMessageId },
				"reply sent via agentmail",
			);
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			logger.error(
				{ src: "agentmail", err: this.lastError, inboxItemId },
				"reply failed",
			);
		}
	}

	// ── Private: connection ────────────────────────────────────────────

	/**
	 * Create the AgentMailClient, provision/retrieve the inbox, and open
	 * the WebSocket subscription for real-time inbound emails.
	 */
	private async connect(apiKey: string): Promise<void> {
		this.client = new AgentMailClient({ apiKey });

		// Create or retrieve inbox. The clientId makes this idempotent —
		// calling create() again with the same clientId returns the existing
		// inbox instead of creating a duplicate.
		const agentId = this.resolveAgentId();
		const inbox = await this.client.inboxes.create({
			clientId: `detour-${agentId}`,
		});
		this.inboxId = inbox.inboxId;
		this.inboxAddress = inbox.email;

		// Cache inboxId in vault for fast lookups on restart
		const manager = await this.vault.manager();
		await manager.set(VAULT_KEY_INBOX_ID, inbox.inboxId);

		logger.info(
			{ src: "agentmail", inboxId: inbox.inboxId, email: inbox.email },
			"agentmail inbox ready",
		);

		// Open WebSocket for real-time message delivery
		await this.openWebSocket();
	}

	/**
	 * Open a WebSocket connection and subscribe to the agent's inbox.
	 * The AgentMail SDK handles reconnection internally.
	 */
	private async openWebSocket(): Promise<void> {
		if (!this.client || !this.inboxId) return;

		try {
			const socket = await this.client.websockets.connect();
			this.socket = socket;

			socket.on("open", () => {
				logger.info({ src: "agentmail" }, "websocket connected");
				socket.sendSubscribe({
					type: "subscribe",
					inboxIds: [this.inboxId!],
				});
			});

			socket.on("message", (event) => {
				const ev = event as { type?: string; message?: unknown; thread?: unknown };
				if (ev.type === "message_received" && ev.message) {
					this.handleIncomingEmail(event as AgentMail.MessageReceivedEvent).catch((err) => {
						logger.error(
							{ src: "agentmail", err: err instanceof Error ? err.message : err },
							"failed to handle incoming email",
						);
					});
				} else if (ev.type === "subscribed") {
					this.connected = true;
					logger.info(
						{ src: "agentmail", inboxId: this.inboxId },
						"subscribed to inbox",
					);
				}
			});

			socket.on("close", (event: { code?: number; reason?: string }) => {
				this.connected = false;
				logger.info(
					{ src: "agentmail", code: event.code, reason: event.reason },
					"websocket closed",
				);
			});

			socket.on("error", (error: unknown) => {
				const msg = error instanceof Error ? error.message : String(error);
				this.lastError = msg;
				logger.error({ src: "agentmail", err: msg }, "websocket error");
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.lastError = msg;
			logger.error({ src: "agentmail", err: msg }, "websocket open failed");
		}
	}

	/**
	 * Handle an inbound email received via WebSocket. Posts it to the
	 * InboxService so the agent can process it through the standard
	 * inbox → agent pipeline.
	 */
	private async handleIncomingEmail(event: AgentMail.MessageReceivedEvent): Promise<void> {
		const message = event.message;
		if (!message) return;

		const senderEmail = typeof message.from === "string" ? message.from : (typeof message.from === "object" && message.from && "address" in message.from ? String((message.from as { address?: string }).address) : "unknown");
		const subject = message.subject ?? "(no subject)";
		const body = message.extractedText ?? message.text ?? "";

		this.messageCount += 1;
		this.lastMessageAt = Date.now();

		logger.info(
			{ src: "agentmail", from: senderEmail, subject },
			"incoming email",
		);

		// Record in gateway for the chat hub feed
		this.gateway.recordChatReply({
			text: `📧 From: ${senderEmail}\nSubject: ${subject}\n\n${body}`.slice(0, 2000),
			roomId: `agentmail:${this.inboxId}`,
			entityId: senderEmail,
			channel: "agentmail",
			source: "agentmail",
		});

		// Post to InboxService so the agent processes it
		if (this.inbox) {
			try {
				await this.inbox.post({
					kind: "message",
					title: `📧 ${subject}`,
					body,
					source: `agentmail:${message.messageId ?? "unknown"}`,
					channel: "agentmail",
					fromHandle: senderEmail,
					meta: {
						messageId: message.messageId,
						threadId: message.threadId,
						inboxId: this.inboxId,
						senderEmail,
						subject,
					},
					prompt: true,
				});
			} catch (err) {
				logger.error(
					{ src: "agentmail", err: err instanceof Error ? err.message : err },
					"failed to post incoming email to inbox",
				);
			}
		}
	}

	/**
	 * Close WebSocket and reset connection state.
	 */
	private disconnect(): void {
		if (this.socket) {
			try {
				this.socket.close();
			} catch {
				// best effort
			}
			this.socket = null;
		}
		this.client = null;
		this.connected = false;
		this.inboxId = null;
		this.inboxAddress = null;
	}

	// ── Private: helpers ───────────────────────────────────────────────

	/**
	 * Read AgentMail config from ConfigService. Falls back to defaults
	 * if the config methods aren't available yet (another subagent adds them).
	 */
	private async readConfig(): Promise<AgentMailConfig> {
		try {
			return await this.config.getAgentMail();
		} catch {
			// fall through to default on any config read failure
		}
		return { ...DEFAULT_CONFIG };
	}

	/**
	 * Write AgentMail config via ConfigService. No-op if the setter
	 * isn't available yet.
	 */
	private async writeConfig(cfg: AgentMailConfig): Promise<void> {
		try {
			await this.config.setAgentMail(cfg);
		} catch (err) {
			logger.warn(
				{ src: "agentmail", err: err instanceof Error ? err.message : err },
				"failed to persist agentmail config",
			);
		}
	}

	/**
	 * Resolve the agent's ID from the RuntimeService, falling back to
	 * a stable default.
	 */
	private resolveAgentId(): string {
		try {
			const rt = this.runtime?.peek();
			if (rt) {
				const agentId = (rt as unknown as { agentId?: string }).agentId;
				if (typeof agentId === "string" && agentId.length > 0) return agentId;
			}
		} catch {
			// non-fatal
		}
		return "detour-agent";
	}

	/**
	 * Look up an inbox item by id. InboxService.list() returns items
	 * matching filters — we scan for the specific item.
	 */
	private findInboxItem(
		id: string,
	): { meta?: Record<string, unknown> } | null {
		if (!this.inbox) return null;
		try {
			const { items } = this.inbox.list({ source: undefined, limit: 500 });
			return items.find((i) => i.id === id) ?? null;
		} catch {
			return null;
		}
	}
}
