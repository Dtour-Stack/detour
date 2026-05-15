/**
 * Service dependency bag passed into every RPC handler factory.
 *
 * Handlers are pure functions over RpcDeps — no globals, no singletons.
 * The registry constructs them once per process at startup and gives the
 * resulting handler bag to every BrowserWindow's RPC instance.
 *
 * Adding a service: extend RpcDeps here, plumb it through buildRpcDeps()
 * in src/bun/core/rpc/registry.ts, and any handler can now reach it.
 */

import type { ActivityService } from "../activity";
import type { AgentHfSyncService } from "../agent-hf-sync-service";
import type { AuthService } from "../auth";
import type { BackendOps } from "../backend-ops";
import type { ChannelGatewayService } from "../channels/gateway";
import type { ChannelsService } from "../channels";
import type { ConfigService } from "../config-service";
import type { CronService } from "../cron-service";
import type { InboxService } from "../inbox";
import type { LlamaServerService } from "../llama/server-service";
import type { LocalChatService } from "../llama/chat-service";
import type { CompanionService } from "../llama/companion-service";
import type { MemoryArbiter } from "../llama/memory-arbiter";
import type { OwnerBindService } from "../owner-bind";
import type { PensieveService } from "../pensieve";
import type { PortlessService } from "../portless";
import type { PreviewServerRegistry } from "../preview-server-registry";
import type { DreamService } from "../dream-service";
import type { GoalService } from "../goal-service";
import type { RuntimeService } from "../runtime";
import type { VaultService } from "../vault";

export type RpcBroadcaster = {
	/**
	 * Push a typed message to every open webview. Replaces the WS
	 * `publish()` path. Each window's typed RPC `send` bag is invoked,
	 * so the message goes over the native postMessage bridge — no HTTP,
	 * no WebSocket, no JSON.parse on the receiving side.
	 *
	 * Window registration is implicit: WindowFactory registers each
	 * created window's send handle with the registry on construction
	 * and unregisters it on close.
	 */
	broadcast<K extends string>(name: K, payload: unknown): void;
};

export type RpcDeps = {
	runtime: RuntimeService;
	vault: VaultService;
	auth: AuthService;
	backendOps: BackendOps;
	config: ConfigService;
	pensieve: PensieveService;
	activity: ActivityService;
	agentHfSync: AgentHfSyncService;
	channels: ChannelsService;
	gateway: ChannelGatewayService;
	inbox: InboxService;
	llama: LlamaServerService;
	localChat: LocalChatService;
	companion: CompanionService;
	memoryArbiter: MemoryArbiter;
	cron: CronService;
	ownerBind: OwnerBindService;
	portless: PortlessService;
	previewServers: PreviewServerRegistry;
	goal: GoalService;
	dream: DreamService;
	broadcaster: RpcBroadcaster;
};
