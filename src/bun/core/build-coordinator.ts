/**
 * Build coordinator — per-room in-flight lock + cooldown for agent builds.
 *
 * Stops people spamming "make me an app" in a group: one build at a time per
 * room. While a build is in flight, a second request is rejected (the agent
 * tells them to chill); for a short window after a build finishes, new requests
 * are also rejected so a finished build isn't immediately followed by another.
 *
 * Pure in-memory state — no delivery, no routing, no other-core imports. The
 * AGENT_PROJECT_* action handlers (which have the channel-routed `callback`)
 * own milestone delivery; this just tracks who's building what, where.
 *
 * Locks expire lazily on a TTL so a crashed / abandoned build can't lock a room
 * forever (the action handlers also call finish() on terminal paths).
 *
 * Module-level singleton mirroring preview-server-registry: plugin actions don't
 * get a DI container, so they reach this via getBuildCoordinator().
 */

/** Max wall-clock a single build may hold its room lock before it's considered
 *  stale and auto-released (a long real build calls note() to refresh this). */
const BUILD_TTL_MS = 15 * 60_000;
/** Quiet window after a build finishes before a new one is accepted. */
const COOLDOWN_MS = 90_000;

type ActiveBuild = { label: string; startedAt: number; lastActivityAt: number };

export type BuildStartResult =
	| { ok: true }
	| { ok: false; reason: "busy" | "cooldown"; label: string; secondsAgo: number };

export class BuildCoordinator {
	private readonly active = new Map<string, ActiveBuild>();
	private readonly cooldown = new Map<string, { label: string; finishedAt: number }>();

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Attempt to claim the build lock for `roomId`. Returns {ok:true} when the
	 * caller may proceed; otherwise {ok:false} with why (busy | cooldown) and the
	 * label/age of the conflicting build so the agent can say what's going on.
	 */
	tryStart(roomId: string, label: string): BuildStartResult {
		const key = this.key(roomId);
		const t = this.now();
		const current = this.active.get(key);
		if (current) {
			if (t - current.lastActivityAt < BUILD_TTL_MS) {
				return { ok: false, reason: "busy", label: current.label, secondsAgo: Math.round((t - current.startedAt) / 1000) };
			}
			this.active.delete(key); // stale lock — release and fall through
		}
		const cd = this.cooldown.get(key);
		if (cd && t - cd.finishedAt < COOLDOWN_MS) {
			return { ok: false, reason: "cooldown", label: cd.label, secondsAgo: Math.round((t - cd.finishedAt) / 1000) };
		}
		this.active.set(key, { label, startedAt: t, lastActivityAt: t });
		return { ok: true };
	}

	/** Refresh the lock's activity timestamp (keeps a long, live build from
	 *  expiring mid-flight). No-op if the room isn't building. */
	note(roomId: string): void {
		const b = this.active.get(this.key(roomId));
		if (b) b.lastActivityAt = this.now();
	}

	/** Release the lock and open the cooldown window. Idempotent. */
	finish(roomId: string): void {
		const key = this.key(roomId);
		const b = this.active.get(key);
		this.active.delete(key);
		this.cooldown.set(key, { label: b?.label ?? "", finishedAt: this.now() });
	}

	/** The label of the build currently holding `roomId`, if any (non-stale). */
	activeLabel(roomId: string): string | null {
		const b = this.active.get(this.key(roomId));
		if (!b) return null;
		return this.now() - b.lastActivityAt < BUILD_TTL_MS ? b.label : null;
	}

	private key(roomId: string): string {
		return roomId && roomId.length > 0 ? roomId : "__no_room__";
	}
}

let coordinatorSingleton: BuildCoordinator | null = null;

export function setBuildCoordinator(c: BuildCoordinator): void {
	coordinatorSingleton = c;
}

/** Lazily returns a coordinator. Unlike the preview registry this never throws —
 *  a missing coordinator must not block a build, just skip the anti-spam gate. */
export function getBuildCoordinator(): BuildCoordinator {
	if (!coordinatorSingleton) coordinatorSingleton = new BuildCoordinator();
	return coordinatorSingleton;
}
