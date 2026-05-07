export type ProviderId = "anthropic" | "openai" | "openrouter";

export type ProviderInfo = {
	id: ProviderId;
	label: string;
	hasKey: boolean;
	active: boolean;
};

export type ChatCommandInfo = {
	name: string;
	usage: string;
	description: string;
	insert: string;
	aliases?: string[];
	source: "native" | "skill";
};

export type WindowOpenTarget =
	| "chat"
	| "command-palette"
	| "settings"
	| "pensieve"
	| "activity"
	| "channels"
	| "browser"
	| "agents";

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

export type ModelProviderRoute =
	| "anthropic-subscription"
	| "openai-codex"
	| "anthropic-api"
	| "openai-api"
	| "openrouter-api";

export type OpenRouterModelCapability =
	| "text"
	| "free"
	| "embedding"
	| "vision"
	| "image";

export type OpenRouterModelInfo = {
	id: string;
	name: string;
	description?: string;
	contextLength?: number;
	inputModalities: string[];
	outputModalities: string[];
	supportedParameters: string[];
	pricing: {
		prompt?: string;
		completion?: string;
		request?: string;
		image?: string;
		webSearch?: string;
		internalReasoning?: string;
		inputCacheRead?: string;
		inputCacheWrite?: string;
	};
	isFree: boolean;
	capabilities: OpenRouterModelCapability[];
};

export type OpenRouterModelBuckets = Record<OpenRouterModelCapability, OpenRouterModelInfo[]>;

export type OpenRouterModelsResponse = {
	fetchedAt: number;
	models: OpenRouterModelInfo[];
	buckets: OpenRouterModelBuckets;
	error?: string;
};

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

export type BrowserCommandSource = "agent" | "ui" | "api";

export type BrowserCommandInput =
	| {
				kind: "open";
				url: string;
				newTab?: boolean;
				tabId?: string;
				source?: BrowserCommandSource;
		  }
		| {
				kind: "inspect";
				tabId?: string;
				source?: BrowserCommandSource;
				timeoutMs?: number;
		  }
		| {
				kind: "script";
				script: string;
				tabId?: string;
				source?: BrowserCommandSource;
				timeoutMs?: number;
		  }
		| {
				kind: "fill-login";
				source: "in-house" | "1password" | "bitwarden";
				identifier: string;
				targetUrl?: string;
				tabId?: string;
				newTab?: boolean;
				timeoutMs?: number;
		  };

export type BrowserCommand = BrowserCommandInput & {
	id: string;
	time: number;
};

export type BrowserCommandResult = {
	ok: boolean;
	result?: unknown;
	error?: string;
	text?: string;
	time: number;
};

export type WsClientMessage =
	| { kind: "chat:send"; convId: string; text: string }
	| { kind: "chat:cancel"; convId: string }
	| { kind: "ui:close-command-palette" }
	| {
			kind: "ui:run-chat-command";
			command: { text: string; submit: boolean };
	  }
	| {
			kind: "log:webview";
			level: "trace" | "debug" | "info" | "warn" | "error";
			msg: string;
			source?: string;
			traceId?: string;
			extras?: Record<string, unknown>;
	  }
	| { kind: "ping" };

export type WsServerMessage =
	| { kind: "chat:delta"; convId: string; delta: string; traceId?: string }
	| { kind: "chat:complete"; convId: string; traceId?: string }
	| { kind: "chat:error"; convId: string; message: string; traceId?: string }
	| { kind: "provider:changed"; activeProvider: ProviderId | null }
	| { kind: "auth:flow-update"; sessionId: string; state: AuthFlowState }
	| { kind: "backend:changed"; backendId: string }
	| { kind: "ui:open-chat" }
	| { kind: "ui:open-settings" }
	| { kind: "ui:open-command-palette" }
	| { kind: "ui:toggle-command-palette" }
	| { kind: "ui:close-command-palette" }
	| {
			kind: "ui:run-chat-command";
			command: { text: string; submit: boolean };
	  }
	| { kind: "ui:open-pensieve" }
	| { kind: "ui:open-activity" }
	| { kind: "ui:open-channels" }
	| { kind: "ui:open-agents" }
	| { kind: "ui:open-browser" }
	| { kind: "browser:command"; command: BrowserCommand }
	| { kind: "ui:preferences-changed"; preferences: UiPreferences }
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

export type AgentCharacterStyle = {
	all: string[];
	chat: string[];
	post: string[];
};

export type AgentCharacterMessageExample = {
	name: string;
	content: {
		text: string;
		actions?: string[];
		providers?: string[];
	};
};

export type AgentCharacterConfig = {
	name: string;
	username: string;
	system: string;
	bio: string[];
	lore: string[];
	adjectives: string[];
	topics: string[];
	style: AgentCharacterStyle;
	postExamples: string[];
	messageExamples: AgentCharacterMessageExample[][];
};

export type ModelConfig = {
	codexLarge: string;
	codexSmall: string;
	codexImage: string;
	openRouterTextLarge: string;
	openRouterTextSmall: string;
	openRouterEmbedding: string;
	openRouterImage: string;
	openRouterVision: string;
	providerPriority: ProviderId[];
};

export type WindowConfig = {
	width: number;
	height: number;
	hideOnBlur: boolean;
	alwaysOnTop: boolean;
};

export type ChroniclerConfig = {
	enabled: boolean;
	intervalMs: number;
	includeWindowTitles: boolean;
	maxWindowsPerScreen: number;
};

export type ChroniclerWindow = {
	app: string;
	title?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	focused: boolean;
};

export type ChroniclerScreen = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	windows: ChroniclerWindow[];
	focusedApp?: string;
	focusedTitle?: string;
};

export type ChroniclerObservation = {
	id: string;
	ts: number;
	screens: ChroniclerScreen[];
	focusedApp?: string;
	focusedTitle?: string;
	windowCount: number;
	summary: string;
};

export type ChroniclerStatus = {
	available: boolean;
	enabled: boolean;
	running: boolean;
	intervalMs: number;
	includeWindowTitles: boolean;
	maxWindowsPerScreen: number;
	pensievePath: string;
	lastSampleAt?: number;
	lastMemoryId?: string;
	lastError?: string;
	screenCount: number;
	windowCount: number;
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

export type PensieveEmbeddingPoint = {
	memoryId: string;
	type?: string;
	path: string;
	preview: string;
	createdAt?: number;
	x: number;
	y: number;
	dim: number;
};

export type PensieveEmbeddingMap = {
	available: boolean;
	count: number;
	points: PensieveEmbeddingPoint[];
	source: "random-projection";
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

export type ChannelId = "discord" | "telegram" | "github" | "imessage";

export type ChannelLiveStatus =
	| "off"
	| "loaded"
	| "connecting"
	| "online"
	| "invalid-token"
	| "error";

export type ChannelStatus = {
	id: ChannelId;
	label: string;
	description: string;
	platform: "any" | "macos";
	requiredVaultKeys: string[];
	optionalVaultKeys: string[];
	pluginPackage: string;
	configured: boolean;
	missingKeys: string[];
	platformAvailable: boolean;
	pluginLoaded: boolean;
	liveStatus: ChannelLiveStatus;
	liveDetail?: string;
	autoReply?: boolean;
	respondOnlyToMentions?: boolean;
};

export type ChannelsSnapshot = {
	channels: ChannelStatus[];
};

export type ActivityDbColumn = {
	name: string;
	type: string;
	nullable: boolean;
	default?: string;
};

export type ActivityDbTable = {
	schema: string;
	name: string;
	rowCount: number;
	columnCount: number;
};

export type ActivityDbTableDetail = {
	schema: string;
	name: string;
	rowCount: number;
	columns: ActivityDbColumn[];
	sample: { rows: Record<string, unknown>[]; truncated: boolean };
};

export type ActivityDbQueryResult = {
	columns: string[];
	rows: Record<string, unknown>[];
	durationMs: number;
	truncated: boolean;
};

export type ActivityPluginDetail = {
	name: string;
	description?: string;
	actionCount: number;
	actionNames: string[];
	providerCount: number;
	providerNames: string[];
	evaluatorCount: number;
	evaluatorNames: string[];
	serviceCount: number;
	serviceTypes: string[];
	hasInit: boolean;
	hasRoutes: boolean;
	hasModels: boolean;
};

export type ActivityPluginsSnapshot = {
	available: boolean;
	generatedAt: number;
	count: number;
	plugins: ActivityPluginDetail[];
};

export type ActivityAutonomySnapshot = {
	available: boolean;
	enabled: boolean;
	running: boolean;
	thinking: boolean;
	intervalMs: number;
	runner: "prompt-batcher" | "task" | "missing" | "none";
	autonomousRoomId?: string;
	tasks: ActivityAutonomyTask[];
	x: ActivityXAutonomySnapshot;
	improvement: ActivityImprovementSnapshot;
};

export type ActivityAutonomyTask = {
	id: string;
	name: string;
	description?: string;
	tags: string[];
	updateInterval?: number;
	nextRunAt?: number;
	lastExecuted?: number;
	lastError?: string;
	failureCount: number;
	paused: boolean;
	hasWorker: boolean;
};

export type ActivityXAutonomyHandled = {
	action: string;
	success?: boolean;
	tweetId?: string;
	resultTweetId?: string;
	error?: string;
	reason?: string;
	text?: string;
	authorScreenName?: string;
	query?: string;
	score?: number;
};

export type ActivityXAutonomySnapshot = {
	available: boolean;
	enabled: boolean;
	writeEnabled: boolean;
	statusPostingEnabled: boolean;
	discoveryEnabled: boolean;
	proactiveEngagementEnabled: boolean;
	followEnabled: boolean;
	intervalMs: number;
	statusIntervalMs: number;
	discoveryIntervalMs: number;
	maxRepliesPerTick: number;
	maxDiscoveryPerTick: number;
	discoveryQueries: string[];
	lastRunAt?: number;
	lastStatusAt?: number;
	lastDiscoveryAt?: number;
	lastStatusTweetId?: string;
	lastHandledCount: number;
	lastHandled: ActivityXAutonomyHandled[];
};

export type ActivityXAutonomyUpdate = {
	enabled?: boolean;
	writeEnabled?: boolean;
	statusPostingEnabled?: boolean;
	discoveryEnabled?: boolean;
	proactiveEngagementEnabled?: boolean;
	followEnabled?: boolean;
	intervalMs?: number;
	statusIntervalMs?: number;
	discoveryIntervalMs?: number;
	maxRepliesPerTick?: number;
	maxDiscoveryPerTick?: number;
	discoveryQueries?: string[];
};

export type ActivityImprovementSnapshot = {
	available: boolean;
	enabled: boolean;
	intervalMs: number;
	lastRunAt?: number;
	lastResult?: string;
	lastCategory?: string;
	lastProposal?: string;
	lastError?: string;
	lastMemoryIds: string[];
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

export type WorkspaceAgentStatus = "running" | "completed" | "failed" | "stopped";

export type WorkspaceAgentRecord = {
	id: string;
	provider: "acpx" | "codex" | "claude";
	agentType: string;
	task: string;
	cwd: string;
	status: WorkspaceAgentStatus;
	command: string;
	args: string[];
	logPath: string;
	previewUrl?: string;
	publicUrl?: string;
	publicUrlProvider?: "ngrok";
	publicUrlPid?: number;
	publicUrlStartedAt?: number;
	publicUrlError?: string;
	startedAt: number;
	pid?: number;
	exitCode?: number | null;
	signal?: string | null;
	endedAt?: number;
	credentialAttempt?: number;
};

export type WorkspaceAgentsSnapshot = {
	agents: WorkspaceAgentRecord[];
	stateDir: string;
	updatedAt: number;
};

export type WorkspaceAgentLog = {
	id: string;
	offset: number;
	nextOffset: number;
	text: string;
	truncated: boolean;
};

export type WorkspaceProjectRecord = {
	id: string;
	name: string;
	cwd: string;
	agentIds: string[];
	runningCount: number;
	completedCount: number;
	failedCount: number;
	latestStartedAt: number;
	previewUrl?: string;
	publicUrl?: string;
};

export type WorkspaceProjectsSnapshot = {
	projects: WorkspaceProjectRecord[];
	workspaceRoot?: string;
	updatedAt: number;
};

export type WorkspaceProjectFileNode = {
	name: string;
	path: string;
	type: "directory" | "file";
	size?: number;
	updatedAt?: number;
};

export type WorkspaceProjectFilesSnapshot = {
	projectId: string;
	cwd: string;
	path: string;
	entries: WorkspaceProjectFileNode[];
};

export type WorkspaceProjectFile = {
	projectId: string;
	cwd: string;
	path: string;
	name: string;
	language: string;
	content: string;
	size: number;
	updatedAt: number;
	truncated: boolean;
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
	tableName: string;
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
	importanceScore?: number;
	messageCount?: number;
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
