import { createHash } from "node:crypto";
import {
	logger,
	type IAgentRuntime,
	type Task,
	type TaskMetadata,
	type UUID,
} from "@elizaos/core";
import type { ChannelGatewayService, GatewayMessage } from "./channels/gateway";
import type { PensieveMemoryService } from "./pensieve/memory-service";
import type { RuntimeService } from "./runtime";

export const DISCORD_OBSERVATION_TASK_NAME = "DISCORD_OBSERVATION_NOTES";

const TASK_TAGS = ["queue", "repeat", "autonomy", "discord-observations"];
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const HASH_LIMIT = 120;
const MAX_MESSAGES_PER_SCAN = 600;
const MAX_ROOM_CONTEXT = 80;
const MAX_RECENT_TURNS = 14;

type RuntimeTaskSurface = IAgentRuntime & {
	getTasks?: (params: { agentIds?: string[]; tags?: string[]; limit?: number }) => Promise<Task[]>;
	createTask?: (task: Task) => Promise<UUID>;
	updateTask?: (id: UUID, task: Partial<Task>) => Promise<void>;
	deleteTask?: (id: UUID) => Promise<void>;
	getTaskWorker?: (name: string) => unknown;
	registerTaskWorker?: (worker: {
		name: string;
		execute: (runtime: IAgentRuntime, options: Record<string, unknown>, task: Task) => Promise<unknown>;
	}) => void;
};

type MemoryCreateInput = Parameters<PensieveMemoryService["create"]>[0];

export interface DiscordObservationWrite {
	readonly hash: string;
	readonly maxMessageAt: number;
	readonly input: MemoryCreateInput;
}

interface SpeakerObservation {
	readonly entityId: string;
	readonly name: string;
	readonly externalHandle?: string;
	readonly messageCount: number;
	readonly lastSeen: number;
	readonly samples: string[];
}

interface FactCandidate {
	readonly text: string;
	readonly entityId: string;
	readonly roomId: string;
	readonly category: "business_role" | "preference";
	readonly structuredFields: Record<string, unknown>;
	readonly confidence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const value = runtime.getSetting(key);
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	const env = process.env[key];
	if (typeof env === "string" && env.trim().length > 0) return env.trim();
	return undefined;
}

function booleanSetting(runtime: IAgentRuntime, key: string, defaultValue: boolean): boolean {
	const value = pickSetting(runtime, key);
	if (value === undefined) return defaultValue;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function numberSetting(runtime: IAgentRuntime, key: string, defaultValue: number): number {
	const value = pickSetting(runtime, key);
	if (value === undefined) return defaultValue;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readTimestamp(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function compactText(text: string, max = 220): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max - 1).trim()}...` : compact;
}

function stripDiscordPrefix(text: string): string {
	return text
		.replace(/^\[Discord [^\]]+\]\s+@.+?\([^)]+\)(?: replying to @[^:]+)?:\s*/s, "")
		.trim();
}

function internalFailureText(text: string): boolean {
	return /dynamicPromptExecFromState|discord_generation_failed|reply generation failed|provider path|server_is_overloaded|apiKey=|x-api-key|authorization/i.test(text);
}

function publicTurnText(message: GatewayMessage, max = 220): string {
	const stripped = stripDiscordPrefix(message.text);
	if (internalFailureText(stripped)) {
		return "[internal generation failure was posted; do not repeat provider or debug details publicly]";
	}
	return compactText(stripped, max);
}

function nameFromGatewayText(text: string): string | null {
	const match = text.match(/^\[Discord [^\]]+\]\s+@(.+?)\s+\(/s);
	return match?.[1]?.trim() || null;
}

function speakerName(message: GatewayMessage, agentId: string): string {
	if (message.entityId === agentId || message.direction === "out") return "Detour Squirrel";
	return nameFromGatewayText(message.text) ?? message.externalHandle ?? message.entityId;
}

function summarizeSpeakers(messages: GatewayMessage[], agentId: string): SpeakerObservation[] {
	const byEntity = new Map<string, SpeakerObservation>();
	for (const message of messages) {
		if (message.direction !== "in" || !message.entityId || message.entityId === agentId) continue;
		const existing = byEntity.get(message.entityId);
		const sample = publicTurnText(message, 160);
		const samples = existing?.samples ?? [];
		const nextSamples = sample && !samples.includes(sample) ? [sample, ...samples].slice(0, 2) : samples;
		byEntity.set(message.entityId, {
			entityId: message.entityId,
			name: speakerName(message, agentId),
			...(message.externalHandle ? { externalHandle: message.externalHandle } : existing?.externalHandle ? { externalHandle: existing.externalHandle } : {}),
			messageCount: (existing?.messageCount ?? 0) + 1,
			lastSeen: Math.max(existing?.lastSeen ?? 0, message.time),
			samples: nextSamples,
		});
	}
	return [...byEntity.values()].sort((a, b) => b.lastSeen - a.lastSeen || b.messageCount - a.messageCount);
}

function instructionLines(messages: GatewayMessage[]): string[] {
	const text = messages.map((message) => `${speakerName(message, "")}: ${publicTurnText(message, 260)}`).join("\n").toLowerCase();
	const lines: string[] = [];
	if (text.includes("notification") && (text.includes("fud") || text.includes(" x "))) {
		lines.push("When asked about X/FUD, inspect Detour's own X notifications/context before asking for a link.");
	}
	if (text.includes("botdick is your dev") || text.includes("dexploarer is my dev") || text.includes("dexploarer is my dev/operator")) {
		lines.push("Dexploarer is Detour's dev/operator; do not confuse that role with Discord jokes or nicknames.");
	}
	if (text.includes("internal generation failure") || text.includes("reply generation failed")) {
		lines.push("Never post provider errors, model overloads, tokens, or debug plumbing as a public Discord reply.");
	}
	if (text.includes("what??") || text.includes("touche")) {
		lines.push("Carry the local thread context across short follow-ups instead of resetting to a generic reply.");
	}
	return [...new Set(lines)];
}

function roomNoteText(roomId: string, messages: GatewayMessage[], agentId: string): string {
	const speakers = summarizeSpeakers(messages, agentId);
	const latest = messages.reduce((max, message) => Math.max(max, message.time), 0);
	const people = speakers
		.slice(0, 12)
		.map((speaker) => {
			const role = /dexploarer/i.test(speaker.name) ? " Detour's dev/operator." : "";
			const samples = speaker.samples.length > 0 ? ` recent: ${speaker.samples.join(" | ")}` : "";
			return `- ${speaker.name}: ${speaker.messageCount} observed inbound messages.${role}${samples}`;
		})
		.join("\n");
	const turns = messages
		.slice(-MAX_RECENT_TURNS)
		.map((message) => `- ${speakerName(message, agentId)}: ${publicTurnText(message, 240)}`)
		.join("\n");
	const instructions = instructionLines(messages);
	const sections = [
		`Discord room ${roomId} observation through ${new Date(latest).toISOString()}.`,
		people ? `People:\n${people}` : "",
		turns ? `Recent turns:\n${turns}` : "",
		instructions.length > 0 ? `Standing context:\n${instructions.map((line) => `- ${line}`).join("\n")}` : "",
		"Use this for continuity and identity grounding. Do not recite it unless it is relevant.",
	].filter((section) => section.length > 0);
	return sections.join("\n\n");
}

function factCandidates(roomId: string, messages: GatewayMessage[], agentId: string): FactCandidate[] {
	const speakers = summarizeSpeakers(messages, agentId);
	const dexploarer = speakers.find((speaker) => /dexploarer/i.test(speaker.name));
	const text = messages.map((message) => publicTurnText(message, 260)).join("\n").toLowerCase();
	const facts: FactCandidate[] = [];
	if (dexploarer) {
		facts.push({
			text: "Dexploarer is Detour's dev/operator and trusted builder context in Discord.",
			entityId: dexploarer.entityId,
			roomId,
			category: "business_role",
			structuredFields: {
				person: "Dexploarer",
				role: "dev/operator",
				agent: "Detour",
				channel: "discord",
			},
			confidence: 0.96,
		});
		if (text.includes("notification") && (text.includes("fud") || text.includes(" x "))) {
			facts.push({
				text: "Dexploarer expects Detour to inspect its own X notifications when asked about X FUD, tags, or mentions.",
				entityId: dexploarer.entityId,
				roomId,
				category: "preference",
				structuredFields: {
					person: "Dexploarer",
					preference: "inspect Detour X notifications before asking for links",
					context: "Discord questions about X/FUD",
				},
				confidence: 0.9,
			});
		}
	}
	return facts;
}

function buildMetadata(current: unknown, runtime: IAgentRuntime): TaskMetadata {
	const intervalMs = Math.max(
		60_000,
		Math.min(30 * 60_000, numberSetting(runtime, "DISCORD_OBSERVATION_INTERVAL_MS", DEFAULT_INTERVAL_MS)),
	);
	return {
		...(isRecord(current) ? current : {}),
		updateInterval: intervalMs,
		baseInterval: intervalMs,
		blocking: false,
		discordObservation: {
			version: 1,
		},
	};
}

function isObservationTask(task: Task): boolean {
	return task.name === DISCORD_OBSERVATION_TASK_NAME && isRecord(task.metadata?.discordObservation);
}

async function ensureTask(runtime: RuntimeTaskSurface): Promise<UUID | null> {
	if (!booleanSetting(runtime, "DISCORD_OBSERVATION_ENABLED", true)) return null;
	if (!runtime.getTasks || !runtime.createTask) return null;
	const tasks = await runtime.getTasks({
		agentIds: [runtime.agentId],
		tags: ["discord-observations"],
	});
	const existing = tasks.filter(isObservationTask);
	const [primary, ...duplicates] = existing;
	for (const duplicate of duplicates) {
		if (duplicate.id && runtime.deleteTask) {
			await runtime.deleteTask(duplicate.id).catch((err) => {
				logger.warn(
					{ src: "discord-observations", taskId: duplicate.id, err: err instanceof Error ? err.message : err },
					"[DiscordObservationService] duplicate task cleanup failed",
				);
			});
		}
	}
	const metadata = buildMetadata(primary?.metadata, runtime);
	if (primary?.id) {
		await runtime.updateTask?.(primary.id, {
			description: "Persist Discord room observations, identity facts, and continuity notes",
			tags: [...TASK_TAGS],
			metadata,
		});
		return primary.id;
	}
	return runtime.createTask({
		name: DISCORD_OBSERVATION_TASK_NAME,
		description: "Persist Discord room observations, identity facts, and continuity notes",
		tags: [...TASK_TAGS],
		metadata,
		dueAt: Date.now() + 10_000,
	});
}

export function planDiscordObservationWrites(
	messages: GatewayMessage[],
	opts: {
		agentId: string;
		lastProcessedAt: number;
		knownHashes: string[];
	},
): DiscordObservationWrite[] {
	const known = new Set(opts.knownHashes);
	// Tracks hashes already added during THIS planning call. Without this,
	// the same fact extracted across multiple rooms / multiple iterations
	// (e.g. "Dexploarer is Detour's dev/operator" mentioned in three
	// channels) produces three identical inserts in a single tick — the DB
	// "memories" table has a unique constraint that rejects all three, so
	// `writeCount=3 failedCount=3` lands in the logs every tick. Dedup
	// in-flight so each unique hash gets at most one write per planner call.
	const seenThisCall = new Set<string>();
	const sorted = messages
		.filter((message) => message.channel === "discord" && message.roomId && message.time > 0)
		.sort((a, b) => a.time - b.time);
	const roomsWithNewMessages = new Set(
		sorted
			.filter((message) => message.time > opts.lastProcessedAt)
			.map((message) => message.roomId),
	);
	const writes: DiscordObservationWrite[] = [];
	for (const roomId of roomsWithNewMessages) {
		const roomMessages = sorted.filter((message) => message.roomId === roomId).slice(-MAX_ROOM_CONTEXT);
		const newMessages = roomMessages.filter((message) => message.time > opts.lastProcessedAt);
		const maxMessageAt = newMessages.reduce((max, message) => Math.max(max, message.time), opts.lastProcessedAt);
		const noteHash = hashText(`discord-note:${roomId}:${newMessages.map((message) => `${message.id}:${message.time}`).join("|")}`);
		if (!known.has(noteHash) && !seenThisCall.has(noteHash)) {
			seenThisCall.add(noteHash);
			writes.push({
				hash: noteHash,
				maxMessageAt,
				input: {
					text: roomNoteText(roomId, roomMessages, opts.agentId),
					path: `/discord/rooms/${roomId}/observations`,
					type: "description",
					tags: ["discord", "observation", "autonomous-notes"],
					roomId,
					entityId: opts.agentId,
					extraMetadata: {
						source: "discord-observation",
						roomId,
						messageCount: roomMessages.length,
						newMessageCount: newMessages.length,
						latestMessageAt: maxMessageAt,
						hash: noteHash,
					},
				},
			});
		}
		for (const fact of factCandidates(roomId, roomMessages, opts.agentId)) {
			const factHash = hashText(`discord-fact:${fact.entityId}:${fact.text}`);
			if (known.has(factHash) || seenThisCall.has(factHash)) continue;
			seenThisCall.add(factHash);
			writes.push({
				hash: factHash,
				maxMessageAt,
				input: {
					text: fact.text,
					path: "/facts/discord/people",
					type: "custom",
					tags: ["discord", "identity-context", "autonomous-fact"],
					roomId: fact.roomId,
					entityId: fact.entityId,
					tableName: "facts",
					extraMetadata: {
						source: "discord-observation",
						confidence: fact.confidence,
						kind: "durable",
						category: fact.category,
						structuredFields: fact.structuredFields,
						verificationStatus: "self_reported",
						lastConfirmedAt: new Date(maxMessageAt).toISOString(),
						hash: factHash,
					},
				},
			});
		}
	}
	return writes;
}

export class DiscordObservationService {
	private inFlight = false;
	/**
	 * Optional companion hook. When wired, the observation tick asks
	 * the companion's shouldRespond() classifier whether the current
	 * Discord message batch contains anything addressed to the agent
	 * BEFORE doing any extraction work. Returns null when the companion
	 * is off or can't decide — the tick proceeds with default behavior.
	 */
	private shouldRespondHook:
		| ((args: {
				agentName: string;
				channel: string;
				recentMessages: { author: string; text: string }[];
		  }) => Promise<boolean | null>)
		| null = null;

	constructor(
		private readonly runtimeService: RuntimeService,
		private readonly memories: PensieveMemoryService,
		private readonly gateway: ChannelGatewayService,
	) {}

	/**
	 * Wire a companion-backed should-respond classifier. Optional —
	 * when unset the observation service runs full extraction on every
	 * tick (legacy behavior). When wired, ticks skip extraction on
	 * messages the companion classifies as not warranting a reply,
	 * cutting wasted planner-adjacent work.
	 */
	setShouldRespondHook(
		hook: (args: {
			agentName: string;
			channel: string;
			recentMessages: { author: string; text: string }[];
		}) => Promise<boolean | null>,
	): void {
		this.shouldRespondHook = hook;
	}

	start(): void {
		this.runtimeService.onAfterBuild(async (state) => {
			await this.attach(state.runtime);
		});
	}

	stop(): void {}

	async attach(runtime: IAgentRuntime): Promise<void> {
		const r = runtime as RuntimeTaskSurface;
		if (!r.registerTaskWorker || !r.getTaskWorker) return;
		if (!r.getTaskWorker(DISCORD_OBSERVATION_TASK_NAME)) {
			r.registerTaskWorker({
				name: DISCORD_OBSERVATION_TASK_NAME,
				execute: async (rt, _options, task) => {
					await this.run(rt, task);
					return undefined;
				},
			});
		}
		await ensureTask(r);
	}

	private async run(runtime: IAgentRuntime, task: Task): Promise<void> {
		if (this.inFlight) {
			logger.info({ src: "discord-observations" }, "discord observation tick skipped because a prior tick is still running");
			return;
		}
		this.inFlight = true;
		try {
			await this.execute(runtime, task);
		} finally {
			this.inFlight = false;
		}
	}

	private async execute(runtime: IAgentRuntime, task: Task): Promise<void> {
		if (!booleanSetting(runtime, "DISCORD_OBSERVATION_ENABLED", true)) return;
		const metadata = isRecord(task.metadata) ? task.metadata : {};
		const hashes = [...new Set([...readStringArray(metadata.discordObservationHashes), ...(await this.storedHashes())])];
		const lastProcessedAt = readTimestamp(metadata.discordObservationLastProcessedAt);
		const messages = this.gateway.list({ channel: "discord", limit: MAX_MESSAGES_PER_SCAN }).messages;
		const latestMessageAt = messages.reduce((max, message) => Math.max(max, message.time), lastProcessedAt);

		// Companion should-respond gate: when wired, ask the local 0.6B
		// classifier whether anything in the message batch warrants a
		// reply BEFORE we plan extractions. Skipping early means no
		// memory writes, no hash list growth, no log noise from
		// confirmed-dupe inserts on rooms where nothing's addressed to
		// the agent. The gate is optional — `null` means "couldn't
		// decide; proceed with default behavior."
		if (this.shouldRespondHook && messages.length > 0) {
			try {
				const agentName =
					(runtime.character?.name as string | undefined) ?? "agent";
				const recentMessages = messages
					.filter((m) => m.time > lastProcessedAt)
					.slice(-12)
					.map((m) => ({
						author: m.externalHandle ?? m.entityId?.slice(0, 8) ?? "user",
						text: (m.text ?? "").slice(0, 240),
					}));
				if (recentMessages.length > 0) {
					const decision = await this.shouldRespondHook({
						agentName,
						channel: "discord",
						recentMessages,
					});
					if (decision === false) {
						logger.info(
							{
								src: "discord-observations",
								agentName,
								newMessages: recentMessages.length,
							},
							"companion gate said skip — no observation work this tick",
						);
						await this.updateTask(runtime, task, {
							metadata,
							hashes,
							createdIds: [],
							failedCount: 0,
							lastProcessedAt,
							latestMessageAt,
							writeCount: 0,
						});
						return;
					}
				}
			} catch (err) {
				// Gate failures must never block the legacy path.
				logger.debug(
					{
						src: "discord-observations",
						err: err instanceof Error ? err.message : err,
					},
					"companion shouldRespond gate threw — proceeding with default behavior",
				);
			}
		}

		const writes = planDiscordObservationWrites(messages, {
			agentId: String(runtime.agentId),
			lastProcessedAt,
			knownHashes: hashes,
		});
		const createdIds: string[] = [];
		let failedCount = 0;
		for (const write of writes) {
			try {
				const created = await this.memories.create(write.input);
				if (created?.id) {
					createdIds.push(created.id);
					hashes.push(write.hash);
				} else {
					failedCount += 1;
				}
			} catch (err) {
				failedCount += 1;
				logger.warn(
					{ src: "discord-observations", err: err instanceof Error ? err.message : err, tableName: write.input.tableName ?? "memories" },
					"[DiscordObservationService] write failed",
				);
			}
		}
		await this.updateTask(runtime, task, {
			metadata,
			hashes,
			createdIds,
			failedCount,
			lastProcessedAt,
			latestMessageAt,
			writeCount: writes.length,
		});
		logger.info(
			{ src: "discord-observations", writeCount: writes.length, createdCount: createdIds.length, failedCount },
			"discord observation tick complete",
		);
	}

	private async storedHashes(): Promise<string[]> {
		const [notes, facts] = await Promise.all([
			this.memories.list({
				tableName: "memories",
				pathPrefix: "/discord/rooms",
				limit: HASH_LIMIT,
			}),
			this.memories.list({
				tableName: "facts",
				pathPrefix: "/facts/discord/people",
				limit: HASH_LIMIT,
			}),
		]);
		const details = await Promise.all(
			[...notes, ...facts].map((memory) => this.memories.get(memory.id as UUID)),
		);
		const hashes: string[] = [];
		for (const detail of details) {
			const metadata = isRecord(detail?.metadata) ? detail.metadata : {};
			if (typeof metadata.hash === "string" && metadata.hash.length > 0) hashes.push(metadata.hash);
		}
		return hashes;
	}

	private async updateTask(
		runtime: IAgentRuntime,
		task: Task,
		result: {
			metadata: Record<string, unknown>;
			hashes: string[];
			createdIds: string[];
			failedCount: number;
			lastProcessedAt: number;
			latestMessageAt: number;
			writeCount: number;
		},
	): Promise<void> {
		if (!task.id) return;
		const processedAt = result.failedCount === 0 ? result.latestMessageAt : result.lastProcessedAt;
		await (runtime as RuntimeTaskSurface).updateTask?.(task.id, {
			metadata: {
				...result.metadata,
				discordObservationLastRunAt: Date.now(),
				discordObservationLastProcessedAt: processedAt,
				discordObservationLastResult:
					result.failedCount > 0 ? "write_failed" : result.createdIds.length > 0 ? "memories_written" : "no_new_messages",
				discordObservationLastMemoryIds: result.createdIds,
				discordObservationLastWriteCount: result.writeCount,
				discordObservationHashes: result.hashes.slice(-HASH_LIMIT),
			},
		});
	}
}
