import { describe, expect, test } from "bun:test";
import { SERVICE_METHODS, isMethodAllowed, permissionForService } from "./service-registry";

describe("carrot service registry", () => {
	test("keeps vault carrots away from secret material", () => {
		expect(permissionForService("vault")).toBe("service:vault");
		expect(SERVICE_METHODS.vault).toEqual(["hasMasterKey"]);
		expect(isMethodAllowed("vault", "hasMasterKey")).toBe(true);
		expect(isMethodAllowed("vault", "listSecretIds")).toBe(false);
		expect(isMethodAllowed("vault", "getSecret")).toBe(false);
	});
});
