export const UI_POLL_INTERVAL_MS = {
	agentHfJob: 1_500,
	default: 5_000,
	activityAutonomy: 3_000,
	activityPlugins: 8_000,
	activityTail: 3_000,
	channels: 8_000,
	channelHealth: 5_000,
	cloudContainers: 8_000,
	gateway: 3_000,
	githubFeed: 30_000,
	inbox: 3_000,
	liveClock: 1_000,
	localAi: 4_000,
	mainChat: 6_000,
	petActivity: 2_500,
	portless: 3_000,
	providerClock: 30_000,
	status: 4_000,
	trayStatus: 4_000,
} as const;

export const UI_DELAY_MS = {
	browserPendingShort: 150,
	browserPendingLong: 750,
	browserLoadRetrySlow: 500,
	browserSyncImmediate: 100,
	browserSyncQuick: 250,
	browserSyncSettled: 350,
	browserSyncSlow: 1_000,
	browserWebviewReadyRetry: 100,
	channelPairingRetry: 1_000,
	credentialIdentityRefresh: 400,
	pensieveSearchDebounce: 250,
	petManualStateReset: 9_000,
	petIdleAnimation: 12_000,
	phantomErrorClear: 3_000,
	phantomSuccessClear: 2_000,
	saveFlash: 2_200,
	saveFlashVisible: 2_000,
	skillsToastShort: 1_500,
	skillsToastLong: 3_000,
	subagentPulse: 1_000,
	subagentTailScroll: 30,
} as const;

export const MEDIA_TIMING_MS = {
	openRouterVideoPoll: 30_000,
	openRouterVideoTimeout: 10 * 60_000,
} as const;

export const BROWSER_TIMING_MS = {
	scriptTimeout: 30_000,
} as const;

export const RPC_TIMING_MS = {
	maxRequest: 30_000,
} as const;
