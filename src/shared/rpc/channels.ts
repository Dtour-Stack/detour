import type { ChannelsSnapshot } from "../index";

/**
 * Discord catch-up result wire shape. Returned by
 * `channelsDiscordCatchUp` when `wait` is truthy. `errorDetails` is
 * optional because the bun-side `DiscordCatchUpResult` always carries
 * it but call sites tolerate undefined.
 */
export type ChannelsDiscordCatchUpResult = {
	channelsScanned: number;
	messagesScanned: number;
	addressed: number;
	alreadyAnswered: number;
	replied: number;
	errors: number;
	errorDetails?: Array<{ channelId: string; channelName?: string; error: string }>;
};

export type ChannelsDiscordGuild = {
	id: string;
	name: string;
	channels: Array<{ id: string; name: string; type: number }>;
};

export type ChannelsRequests = {
	channelsList: {
		params: Record<string, never>;
		response: ChannelsSnapshot;
	};
	channelsSetCredential: {
		params: { key: string; value: string; skipValidate?: boolean };
		response: { ok: true; reloadScheduled: true; validated: boolean };
	};
	channelsClearCredential: {
		params: { key: string };
		response: { ok: true; reloadScheduled: true };
	};
	channelsReload: {
		params: Record<string, never>;
		response: { ok: true; reloadScheduled: true };
	};
	channelsDiscordGuilds: {
		params: Record<string, never>;
		response: { guilds: ChannelsDiscordGuild[] };
	};
	channelsDiscordBackfill: {
		params: { channelId: string; limit?: number; force?: boolean };
		response: { ok: true; scheduled: true; channelId: string };
	};
	channelsDiscordCatchUp: {
		params: { channelId?: string; limit?: number; maxAgeHours?: number; wait?: boolean };
		response: {
			ok: true;
			scheduled: boolean;
			channelId?: string;
			result?: ChannelsDiscordCatchUpResult;
		};
	};
};
