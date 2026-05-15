/**
 * Skills RPC — read-only listing of skills the agent can use, sourced
 * from `@elizaos/skills` (bundled, managed, curated, project).
 *
 * UI surface: Settings → Configuration → Skills.
 *
 * Mutations (install / uninstall / toggle) flow through the agent
 * runtime's `plugin-agent-skills` actions, not directly through this
 * RPC. This namespace stays read-only on purpose — the agent owns its
 * skill state.
 */

export type SkillSourceTag = "bundled" | "managed" | "curated" | "project" | "unknown";

export type SkillSummary = {
	name: string;
	description: string;
	source: SkillSourceTag;
	filePath: string | null;
	baseDir: string | null;
	emoji: string | null;
};

export type SkillsListResponse = {
	bundledDir: string | null;
	skills: SkillSummary[];
};

export type SkillsRequests = {
	skillsList: {
		params: Record<string, never>;
		response: SkillsListResponse;
	};
	skillsOpenDir: {
		params: { path: string };
		response: { ok: true };
	};
};
