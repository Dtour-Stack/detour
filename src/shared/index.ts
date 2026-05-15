export type ProviderId = "anthropic" | "openai" | "openrouter" | "elizacloud";

export type ProviderInfo = {
	id: ProviderId;
	label: string;
	hasKey: boolean;
	active: boolean;
	/** Number of OAuth-account credentials wired up for this provider
	 * (e.g. Anthropic subscription / OpenAI Codex). Independent from
	 * `hasKey` — a user can have OAuth-only with no vault API key. */
	oauthAccountCount?: number;
};

/**
 * Snapshot of a paid-plan quota cap currently in effect on a provider's
 * credential. Surfaced by `providersGetQuotaState` and the
 * `providerQuotaChanged` broadcast so the chat banner and Settings tab
 * can show the cap, when it resets, and which backup provider is
 * available without polling the upstream.
 */
export type ProviderQuotaCap = {
	providerId: ProviderId;
	accountId: string;
	accountLabel: string;
	planType: string;
	resetsAtMs: number;
	upstreamMessage: string;
	markedAtMs: number;
	/** True when this cap is on the credential the runtime is currently
	 * using — drives the prominent chat banner. */
	active: boolean;
};

export type ProviderQuotaState = {
	caps: ProviderQuotaCap[];
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
	| "browser"
	| "agents"
	| "pet"
	| "gallery"
	| "portless"
	| "workspace";

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

// --- portless (local-dev reverse proxy) ---
export type PortlessRoute = {
	hostname: string;
	port: number;
	pid: number;
	tailscaleUrl?: string;
	tailscaleHttpsPort?: number;
	tailscaleFunnel?: boolean;
};

export type PortlessSnapshot = {
	running: boolean;
	proxyPort: number;
	/** True when deferring to standalone portless on HTTPS (typically :443). */
	proxyHttps: boolean;
	tld: string;
	routes: PortlessRoute[];
	/** Last bind error when the proxy couldn't claim a port (e.g. a
	 * stale standalone `portless` daemon owns 4848). null when running. */
	bindError?: string | null;
};

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
	| "image"
	| "video";

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

// ElizaOS Cloud /models catalog — flat list grouped by upstream
// provider (openai/anthropic/google/etc) inferred from the model id.
// Bucketing matches @elizaos/plugin-elizacloud's CloudModelRegistryService
// so a model picked here routes to the same upstream the agent uses.
export type ElizaCloudModelInfo = {
	id: string;
	provider: string;
	ownedBy: string;
	createdAt: number;
};

export type ElizaCloudModelsResponse = {
	fetchedAt: number;
	models: ElizaCloudModelInfo[];
	byProvider: Record<string, ElizaCloudModelInfo[]>;
	error?: string;
};

// --- generic vault keys ---
// `descriptor` mirrors @elizaos/vault's VaultDescriptor — duplicated as a
// loose record so non-Bun clients don't need the @elizaos/vault dep just
// to know the wire shape.
export type VaultKeyDescriptor = {
	readonly key: string;
	readonly source: "file" | "keychain-encrypted" | "1password" | "protonpass";
	readonly sensitive: boolean;
	readonly lastModified: number;
};

export type VaultStats = {
	readonly total: number;
	readonly sensitive: number;
	readonly nonSensitive: number;
	readonly references: number;
};

// Returned by `/api/vault/inventory` — the raw vault entry plus the
// server-side enrichment (category derived heuristically when no
// `_meta.<key>` exists, plus inferred provider id and a stored meta blob).
export type VaultInventoryItem = {
	readonly key: string;
	readonly category: string;
	readonly label?: string;
	readonly providerId?: string;
	readonly hasProfiles?: boolean;
	readonly activeProfile?: string;
	readonly profiles?: ReadonlyArray<{ id: string; label: string; createdAt?: number }>;
	readonly lastModified?: number;
	readonly lastUsed?: number;
	readonly kind?: "secret" | "value" | "reference";
	readonly provider: string | null;
	readonly meta: Record<string, unknown> | null;
};

export type VaultKeyResult = {
	readonly key: string;
	readonly descriptor: VaultKeyDescriptor | null;
	readonly value?: string;
};

export type SetVaultKeyBody = { value: string; sensitive?: boolean };

// --- saved logins (1Password etc.) ---
// Structural subset used by the browser-autofill UI — kept around even
// though the canonical wire shape is `SavedLoginListEntry` below.
export type SavedLoginEntry = {
	source: "in-house" | "1password" | "bitwarden";
	identifier: string;
	domain?: string;
	username?: string;
	label?: string;
};

// Mirrors @elizaos/vault's UnifiedLoginListEntry — the actual wire shape
// returned by `/api/saved-logins`.
export type SavedLoginListEntry = {
	readonly source: "in-house" | "1password" | "bitwarden";
	readonly identifier: string;
	readonly domain: string | null;
	readonly username: string;
	readonly title: string;
	readonly updatedAt: number;
};

// Mirrors @elizaos/vault's UnifiedLoginListResult.
export type SavedLoginsListResult = {
	readonly logins: ReadonlyArray<SavedLoginListEntry>;
	readonly failures: ReadonlyArray<{ source: string; message: string }>;
};

// Mirrors @elizaos/vault's UnifiedLoginReveal. Note: `password` may be
// empty when the underlying 1Password item has no password field — the
// server then falls back to `op item get` and returns metadata-only.
export type RevealedLogin = {
	readonly source: "in-house" | "1password" | "bitwarden";
	readonly identifier?: string;
	readonly username: string;
	readonly password: string;
	readonly totp?: string;
	readonly domain: string | null;
	readonly note?: string;
};

// --- backend install metadata (`/api/backends/install`) ---
export type InstallMethod =
	| { readonly kind: "brew"; readonly package: string; readonly cask: boolean }
	| { readonly kind: "npm"; readonly package: string }
	| { readonly kind: "manual"; readonly instructions: string; readonly url: string };

export type InstallCommand = {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
};

export type BackendInstallSpec = {
	readonly id: string;
	readonly methods: ReadonlyArray<InstallMethod>;
	readonly commands: ReadonlyArray<InstallCommand | null>;
};

export type SupportedPlatform = "darwin" | "linux" | "win32";

export type PackageManagerAvailability = {
	readonly brew: boolean;
	readonly npm: boolean;
};

export type BackendInstall = {
	readonly platform: SupportedPlatform;
	readonly packageManagers: PackageManagerAvailability;
	readonly specs: ReadonlyArray<BackendInstallSpec>;
};

// --- backend signin / signout ---
export type SignInBackendBody = {
	readonly email?: string;
	readonly masterPassword: string;
	readonly secretKey?: string;
	readonly signInAddress?: string;
	readonly bitwardenClientId?: string;
	readonly bitwardenClientSecret?: string;
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
				kind: "screenshot";
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

// LlamaServerStatus — wire shape returned by `LlamaServerService.status()`.
// Mirrored as `LlamaServerStatusWire` in src/shared/rpc/llama.ts; this name
// is preserved here so view-side imports (e.g. LocalAITab.tsx) keep their
// existing import path stable post-WebClient.
export type LlamaServerStatus = {
	readonly running: boolean;
	readonly url: string | null;
	readonly modelPath: string | null;
	readonly pid: number | null;
	readonly startedAt: number | null;
	readonly lastError: string | null;
	readonly downloadProgress?: {
		downloadedBytes: number;
		totalBytes: number;
		percent: number;
	} | null;
};

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
	browserUse?: boolean;
	computerUse?: boolean;
	/** When true, the coding-tools sandbox path restriction is lifted —
	 * FILE/BASH/EDIT/etc can operate outside DETOUR_AGENT_SANDBOX. Read by
	 * runtime.buildRuntimeSettings as DETOUR_ELEVATED_CODING. */
	elevatedCoding?: boolean;
};

export type AgentDataDumpCounts = {
	trajectories: number;
	trajectoryDetails: number;
	memories: number;
	memoryTables: number;
	relationships: number;
	redactedMemories: number;
	totalTrajectoriesScanned: number;
	totalMemoriesScanned: number;
	dataBytes: number;
};

export const AGENT_HF_SYNC_DEFAULT_DESTINATION = "hf://buckets/dexploarer/detourdump";

export type AgentHfSyncReason =
	| "manual"
	| "startup"
	| "daily"
	| "trajectory-threshold";

export type AgentHfSyncPolicy = {
	enabled: boolean;
	destination: string;
	limit: number;
	syncOnStartup: boolean;
	daily: boolean;
	dailyTimeUtc: string;
	everyNewTrajectories: number;
	minIntervalMinutes: number;
	failureCooldownMinutes: number;
};

export type AgentHfSyncState = {
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	lastError: string | null;
	lastReason: AgentHfSyncReason | null;
	lastSyncedTrajectoryTotal: number | null;
	lastObservedTrajectoryTotal: number | null;
	lastDailySyncDateUtc: string | null;
	lastCounts: AgentDataDumpCounts | null;
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
	openRouterVideo: string;
	openRouterVision: string;
	// ElizaOS Cloud model bucket overrides — flow into the
	// `ELIZAOS_CLOUD_*_MODEL` env vars that
	// `@elizaos/plugin-elizacloud` reads (utils/config.ts).
	elizaCloudLarge: string;
	elizaCloudMedium: string;
	elizaCloudSmall: string;
	elizaCloudNano: string;
	elizaCloudMega: string;
	elizaCloudResponseHandler: string;
	elizaCloudImage: string;
	elizaCloudVideo: string;
};

export type WindowConfig = {
	width: number;
	height: number;
	hideOnBlur: boolean;
	alwaysOnTop: boolean;
};

/**
 * What the user can pin to the tray popover's quick-action grid.
 * Must match a real WindowOpenTarget or one of the special action
 * names handled in tray-popover/TrayPopoverView.tsx.
 */
export type TraySlot =
	| "chat"
	| "pensieve"
	| "activity"
	| "browser"
	| "gallery"
	| "settings"
	| "command-palette"
	| "portless"
	| "workspace";

export type TrayStatusLabelMode = "terse" | "verbose";

export type TrayPrefs = {
	/**
	 * 6 slots in the quick-action grid (2×3). Duplicates are filtered
	 * out by the sanitizer; entries fewer than 6 are padded with the
	 * defaults; entries more than 6 are truncated.
	 */
	slots: TraySlot[];
	/** Which status pills are visible in the popover header. */
	pillsVisible: {
		embed: boolean;
		chat: boolean;
		companion: boolean;
	};
	/**
	 * How the menu-bar status label renders.
	 *   - terse:   `● Claude`
	 *   - verbose: `● Detour: Claude + local embeds` (legacy default)
	 */
	statusLabelMode: TrayStatusLabelMode;
	/** Auto-hide the floating status widget when chat has focus. */
	statusWidgetEnabled: boolean;
};

export const DEFAULT_TRAY_SLOTS: TraySlot[] = [
	"chat",
	"pensieve",
	"activity",
	"browser",
	"gallery",
	"settings",
];

export const DEFAULT_TRAY_PREFS: TrayPrefs = {
	slots: DEFAULT_TRAY_SLOTS,
	pillsVisible: { embed: true, chat: true, companion: true },
	statusLabelMode: "verbose",
	statusWidgetEnabled: false,
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
	/** Telegram: CONTINUOUS_IMPROVEMENT_ENABLED (vault + runtime). */
	continuousImprovementEnabled?: boolean;
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

export type CodexPetAtlas = {
	columns: number;
	rows: number;
	cellWidth: number;
	cellHeight: number;
	width: number;
	height: number;
};

export type CodexPetAnimationState =
	| "idle"
	| "running-right"
	| "running-left"
	| "waving"
	| "jumping"
	| "failed"
	| "waiting"
	| "running"
	| "review";

export type CodexPetSummary = {
	id: string;
	displayName: string;
	description: string;
	directory: string;
	petJsonPath: string;
	spritesheetPath: string;
	spritesheetUrl: string;
	atlas: CodexPetAtlas;
};

export type CodexPetsResponse = {
	pets: CodexPetSummary[];
	errors: string[];
};

export type CodexPetSpawnResponse = {
	pet: CodexPetSummary;
	state: CodexPetAnimationState;
};

export type CodexPetActivity = {
	state: CodexPetAnimationState;
	summary: string;
	detail?: string;
	runningAgents: WorkspaceAgentRecord[];
	recentLogs: ActivityLogEntry[];
	runtime?: Pick<ActivityRuntimeSnapshot, "available" | "agentName" | "counts">;
	updatedAt: number;
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
	memberEntityIds: string[];
	tracked: boolean;
	trackedAt?: string;
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
