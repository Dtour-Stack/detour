import type { ChatCommandInfo } from "../../../../shared/index";
import { codexSkillChatCommands } from "../../codex-skills";
import type { RpcDeps } from "../types";
import { newTraceId, traceScope } from "../../trace";

/**
 * Native (bun-resident) chat commands the command palette renders.
 * Skill-derived commands will be appended once the codex-skills loader
 * is ported (origin/main 88230a81). Aliases let users discover the
 * canonical name; insertion text is what the palette puts in the chat
 * composer when picked.
 */
const NATIVE_CHAT_COMMANDS: ChatCommandInfo[] = [
	{ name: "/browser", usage: "/browser <url or search>", description: "Open the agent browser.", insert: "/browser ", aliases: ["/open", "/web", "/internet"], source: "native" },
	{ name: "/inspect", usage: "/inspect", description: "Read the active browser tab.", insert: "/inspect", aliases: ["/read-page"], source: "native" },
	{ name: "/browser-screenshot", usage: "/browser-screenshot", description: "Take a screenshot of the agent browser.", insert: "/browser-screenshot", aliases: ["/screenshot-browser"], source: "native" },
	{ name: "/screenshot", usage: "/screenshot", description: "Take a screenshot of the computer screen.", insert: "/screenshot", aliases: ["/screen", "/computer-screenshot"], source: "native" },
	{ name: "/script", usage: "/script <javascript>", description: "Run JavaScript in the browser tab.", insert: "/script ", aliases: ["/js"], source: "native" },
	{ name: "/logins", usage: "/logins [domain]", description: "List saved logins from vault backends.", insert: "/logins ", aliases: ["/passwords"], source: "native" },
	{ name: "/login", usage: "/login <source> <identifier> [url]", description: "Fill a saved login in the browser.", insert: "/login 1password ", source: "native" },
	{ name: "/1password", usage: "/1password <identifier> [url]", description: "Fill a 1Password login in the browser.", insert: "/1password ", aliases: ["/op"], source: "native" },
	{ name: "/codex", usage: "/codex [cwd=/path] <task>", description: "Run a Codex coding subagent and wait for the result.", insert: "/codex ", aliases: ["/task"], source: "native" },
	{ name: "/claude", usage: "/claude [cwd=/path] <task>", description: "Run a Claude coding subagent and wait for the result.", insert: "/claude ", source: "native" },
	{ name: "/spawn-codex", usage: "/spawn-codex [cwd=/path] <task>", description: "Start a Codex coding subagent in the background.", insert: "/spawn-codex ", source: "native" },
	{ name: "/spawn-claude", usage: "/spawn-claude [cwd=/path] <task>", description: "Start a Claude coding subagent in the background.", insert: "/spawn-claude ", source: "native" },
	{ name: "/video", usage: "/video <prompt>", description: "Generate a video via ElizaCloud and save it to Gallery.", insert: "/video ", source: "native" },
	{ name: "/gallery", usage: "/gallery", description: "Open generated media gallery.", insert: "/gallery", source: "native" },
	{ name: "/help", usage: "/help", description: "Show native chat commands.", insert: "/help", aliases: ["/commands"], source: "native" },
];

/**
 * Chat streaming RPC handler. Replaces the WS `chat:send` path.
 *
 * Flow:
 *   1. View calls `rpc.request.chatSend({ convId, text })`.
 *   2. Handler opens a trace scope (so eliza pipeline logs correlate
 *      with the turn) and dispatches via `runtime.sendMessage`.
 *   3. On every delta, broadcasts `chatDelta`. On idle 1.5s after the
 *      last delta, broadcasts `chatComplete`. On error, broadcasts
 *      `chatError`.
 *   4. The request promise resolves `{ ok: true }` once the call
 *      returns from runtime.sendMessage (independent of when the
 *      delta-stream-idle completion fires).
 *
 * Note: matches the legacy WS handler's idle-detection completion
 * pattern (1.5s after last delta, since runtime.sendMessage doesn't
 * itself signal end-of-turn).
 */
/**
 * Active chat turn tracker, keyed by convId. Populated when chatSend
 * starts a turn; consulted by chatCancel to abort it. Module-level
 * because there's at most one active turn per convId per process and
 * the cancel closure captures local refs to fireComplete / cancelled
 * / idleTimer that are scoped to the chatSend invocation.
 */
const activeChatTurns = new Map<string, { traceId: string; cancel: () => void }>();

export function chatRequests(deps: RpcDeps) {
	return {
		chatSend: async (params: { convId: string; text: string }): Promise<{ ok: true; traceId: string }> => {
			// Fire-and-forget. The actual chat turn can take 30-180s (model
			// generation + tool chains); a synchronous await of that here
			// gates the RPC on it and the WindowFactory's maxRequestTime
			// fires long before the work is done — the view sees "RPC
			// request timed out" while the bun-side is still streaming
			// deltas. Instead we ack immediately and stream progress
			// purely through chatDelta / chatComplete / chatError. The
			// view never awaits the heavy lifting.
			const { convId, text } = params;
			const traceId = newTraceId();
			let completeFired = false;
			let cancelled = false;
			let idleTimer: ReturnType<typeof setTimeout> | null = null;
			const clearActive = () => {
				const active = activeChatTurns.get(convId);
				if (active?.traceId === traceId) activeChatTurns.delete(convId);
			};
			const fireComplete = () => {
				if (cancelled || completeFired) return;
				completeFired = true;
				if (idleTimer) clearTimeout(idleTimer);
				clearActive();
				deps.broadcaster.broadcast("chatComplete", { convId, traceId });
			};
			const cancel = () => {
				if (cancelled || completeFired) return;
				cancelled = true;
				completeFired = true;
				if (idleTimer) clearTimeout(idleTimer);
				clearActive();
				// Fire chatComplete so the view spins down. No chatError —
				// cancellation is a deliberate user action, not a failure.
				deps.broadcaster.broadcast("chatComplete", { convId, traceId });
			};
			const armIdle = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(fireComplete, 1500);
			};
			// Pre-cancel any in-flight turn for the same conv (e.g. user
			// rapidly hitting send) so streams don't interleave.
			activeChatTurns.get(convId)?.cancel();
			activeChatTurns.set(convId, { traceId, cancel });
			void (async () => {
				try {
					await traceScope(traceId, async () => {
						try {
							await deps.runtime.sendMessage(text, (delta) => {
								if (cancelled) return;
								deps.broadcaster.broadcast("chatDelta", { convId, delta, traceId });
								armIdle();
							});
							fireComplete();
						} catch (err) {
							if (cancelled) return;
							if (idleTimer) clearTimeout(idleTimer);
							clearActive();
							const message = err instanceof Error ? err.message : String(err);
							deps.broadcaster.broadcast("chatError", { convId, message, traceId });
						}
					});
				} catch (err) {
					console.warn("[chatSend] traceScope error:", err instanceof Error ? err.message : err);
				}
			})();
			return { ok: true, traceId };
		},

		/**
		 * Thumbs feedback on an agent reply. Writes a Pensieve memory
		 * tagged `feedback` + `chat-rate` with the trace id, conv id,
		 * rating, and (optionally) the assistant text snippet that was
		 * being rated. The activity tab can later join this against the
		 * trajectory log via traceId for a "human-feedback signal" view.
		 */
		chatRateMessage: async (params: {
			traceId: string;
			convId: string;
			rating: 1 | -1;
			text?: string;
		}): Promise<{ ok: true }> => {
			const { traceId, convId, rating, text } = params;
			try {
				const ratingLabel = rating > 0 ? "thumbs-up" : "thumbs-down";
				await deps.pensieve.memories.create({
					text: text
						? `[${ratingLabel}] ${text.slice(0, 500)}`
						: `[${ratingLabel}] (no snippet)`,
					type: "feedback",
					path: `feedback/chat/${traceId}`,
					tags: ["feedback", "chat-rate", ratingLabel],
					extraMetadata: { traceId, convId, rating },
				});
			} catch (err) {
				console.warn(
					"[chat.rate] failed to record feedback:",
					err instanceof Error ? err.message : err,
				);
			}
			return { ok: true };
		},
		chatCancel: async (params: { convId: string }): Promise<{ ok: true }> => {
			activeChatTurns.get(params.convId)?.cancel();
			return { ok: true };
		},
		listChatCommands: async (_params: Record<string, never>): Promise<{ commands: ChatCommandInfo[] }> => {
			// Skill-derived commands are deduped after natives so a skill
			// can't shadow a native by collision (matches origin's
			// `byName.set` only-if-absent behavior).
			const byName = new Map<string, ChatCommandInfo>();
			for (const command of [
				...NATIVE_CHAT_COMMANDS,
				{ name: "/skills", usage: "/skills", description: "List installed Codex skills.", insert: "/skills", source: "native" as const },
				{ name: "/skill", usage: "/skill <name> <task>", description: "Run a Codex skill against a task.", insert: "/skill ", source: "native" as const },
				...codexSkillChatCommands(),
			]) {
				if (!byName.has(command.name)) byName.set(command.name, command);
			}
			return { commands: [...byName.values()] };
		},
	};
}

/**
 * View → bun fire-and-forget messages for the chat group. Currently
 * only carries the command-palette round-trip — palette posts
 * chatCommandRun, bun fans it out to every window so the chat view
 * (whichever window holds it) inserts the command into its composer.
 */
export function chatMessages(deps: RpcDeps) {
	return {
		chatCommandRun: (payload: { command: { text: string; submit: boolean } }) => {
			deps.broadcaster.broadcast("chatCommandRun", payload);
		},
	};
}
