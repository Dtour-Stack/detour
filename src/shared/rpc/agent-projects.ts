/**
 * Agent-projects RPC. Exposes file-tree / read / write / git
 * primitives for the projects scaffolded by the AGENT_PROJECT_NEW
 * action.
 *
 * Path semantics: every `path` parameter is RELATIVE to the project
 * root. The handler resolves it against `$DETOUR_AGENT_SANDBOX/projects/
 * <slug>/` and rejects any path that escapes (`..`-traversal).
 */

export type AgentProjectFileNode = {
	name: string;
	path: string; // relative to project root
	type: "file" | "dir";
	size?: number;
	children?: AgentProjectFileNode[];
};

export type AgentProjectGitFileStatus = {
	path: string;
	status: "modified" | "added" | "deleted" | "untracked" | "renamed" | "unchanged";
	staged: boolean;
};

export type AgentProjectGitCommit = {
	sha: string;
	subject: string;
	author: string;
	timestamp: number; // unix seconds
};

export type AgentProjectTemplate =
	| "carrot"
	| "nextjs"
	| "static"
	| `electrobun:${string}`;

export type AgentProjectSummary = {
	slug: string;
	name: string;
	type: "app" | "page";
	template?: AgentProjectTemplate;
	description: string;
	createdAt: number;
	updatedAt: number;
	deployedAppId?: string;
};

export type AgentProjectsRequests = {
	agentProjectList: {
		params: Record<string, never>;
		response: { projects: AgentProjectSummary[] };
	};
	agentProjectCreate: {
		params: {
			name: string;
			description: string;
			type: "app" | "page";
			template?: AgentProjectTemplate;
		};
		response: { project: AgentProjectSummary };
	};
	/**
	 * Open a native folder-picker, then register the chosen directory as
	 * an agent project. The directory itself is not moved or modified
	 * (other than writing a `project.json` sidecar inside it). Useful
	 * for pointing the agent at an existing repo on disk.
	 */
	agentProjectImport: {
		params: {
			/** When set, skip the native folder picker and import this absolute
			 * directory directly. Required for non-UI callers (Discord/X
			 * → AGENT_PROJECT_IMPORT action). */
			dir?: string;
			name?: string;
			description?: string;
		};
		response:
			| { ok: true; project: AgentProjectSummary }
			| { ok: false; cancelled: true }
			| { ok: false; error: string };
	};
	agentProjectListFiles: {
		params: { slug: string };
		response: { tree: AgentProjectFileNode; dir: string };
	};
	agentProjectReadFile: {
		params: { slug: string; path: string };
		response: { content: string; size: number };
	};
	agentProjectWriteFile: {
		params: { slug: string; path: string; content: string; autoStage?: boolean };
		response: { ok: true; staged: boolean };
	};
	/**
	 * File-system CRUD for agent projects.
	 * All paths are relative to project root and validated against escape.
	 */
	agentProjectCreateFile: {
		params: { slug: string; path: string; content?: string; overwrite?: boolean };
		response: { ok: true; path: string };
	};
	agentProjectCreateFolder: {
		params: { slug: string; path: string };
		response: { ok: true; path: string };
	};
	agentProjectRenameEntry: {
		params: { slug: string; oldPath: string; newPath: string };
		response: { ok: true; path: string };
	};
	agentProjectDeleteEntry: {
		params: { slug: string; path: string };
		response: { ok: true };
	};
	agentProjectGitStatus: {
		params: { slug: string };
		response: { files: AgentProjectGitFileStatus[]; branch: string | null };
	};
	agentProjectGitCommit: {
		params: { slug: string; message: string };
		response: { sha: string };
	};
	agentProjectGitLog: {
		params: { slug: string; limit?: number };
		response: { commits: AgentProjectGitCommit[] };
	};
	agentProjectOpenInFinder: {
		params: { slug: string };
		response: { ok: true };
	};
	workspaceDetectIDEs: {
		params: Record<string, never>;
		response: { ides: WorkspaceIDEAvailability[] };
	};
	workspaceLaunchInIDE: {
		params: { slug: string; ide: WorkspaceIDEId };
		response: { ok: true; method: "url-scheme" | "cli" | "open-app" };
	};
	/**
	 * Start a real HTTP preview for a project. Static + carrot projects
	 * boot an in-process Bun.serve over the project dir; the registry
	 * registers it with portless so the URL is stable across restarts.
	 * Nextjs is expected to run `bun dev` itself.
	 */
	agentProjectStartPreview: {
		params: { slug: string };
		response: {
			ok: true;
			url: string;
			port: number;
			hostname: string;
			publicUrl?: string;
			publicUrlProvider?: "ngrok";
			publicUrlPid?: number;
			publicUrlStartedAt?: number;
			publicUrlError?: string;
		};
	};
	agentProjectStartPublicPreview: {
		params: { slug: string };
		response: {
			ok: true;
			url: string;
			publicUrl: string;
			publicUrlProvider: "ngrok";
			port: number;
			hostname: string;
			publicUrlPid?: number;
			publicUrlStartedAt?: number;
		};
	};
	agentProjectStopPreview: {
		params: { slug: string };
		response: { ok: true };
	};
};

export type WorkspaceIDEId = "vscode" | "cursor" | "windsurf";

export type WorkspaceIDEAvailability = {
	id: WorkspaceIDEId;
	label: string;
	installed: boolean;
	method: "url-scheme" | "cli" | "open-app" | null; // best available launch method
};
