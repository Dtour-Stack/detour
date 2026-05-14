import { describe, expect, test } from "bun:test";
import type { PortlessSnapshot } from "../../portless";
import { resolvePhantomPortalConfig } from "./phantom";

const stoppedPortless: PortlessSnapshot = {
	running: false,
	proxyPort: 4848,
	proxyHttps: false,
	tld: "localhost",
	routes: [],
	bindError: null,
};

describe("phantom portal config", () => {
	test("uses bundled app redirect when no public dev URL is configured", () => {
		const config = resolvePhantomPortalConfig({
			appIdRaw: " d7c039d5-9ea4-48c8-8c39-7a57923ff9ce ",
			explicitRedirectUrlRaw: "",
			detourDevUrlRaw: "",
			phantomPortlessFqdnRaw: "",
			phantomPortlessHostRaw: "",
			portlessSnapshot: stoppedPortless,
			addPortlessRoute: () => undefined,
		});

		expect(config.appId).toBe("d7c039d5-9ea4-48c8-8c39-7a57923ff9ce");
		expect(config.redirectUrl).toBe("views://main/index.html");
		expect(config.portalAllowedOrigins).toEqual(["views://main"]);
		expect(config.portalRedirectUrls).toEqual(["views://main/index.html"]);
	});

	test("normalizes explicit http redirect roots for Portal", () => {
		const config = resolvePhantomPortalConfig({
			appIdRaw: "app-id",
			explicitRedirectUrlRaw: "https://detour.example",
			detourDevUrlRaw: "",
			phantomPortlessFqdnRaw: "",
			phantomPortlessHostRaw: "",
			portlessSnapshot: stoppedPortless,
			addPortlessRoute: () => undefined,
		});

		expect(config.redirectUrl).toBe("https://detour.example/");
		expect(config.portalAllowedOrigins).toEqual(["https://detour.example"]);
		expect(config.portalRedirectUrls).toEqual(["https://detour.example/"]);
	});

	test("registers portless redirect when local dev URL and portless are running", () => {
		const routes: Array<{ hostname: string; port: number }> = [];
		const config = resolvePhantomPortalConfig({
			appIdRaw: "app-id",
			explicitRedirectUrlRaw: "",
			detourDevUrlRaw: "http://127.0.0.1:5180",
			phantomPortlessFqdnRaw: "wallet.detour.localhost",
			phantomPortlessHostRaw: "",
			portlessSnapshot: {
				...stoppedPortless,
				running: true,
				proxyPort: 443,
				proxyHttps: true,
			},
			addPortlessRoute: (hostname, port) => routes.push({ hostname, port }),
		});

		expect(routes).toEqual([{ hostname: "wallet.detour.localhost", port: 5180 }]);
		expect(config.redirectUrl).toBe("https://wallet.detour.localhost/");
		expect(config.portalAllowedOrigins).toEqual(["https://wallet.detour.localhost", "http://127.0.0.1:5180"]);
	});
});
