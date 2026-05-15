/**
 * Companion job prompt templates.
 *
 * Each job is a small, terse text-completion task the companion runs
 * against a tiny base model (default: eliza-1 0.6B). The prompts are
 * deliberately short — total budget ≤500 tokens per call — so the 0.6B
 * keeps end-to-end latency under ~200ms.
 *
 * Pure functions; no I/O. The companion-service.ts module composes
 * these prompts and POSTs them at /v1/completions on the local model.
 *
 * Design rule for every job: the LAST line of the prompt is the cue
 * the model continues. Base models (un-fine-tuned) work best when the
 * structure leaves them only one obvious thing to do next.
 */

/**
 * Triage classifier. Decides whether the input is something the
 * planner / cloud big model needs to handle, or whether the companion
 * (or a deterministic shortcut) can resolve it locally.
 *
 *   "chat"     — short conversational reply; companion alone can handle
 *   "tool"     — needs an action (GENERATE_IMAGE, CREATE_TASK, etc)
 *   "search"   — needs grounded data the planner should fetch
 *   "complex"  — needs multi-step reasoning; planner required
 *   "skip"     — passive / off-topic; ignore
 */
export type TriageLabel = "chat" | "tool" | "search" | "complex" | "skip";

export function triagePrompt(userText: string): {
	input: string;
	stop: string[];
	maxTokens: number;
} {
	const safe = userText.replace(/\s+/g, " ").slice(0, 600);
	const input = [
		"Classify the user's message into one of: chat / tool / search / complex / skip.",
		"chat     = short reply, no tool, no extra data needed",
		"tool     = needs an action (image gen, task creation, posting, fetching)",
		"search   = needs information lookup before reply",
		"complex  = multi-step reasoning required",
		"skip     = passive, off-topic, or no reply needed",
		"",
		"Examples:",
		"Message: hey what's up",
		"Label: chat",
		"Message: generate an image of a cat",
		"Label: tool",
		"Message: what's the weather in tokyo right now",
		"Label: search",
		"Message: explain how RAG and tool-use combine in an agent loop",
		"Label: complex",
		"Message: lol",
		"Label: skip",
		"",
		`Message: ${safe}`,
		"Label:",
	].join("\n");
	return { input, stop: ["\n", "Message:"], maxTokens: 6 };
}

/**
 * Parse the model's triage reply into a TriageLabel. Falls back to
 * "complex" when output is unrecognizable — the safe default that
 * keeps the planner in the loop.
 */
export function parseTriageOutput(text: string): TriageLabel {
	const t = text.toLowerCase().trim();
	if (t.startsWith("chat")) return "chat";
	if (t.startsWith("tool")) return "tool";
	if (t.startsWith("search")) return "search";
	if (t.startsWith("complex")) return "complex";
	if (t.startsWith("skip") || t.startsWith("ignore")) return "skip";
	return "complex";
}

/**
 * Should-respond gate for background observation ticks (Discord, X_AUTONOMY).
 * Given the latest batch of channel messages + the agent's identity,
 * decide if any message warrants a turn. Output: "yes" or "no" + reason.
 *
 * Goal: cut wasted planner ticks on rooms where nothing addressable to
 * the agent has happened.
 */
export function shouldRespondPrompt(
	agentName: string,
	channel: string,
	recentMessages: { author: string; text: string }[],
): { input: string; stop: string[]; maxTokens: number } {
	const lines = recentMessages
		.slice(-12)
		.map((m) => `${m.author}: ${m.text.replace(/\s+/g, " ").slice(0, 240)}`)
		.join("\n");
	const input = [
		`Channel: ${channel}`,
		`Agent identity: ${agentName}`,
		"",
		"Recent messages:",
		lines,
		"",
		"Question: Does any of the above invite the agent to respond, mention the agent by name, ask a question, or otherwise warrant a reply?",
		"Answer with a single word: yes or no.",
		"Answer:",
	].join("\n");
	return { input, stop: ["\n", "Question:"], maxTokens: 4 };
}

export function parseShouldRespondOutput(text: string): boolean {
	return /^\s*(yes|y|true)/i.test(text);
}

/**
 * Memory query rewrite. Given a user's input (often vague:
 * "what was that thing we talked about"), produce 1-3 retrieval
 * queries the Pensieve embedding store can search on.
 */
export function memoryQueryPrompt(userText: string): {
	input: string;
	stop: string[];
	maxTokens: number;
} {
	const safe = userText.replace(/\s+/g, " ").slice(0, 600);
	const input = [
		"Rewrite the user's message into 1-3 short retrieval queries for an embedding-based memory store.",
		"Each query is a noun-phrase or short question, one per line.",
		"Examples:",
		"Message: what was that thing we talked about?",
		"Queries:",
		"- topic the user mentioned previously",
		"- recent conversation thread",
		"",
		"Message: remind me what tools my agent has",
		"Queries:",
		"- agent's available actions",
		"- registered tools",
		"- tool capabilities list",
		"",
		`Message: ${safe}`,
		"Queries:",
	].join("\n");
	return { input, stop: ["\nMessage:", "Message:"], maxTokens: 80 };
}

export function parseMemoryQueryOutput(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.replace(/^[\s\-*]+/, "").trim())
		.filter((l) => l.length > 0 && l.length < 200)
		.slice(0, 3);
}

/**
 * Context compression. Squashes a long conversation history into a
 * short summary (~150-300 tokens) suitable for ferrying to the planner.
 * Used when the recent-messages block in composed state exceeds a
 * configurable budget — direct prompt-cost savings.
 */
export function compressPrompt(history: string, targetTokens = 200): {
	input: string;
	stop: string[];
	maxTokens: number;
} {
	const safe = history.replace(/\r/g, "").slice(0, 6_000);
	const input = [
		`Summarize the conversation below in roughly ${targetTokens} tokens.`,
		"Keep: user goals, decisions made, open questions, named entities.",
		"Drop: pleasantries, repeated content, transient errors.",
		"Output: a single paragraph, no bullet points, no headings.",
		"",
		"Conversation:",
		safe,
		"",
		"Summary:",
	].join("\n");
	return { input, stop: ["\n\n", "Conversation:"], maxTokens: targetTokens * 2 };
}

/**
 * Light persona pre-pass. Rewrites the user's input into a more
 * structured frame the planner can react to in-voice. The result is
 * an "intent + framing" line, not a replacement for the user's text.
 *
 * The planner still sees the ORIGINAL user message — this is
 * additional context, NEVER a substitution. Compounding errors stay
 * bounded because the planner can ignore a bad frame.
 */
export function personaPrePassPrompt(
	agentName: string,
	userText: string,
): { input: string; stop: string[]; maxTokens: number } {
	const safe = userText.replace(/\s+/g, " ").slice(0, 600);
	const input = [
		`${agentName} is about to reply to a user message. Frame the user's intent in one short sentence the assistant can read before drafting its reply.`,
		"Do not answer the message. Do not add commentary. Output one sentence describing the user's intent.",
		"",
		"Examples:",
		"Message: hey can you ship that feature today",
		"Frame: User is checking on delivery timing for a specific in-progress feature; reply should commit or update the estimate.",
		"",
		"Message: roast my code",
		"Frame: User wants candid, sharp critique of code they're about to share; tone permission for direct feedback.",
		"",
		`Message: ${safe}`,
		"Frame:",
	].join("\n");
	return { input, stop: ["\nMessage:", "\n\n"], maxTokens: 60 };
}
