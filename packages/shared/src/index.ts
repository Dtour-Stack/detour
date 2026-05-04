export type ProviderId = "anthropic" | "openai";

export type ProviderInfo = {
	id: ProviderId;
	label: string;
	hasKey: boolean;
	active: boolean;
};

// Mirrors @elizaos/vault BackendStatus — duplicated here so non-Bun clients
// (web, cli) don't need the @elizaos/vault dep.
export type BackendId = "in-house" | "1password" | "protonpass" | "bitwarden";

export type BackendStatus = {
	readonly id: BackendId;
	readonly label: string;
	readonly available: boolean;
	readonly signedIn?: boolean;
	readonly detail?: string;
	readonly authMode?: "desktop-app" | "session-token" | null;
};

export type Health = { ok: true; version: string };

export type SetProviderKeyBody = { key: string };
export type SetActiveProviderBody = { id: ProviderId };
export type SetEnabledBackendsBody = { enabled: string[] };

// --- generic vault keys ---
export type VaultKeyDescriptor = {
	key: string;
	sensitive: boolean;
	source: "in-house" | "1password" | "bitwarden" | "protonpass";
	updatedAt?: string;
	createdAt?: string;
};

export type SetVaultKeyBody = { value: string; sensitive?: boolean };

// --- saved logins (1Password etc.) ---
export type SavedLoginEntry = {
	source: "in-house" | "1password" | "bitwarden";
	identifier: string;
	domain?: string;
	username?: string;
	label?: string;
};

export type SavedLoginListResult = {
	entries: SavedLoginEntry[];
	failures: { source: string; message: string }[];
};

export type RevealedLogin = {
	source: "in-house" | "1password" | "bitwarden";
	username?: string;
	password: string;
	totp?: string;
	domain?: string;
};

export type WsClientMessage =
	| { kind: "chat:send"; convId: string; text: string }
	| { kind: "ping" };

export type WsServerMessage =
	| { kind: "chat:delta"; convId: string; delta: string }
	| { kind: "chat:complete"; convId: string }
	| { kind: "chat:error"; convId: string; message: string }
	| { kind: "provider:changed"; activeProvider: ProviderId | null }
	| { kind: "auth:flow-update"; sessionId: string; state: AuthFlowState }
	| { kind: "backend:changed"; backendId: string }
	| { kind: "ui:open-settings" }
	| { kind: "pong" };

export type ThemeChoice = "system" | "light" | "dark";
export type UiPreferences = {
	theme: ThemeChoice;
	accent: string;
};

export type AgentVaultMode = "off" | "read" | "read-write";
export type AgentConfig = {
	deny: boolean;
	mode: AgentVaultMode;
	allowedPrefixes: string[];
	deniedPrefixes: string[];
};

export type ModelConfig = {
	codexLarge: string;
	codexSmall: string;
	codexImage: string;
	providerPriority: ("anthropic-subscription" | "openai-codex" | "anthropic-api" | "openai-api")[];
};

export type WindowConfig = {
	width: number;
	height: number;
	hideOnBlur: boolean;
	alwaysOnTop: boolean;
};

export type OsPermissionId =
	| "camera"
	| "microphone"
	| "screen-recording"
	| "accessibility"
	| "full-disk-access"
	| "automation"
	| "location"
	| "files-folders"
	| "input-monitoring"
	| "bluetooth";

export type OsPermissionStatus = "granted" | "denied" | "unknown" | "not-applicable";

export type OsPermissionInfo = {
	id: OsPermissionId;
	label: string;
	enables: string;
	status: OsPermissionStatus;
	detail?: string;
	settingsUrl?: string;
};

export type OpDiagnostic = {
	platform: string;
	opPath: string | null;
	opVersion: string | null;
	accountList: { exitCode: number; stdout: string; stderr: string };
	vaultList: {
		account: string | null;
		exitCode: number;
		stdout: string;
		stderr: string;
	} | null;
	desktopIntegrationDetected: boolean;
	sessionTokenStored: boolean;
	hint: string;
};

export type SigninResult = {
	backendId: "1password" | "bitwarden" | "protonpass";
	sessionStored: boolean;
	message: string;
};

// ── Pensieve ─────────────────────────────────────────────────────────────────

export type ActivityLogEntry = {
	time: number;
	level: number;
	levelName: string;
	msg: string;
	source?: string;
	agentName?: string;
	agentId?: string;
	extras?: Record<string, unknown>;
};

export type ActivityTrajectoryListItem = {
	id: string;
	source?: string;
	status?: string;
	startTime?: number;
	endTime?: number;
	durationMs?: number;
	llmCallCount?: number;
	totalPromptTokens?: number;
	totalCompletionTokens?: number;
};

export type ActivityTrajectoryListResult = {
	trajectories: ActivityTrajectoryListItem[];
	total: number;
	limit: number;
	offset: number;
};

export type ActivityLlmCall = {
	callId: string;
	stepNumber: number;
	timestamp: number;
	model: string;
	systemPrompt?: string;
	userPrompt?: string;
	response?: string;
	reasoning?: string;
	temperature?: number;
	maxTokens?: number;
	promptTokens?: number;
	completionTokens?: number;
	latencyMs?: number;
	purpose?: string;
	stepType?: string;
	actionType?: string;
	tags?: string[];
};

export type ActivityProviderAccess = {
	providerId: string;
	providerName: string;
	stepNumber: number;
	timestamp: number;
	purpose?: string;
	query?: unknown;
	data?: unknown;
};

export type ActivityActionAttempt = {
	attemptId: string;
	stepNumber: number;
	timestamp: number;
	actionType?: string;
	actionName?: string;
	parameters?: unknown;
	reasoning?: string;
	success?: boolean;
	result?: unknown;
	error?: string;
	immediateReward?: number;
};

export type ActivityTrajectoryStepSummary = {
	stepNumber: number;
	timestamp: number;
	reasoning?: string;
	reward?: number;
	done?: boolean;
	llmCallCount: number;
	providerAccessCount: number;
	hasAction: boolean;
	actionName?: string;
	actionSuccess?: boolean;
	observation?: unknown;
	environmentState?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
};

export type ActivityTrajectoryIdentity = {
	id: string;
	agentId?: string;
	agentName?: string;
	agentModel?: string;
	episodeId?: string;
	scenarioId?: string;
	batchId?: string;
	groupIndex?: number;
	source?: string;
	status?: string;
	startTime?: number;
	endTime?: number;
	durationMs?: number;
	totalReward?: number;
};

export type ActivityTrajectoryDetail = {
	trajectory: ActivityTrajectoryListItem | null;
	identity: ActivityTrajectoryIdentity | null;
	totals: {
		stepCount: number;
		llmCallCount: number;
		providerAccessCount: number;
		actionCount: number;
		totalPromptTokens: number;
		totalCompletionTokens: number;
		totalLatencyMs: number;
	};
	llmCalls: ActivityLlmCall[];
	providerAccesses: ActivityProviderAccess[];
	actions: ActivityActionAttempt[];
	steps: ActivityTrajectoryStepSummary[];
	metadata: Record<string, unknown> | null;
	rewardComponents: Record<string, unknown> | null;
	metrics: Record<string, unknown> | null;
	raw: Record<string, unknown> | null;
};

export type ActivityTrajectoryExport = {
	exportedAt: number;
	count: number;
	trajectories: ActivityTrajectoryDetail[];
};

export type ActivityTaskWorker = {
	name: string;
	hasShouldRun: boolean;
	hasCanExecute: boolean;
};

export type ActivityTaskRecord = {
	id: string;
	name: string;
	description?: string;
	tags: string[];
	roomId?: string;
	worldId?: string;
	entityId?: string;
	createdAt?: number;
	updatedAt?: number;
	dueAt?: number;
	updateInterval?: number;
	nextRunAt?: number;
	lastExecuted?: number;
	lastError?: string;
	failureCount: number;
	maxFailures?: number;
	paused: boolean;
	hasWorker: boolean;
	metadata: Record<string, unknown>;
};

export type PensieveTemplateSummary = {
	id: string;
	name: string;
	path: string;
	preview: string;
	variables: string[];
	tags: string[];
	updatedAt?: number;
};

export type PensieveTemplateDetail = PensieveTemplateSummary & {
	body: string;
	currentValues: Record<string, string>;
	missingVariables: string[];
};

export type PensievePromptVariable = {
	name: string;
	value: string;
	memoryId: string;
	updatedAt?: number;
};

export type PensieveTemplateRenderResult = {
	rendered: string;
	usedValues: Record<string, string>;
	missing: string[];
};

export type ActivityTasksSnapshot = {
	available: boolean;
	workers: ActivityTaskWorker[];
	tasks: ActivityTaskRecord[];
	totals: {
		workerCount: number;
		taskCount: number;
		recurringCount: number;
		pausedCount: number;
		failingCount: number;
	};
};

export type PensieveMemorySummary = {
	id: string;
	type?: string;
	createdAt?: number;
	roomId?: string;
	entityId?: string;
	worldId?: string;
	tags?: string[];
	path: string;
	preview: string;
};

export type PensieveMemoryTreeNode = {
	path: string;
	name: string;
	count: number;
	totalCount: number;
	children: PensieveMemoryTreeNode[];
};

export type PensieveMemoryTree = {
	root: PensieveMemoryTreeNode;
	total: number;
};

export type PensieveMemoryDetail = PensieveMemorySummary & {
	content: { text?: string; [k: string]: unknown };
	metadata?: Record<string, unknown>;
	hasEmbedding: boolean;
	backlinks?: PensieveGraphSnapshot;
};

export type PensieveEntitySummary = {
	id: string;
	name?: string;
	relationshipCount: number;
	memoryCount: number;
	lastSeen?: number;
	tags: string[];
};

export type PensieveRelationshipSummary = {
	sourceEntityId: string;
	targetEntityId: string;
	tags: string[];
	createdAt?: number;
	metadata?: Record<string, unknown>;
};

export type PensievePersonDetail = {
	entity: PensieveEntitySummary;
	memories: Array<{ id: string; preview: string; createdAt?: number }>;
	relationships: PensieveRelationshipSummary[];
};

export type ActivityRuntimeRegistryItem = {
	name: string;
	description?: string;
	className?: string;
	id?: string;
};

export type ActivityRuntimeSnapshot = {
	available: boolean;
	generatedAt: number;
	agentId?: string;
	agentName?: string;
	counts: {
		actions: number;
		providers: number;
		evaluators: number;
		services: number;
		plugins: number;
	};
	actions: ActivityRuntimeRegistryItem[];
	providers: ActivityRuntimeRegistryItem[];
	evaluators: ActivityRuntimeRegistryItem[];
	services: ActivityRuntimeRegistryItem[];
	plugins: ActivityRuntimeRegistryItem[];
};

export type PensieveGraphNodeKind = "memory" | "entity";

export type PensieveGraphNode = {
	id: string;
	kind: PensieveGraphNodeKind;
	label: string;
	tags?: string[];
	createdAt?: number;
};

export type PensieveGraphEdge = {
	source: string;
	target: string;
	kind: "memory-entity" | "memory-tag" | "entity-relationship";
	weight?: number;
};

export type PensieveGraphSnapshot = {
	nodes: PensieveGraphNode[];
	edges: PensieveGraphEdge[];
	stats: {
		memories: number;
		entities: number;
		trajectories: number;
		edges: number;
	};
};

export type AuthFlowStatus = "pending" | "success" | "error" | "cancelled" | "timeout";
export type AuthFlowState = {
	sessionId: string;
	providerId: string;
	status: AuthFlowStatus;
	authUrl?: string;
	needsCodeSubmission: boolean;
	account?: AccountRecord;
	error?: string;
	startedAt: number;
	endedAt?: number;
};

export type AccountRecord = {
	id: string;
	providerId: string;
	label: string;
	source: "oauth" | "api-key";
	credentials: { access: string; refresh: string; expires: number };
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	organizationId?: string;
	userId?: string;
	email?: string;
};

export type StartAuthFlowBody = {
	provider: "anthropic-subscription" | "openai-codex";
	label: string;
	accountId?: string;
};

export type SubmitFlowCodeBody = { code: string };
