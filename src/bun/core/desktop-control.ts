import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type ScreenRegion = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type DesktopScreenshot = {
	path: string;
	url: string;
	region?: ScreenRegion;
	createdAt: number;
};

export type DesktopObservation = {
	platform: NodeJS.Platform;
	createdAt: number;
	focusedApp?: string;
	windows: Array<{
		app: string;
		title?: string;
		x: number;
		y: number;
		width: number;
		height: number;
		focused: boolean;
	}>;
	screens: Array<{
		id: string;
		x: number;
		y: number;
		width: number;
		height: number;
	}>;
};

type ExecResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

const SCREENSHOT_DIR = join(homedir(), ".detour", "screenshots");

const OBSERVE_JXA = `
ObjC.import("AppKit");
const screens = [];
const nsScreens = $.NSScreen.screens;
for (let i = 0; i < nsScreens.count; i++) {
	const frame = nsScreens.objectAtIndex(i).frame;
	screens.push({
		id: String(i),
		x: Number(frame.origin.x),
		y: Number(frame.origin.y),
		width: Number(frame.size.width),
		height: Number(frame.size.height)
	});
}
const events = Application("System Events");
const processes = events.processes.whose({ visible: true })();
const windows = [];
let focusedApp = "";
for (const process of processes) {
	const app = String(process.name());
	let focused = false;
	try { focused = Boolean(process.frontmost()); } catch {}
	if (focused) focusedApp = app;
	try {
		for (const win of process.windows()) {
			let title = "";
			let position = null;
			let size = null;
			try { title = String(win.name() || ""); } catch {}
			try { position = win.position(); } catch {}
			try { size = win.size(); } catch {}
			if (!position || !size || size.length < 2 || Number(size[0]) <= 0 || Number(size[1]) <= 0) continue;
			windows.push({
				app,
				title,
				x: Number(position[0]),
				y: Number(position[1]),
				width: Number(size[0]),
				height: Number(size[1]),
				focused
			});
		}
	} catch {}
}
JSON.stringify({ focusedApp, screens, windows });
`;

function execShort(cmd: string, args: readonly string[], timeoutMs = 10_000): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ exitCode: -1, stdout, stderr: stderr + " [timeout]" });
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", (err) => {
			clearTimeout(timer);
			resolve({ exitCode: -1, stdout, stderr: stderr + " " + (err as Error).message });
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}

function assertDarwin(action: string): void {
	if (process.platform !== "darwin") throw new Error(`${action} is macOS-only for now`);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sanitizeRegion(region: ScreenRegion | undefined): ScreenRegion | undefined {
	if (!region) return undefined;
	const x = finiteNumber(region.x);
	const y = finiteNumber(region.y);
	const width = finiteNumber(region.width);
	const height = finiteNumber(region.height);
	if (x === null || y === null || width === null || height === null) return undefined;
	if (width <= 0 || height <= 0) return undefined;
	return {
		x: Math.round(x),
		y: Math.round(y),
		width: Math.round(width),
		height: Math.round(height),
	};
}

function screenshotPath(label: string): string {
	mkdirSync(SCREENSHOT_DIR, { recursive: true });
	const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "screen";
	return join(SCREENSHOT_DIR, `${Date.now()}-${safe}.png`);
}

export async function captureScreen(options: {
	label?: string;
	region?: ScreenRegion;
	timeoutMs?: number;
} = {}): Promise<DesktopScreenshot> {
	assertDarwin("Screen capture");
	const region = sanitizeRegion(options.region);
	const path = screenshotPath(options.label ?? (region ? "browser" : "screen"));
	const args = ["-x"];
	if (region) args.push("-R", `${region.x},${region.y},${region.width},${region.height}`);
	args.push(path);
	const out = await execShort("screencapture", args, options.timeoutMs ?? 15_000);
	if (out.exitCode !== 0 || !existsSync(path)) {
		throw new Error(out.stderr.trim() || `screencapture exited ${out.exitCode}`);
	}
	return {
		path,
		url: pathToFileURL(path).href,
		...(region ? { region } : {}),
		createdAt: Date.now(),
	};
}

export async function observeDesktop(): Promise<DesktopObservation> {
	assertDarwin("Desktop observation");
	const out = await execShort("osascript", ["-l", "JavaScript", "-e", OBSERVE_JXA], 8_000);
	if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `osascript exited ${out.exitCode}`);
	const parsed = JSON.parse(out.stdout) as {
		focusedApp?: string;
		windows?: DesktopObservation["windows"];
		screens?: DesktopObservation["screens"];
	};
	return {
		platform: process.platform,
		createdAt: Date.now(),
		...(typeof parsed.focusedApp === "string" && parsed.focusedApp ? { focusedApp: parsed.focusedApp } : {}),
		windows: Array.isArray(parsed.windows) ? parsed.windows : [],
		screens: Array.isArray(parsed.screens) ? parsed.screens : [],
	};
}

export async function clickScreen(x: number, y: number): Promise<void> {
	assertDarwin("Computer click");
	const px = finiteNumber(x);
	const py = finiteNumber(y);
	if (px === null || py === null) throw new Error("COMPUTER_CLICK requires numeric x and y");
	const out = await execShort("osascript", ["-e", `tell application "System Events" to click at {${Math.round(px)}, ${Math.round(py)}}`], 5_000);
	if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `osascript exited ${out.exitCode}`);
}

export async function typeText(text: string): Promise<void> {
	assertDarwin("Computer typing");
	if (!text) throw new Error("COMPUTER_TYPE requires text");
	const out = await execShort("osascript", ["-e", `tell application "System Events" to keystroke ${JSON.stringify(text)}`], 10_000);
	if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `osascript exited ${out.exitCode}`);
}

export async function pressKey(key: string, modifiers: readonly string[] = []): Promise<void> {
	assertDarwin("Computer key press");
	const trimmed = key.trim();
	if (!trimmed) throw new Error("COMPUTER_KEY requires key");
	const modifierNames = modifiers
		.map((m) => m.trim().toLowerCase())
		.filter((m) => ["command", "shift", "option", "control"].includes(m))
		.map((m) => `${m} down`);
	const using = modifierNames.length > 0 ? ` using {${modifierNames.join(", ")}}` : "";
	const script = /^\d+$/.test(trimmed)
		? `tell application "System Events" to key code ${trimmed}${using}`
		: `tell application "System Events" to keystroke ${JSON.stringify(trimmed)}${using}`;
	const out = await execShort("osascript", ["-e", script], 5_000);
	if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `osascript exited ${out.exitCode}`);
}

export async function openApp(target: string): Promise<void> {
	assertDarwin("Open app");
	const trimmed = target.trim();
	if (!trimmed) throw new Error("COMPUTER_OPEN_APP requires app, path, or url");
	const args = /^https?:\/\//i.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("file:")
		? [trimmed]
		: ["-a", trimmed];
	const out = await execShort("open", args, 8_000);
	if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `open exited ${out.exitCode}`);
}
