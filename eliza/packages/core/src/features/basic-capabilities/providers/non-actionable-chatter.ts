import type { Memory } from "../../../types/index.ts";
import { normalizeUserMessageText } from "../../../utils/message-text.ts";

export function normalizeMessageText(message: Memory): string {
	return normalizeUserMessageText(message);
}

export function looksLikeNonActionableChatter(message: Memory): boolean {
	const text = normalizeMessageText(message);
	return (
		looksLikeLightweightSocialTurn(message) ||
		/\bi hate\b.*\b(email|gmail|inbox|mail)\b/.test(text) ||
		/^my calendar has been\b/.test(text) ||
		(/\b(any )?(tips|advice|suggestions?)\b/.test(text) &&
			/\bgoals?\b/.test(text)) ||
		/\bi think i spend\b.*\btoo much time\b.*\b(phone|screen)\b/.test(text) ||
		/^do you think blocking websites\b/.test(text) ||
		/^should i call .*\bor just email\b/.test(text)
	);
}

export function looksLikeLightweightSocialTurn(message: Memory): boolean {
	const text = normalizeMessageText(message).replace(/[.!?]+$/g, "").trim();
	return (
		/^(hey|hi|hello|yo|hiya|heya|howdy|gm|good morning|good afternoon|good evening|sup|what'?s up|whats up)$/.test(
			text,
		) ||
		/^(thanks|thank you|ty|thx|appreciate it|cool|nice|great|ok|okay|k|got it|sounds good|makes sense|lol|haha)$/.test(
			text,
		)
	);
}

export function looksLikeRelationshipFollowUpReminder(
	message: Memory,
): boolean {
	const text = normalizeMessageText(message);
	return (
		/\bfollow up with\b/.test(text) &&
		/\b(next\s+(week|month)|tomorrow|today|tonight|this\s+week|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d)\b/.test(
			text,
		) &&
		!/\bevery\b/.test(text)
	);
}
