/**
 * MemoryArbiter — single-machine RAM budget gate for the three llama
 * services (embedding, chat, companion).
 *
 * Each tier asks `shouldAllowStart(tier, ramGB)` before spawning its
 * llama-server. If the total of currently-reserved RAM plus the
 * requested amount would push past the budget, the request is refused
 * with a human-readable reason that the UI (Settings → Local AI) can
 * surface directly. Refusal is non-fatal — the user sees "would push
 * total to 13/16 GB" and decides to pick a smaller preset or stop
 * another tier first.
 *
 * Why this exists: before the arbiter, each service independently
 * decided to spawn. A user could enable embedding (auto) + chat
 * (Qwen3-8B, 11 GB) + companion (Qwen3-1.7B, 4 GB) on a 16 GB Mac and
 * push past unified memory into swap, which is fatal for inference
 * latency. The arbiter is the single coordination point that prevents
 * the footgun.
 *
 * Budget model:
 *   - `headroomGB` is reserved for OS + Bun + Electrobun + the cloud
 *     planner + whatever Mac apps the user is also running. Defaults
 *     to max(6, 0.3 * totalGB) — 6 GB on a 16 GB Mac, ~10 GB on a 32
 *     GB Mac. Tighter on small machines, looser on big ones.
 *   - The "budget" is `totalGB - headroomGB`. Reservations across all
 *     tiers must fit inside it.
 *
 * Reservation model:
 *   - One entry per tier. A tier re-reserving (e.g. restart with a
 *     bigger model) replaces its previous entry, so the gate evaluates
 *     the request as a SWAP, not an addition.
 *   - `release(tier)` clears a reservation (called on stop).
 *
 * Shared mode (companion reusing the chat server) intentionally does
 * NOT take a reservation — no new process means no new RAM cost.
 * Callers are responsible for skipping the reserve() call when they
 * enter shared mode.
 */

import { totalmem } from "node:os";

export type LlamaTier = "embedding" | "chat" | "companion";

export interface ArbiterDecision {
	readonly ok: boolean;
	/**
	 * Human-readable explanation when ok=false. Format is short enough
	 * to drop straight into a toast / inline error: e.g.
	 * "Not enough RAM: chat (11 GB) + companion (4 GB) would push total
	 *  past the 10 GB budget on a 16 GB machine."
	 */
	readonly reason?: string;
	/** Snapshot of the budget state at decision time — for diagnostics + UI. */
	readonly snapshot: ArbiterSnapshot;
}

export interface ArbiterSnapshot {
	readonly totalGB: number;
	readonly headroomGB: number;
	readonly budgetGB: number;
	/** Sum of all currently-active reservations. */
	readonly usedGB: number;
	readonly reservations: ReadonlyArray<{ tier: LlamaTier; ramGB: number }>;
}

export interface MemoryArbiterConfig {
	/**
	 * Override `os.totalmem()` (in GB). Tests pass a small number to
	 * simulate constrained machines. Production callers leave this unset.
	 */
	readonly totalGB?: number;
	/**
	 * Override headroom (GB reserved for everything that isn't a llama
	 * server). When unset, defaults to max(6, 0.3 * totalGB).
	 */
	readonly headroomGB?: number;
}

export class MemoryArbiter {
	private readonly reservations = new Map<LlamaTier, number>();
	private readonly totalGB: number;
	private readonly headroomGB: number;

	constructor(config: MemoryArbiterConfig = {}) {
		this.totalGB =
			config.totalGB ?? totalmem() / 1024 ** 3;
		this.headroomGB =
			config.headroomGB ??
			Math.max(6, 0.3 * this.totalGB);
	}

	get budgetGB(): number {
		return Math.max(0, this.totalGB - this.headroomGB);
	}

	private usedGB(excludeTier?: LlamaTier): number {
		let used = 0;
		for (const [tier, ramGB] of this.reservations) {
			if (tier === excludeTier) continue;
			used += ramGB;
		}
		return used;
	}

	private snapshot(): ArbiterSnapshot {
		return {
			totalGB: this.totalGB,
			headroomGB: this.headroomGB,
			budgetGB: this.budgetGB,
			usedGB: this.usedGB(),
			reservations: [...this.reservations.entries()].map(([tier, ramGB]) => ({
				tier,
				ramGB,
			})),
		};
	}

	/**
	 * Ask whether `tier` may take an additional `ramGB`. Existing
	 * reservation for the SAME tier is excluded from the "used" total —
	 * a tier replacing its own model is evaluated as a swap, not an add.
	 *
	 * Does NOT take the reservation; caller must call `reserve()` after
	 * a successful spawn. (Split so a failed spawn doesn't leak.)
	 */
	shouldAllowStart(tier: LlamaTier, ramGB: number): ArbiterDecision {
		const usedExcludingSelf = this.usedGB(tier);
		const wouldUse = usedExcludingSelf + ramGB;
		const snap = this.snapshot();
		if (this.totalGB <= 0 || !Number.isFinite(this.totalGB)) {
			// Couldn't measure system RAM (totalmem returned 0 / NaN). Don't
			// block — assume the user knows what they're doing.
			return { ok: true, snapshot: snap };
		}
		if (wouldUse <= this.budgetGB) {
			return { ok: true, snapshot: snap };
		}
		const others = [...this.reservations.entries()]
			.filter(([t]) => t !== tier)
			.map(([t, gb]) => `${t} (${gb.toFixed(1)} GB)`)
			.join(" + ");
		const lhs = others ? `${others} + ${tier} (${ramGB.toFixed(1)} GB)` : `${tier} (${ramGB.toFixed(1)} GB)`;
		return {
			ok: false,
			reason: `Not enough RAM: ${lhs} would use ${wouldUse.toFixed(1)} GB but the budget on this ${this.totalGB.toFixed(0)} GB machine is ${this.budgetGB.toFixed(1)} GB (${this.headroomGB.toFixed(1)} GB held back for the OS + Detour itself).`,
			snapshot: snap,
		};
	}

	/**
	 * Record a successful start. Replaces any prior entry for the tier.
	 */
	reserve(tier: LlamaTier, ramGB: number): void {
		this.reservations.set(tier, ramGB);
	}

	/**
	 * Clear a reservation. Called on stop(). Safe to call when no
	 * reservation exists.
	 */
	release(tier: LlamaTier): void {
		this.reservations.delete(tier);
	}

	/** Diagnostic surface for the UI / RPC layer. */
	inspect(): ArbiterSnapshot {
		return this.snapshot();
	}
}
