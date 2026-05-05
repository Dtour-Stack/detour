/**
 * Activity > Autonomy pane.
 *
 * Wraps elizaOS's AutonomyService (serviceType "AUTONOMY"). Lets the user:
 *  - see whether autonomy is enabled + currently running
 *  - read/set the loop interval (recreates the batcher section internally)
 *  - flip enable/disable
 *
 * The underlying service is registered when @elizaos/plugin-bootstrap or the
 * basic-capabilities feature is loaded — we resolve via runtime.getService().
 */

import type { IAgentRuntime } from "@elizaos/core";

const AUTONOMY_SERVICE_TYPE = "AUTONOMY";

export interface ActivityAutonomySnapshot {
	available: boolean;
	enabled: boolean;
	running: boolean;
	thinking: boolean;
	intervalMs: number;
	autonomousRoomId?: string;
}

interface AutonomyServiceShape {
	getStatus?: () => {
		enabled: boolean;
		running: boolean;
		thinking?: boolean;
		interval: number;
		autonomousRoomId?: string;
	};
	enableAutonomy?: () => Promise<void>;
	disableAutonomy?: () => Promise<void>;
	getInterval?: () => number;
	setInterval?: (ms: number) => Promise<void> | void;
}

const EMPTY: ActivityAutonomySnapshot = {
	available: false,
	enabled: false,
	running: false,
	thinking: false,
	intervalMs: 0,
};

function findService(runtime: IAgentRuntime): AutonomyServiceShape | null {
	const r = runtime as unknown as {
		getService?: (t: string) => unknown;
		getServicesByType?: (t: string) => unknown[];
	};
	const first = r.getService?.(AUTONOMY_SERVICE_TYPE);
	if (first) return first as AutonomyServiceShape;
	const all = r.getServicesByType?.(AUTONOMY_SERVICE_TYPE) ?? [];
	return (all[0] as AutonomyServiceShape) ?? null;
}

export class ActivityAutonomyService {
	constructor(private readonly resolveRuntime: () => IAgentRuntime | null) {}

	snapshot(): ActivityAutonomySnapshot {
		const runtime = this.resolveRuntime();
		if (!runtime) return EMPTY;
		const svc = findService(runtime);
		if (!svc?.getStatus) return EMPTY;
		const s = svc.getStatus();
		return {
			available: true,
			enabled: !!s.enabled,
			running: !!s.running,
			thinking: !!s.thinking,
			intervalMs: s.interval ?? 0,
			...(s.autonomousRoomId ? { autonomousRoomId: s.autonomousRoomId } : {}),
		};
	}

	async setEnabled(enabled: boolean): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const svc = findService(runtime);
		if (!svc) return false;
		if (enabled && svc.enableAutonomy) {
			await svc.enableAutonomy();
			return true;
		}
		if (!enabled && svc.disableAutonomy) {
			await svc.disableAutonomy();
			return true;
		}
		return false;
	}

	async setIntervalMs(ms: number): Promise<boolean> {
		const runtime = this.resolveRuntime();
		if (!runtime) return false;
		const svc = findService(runtime);
		if (!svc?.setInterval) return false;
		await svc.setInterval(Math.max(5_000, Math.min(600_000, Math.round(ms))));
		return true;
	}
}
