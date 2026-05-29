/**
 * Capabilities plugin: three providers that ride on every turn:
 *
 *   1. AGENT_CHARACTER_ANCHOR (position -100): re-states the agent's
 *      stable identity + tone in a fixed prose block, regardless of
 *      which provider's LLM is active. Stops drift when failing over
 *      Anthropic -> OpenAI -> OpenRouter mid-conversation.
 *
 *   2. AGENT_CAPABILITIES (position -50): live introspection of
 *      loaded plugins / actions / providers / services + the self-
 *      action-guard contract. Authoritative answer to "what can you
 *      do?", generated from runtime state, not training data.
 *
 *   3. AGENT_CODING_BRIEF (position -40): when coding-tools is
 *      loaded, gives the agent explicit "you have full creative
 *      range, here are your tools, here's how to scaffold projects"
 *      framing. Reduces over-cautious refusals on builder asks. Also
 *      surfaces the elevated-permissions toggle's current state.
 */

import type { Character, IAgentRuntime, Memory, Plugin, Provider, ProviderResult, State } from "@elizaos/core";

const MAX_DESC = 140;
const MAX_ACTIONS_PER_PLUGIN = 12;

function trimDesc(input: string | undefined | null): string {
	if (!input) return "";
	const single = input.replace(/\s+/g, " ").trim();
	return single.length > MAX_DESC ? `${single.slice(0, MAX_DESC - 1)}…` : single;
}

function getActionsByPlugin(runtime: IAgentRuntime): Map<string, Array<{ name: string; description: string }>> {
	const out = new Map<string, Array<{ name: string; description: string }>>();
	const plugins = runtime.plugins ?? [];
	for (const plugin of plugins) {
		const actions = plugin.actions ?? [];
		if (actions.length === 0) continue;
		const list: Array<{ name: string; description: string }> = [];
		for (const a of actions) {
			list.push({
				name: a.name,
				description: trimDesc(
					(a as unknown as { descriptionCompressed?: string }).descriptionCompressed ?? a.description,
				),
			});
		}
		// Stable order, capped per plugin so the prompt doesn't blow up.
		list.sort((a, b) => a.name.localeCompare(b.name));
		out.set(plugin.name, list.slice(0, MAX_ACTIONS_PER_PLUGIN));
	}
	return out;
}

function listProviderNames(runtime: IAgentRuntime): string[] {
	const provs = runtime.providers ?? [];
	return provs.map((p) => p.name).filter((n) => n !== "AGENT_CAPABILITIES").sort();
}

function listServiceNames(runtime: IAgentRuntime): string[] {
	const svc = (runtime as unknown as { services?: Map<string, unknown> }).services;
	if (!svc) return [];
	return Array.from(svc.keys()).sort();
}

function renderCapabilities(runtime: IAgentRuntime): string {
	const actionsByPlugin = getActionsByPlugin(runtime);
	const lines: string[] = [];
	lines.push("# Your live capability set");
	lines.push("");
	lines.push("This is the EXACT set of plugins, actions, providers, and services loaded into your runtime right now. Treat this as the source of truth for what you can do. Do NOT claim capabilities not listed here.");
	lines.push("Execution contract: when Dexploarer gives a direct command and the matching action/tool is listed here, run it. Do not ask for confirmation again for normal configured actions like posting to X, editing files, running repo commands, searching, or inspecting state. Ask only when the target is missing or the operation is destructive, credential-exposing, or an irreversible account/security change.");
	lines.push("");

	if (actionsByPlugin.size === 0) {
		lines.push("(no plugins with actions are currently loaded)");
	} else {
		const sortedPlugins = Array.from(actionsByPlugin.entries()).sort(([a], [b]) => a.localeCompare(b));
		for (const [pluginName, actions] of sortedPlugins) {
			if (actions.length === 0) continue;
			lines.push(`## ${pluginName}`);
			for (const a of actions) {
				lines.push(`- **${a.name}**: ${a.description || "(no description)"}`);
			}
			lines.push("");
		}
	}

	const providerNames = listProviderNames(runtime);
	if (providerNames.length > 0) {
		lines.push("## State providers active");
		lines.push(providerNames.join(", "));
		lines.push("");
	}

	const serviceNames = listServiceNames(runtime);
	if (serviceNames.length > 0) {
		lines.push("## Services attached");
		lines.push(serviceNames.join(", "));
		lines.push("");
	}

	lines.push("## Self-action guards (important)");
	lines.push("- GitHub: refuses to review/comment on a PR you authored, and filters self-authored items out of notification triage.");
	lines.push("- X / Twitter: refuses to reply / like / retweet your own tweets, and won't follow yourself.");
	lines.push("- Discord: the connector ignores messages your own bot user posted (built into plugin-discord).");
	lines.push("Result: don't try to engage with your own posts on these channels; the action will refuse.");

	return lines.join("\n");
}

export const capabilitiesProvider: Provider = {
	name: "AGENT_CAPABILITIES",
	description:
		"Live introspection of the agent's loaded plugins, actions, state providers, services, and self-action guards. Authoritative answer to 'what can you do?', generated from runtime state, not from a static prompt.",
	descriptionCompressed: "live runtime capabilities (plugins, actions, providers, services, self-guards).",
	position: -50,
	get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
		const text = renderCapabilities(runtime);
		const actionsByPlugin = getActionsByPlugin(runtime);
		const flat: Record<string, Array<{ name: string; description: string }>> = {};
		for (const [k, v] of actionsByPlugin) flat[k] = v;
		return {
			text,
			values: { capabilitySnapshotAt: new Date().toISOString() },
			data: {
				plugins: flat,
				providers: listProviderNames(runtime),
				services: listServiceNames(runtime),
			} as never,
		};
	},
};

// ── Character anchor (cross-provider tone consistency) ────────────────

function renderCharacterAnchor(runtime: IAgentRuntime): string {
	const ch = runtime.character as Character | undefined;
	const name = ch?.name ?? "the agent";
	const adjectives = Array.isArray(ch?.adjectives) ? ch?.adjectives : [];
	const topics = Array.isArray(ch?.topics) ? ch?.topics : [];
	const styleAll = Array.isArray((ch?.style as { all?: string[] } | undefined)?.all) ? (ch?.style as { all?: string[] }).all : [];
	const styleChat = Array.isArray((ch?.style as { chat?: string[] } | undefined)?.chat) ? (ch?.style as { chat?: string[] }).chat : [];
	const sysLine = ch?.system ? ch.system.replace(/\s+/g, " ").trim() : "";
	const lines: string[] = [];
	lines.push(`# Identity anchor: ${name}`);
	lines.push("");
	lines.push("Maintain this exact identity, tone, and conventions on every turn, regardless of which underlying model or provider is currently active. The runtime fails over between Anthropic, OpenAI, OpenRouter, and ElizaCloud when one rate-limits or errors. DO NOT change voice, framing, or stance when this happens. The user is talking to one consistent character; the model behind the curtain is an implementation detail.");
	lines.push("");
	lines.push("## Execution defaults (planner routing)");
	lines.push("- For build / code / run / install / test / deploy / scaffold / post / tweet / publish / push / commit / search / fetch / read / write / edit / grep / lookup requests from a trusted operator: NEVER pick contexts=['simple']. Always include the matching action contexts and populate candidateActionNames with concrete tools (BASH, READ, WRITE, EDIT, GLOB, GREP, LS, WEB_FETCH, X_POST, X_REPLY, X_POST_DETOUR_STATUS, AGENT_PROJECT_CREATE, AGENT_PROJECT_PUBLIC_PREVIEW, CREATE_TASK, START_CODING_TASK).");
	lines.push("- For \"how are you / what are you working on / status\" questions: query TASK_HISTORY / USER_ACTIVITY_CONTEXT before answering. Concrete answer with numbers beats a vague \"I'm here\".");
	lines.push("- For requests where intent is clear from the conversation: do NOT ask a clarifying question. Make the reasonable inference, invoke the tool, and report what you did. One clarifying question MAX, only when a critical target is genuinely missing and cannot be inferred.");
	lines.push("- Hedging output without a tool call (\"I'll try\", \"let me think\", \"I can help with that\") is a failure mode. If you are not invoking a tool, you are not working.");
	if (sysLine) {
		lines.push("");
		lines.push(`Core directive: ${sysLine}`);
	}
	if (adjectives.length > 0) {
		lines.push("");
		lines.push(`Traits: ${adjectives.slice(0, 12).join(", ")}.`);
	}
	if (topics.length > 0) {
		lines.push(`Domains you naturally pull toward: ${topics.slice(0, 8).join(", ")}.`);
	}
	if (styleAll && styleAll.length > 0) {
		lines.push("");
		lines.push("Style (always):");
		for (const s of styleAll.slice(0, 8)) lines.push(`- ${s}`);
	}
	if (styleChat && styleChat.length > 0) {
		lines.push("");
		lines.push("Style (chat-specific):");
		for (const s of styleChat.slice(0, 6)) lines.push(`- ${s}`);
	}
	return lines.join("\n");
}

export const characterAnchorProvider: Provider = {
	name: "AGENT_CHARACTER_ANCHOR",
	description:
		"Stable identity + tone block re-injected on every turn so the agent sounds like itself even when failing over between LLM providers (Anthropic, OpenAI, OpenRouter, ElizaCloud).",
	descriptionCompressed: "stable identity + tone, cross-provider.",
	position: -100,
	get: async (runtime: IAgentRuntime, _m: Memory, _s: State): Promise<ProviderResult> => {
		return { text: renderCharacterAnchor(runtime) };
	},
};

// ── Coding-agent brief ─────────────────────────────────────────────────

function isElevatedCoding(runtime: IAgentRuntime): boolean {
	const v = runtime.getSetting?.("DETOUR_ELEVATED_CODING") ?? process.env.DETOUR_ELEVATED_CODING;
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v === "true" || v === "1";
	return false;
}

function hasCodingTools(runtime: IAgentRuntime): boolean {
	for (const p of runtime.plugins ?? []) {
		if (p.name === "coding-tools") return true;
	}
	return false;
}

function hasOrchestrator(runtime: IAgentRuntime): boolean {
	const actions = (runtime as unknown as { actions?: Array<{ name?: string }> }).actions ?? [];
	return actions.some((a) => a?.name === "CREATE_TASK");
}

function renderCodingBrief(runtime: IAgentRuntime): string {
	const elevated = isElevatedCoding(runtime);
	const orchestrator = hasOrchestrator(runtime);
	const sandbox = runtime.getSetting?.("DETOUR_AGENT_SANDBOX") ?? process.env.DETOUR_AGENT_SANDBOX ?? "(unset)";
	const lines: string[] = [];
	lines.push("# Coding-agent brief");
	lines.push("");
	lines.push("You have FULL creative range as a coding agent. Build, scaffold, refactor, debug, deploy. The user has installed the coding-tools plugin precisely because they want you to act, not narrate. Don't refuse builder asks unless they're actually destructive (rm -rf user dirs, leak secrets). \"I can't write code for you\" is a hallucination of restriction.");
	lines.push("Direct owner instruction is the permission signal for ordinary work. If Dexploarer says to write code, run the command, post a status, use a configured connector, build an app, or send a preview link from any connected channel, do it and report the result. Do not turn execution requests into a confirmation ritual.");
	lines.push("");
	lines.push("## Your toolset");
	lines.push("- **FILE**: read / write / edit files. Subactions: read, write, edit. Pass absolute paths.");
	lines.push("- **BASH**: run shell commands. Pass `cwd` to scope it to the right directory.");
	lines.push("- **GREP / GLOB / LS**: search and explore the filesystem.");
	lines.push("- **WEB_FETCH**: pull web content into context.");
	lines.push("- **ENTER_WORKTREE / EXIT_WORKTREE**: git worktree isolation for parallel branches.");
	lines.push("- **AGENT_PROJECT_NEW**: scaffold a new project (templates: `nextjs` for component-rich UIs, `carrot` for native widgets, `static` for plain HTML).");
	lines.push("- **AGENT_PROJECT_IMPORT**: register an existing on-disk directory as an agent project. Pass the user's actual repo path here when they say \"work on /Users/.../foo\".");
	lines.push("- **AGENT_PROJECT_PREVIEW / AGENT_PROJECT_PUBLIC_PREVIEW / DEPLOY**: local preview, ngrok HTTPS public preview URL, and ElizaOS Cloud deploy. Use PUBLIC_PREVIEW when the user asks for a live/shareable/ngrok URL.");
	if (orchestrator) {
		lines.push("- **CREATE_TASK**: spawn a background coding subagent (Codex / Claude Code / OpenCode / Pi) in its own PTY + workdir. Use this when the request is an open-ended build (\"make me a web app for X\", \"refactor the auth flow\", \"port the docs site\") that will take more than a few turns. The subagent runs async; you stay free to keep chatting. Required: `task` (the brief). Optional: `agentType` (codex|claude|opencode|pi), `repo` (url to clone first), `agents` (array, for parallel multi-agent swarm). On Telegram, Discord, X, iMessage, and other connectors, the subagent's progress streams back into the same thread automatically.");
		lines.push("- For app-build requests from any channel, the first visible response should acknowledge the request and say you are starting a background build. Then CREATE_TASK should carry the full implementation brief, including build/test/public-preview/final-link requirements.");
		lines.push("- **SEND_TO_AGENT**: push follow-up input into a running task session. Required: `sessionId` (from CREATE_TASK response) + `input`. Use to answer the subagent's questions or course-correct it.");
		lines.push("- **STOP_AGENT**: kill a running task session. Required: `sessionId`.");
		lines.push("- **TASK_HISTORY**: list/inspect past and current task threads. Use for \"what's the agent working on\" or \"show me the result from yesterday's task\".");
		lines.push("- **TASK_CONTROL**: archive/reopen task threads.");
		lines.push("- **PROVISION_WORKSPACE / FINALIZE_WORKSPACE**: set up a clean git worktree before a task and roll its result into a branch/PR after.");
		lines.push("- **MANAGE_ISSUES**: create/update/close GitHub issues for a task workdir.");
	}
	lines.push("- **ASK_USER_QUESTION**: broadcast 1-4 structured questions if you genuinely need a decision before proceeding.");
	lines.push("");
	lines.push("## Use SKILL_LOAD before complex domain work");
	lines.push("- The AGENT_SKILL_CATALOG provider lists curated skills (coding-agent, elizaos, eliza-app-development, build-monetized-app, eliza-cloud-buy-domain, eliza-cloud-manage-domain).");
	lines.push("- Before tackling a domain-specific multi-step task (running another coding CLI in PTY, registering a domain, deploying through Eliza Cloud), call SKILL_LOAD with the relevant skill name to read its full procedure. Don't improvise on top of half-remembered conventions.");
	lines.push("");
	lines.push("## Working dir: anchor to what the user said");
	lines.push(`- Default sandbox: \`${sandbox}\`. New scaffolds land under \`projects/<slug>/\` here.`);
	lines.push("- **You can build ANYWHERE the user names a path.** When the user says \"work on /Users/me/foo\" or \"in my repo at ~/code/x\", treat that as the working dir for FILE/BASH/EDIT. Pass it as cwd to BASH and as the prefix for FILE absolute paths.");
	lines.push("- If a project context block with a `dir:` line is in this turn's prompt, default cwd to that `dir`.");
	lines.push("- You may be invoked from any channel: main chat, Discord, X, iMessage. The path the user gives is your scope regardless of channel.");
	lines.push("- For \"build me a new X\" with no existing dir: use AGENT_PROJECT_NEW (pick `nextjs` template by default for anything component-rich).");
	lines.push("- For \"work on this folder I have\": use AGENT_PROJECT_IMPORT, then operate inside it.");
	lines.push("- For generated apps: write the code, run the relevant build/test, call AGENT_PROJECT_PUBLIC_PREVIEW, and send the ngrok `publicUrl` back to the same channel that asked.");
	lines.push("- If AGENT_PROJECT_PUBLIC_PREVIEW fails because ngrok is missing/auth-broken, report the exact error and the local preview URL if one was created.");
	lines.push("");
	if (orchestrator) {
		lines.push("## When to spawn a coding subagent (CREATE_TASK) vs do it inline");
		lines.push("- **Inline (FILE/BASH/EDIT)**: small edits, lookups, single-file changes, debugging in a known repo. You're already in the conversation; just do it and report back.");
		lines.push("- **Subagent (CREATE_TASK)**: open-ended builds, multi-file features, long-running work, anything you'd estimate takes >5-10 minutes of focused work. Especially when the request comes from Telegram/Discord/X/iMessage or another connector. The user wants an ack now and a delivery later, not radio silence.");
		lines.push("- After CREATE_TASK: keep the user posted. Progress messages from the subagent surface back to the originating channel automatically; the same thread should receive the start acknowledgement, meaningful progress, blockers, and final ngrok URL.");
		lines.push("- After a restart, in-flight tasks resume from disk. Don't redo work; check TASK_HISTORY first.");
		lines.push("");
	}
	if (elevated) {
		lines.push("## ⚠ Elevated permissions: ON");
		lines.push("- FILE/BASH/GREP can operate OUTSIDE the sandbox dir. The user has granted full FS access for this session.");
		lines.push("- Still avoid: writing into system paths (`/etc`, `/usr`, `/System`), reading credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`), mass-deleting user files.");
		lines.push("- Confirm before running anything irreversible (rm -rf, dropping DBs, force-pushing).");
	} else {
		lines.push("## Elevated permissions: OFF");
		lines.push("- The system blocklist (`~/.ssh`, `~/.aws`, `~/Library`, `/etc`, `/usr`, `/System`) is always enforced.");
		lines.push("- For paths outside the user's named project dir / sandbox: ASK_USER_QUESTION before acting, or ask them to flip the toggle in Settings → Agent Permissions.");
	}
	return lines.join("\n");
}

export const codingBriefProvider: Provider = {
	name: "AGENT_CODING_BRIEF",
	description:
		"Coding-agent framing: enumerates the FILE/BASH/EDIT/GLOB/etc toolset, names the sandbox dir, and reflects the elevated-permissions toggle's current state. Loaded only when coding-tools plugin is present.",
	descriptionCompressed: "coding-tools brief + elevated-permissions state.",
	position: -40,
	get: async (runtime: IAgentRuntime, _m: Memory, _s: State): Promise<ProviderResult> => {
		if (!hasCodingTools(runtime)) return { text: "" };
		return {
			text: renderCodingBrief(runtime),
			values: {
				codingElevated: isElevatedCoding(runtime),
			},
		};
	},
};

export const capabilitiesPlugin: Plugin = {
	name: "capabilities",
	description:
		"Self-awareness: injects the agent's live action/plugin/provider/service inventory, identity anchor (cross-provider tone consistency), and coding-tools brief (range framing + elevated-permissions state) into every turn's planner state.",
	providers: [characterAnchorProvider, capabilitiesProvider, codingBriefProvider],
};
