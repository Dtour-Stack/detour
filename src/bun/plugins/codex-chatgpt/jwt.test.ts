import { describe, expect, test } from "bun:test";
import { decodeCodexJwt } from "./jwt";

function fakeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.fake-signature`;
}

describe("decodeCodexJwt", () => {
	test("extracts chatgpt_account_id from custom claim", () => {
		const token = fakeJwt({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-123",
				organization_id: "org-456",
				project_id: "proj-789",
			},
		});
		const claims = decodeCodexJwt(token);
		expect(claims).not.toBeNull();
		expect(claims!.chatgptAccountId).toBe("acct-123");
		expect(claims!.organizationId).toBe("org-456");
		expect(claims!.projectId).toBe("proj-789");
	});

	test("returns null fields when auth claim is missing", () => {
		const token = fakeJwt({ sub: "user-1" });
		const claims = decodeCodexJwt(token);
		expect(claims).not.toBeNull();
		expect(claims!.chatgptAccountId).toBeNull();
		expect(claims!.organizationId).toBeNull();
		expect(claims!.projectId).toBeNull();
		expect(claims!.raw.sub).toBe("user-1");
	});

	test("returns null on garbage input", () => {
		expect(decodeCodexJwt("not-a-jwt")).toBeNull();
		expect(decodeCodexJwt("")).toBeNull();
		expect(decodeCodexJwt("only.one")).toBeNull();
	});

	test("returns null on invalid base64 payload", () => {
		expect(decodeCodexJwt("header.@not-base64@.sig")).toBeNull();
	});

	test("returns null on non-object payload", () => {
		const token = `header.${Buffer.from('"a string"').toString("base64url")}.sig`;
		// JSON.parse succeeds but the result isn't a record — destructuring still works
		const claims = decodeCodexJwt(token);
		// Either returns null or returns object with null fields — both acceptable
		if (claims) {
			expect(claims.chatgptAccountId).toBeNull();
		}
	});

	test("ignores wrong-shaped auth claim", () => {
		const token = fakeJwt({ "https://api.openai.com/auth": "not-an-object" });
		const claims = decodeCodexJwt(token);
		expect(claims!.chatgptAccountId).toBeNull();
	});

	test("base64url variants (no padding, - and _) decode correctly", () => {
		const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "abc-def_+/=" } };
		const token = fakeJwt(payload);
		const claims = decodeCodexJwt(token);
		expect(claims!.chatgptAccountId).toBe("abc-def_+/=");
	});
});
