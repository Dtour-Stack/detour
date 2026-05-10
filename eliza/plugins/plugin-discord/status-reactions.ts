import type { Message as DiscordMessage } from "discord.js";

export type StatusReactionScope = "all" | "group-mentions" | "none";

export interface StatusReactionController {
	setQueued: () => void;
	setThinking: () => void;
	setDone: () => void;
	setError: () => void;
}

export interface StatusReactionControllerOptions {
	onError?: (error: unknown, emoji: string) => void;
}

export interface LongRunningStatusController {
	start: () => void;
	stop: () => void;
}

export interface LongRunningStatusControllerOptions {
	firstDelayMs: number;
	intervalMs: number;
	maxUpdates: number;
	send: (content: string) => Promise<void>;
	onError?: (error: unknown) => void;
	messages?: readonly string[];
}

const EMOJI_QUEUED = "⏳";
const EMOJI_THINKING = "🤔";
const EMOJI_DONE = "✅";
const EMOJI_ERROR = "❌";
const DEFAULT_LONG_RUNNING_STATUS_MESSAGES = [
	"got it, working on it.",
	"still working on it.",
	"still working; this one is taking longer than usual.",
] as const;

export function shouldShowStatusReaction(
	scope: StatusReactionScope,
	message: DiscordMessage,
	botId: string | undefined,
	addressedByName = false,
): boolean {
	if (scope === "none") {
		return false;
	}
	if (scope === "all") {
		return true;
	}

	if (!message.guild) {
		return true;
	}

	const isMentioned =
		addressedByName || Boolean(botId && message.mentions.users?.has(botId));
	const isReplyToBot = message.mentions.repliedUser?.id === botId;
	return isMentioned || isReplyToBot;
}

export function createLongRunningStatusController(
	options: LongRunningStatusControllerOptions,
): LongRunningStatusController {
	const messages =
		options.messages && options.messages.length > 0
			? options.messages
			: DEFAULT_LONG_RUNNING_STATUS_MESSAGES;
	let started = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let sentCount = 0;

	const clearTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const schedule = (delayMs: number) => {
		clearTimer();
		if (stopped || sentCount >= options.maxUpdates) {
			return;
		}
		timer = setTimeout(() => {
			void sendNext();
		}, delayMs);
	};

	const sendNext = async () => {
		if (stopped || sentCount >= options.maxUpdates) {
			return;
		}
		const message = messages[Math.min(sentCount, messages.length - 1)];
		sentCount += 1;
		try {
			await options.send(message);
		} catch (error) {
			options.onError?.(error);
		}
		if (!stopped && sentCount < options.maxUpdates) {
			schedule(options.intervalMs);
		}
	};

	return {
		start: () => {
			if (started) {
				return;
			}
			started = true;
			schedule(options.firstDelayMs);
		},
		stop: () => {
			stopped = true;
			clearTimer();
		},
	};
}

export function createStatusReactionController(
	message: DiscordMessage,
	options: StatusReactionControllerOptions = {},
): StatusReactionController {
	let currentEmoji: string | null = null;
	let finished = false;
	let chain: Promise<void> = Promise.resolve();
	const botId = message.client?.user?.id;

	const transition = (emoji: string, terminal = false) => {
		if (finished) {
			return;
		}
		chain = chain.then(async () => {
			if (finished && !terminal) {
				return;
			}

			try {
				if (currentEmoji && currentEmoji !== emoji && botId) {
					try {
						const reaction = message.reactions.resolve(currentEmoji);
						if (reaction) {
							await reaction.users.remove(botId);
						}
					} catch {
						// Ignore missing permissions or already-removed reactions.
					}
				}

				await message.react(emoji);
				currentEmoji = emoji;
			} catch (error) {
				options.onError?.(error, emoji);
			} finally {
				if (terminal) {
					finished = true;
				}
			}
		});
	};

	return {
		setQueued: () => transition(EMOJI_QUEUED),
		setThinking: () => transition(EMOJI_THINKING),
		setDone: () => transition(EMOJI_DONE, true),
		setError: () => transition(EMOJI_ERROR, true),
	};
}
