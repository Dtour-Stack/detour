import { spawn } from "node:child_process";
import { logger } from "@elizaos/core";
import type {
	ChroniclerConfig,
	ChroniclerObservation,
	ChroniclerScreen,
	ChroniclerStatus,
	ChroniclerWindow,
} from "../../../shared/index";
import type { ConfigService } from "../config-service";
import type { PensieveMemoryService } from "./memory-service";

const PENSIEVE_PATH = "/observations/user-activity";
const DEFAULT_CONFIG: ChroniclerConfig = {
	enabled: false,
	intervalMs: 60_000,
	includeWindowTitles: true,
	maxWindowsPerScreen: 8,
};

const JXA_SCRIPT = `
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
for (const process of processes) {
	const app = String(process.name());
	let focused = false;
	try { focused = Boolean(process.frontmost()); } catch {}
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
JSON.stringify({ ts: Date.now(), screens, windows });
`;

interface CapturePayload {
	ts?: number;
	screens?: CaptureScreen[];
	windows?: CaptureWindow[];
}

interface CaptureScreen {
	id?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

interface CaptureWindow {
	app?: string;
	title?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	focused?: boolean;
}

export class PensieveChroniclerService {
	private config: ChroniclerConfig = DEFAULT_CONFIG;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight = false;
	private running = false;
	private lastSampleAt: number | undefined;
	private lastMemoryId: string | undefined;
	private lastError: string | undefined;
	private lastObservation: ChroniclerObservation | undefined;
	private readonly recentObservations: ChroniclerObservation[] = [];

	constructor(
		private readonly memories: PensieveMemoryService,
		private readonly configService: ConfigService,
	) {}

	async start(): Promise<void> {
		this.config = await this.configService.getChronicler();
		this.applySchedule();
	}

	stop(): void {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	async configure(next: ChroniclerConfig): Promise<ChroniclerConfig> {
		this.config = await this.configService.setChronicler(next);
		this.applySchedule();
		return this.config;
	}

	getConfig(): ChroniclerConfig {
		return this.config;
	}

	status(): ChroniclerStatus {
		return {
			available: process.platform === "darwin",
			enabled: this.config.enabled,
			running: this.running,
			intervalMs: this.config.intervalMs,
			includeWindowTitles: this.config.includeWindowTitles,
			maxWindowsPerScreen: this.config.maxWindowsPerScreen,
			pensievePath: PENSIEVE_PATH,
			...(this.lastSampleAt ? { lastSampleAt: this.lastSampleAt } : {}),
			...(this.lastMemoryId ? { lastMemoryId: this.lastMemoryId } : {}),
			...(this.lastError ? { lastError: this.lastError } : {}),
			screenCount: this.lastObservation?.screens.length ?? 0,
			windowCount: this.lastObservation?.windowCount ?? 0,
		};
	}

	recent(limit = 20): ChroniclerObservation[] {
		return this.recentObservations.slice(-Math.max(1, Math.min(limit, 100))).reverse();
	}

	async sampleNow(): Promise<ChroniclerObservation> {
		if (process.platform !== "darwin") {
			throw new Error(`Chronicler is macOS-only for now (got ${process.platform}).`);
		}
		const observation = await captureActivity(this.config);
		await this.persist(observation);
		this.recordRecent(observation);
		this.lastError = undefined;
		return observation;
	}

	private applySchedule(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.running = this.config.enabled && process.platform === "darwin";
		if (!this.running) return;
		this.timer = setTimeout(() => void this.tick(), 1_000);
		this.timer.unref?.();
	}

	private async tick(): Promise<void> {
		if (!this.running) return;
		if (!this.inFlight) {
			this.inFlight = true;
			try {
				await this.sampleNow();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.lastError = message;
				logger.warn({ src: "pensieve:chronicler", err: message }, "sample failed");
			} finally {
				this.inFlight = false;
			}
		}
		if (!this.running) return;
		this.timer = setTimeout(() => void this.tick(), this.config.intervalMs);
		this.timer.unref?.();
	}

	private async persist(observation: ChroniclerObservation): Promise<void> {
		const created = await this.memories.create({
			text: renderObservationText(observation),
			path: PENSIEVE_PATH,
			type: "description",
			tags: ["chronicler", "user-activity"],
			extraMetadata: {
				source: "chronicler",
				kind: "user-activity",
				observationId: observation.id,
				ts: observation.ts,
				screens: observation.screens,
				focusedApp: observation.focusedApp,
				focusedTitle: observation.focusedTitle,
				windowCount: observation.windowCount,
				summary: observation.summary,
			},
		});
		if (!created) {
			throw new Error("Pensieve runtime is not ready for chronicler writes.");
		}
		this.lastSampleAt = observation.ts;
		this.lastMemoryId = created.id;
	}

	private recordRecent(observation: ChroniclerObservation): void {
		this.lastObservation = observation;
		this.recentObservations.push(observation);
		if (this.recentObservations.length > 100) this.recentObservations.shift();
	}
}

async function captureActivity(config: ChroniclerConfig): Promise<ChroniclerObservation> {
	const raw = await runJxa(JXA_SCRIPT);
	const payload = JSON.parse(raw) as CapturePayload;
	const ts = finiteNumber(payload.ts) ?? Date.now();
	const screens = normalizeScreens(Array.isArray(payload.screens) ? payload.screens : []);
	const windows = normalizeWindows(Array.isArray(payload.windows) ? payload.windows : [], config.includeWindowTitles);
	assignWindows(screens, windows, config.maxWindowsPerScreen);
	const focused = windows.find((win) => win.focused);
	for (const screen of screens) {
		const screenFocused = screen.windows.find((win) => win.focused);
		if (screenFocused) {
			screen.focusedApp = screenFocused.app;
			if (screenFocused.title) screen.focusedTitle = screenFocused.title;
		}
	}
	const observation: ChroniclerObservation = {
		id: `chronicler-${ts}`,
		ts,
		screens,
		...(focused ? { focusedApp: focused.app } : {}),
		...(focused?.title ? { focusedTitle: focused.title } : {}),
		windowCount: windows.length,
		summary: summarizeObservation(screens, focused),
	};
	return observation;
}

function runJxa(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("osascript", ["-l", "JavaScript", "-e", script], {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("activity capture timed out"));
		}, 8_000);
		timer.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout.trim());
				return;
			}
			reject(new Error(stderr.trim() || `osascript exited with ${code}`));
		});
	});
}

function normalizeScreens(rawScreens: CaptureScreen[]): ChroniclerScreen[] {
	const out = rawScreens.flatMap((screen, index) => {
		const x = finiteNumber(screen.x);
		const y = finiteNumber(screen.y);
		const width = positiveNumber(screen.width);
		const height = positiveNumber(screen.height);
		if (x === null || y === null || width === null || height === null) return [];
		return [{
			id: typeof screen.id === "string" && screen.id.length > 0 ? screen.id : String(index),
			x,
			y,
			width,
			height,
			windows: [],
		}];
	});
	if (out.length > 0) return out;
	return [{ id: "0", x: 0, y: 0, width: 1, height: 1, windows: [] }];
}

function normalizeWindows(rawWindows: CaptureWindow[], includeWindowTitles: boolean): ChroniclerWindow[] {
	return rawWindows.flatMap((win) => {
		if (typeof win.app !== "string" || win.app.length === 0) return [];
		const x = finiteNumber(win.x);
		const y = finiteNumber(win.y);
		const width = positiveNumber(win.width);
		const height = positiveNumber(win.height);
		if (x === null || y === null || width === null || height === null) return [];
		return [{
			app: win.app,
			...(includeWindowTitles && typeof win.title === "string" && win.title.length > 0 ? { title: win.title } : {}),
			x,
			y,
			width,
			height,
			focused: win.focused === true,
		}];
	});
}

function assignWindows(screens: ChroniclerScreen[], windows: ChroniclerWindow[], maxWindowsPerScreen: number): void {
	for (const win of windows) {
		const screen = bestScreenFor(win, screens);
		screen.windows.push(win);
	}
	for (const screen of screens) {
		screen.windows.sort((a, b) => Number(b.focused) - Number(a.focused) || area(b) - area(a));
		screen.windows = screen.windows.slice(0, maxWindowsPerScreen);
	}
}

function bestScreenFor(win: ChroniclerWindow, screens: ChroniclerScreen[]): ChroniclerScreen {
	let best = screens[0]!;
	let bestScore = -1;
	for (const screen of screens) {
		const score = intersectionArea(win, screen);
		if (score > bestScore) {
			best = screen;
			bestScore = score;
		}
	}
	return best;
}

function intersectionArea(win: ChroniclerWindow, screen: ChroniclerScreen): number {
	const left = Math.max(win.x, screen.x);
	const top = Math.max(win.y, screen.y);
	const right = Math.min(win.x + win.width, screen.x + screen.width);
	const bottom = Math.min(win.y + win.height, screen.y + screen.height);
	return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function area(win: ChroniclerWindow): number {
	return win.width * win.height;
}

function summarizeObservation(screens: ChroniclerScreen[], focused: ChroniclerWindow | undefined): string {
	const apps = [...new Set(screens.flatMap((screen) => screen.windows.map((win) => win.app)))].slice(0, 8);
	const focus = focused
		? `Focused ${focused.app}${focused.title ? `: ${focused.title}` : ""}`
		: "No focused window detected";
	return `${focus}. Visible apps: ${apps.length > 0 ? apps.join(", ") : "none"}.`;
}

function renderObservationText(observation: ChroniclerObservation): string {
	const lines = [
		`User activity observation at ${new Date(observation.ts).toISOString()}`,
		observation.summary,
	];
	for (const screen of observation.screens) {
		lines.push(`Screen ${screen.id}:`);
		if (screen.windows.length === 0) {
			lines.push("- No visible windows");
			continue;
		}
		for (const win of screen.windows) {
			const title = win.title ? ` - ${win.title}` : "";
			const focused = win.focused ? " (focused)" : "";
			lines.push(`- ${win.app}${title}${focused}`);
		}
	}
	return lines.join("\n");
}

function finiteNumber(value: number | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: number | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
