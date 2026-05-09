/**
 * Routing profiles — vault-backed key→profile rules. Replaces GET /api/routing.
 *
 * Wire shape mirrors @elizaos/vault's RoutingConfig: an array of rules + an
 * optional default profile. Kept here (instead of re-exporting from the vault
 * package) so the shared schema stays decoupled from the runtime bun deps.
 */
export type RoutingScopeKindWire = "agent" | "app" | "skill";

export type RoutingScopeWire = {
	readonly kind: RoutingScopeKindWire;
	readonly agentId?: string;
	readonly appName?: string;
	readonly skillId?: string;
};

export type RoutingRuleWire = {
	readonly keyPattern: string;
	readonly scope: RoutingScopeWire;
	readonly profileId: string;
};

export type RoutingConfigWire = {
	readonly rules: ReadonlyArray<RoutingRuleWire>;
	readonly defaultProfile?: string;
};

export type RoutingRequests = {
	routingGet: {
		params: Record<string, never>;
		response: RoutingConfigWire;
	};
};
