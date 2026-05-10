import type { Message as DiscordMessage } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLongRunningStatusController,
	shouldShowStatusReaction,
} from "../status-reactions";

function discordMessage({
	guild = true,
	mentionedBot = false,
	replyToBot = false,
}: {
	guild?: boolean;
	mentionedBot?: boolean;
	replyToBot?: boolean;
} = {}): DiscordMessage {
	return {
		guild: guild ? { id: "guild-1" } : null,
		mentions: {
			users: {
				has: (id: string) => mentionedBot && id === "bot-1",
			},
			repliedUser: replyToBot ? { id: "bot-1" } : null,
		},
	} as unknown as DiscordMessage;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("shouldShowStatusReaction", () => {
	it("shows group mention reactions for typed bot-name addresses", () => {
		expect(
			shouldShowStatusReaction(
				"group-mentions",
				discordMessage(),
				"bot-1",
				true,
			),
		).toBe(true);
	});

	it("does not show group mention reactions for unrelated group messages", () => {
		expect(
			shouldShowStatusReaction("group-mentions", discordMessage(), "bot-1"),
		).toBe(false);
	});

	it("shows group mention reactions in DMs", () => {
		expect(
			shouldShowStatusReaction(
				"group-mentions",
				discordMessage({ guild: false }),
				"bot-1",
			),
		).toBe(true);
	});
});

describe("createLongRunningStatusController", () => {
	it("sends bounded status updates until stopped", async () => {
		vi.useFakeTimers();
		const send = vi.fn(async () => {});
		const controller = createLongRunningStatusController({
			firstDelayMs: 1_000,
			intervalMs: 2_000,
			maxUpdates: 2,
			send,
		});

		controller.start();
		vi.advanceTimersByTime(999);
		await Promise.resolve();
		expect(send).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await Promise.resolve();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenLastCalledWith("got it, working on it.");

		vi.advanceTimersByTime(2_000);
		await Promise.resolve();
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenLastCalledWith("still working on it.");

		vi.advanceTimersByTime(2_000);
		await Promise.resolve();
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("stops pending status updates", async () => {
		vi.useFakeTimers();
		const send = vi.fn(async () => {});
		const controller = createLongRunningStatusController({
			firstDelayMs: 1_000,
			intervalMs: 2_000,
			maxUpdates: 3,
			send,
		});

		controller.start();
		controller.stop();
		vi.advanceTimersByTime(5_000);
		await Promise.resolve();

		expect(send).not.toHaveBeenCalled();
	});
});
