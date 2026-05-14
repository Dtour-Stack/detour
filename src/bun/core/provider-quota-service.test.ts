import { describe, expect, test } from "bun:test";
import { ProviderQuotaService } from "./provider-quota-service";

function makeCap(overrides: Partial<{ providerId: string; accountId: string; resetsAtMs: number }> = {}) {
	return {
		providerId: overrides.providerId ?? "openai",
		accountId: overrides.accountId ?? "acct-1",
		accountLabel: "Codex Pro",
		kind: "plan_quota" as const,
		planType: "pro",
		resetsAtMs: overrides.resetsAtMs ?? Date.now() + 60_000,
		upstreamMessage: "cap",
	};
}

describe("ProviderQuotaService", () => {
	test("mark + getCap roundtrip", () => {
		const svc = new ProviderQuotaService();
		svc.mark(makeCap());
		const cap = svc.getCap("openai", "acct-1");
		expect(cap).not.toBeNull();
		expect(cap?.planType).toBe("pro");
		expect(svc.isCapped("openai", "acct-1")).toBe(true);
	});

	test("expired caps auto-clear on read", () => {
		const svc = new ProviderQuotaService();
		svc.mark(makeCap({ resetsAtMs: Date.now() - 1_000 }));
		expect(svc.getCap("openai", "acct-1")).toBeNull();
		expect(svc.listCaps()).toHaveLength(0);
	});

	test("getActiveCap follows setActiveCredential", () => {
		const svc = new ProviderQuotaService();
		svc.mark(makeCap({ providerId: "openai", accountId: "acct-1" }));
		svc.mark(makeCap({ providerId: "anthropic", accountId: "acct-A" }));
		// Before setActive, no active cap (we don't know which credential
		// is live yet).
		expect(svc.getActiveCap()).toBeNull();
		svc.setActiveCredential("openai", "acct-1");
		expect(svc.getActiveCap()?.providerId).toBe("openai");
		svc.setActiveCredential("anthropic", "acct-A");
		expect(svc.getActiveCap()?.providerId).toBe("anthropic");
		svc.setActiveCredential(null, null);
		expect(svc.getActiveCap()).toBeNull();
	});

	test("onChange fires on mark and clear", () => {
		const svc = new ProviderQuotaService();
		const events: number[] = [];
		const off = svc.onChange((caps) => events.push(caps.length));
		svc.mark(makeCap());
		svc.mark(makeCap({ accountId: "acct-2" }));
		svc.clear("openai", "acct-1");
		off();
		svc.clear("openai", "acct-2");
		expect(events).toEqual([1, 2, 1]);
	});

	test("clear is a no-op for unknown credential", () => {
		const svc = new ProviderQuotaService();
		const events: number[] = [];
		svc.onChange((caps) => events.push(caps.length));
		svc.clear("openai", "ghost");
		expect(events).toEqual([]);
	});
});
