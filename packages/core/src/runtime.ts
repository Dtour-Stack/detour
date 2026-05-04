import {
	AgentRuntime,
	ChannelType,
	type Character,
	createCharacter,
	createMessageMemory,
	type Plugin,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import type { ProviderId } from "@detour/shared";
import type { VaultService } from "./vault";

const ROOM_ID = stringToUuid("tray-app:default-room");
const WORLD_ID = stringToUuid("tray-app:default-world");
const USER_ID = uuidv4() as UUID;

type RuntimeState = {
	runtime: AgentRuntime;
	provider: ProviderId;
};

const PROVIDER_PLUGINS: Record<ProviderId, () => Promise<Plugin>> = {
	anthropic: async () => (await import("@elizaos/plugin-anthropic")).default,
	openai: async () => (await import("@elizaos/plugin-openai")).default,
};

export class RuntimeService {
	private current: RuntimeState | null = null;
	private buildPromise: Promise<RuntimeState | null> | null = null;

	constructor(private readonly vault: VaultService) {}

	async getOrBuild(): Promise<RuntimeState | null> {
		if (this.current) return this.current;
		if (!this.buildPromise) {
			this.buildPromise = this.build()
				.then((state) => {
					this.current = state;
					return state;
				})
				.finally(() => {
					this.buildPromise = null;
				});
		}
		return this.buildPromise;
	}

	async rebuild(): Promise<RuntimeState | null> {
		if (this.current) {
			try {
				await this.current.runtime.stop();
			} catch (err) {
				console.error("Failed to stop runtime cleanly:", err);
			}
			this.current = null;
		}
		return this.getOrBuild();
	}

	getCurrentProvider(): ProviderId | null {
		return this.current?.provider ?? null;
	}

	async sendMessage(
		text: string,
		onDelta: (delta: string) => void,
	): Promise<void> {
		const state = await this.getOrBuild();
		if (!state) {
			throw new Error("No LLM provider configured. Add an API key in Settings.");
		}
		const service = state.runtime.messageService;
		if (!service) {
			throw new Error(
				"Agent runtime has no messageService — check that @elizaos/plugin-sql initialised correctly.",
			);
		}
		const message = createMessageMemory({
			id: uuidv4() as UUID,
			entityId: USER_ID,
			roomId: ROOM_ID,
			content: { text, source: "tray-app", channelType: ChannelType.DM },
		});
		await service.handleMessage(state.runtime, message, async (content) => {
			if (content?.text) onDelta(content.text);
			return [];
		});
	}

	private async build(): Promise<RuntimeState | null> {
		const provider = await this.vault.loadKeysIntoEnv();
		if (!provider) return null;

		const llmPlugin = await PROVIDER_PLUGINS[provider]();
		const character: Character = createCharacter({
			name: "Eliza",
			bio: "A helpful assistant living in your menu bar.",
		});

		const runtime = new AgentRuntime({
			character,
			plugins: [sqlPlugin, llmPlugin],
		});
		await runtime.initialize();

		await runtime.ensureConnection({
			entityId: USER_ID,
			roomId: ROOM_ID,
			worldId: WORLD_ID,
			userName: "User",
			source: "tray-app",
			channelId: "chat",
			type: ChannelType.DM,
		});

		return { runtime, provider };
	}
}
