/**
 * MemoryArbiter — RAM budget gate for the three llama tiers (embedding,
 * chat, companion). Each tier asks `shouldAllowStart` before spawning;
 * if the request would push past the budget, refusal returns a
 * human-readable reason the UI surfaces directly.
 *
 * Why this exists: before the arbiter, each tier independently decided
 * to spawn. A user could enable embedding + chat (Qwen3-8B, 11 GB) +
 * companion (Qwen3-1.7B, 4 GB) on a 16 GB Mac and push unified memory
 * into swap, which is fatal for inference latency.
 *
 * Budget = totalGB − headroomGB. Headroom defaults to max(6, 0.3*total):
 * 6 GB on a 16 GB Mac, ~10 GB on a 32 GB Mac.
 *
 * Shared mode (companion reusing the chat server) intentionally skips
 * reservation — no new process means no new RAM cost. Callers must not
 * call `reserve()` when they enter shared mode.
 */

import { totalmem } from "node:os";

export type LlamaTier = "embedding" | "chat" | "companion";

export interface ArbiterDecision {
	readonly ok: boolean;
	readonly reason?: string;
	readonly snapshot: ArbiterSnapshot;
}

export interface ArbiterSnapshot {
	readonly totalGB: number;
	readonly headroomGB: number;
	readonly budgetGB: number;
	readonly usedGB: number;
	readonly reservations: ReadonlyArray<{ tier: LlamaTier; ramGB: number }>;
}

export interface MemoryArbiterConfig {
	/** Override `os.totalmem()` in GB. Tests use this to pin behavior. */
	readonly totalGB?: number;
	/** Override the default `max(6, 0.3 * totalGB)` headroom. */
	readonly headroomGB?: number;
}

export class MemoryArbiter {
	private readonly reservations = new Map<LlamaTier, number>();
	private readonly totalGB: number;
	private readonly headroomGB: number;

	constructor(config: MemoryArbiterConfig = {}) {
		this.totalGB = config.totalGB ?? totalmem() / 1024 ** 3;
		this.headroomGB = config.headroomGB ?? Math.max(6, 0.3 * this.totalGB);
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
	 * Existing reservation for the SAME tier is excluded from the used
	 * total — a tier replacing its own model is evaluated as a swap, not
	 * an addition. Does NOT take the reservation; caller calls `reserve`
	 * after a successful spawn so a failed spawn doesn't leak.
	 */
	shouldAllowStart(tier: LlamaTier, ramGB: number): ArbiterDecision {
		const wouldUse = this.usedGB(tier) + ramGB;
		const snap = this.snapshot();
		// totalmem() returned 0 / NaN — assume the user knows the budget.
		if (this.totalGB <= 0 || !Number.isFinite(this.totalGB)) {
			return { ok: true, snapshot: snap };
		}
		if (wouldUse <= this.budgetGB) {
			return { ok: true, snapshot: snap };
		}
		const others = [...this.reservations.entries()]
			.filter(([t]) => t !== tier)
			.map(([t, gb]) => `${t} (${gb.toFixed(1)} GB)`)
			.join(" + ");
		const lhs = others
			? `${others} + ${tier} (${ramGB.toFixed(1)} GB)`
			: `${tier} (${ramGB.toFixed(1)} GB)`;
		return {
			ok: false,
			reason: `Not enough RAM: ${lhs} would use ${wouldUse.toFixed(1)} GB but the budget on this ${this.totalGB.toFixed(0)} GB machine is ${this.budgetGB.toFixed(1)} GB (${this.headroomGB.toFixed(1)} GB held back for the OS + Detour itself).`,
			snapshot: snap,
		};
	}

	reserve(tier: LlamaTier, ramGB: number): void {
		this.reservations.set(tier, ramGB);
	}

	release(tier: LlamaTier): void {
		this.reservations.delete(tier);
	}

	inspect(): ArbiterSnapshot {
		return this.snapshot();
	}
}
