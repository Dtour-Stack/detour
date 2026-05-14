/**
 * ProviderQuotaService — tracks paid-plan quota exhaustion per credential
 * so the UI and the runtime can distinguish "your provider hit its weekly
 * cap" from "generic upstream 429" and act accordingly.
 *
 * The runtime calls `mark(...)` when a `QuotaExceededError` propagates out
 * of a model call. The chat-side banner subscribes via `onChange(...)`.
 * The runtime's pre-flight check uses `getActiveCap()` to fail fast
 * instead of hammering an exhausted upstream.
 *
 * Caps clear automatically once `resetsAtMs` has passed, on the next read.
 * No timer — caps are queried frequently enough by the UI banner that
 * a lazy sweep is fine and we avoid an unref'd interval lingering.
 */

export type QuotaCapKind = "plan_quota";

export interface QuotaCap {
	readonly providerId: string;
	readonly accountId: string;
	readonly accountLabel: string;
	readonly kind: QuotaCapKind;
	readonly planType: string;
	readonly resetsAtMs: number;
	readonly upstreamMessage: string;
	readonly markedAtMs: number;
}

export type QuotaChangeHandler = (caps: ReadonlyArray<QuotaCap>) => void;

function capKey(providerId: string, accountId: string): string {
	return `${providerId}::${accountId}`;
}

export class ProviderQuotaService {
	private readonly caps = new Map<string, QuotaCap>();
	private readonly handlers = new Set<QuotaChangeHandler>();
	private activeCredential: { providerId: string; accountId: string } | null = null;

	setActiveCredential(providerId: string | null, accountId: string | null): void {
		if (!providerId || !accountId) {
			this.activeCredential = null;
			return;
		}
		this.activeCredential = { providerId, accountId };
	}

	mark(input: Omit<QuotaCap, "markedAtMs">): QuotaCap {
		const cap: QuotaCap = { ...input, markedAtMs: Date.now() };
		this.caps.set(capKey(cap.providerId, cap.accountId), cap);
		this.emit();
		return cap;
	}

	clear(providerId: string, accountId: string): void {
		const key = capKey(providerId, accountId);
		if (!this.caps.has(key)) return;
		this.caps.delete(key);
		this.emit();
	}

	clearExpired(): void {
		const now = Date.now();
		let changed = false;
		for (const [key, cap] of this.caps.entries()) {
			if (cap.resetsAtMs <= now) {
				this.caps.delete(key);
				changed = true;
			}
		}
		if (changed) this.emit();
	}

	getCap(providerId: string, accountId: string): QuotaCap | null {
		this.clearExpired();
		return this.caps.get(capKey(providerId, accountId)) ?? null;
	}

	getActiveCap(): QuotaCap | null {
		if (!this.activeCredential) return null;
		return this.getCap(this.activeCredential.providerId, this.activeCredential.accountId);
	}

	isCapped(providerId: string, accountId: string): boolean {
		return this.getCap(providerId, accountId) !== null;
	}

	listCaps(): ReadonlyArray<QuotaCap> {
		this.clearExpired();
		return Array.from(this.caps.values());
	}

	onChange(handler: QuotaChangeHandler): () => void {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	private emit(): void {
		const snapshot = this.listCaps();
		for (const handler of this.handlers) {
			try {
				handler(snapshot);
			} catch (err) {
				console.error("[provider-quota] handler threw:", err);
			}
		}
	}
}

let singleton: ProviderQuotaService | null = null;

export function getProviderQuotaService(): ProviderQuotaService {
	if (!singleton) singleton = new ProviderQuotaService();
	return singleton;
}
