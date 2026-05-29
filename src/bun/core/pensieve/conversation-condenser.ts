/**
 * Conversation Condenser — Phase 3
 *
 * Periodically condenses old conversations per contact into compact summaries.
 * Raw messages pile up across channels; without condensation, the dossier
 * context gets stale/overloaded. This service:
 *
 *   1. Groups gateway messages by entity + time window (day)
 *   2. Filters to windows with >5 uncondensed messages
 *   3. Summarizes each window into 2-3 sentence condensation
 *   4. Stores condensations as Pensieve memories at
 *      /contacts/{entityId}/conversations/summary/{date}
 *   5. Tracks which windows have been condensed to avoid re-processing
 *
 * Designed to run on cron (every 6 hours or configurable).
 */

import { logger, type IAgentRuntime, type UUID, ModelType } from "@elizaos/core";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PensieveMemoryService } from "./memory-service";

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
}

interface CondensationResult {
	entityId: string;
	windowDate: string;
	messageCount: number;
	summary: string;
	memoryId?: string;
}

export interface CondenserRunResult {
	windowsProcessed: number;
	summariesCreated: number;
	errors: number;
	results: CondensationResult[];
}

const MIN_MESSAGES_PER_WINDOW = 5;
const MAX_MESSAGES_PER_SUMMARY = 50;
const MAX_ENTITIES_PER_RUN = 20;

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
		const lines = readFileSync(path, "utf8").trim().split("\n");
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

function dateKey(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
}

function stripMetaPrefix(text: string): string {
	return text
		.replace(/^\[Discord\s[^\]]+\]\s+@.+?\([^)]+\)(?:\s+replying\sto\s@[^:]+)?:\s*/s, "")
		.replace(/^\[source=[^\]]+\]\n?/s, "")
		.trim();
}

function internalText(text: string): boolean {
	return /dynamicPromptExecFromState|generation_failed|provider\spath|apiKey=|x-api-key|authorization/i.test(text);
}

/**
 * Track which entity+date windows have been condensed to avoid re-processing.
 * Persisted to a simple JSON file alongside the gateway state.
 */
function loadCondensedWindows(): Set<string> {
	const path = join(resolveStateDir(), "gateway", "condensed-windows.json");
	if (!existsSync(path)) return new Set();
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as string[];
		return new Set(data);
	} catch {
		return new Set();
	}
}

function saveCondensedWindows(windows: Set<string>): void {
	const dir = join(resolveStateDir(), "gateway");
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "condensed-windows.json"),
			JSON.stringify(Array.from(windows), null, 2),
			"utf8",
		);
	} catch (err) {
		logger.warn(
			{ src: "pensieve:condenser", err: err instanceof Error ? err.message : err },
			"failed to save condensed windows state",
		);
	}
}

export class ConversationCondenserService {
	constructor(
		private readonly resolveRuntime: () => IAgentRuntime | null,
	) {}

	/**
	 * Run a condensation pass. Groups gateway messages by entity+day,
	 * filters to windows with enough messages that haven't been condensed,
	 * then summarizes and stores each as a Pensieve memory.
	 */
	async run(opts?: {
		maxEntities?: number;
		minMessages?: number;
		olderThanHours?: number;
	}): Promise<CondenserRunResult> {
		const runtime = this.resolveRuntime();
		if (!runtime) {
			return { windowsProcessed: 0, summariesCreated: 0, errors: 0, results: [] };
		}

		const maxEntities = opts?.maxEntities ?? MAX_ENTITIES_PER_RUN;
		const minMessages = opts?.minMessages ?? MIN_MESSAGES_PER_WINDOW;
		const olderThanMs = (opts?.olderThanHours ?? 24) * 3_600_000;
		const cutoff = Date.now() - olderThanMs;

		const allMessages = readGatewayMessages();
		const condensedWindows = loadCondensedWindows();
		const agentId = String(runtime.agentId);

		// Group messages by entity + date
		const windows = new Map<string, GatewayMessage[]>();
		for (const msg of allMessages) {
			if (msg.entityId === agentId) continue;
			if (msg.time > cutoff) continue; // Don't condense very recent
			if (msg.direction === "deleted") continue;
			const stripped = stripMetaPrefix(msg.text);
			if (!stripped || internalText(stripped)) continue;

			const day = dateKey(msg.time);
			const key = `${msg.entityId}:${day}`;
			if (condensedWindows.has(key)) continue;

			const bucket = windows.get(key) ?? [];
			bucket.push(msg);
			windows.set(key, bucket);
		}

		// Filter to windows with enough messages
		const eligible = Array.from(windows.entries())
			.filter(([_, msgs]) => msgs.length >= minMessages)
			.sort(([_, a], [__, b]) => b.length - a.length)
			.slice(0, maxEntities);

		const memories = new PensieveMemoryService(() => runtime);
		const results: CondensationResult[] = [];
		let summariesCreated = 0;
		let errors = 0;

		for (const [key, msgs] of eligible) {
			const [entityId, windowDate] = key.split(":") as [string, string];
			const sorted = msgs.sort((a, b) => a.time - b.time).slice(0, MAX_MESSAGES_PER_SUMMARY);

			try {
				// Build a conversation transcript for summarization
				const transcript = sorted.map((msg) => {
					const speaker = msg.direction === "out" ? "Agent" : (msg.externalHandle ?? msg.entityId.slice(0, 8));
					const channel = msg.channel;
					const text = stripMetaPrefix(msg.text).slice(0, 300);
					return `[${channel}] ${speaker}: ${text}`;
				}).join("\n");

				const prompt = [
					"Summarize this conversation in 2-3 concise sentences.",
					"Focus on: key topics discussed, decisions made, action items, and any important information about the other person.",
					"Do NOT include timestamps or channel prefixes in the summary.",
					"",
					"Conversation:",
					transcript,
				].join("\n");

				// Use companion model for cheap summarization
				let summary: string;
				try {
					summary = await runtime.useModel(ModelType.TEXT_SMALL, {
						prompt,
						maxTokens: 200,
						temperature: 0.3,
					}) as string;
				} catch {
					// Fallback: just take first and last message as a basic summary
					const first = stripMetaPrefix(sorted[0].text).slice(0, 100);
					const last = stripMetaPrefix(sorted[sorted.length - 1].text).slice(0, 100);
					summary = `${sorted.length} messages on ${windowDate}. Started: "${first}" ... Ended: "${last}"`;
				}

				if (!summary || summary.length < 10) {
					summary = `${sorted.length} messages exchanged on ${windowDate} across ${new Set(sorted.map((m) => m.channel)).size} channel(s).`;
				}

				// Store as Pensieve memory
				const created = await memories.create({
					text: summary,
					path: `/contacts/${entityId}/conversations/summary/${windowDate}`,
					type: "description",
					tags: ["conversation-summary", "auto-condensed", ...new Set(sorted.map((m) => m.channel))],
					extraMetadata: {
						source: "conversation-condenser",
						entityId,
						windowDate,
						messageCount: sorted.length,
						channels: [...new Set(sorted.map((m) => m.channel))],
						timeRange: {
							start: sorted[0].time,
							end: sorted[sorted.length - 1].time,
						},
					},
				});

				condensedWindows.add(key);
				summariesCreated++;
				results.push({
					entityId,
					windowDate,
					messageCount: sorted.length,
					summary,
					memoryId: created?.id,
				});
			} catch (err) {
				errors++;
				logger.warn(
					{
						src: "pensieve:condenser",
						err: err instanceof Error ? err.message : err,
						entityId,
						windowDate,
					},
					"condensation failed for window",
				);
				results.push({
					entityId,
					windowDate,
					messageCount: sorted.length,
					summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}

		// Persist the condensed windows state
		saveCondensedWindows(condensedWindows);

		return {
			windowsProcessed: eligible.length,
			summariesCreated,
			errors,
			results,
		};
	}
}
