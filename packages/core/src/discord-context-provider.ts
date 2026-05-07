import {
	type Entity,
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

type GatewayDirection = "in" | "out" | "deleted" | "interaction";
type GatewayChannel = "discord" | "telegram" | "imessage" | "chat" | "unknown";

interface GatewayMessage {
	id: string;
	time: number;
	direction: GatewayDirection;
	channel: GatewayChannel;
	source: string;
	roomId: string;
	entityId: string;
	externalHandle?: string;
	text: string;
	meta?: Record<string, unknown>;
}

interface SpeakerSummary {
	entityId: string;
	name: string;
	externalHandle?: string;
	messageCount: number;
	lastSeen: number;
	samples: string[];
}

const MAX_LOG_LINES = 5000;
const MAX_RECENT_TURNS = 14;
const MAX_PEOPLE = 12;
const MAX_SAMPLE_LEN = 180;

function resolveStateDir(): string {
	return (
		process.env.ELIZA_STATE_DIR?.trim() ||
		join(homedir(), `.${process.env.ELIZA_NAMESPACE?.trim() || "eliza"}`)
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
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

function readGatewayMessages(): GatewayMessage[] {
	const path = join(resolveStateDir(), "gateway", "messages.jsonl");
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").trim().split("\n").slice(-MAX_LOG_LINES);
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
}

function isDiscordMessage(message: Memory): boolean {
	const source = typeof message.content?.source === "string" ? message.content.source.toLowerCase() : "";
	const text = typeof message.content?.text === "string" ? message.content.text : "";
	const metadata = asRecord(message.metadata);
	return source.includes("discord") ||
		text.startsWith("[Discord ") ||
		metadata?.source === "discord" ||
		metadata?.provider === "discord" ||
		metadata?.discord !== undefined;
}

function compactText(text: string, limit = MAX_SAMPLE_LEN): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, limit - 1).trim()}...` : compact;
}

function stripDiscordPrefix(text: string): string {
	return text
		.replace(/^\[Discord [^\]]+\]\s+@.+?\([^)]+\)(?: replying to @[^:]+)?:\s*/s, "")
		.trim();
}

function nameFromGatewayText(text: string): string | null {
	const match = text.match(/^\[Discord [^\]]+\]\s+@(.+?)\s+\(/s);
	return match?.[1]?.trim() || null;
}

function entityName(entity: Entity | undefined): string | null {
	const first = entity?.names?.find((name) => typeof name === "string" && name.trim().length > 0);
	return first?.trim() || null;
}

function relationshipIsDiscord(rel: Relationship): boolean {
	const metadata = asRecord(rel.metadata);
	return rel.tags?.includes("discord") === true ||
		rel.tags?.includes("discord-user") === true ||
		metadata?.channel === "discord";
}

async function discordEntityNames(runtime: IAgentRuntime): Promise<Map<string, string>> {
	if (typeof runtime.getRelationships !== "function" || typeof runtime.getEntitiesByIds !== "function") {
		return new Map();
	}
	const rels = await runtime.getRelationships({ entityIds: [runtime.agentId], limit: 500 });
	const ids = new Set<string>();
	for (const rel of rels) {
		if (!relationshipIsDiscord(rel)) continue;
		for (const id of [String(rel.sourceEntityId), String(rel.targetEntityId)]) {
			if (id !== String(runtime.agentId)) ids.add(id);
		}
	}
	if (ids.size === 0) return new Map();
	const entities = await runtime.getEntitiesByIds([...ids] as UUID[]);
	return new Map(entities.map((entity) => [String(entity.id), entityName(entity) ?? String(entity.id)]));
}

function speakerName(message: GatewayMessage, names: Map<string, string>, agentId: UUID): string {
	if (message.entityId === String(agentId)) return "Detour Squirrel";
	return names.get(message.entityId) ??
		nameFromGatewayText(message.text) ??
		message.externalHandle ??
		message.entityId;
}

function summarizeSpeakers(
	messages: GatewayMessage[],
	names: Map<string, string>,
	agentId: UUID,
): SpeakerSummary[] {
	const summaries = new Map<string, SpeakerSummary>();
	for (const message of messages) {
		if (message.direction !== "in" || message.entityId === String(agentId)) continue;
		const name = speakerName(message, names, agentId);
		const summary = summaries.get(message.entityId) ?? {
			entityId: message.entityId,
			name,
			...(message.externalHandle ? { externalHandle: message.externalHandle } : {}),
			messageCount: 0,
			lastSeen: 0,
			samples: [],
		};
		summary.name = name;
		if (message.externalHandle) summary.externalHandle = message.externalHandle;
		summary.messageCount += 1;
		summary.lastSeen = Math.max(summary.lastSeen, message.time);
		const sample = compactText(stripDiscordPrefix(message.text));
		if (sample && !summary.samples.includes(sample)) summary.samples = [sample, ...summary.samples].slice(0, 2);
		summaries.set(message.entityId, summary);
	}
	return [...summaries.values()].sort((a, b) => b.lastSeen - a.lastSeen || b.messageCount - a.messageCount);
}

function currentSpeakerLine(message: Memory, speakers: SpeakerSummary[], names: Map<string, string>): string | null {
	const entityId = String(message.entityId ?? "");
	const matched = speakers.find((speaker) => speaker.entityId === entityId);
	const name = matched?.name ?? names.get(entityId) ?? nameFromGatewayText(String(message.content?.text ?? ""));
	if (!name) return null;
	const parts = [`Current speaker: ${name}`];
	if (matched?.externalHandle) parts.push(`discord id ${matched.externalHandle}`);
	if (/dexploarer/i.test(name)) parts.push("Detour's dev/operator; treat as trusted builder context");
	if (matched) parts.push(`${matched.messageCount} recent captured room message${matched.messageCount === 1 ? "" : "s"}`);
	return parts.join(" | ");
}

function recentTurnLines(messages: GatewayMessage[], names: Map<string, string>, agentId: UUID): string[] {
	return messages
		.slice(-MAX_RECENT_TURNS)
		.map((message) => {
			const name = speakerName(message, names, agentId);
			return `- ${name}: ${compactText(stripDiscordPrefix(message.text), 220)}`;
		});
}

function speakerLines(speakers: SpeakerSummary[]): string[] {
	return speakers.slice(0, MAX_PEOPLE).map((speaker) => {
		const samples = speaker.samples.length > 0 ? ` recent: ${speaker.samples.join(" | ")}` : "";
		const dev = /dexploarer/i.test(speaker.name) ? " Detour's dev/operator." : "";
		return `- ${speaker.name}: ${speaker.messageCount} captured room messages.${dev}${samples}`;
	});
}

async function buildDiscordContextForMessage(runtime: IAgentRuntime, message: Memory): Promise<string> {
	if (!isDiscordMessage(message)) return "";
	const names = await discordEntityNames(runtime);
	const roomId = String(message.roomId ?? "");
	const history = readGatewayMessages()
		.filter((entry) => entry.channel === "discord" && (!roomId || entry.roomId === roomId))
		.sort((a, b) => a.time - b.time);
	const speakers = summarizeSpeakers(history, names, runtime.agentId);
	const current = currentSpeakerLine(message, speakers, names);
	const sections: string[] = ["# Discord Context"];
	if (current) sections.push(current);
	if (speakers.length > 0) sections.push("Known Discord people:\n" + speakerLines(speakers).join("\n"));
	if (history.length > 0) sections.push("Recent captured room turns:\n" + recentTurnLines(history, names, runtime.agentId).join("\n"));
	if (sections.length === 1 && names.size === 0) return "";
	sections.push("Use this as factual room context. Do not invent identities, roles, or Discord history beyond it.");
	return sections.join("\n\n").slice(0, 6000);
}

export async function discordContextForMessage(runtime: IAgentRuntime, message: Memory): Promise<string> {
	try {
		return await buildDiscordContextForMessage(runtime, message);
	} catch (error) {
		runtime.logger?.warn(
			{
				src: "detour:discord-context",
				error: error instanceof Error ? error.message : String(error),
				roomId: String(message.roomId ?? ""),
				entityId: String(message.entityId ?? ""),
			},
			"Discord context provider failed",
		);
		return "";
	}
}

export const discordContextProvider: Provider = {
	name: "DISCORD_CONTEXT",
	description: "Known Discord room participants, speaker identity, and persisted recent room history.",
	position: 54,
	relevanceKeywords: ["discord", "who", "context", "people", "room", "server"],
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const text = await discordContextForMessage(runtime, message);
		return {
			text,
			values: { discordContext: text },
			data: { hasDiscordContext: text.length > 0 },
		};
	},
};

export const discordContextPlugin: Plugin = {
	name: "detour-discord-context",
	description: "Adds persisted Discord room identity and conversation context to state composition.",
	providers: [discordContextProvider],
};
