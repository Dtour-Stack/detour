import { describe, expect, test } from "bun:test";
import { ngrokArgsForPort, parseNgrokTunnelUrlLine } from "./preview-server-registry";

describe("ngrok preview helpers", () => {
	test("extracts the public HTTPS URL from ngrok JSON logs", () => {
		const line = JSON.stringify({
			lvl: "info",
			msg: "started tunnel",
			url: "https://example.ngrok-free.app",
		});

		expect(parseNgrokTunnelUrlLine(line)).toBe("https://example.ngrok-free.app/");
	});

	test("ignores non-public or malformed tunnel URLs", () => {
		expect(parseNgrokTunnelUrlLine(JSON.stringify({ url: "http://example.ngrok-free.app" }))).toBeNull();
		expect(parseNgrokTunnelUrlLine("not a tunnel")).toBeNull();
	});

	test("passes configured ngrok domains to the CLI", () => {
		const priorDetour = process.env.DETOUR_NGROK_DOMAIN;
		const priorNgrok = process.env.NGROK_DOMAIN;
		try {
			process.env.DETOUR_NGROK_DOMAIN = "preview.example.com";
			delete process.env.NGROK_DOMAIN;
			expect(ngrokArgsForPort(4321)).toEqual([
				"http",
				"http://127.0.0.1:4321",
				"--log=stdout",
				"--log-format=json",
				"--domain=preview.example.com",
			]);
		} finally {
			if (priorDetour === undefined) delete process.env.DETOUR_NGROK_DOMAIN;
			else process.env.DETOUR_NGROK_DOMAIN = priorDetour;
			if (priorNgrok === undefined) delete process.env.NGROK_DOMAIN;
			else process.env.NGROK_DOMAIN = priorNgrok;
		}
	});
});
