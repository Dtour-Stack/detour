import type { IAgentRuntime, Plugin, Service } from "@elizaos/core";

declare module "@elizaos/core" {
	interface ServiceTypeRegistry {
		AGENT_SKILLS_SERVICE: "AGENT_SKILLS_SERVICE";
	}
}

declare module "@elizaos/plugin-agent-skills" {
	type SkillRecord = {
		slug: string;
		name: string;
		description: string;
		source?: string;
		sourceDir?: string;
		path?: string;
		enabled?: boolean;
	};

	export type SkillSource = "workspace" | "managed" | "bundled" | "plugin" | "extra";
	export type SkillFrontmatter = {
		name: string;
		description: string;
		metadata?: Record<string, string | number | boolean | object | undefined>;
	};
	export type LoadedSkillWithSource = SkillRecord & {
		version: string;
		content: string;
		frontmatter: SkillFrontmatter;
		path: string;
		scripts: string[];
		references: string[];
		assets: string[];
		loadedAt: number;
		source: SkillSource;
		sourceDir: string;
		precedence: number;
		bundledDir?: string;
	};
	export type PromptToonOptions = {
		includeLocation?: boolean;
		maxSkills?: number;
	};
	export type CacheOptions = {
		notOlderThan?: number;
		forceRefresh?: boolean;
	};
	export type SkillInstructions = {
		slug: string;
		body: string;
		estimatedTokens: number;
	};
	export type SkillEligibility = {
		slug: string;
		eligible: boolean;
		reasons: Array<{
			type: "bin" | "env" | "config";
			missing: string;
			message: string;
			suggestion?: string;
		}>;
		checkedAt: number;
	};
	export type SkillCatalogEntry = {
		slug: string;
		displayName: string;
		summary: string | null;
		version: string;
		tags: Record<string, string>;
		stats: { downloads: number; stars: number };
		updatedAt: number;
	};
	export type SkillSearchResult = {
		score: number;
		slug: string;
		displayName: string;
		summary: string;
		version: string;
		updatedAt: number;
	};
	export type SkillDetails = {
		skill: {
			slug: string;
			displayName: string;
			summary: string;
			tags: Record<string, string>;
			stats: { downloads: number; stars: number; versions: number };
			createdAt: number;
			updatedAt: number;
		};
		latestVersion: { version: string; createdAt: number; changelog?: string };
		owner?: { handle: string; displayName: string; image?: string };
	};

	export const SKILL_SOURCE_PRECEDENCE: Record<SkillSource, number>;
	export function parseFrontmatter(content: string): {
		frontmatter: SkillFrontmatter | null;
		body: string;
		raw: string;
	};
	export function extractBody(content: string): string;
	export function estimateTokens(text: string): number;
	export function generateSkillsToon(
		skills: Array<{ name: string; description: string; location?: string }>,
		options?: { includeLocation?: boolean },
	): string;

	export class AgentSkillsService extends Service {
		static serviceType: string;
		static start(runtime: IAgentRuntime, config?: object): Promise<AgentSkillsService>;
		static stop(runtime: IAgentRuntime): Promise<void>;
		capabilityDescription: string;
		constructor(runtime?: IAgentRuntime, config?: object);
		initialize(): Promise<void>;
		stop(): Promise<void>;
		getLoadedSkills(): SkillRecord[];
		getCatalogStats(): {
			loaded: number;
			total: number;
			storageType: string;
		};
	}

	export const agentSkillsPlugin: Plugin;
	export default agentSkillsPlugin;
}
