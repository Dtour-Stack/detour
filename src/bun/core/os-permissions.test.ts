import { describe, expect, test } from "bun:test";
import { listPermissions, openPermissionPane } from "./os-permissions";

const SUPPORTED_IDS = [
	"camera",
	"microphone",
	"screen-recording",
	"accessibility",
	"full-disk-access",
	"automation",
	"location",
	"files-folders",
	"input-monitoring",
	"bluetooth",
];

describe("os-permissions", () => {
	test("listPermissions returns all 10 IDs", async () => {
		const list = await listPermissions();
		const ids = list.map((p) => String(p.id)).sort();
		expect(ids).toEqual([...SUPPORTED_IDS].sort());
	});

	test("each entry includes label + enables description (UI surface contract)", async () => {
		const list = await listPermissions();
		for (const p of list) {
			expect(typeof p.label).toBe("string");
			expect(p.label.length).toBeGreaterThan(0);
			expect(typeof p.enables).toBe("string");
			expect(p.enables.length).toBeGreaterThan(10);
		}
	});

	test("non-darwin platforms return status='not-applicable' with no settingsUrl", async () => {
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			const list = await listPermissions();
			expect(list.every((p) => p.status === "not-applicable")).toBe(true);
			expect(list.every((p) => p.settingsUrl === undefined)).toBe(true);
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	});

	test("darwin entries surface the System Settings deep link", async () => {
		if (process.platform !== "darwin") return;
		const list = await listPermissions();
		const screen = list.find((p) => p.id === "screen-recording");
		expect(screen?.settingsUrl).toContain("x-apple.systempreferences");
		expect(screen?.settingsUrl).toContain("Privacy_ScreenCapture");
	});

	test("openPermissionPane on non-darwin throws", async () => {
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			await expect(openPermissionPane("camera")).rejects.toThrow(/macOS/);
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	});
});
