/**
 * macOS TCC (Transparency, Consent, Control) permission surface.
 *
 * macOS doesn't expose a clean public API for "is this app granted permission X"
 * — the canonical query (`AVCaptureDevice.authorizationStatus`,
 * `AXIsProcessTrusted`, etc.) lives in private framework headers we can't reach
 * from Bun. So we do two things:
 *
 *   1. **Probe** what we can with shell-outs (mostly Accessibility +
 *      Screen Recording have testable side-effects).
 *   2. **Deep link** to the right System Settings pane so the user can
 *      grant / revoke. Detection is best-effort; granting is always a
 *      one-click hop.
 *
 * Linux/Windows: returns a flat list with `available: false` and a note —
 * TCC is macOS-specific.
 */

import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";

export type PermissionStatus = "granted" | "denied" | "unknown" | "not-applicable";

export type PermissionId =
	| "camera"
	| "microphone"
	| "screen-recording"
	| "accessibility"
	| "full-disk-access"
	| "automation"
	| "location"
	| "files-folders"
	| "input-monitoring"
	| "bluetooth";

export interface PermissionInfo {
	id: PermissionId;
	label: string;
	/** What the agent can do with this permission. */
	enables: string;
	status: PermissionStatus;
	detail?: string;
	/** macOS x-apple.systempreferences URL to deep-link to the right pane. */
	settingsUrl?: string;
}

const PANES: Record<PermissionId, string> = {
	camera: "Privacy_Camera",
	microphone: "Privacy_Microphone",
	"screen-recording": "Privacy_ScreenCapture",
	accessibility: "Privacy_Accessibility",
	"full-disk-access": "Privacy_AllFiles",
	automation: "Privacy_Automation",
	location: "Privacy_LocationServices",
	"files-folders": "Privacy_FilesAndFolders",
	"input-monitoring": "Privacy_ListenEvent",
	bluetooth: "Privacy_Bluetooth",
};

const ENABLES: Record<PermissionId, { label: string; enables: string }> = {
	camera: {
		label: "Camera",
		enables: "Capture photos and video for vision-based agent tasks (e.g. analyze what's on your desk).",
	},
	microphone: {
		label: "Microphone",
		enables: "Capture audio for voice input or transcription.",
	},
	"screen-recording": {
		label: "Screen Recording",
		enables: "Take screenshots so the agent can see the contents of any window — required for browser/UI automation.",
	},
	accessibility: {
		label: "Accessibility",
		enables: "Simulate keystrokes and mouse clicks; required for the agent to control other apps (autofill, scripted UI).",
	},
	"full-disk-access": {
		label: "Full Disk Access",
		enables: "Read and write files anywhere on disk (Documents, Library, etc.). Be cautious — this is broad.",
	},
	automation: {
		label: "Automation (AppleScript)",
		enables: "Send AppleScript commands to other apps (Safari tabs, Mail, Finder, etc.).",
	},
	location: {
		label: "Location",
		enables: "Read your current location for location-aware actions (weather, nearby search).",
	},
	"files-folders": {
		label: "Files and Folders",
		enables: "Read specific user folders without Full Disk Access (Documents, Downloads, Desktop).",
	},
	"input-monitoring": {
		label: "Input Monitoring",
		enables: "Observe keyboard / mouse events globally — for hotkey-style agent triggers.",
	},
	bluetooth: {
		label: "Bluetooth",
		enables: "Discover and connect to nearby Bluetooth devices.",
	},
};

const PERMISSIONS: PermissionId[] = [
	"screen-recording",
	"accessibility",
	"automation",
	"microphone",
	"camera",
	"full-disk-access",
	"files-folders",
	"input-monitoring",
	"location",
	"bluetooth",
];

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function execShort(cmd: string, args: readonly string[], timeoutMs = 5000): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ exitCode: -1, stdout, stderr: stderr + " [timeout]" });
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ exitCode: -1, stdout, stderr: stderr + " " + (err as Error).message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}

// ── Probe implementations ─────────────────────────────────────────────────

/**
 * Take a 1x1 screenshot to /tmp. If granted, exit 0. If denied, screencapture
 * still produces a (mostly black) image but writes to stderr "screencapture: ...
 * cannot be completed because Screen Recording permission has not been granted".
 */
async function probeScreenRecording(): Promise<{ status: PermissionStatus; detail: string }> {
	const tmp = `/tmp/.detour-screencap-${Date.now()}.png`;
	const out = await execShort("screencapture", ["-x", "-R", "0,0,1,1", tmp]);
	try {
		unlinkSync(tmp);
	} catch {
		// no file written → probably denied
	}
	if (out.exitCode === 0 && !/permission/i.test(out.stderr)) {
		return { status: "granted", detail: "screencapture probe succeeded" };
	}
	if (/permission/i.test(out.stderr)) {
		return { status: "denied", detail: out.stderr.trim().slice(0, 200) };
	}
	return { status: "unknown", detail: out.stderr.trim().slice(0, 200) || "indeterminate" };
}

/**
 * Send a no-op AppleScript that requires Accessibility (synthesizing a key
 * event with no key). Granted → exit 0; denied → AppleScript error 1002.
 */
async function probeAccessibility(): Promise<{ status: PermissionStatus; detail: string }> {
	const out = await execShort("osascript", [
		"-e",
		'tell application "System Events" to get UI elements enabled',
	]);
	if (out.exitCode === 0) {
		return { status: out.stdout.trim() === "true" ? "granted" : "denied", detail: out.stdout.trim() };
	}
	if (/not allowed assistive access|1002|not authorised/i.test(out.stderr)) {
		return { status: "denied", detail: out.stderr.trim().slice(0, 200) };
	}
	return { status: "unknown", detail: out.stderr.trim().slice(0, 200) };
}

/**
 * AppleScript to query a benign target (System Events name). Granted → exit 0;
 * denied → user prompt OR error -1743.
 */
async function probeAutomation(): Promise<{ status: PermissionStatus; detail: string }> {
	const out = await execShort("osascript", ["-e", 'tell application "System Events" to get name'], 3000);
	if (out.exitCode === 0) return { status: "granted", detail: out.stdout.trim() };
	if (/-1743|not allowed/i.test(out.stderr)) return { status: "denied", detail: out.stderr.trim().slice(0, 200) };
	return { status: "unknown", detail: out.stderr.trim().slice(0, 200) };
}

/**
 * Try to read a small file in ~/Library/Application Support/com.apple.TCC/
 * which requires Full Disk Access. Read-only probe.
 */
async function probeFullDiskAccess(): Promise<{ status: PermissionStatus; detail: string }> {
	const out = await execShort("ls", [`${process.env.HOME ?? ""}/Library/Application Support/com.apple.TCC`]);
	if (out.exitCode === 0) return { status: "granted", detail: "TCC dir readable" };
	return { status: "denied", detail: out.stderr.trim().slice(0, 200) || "cannot read TCC dir" };
}

// ── Public API ────────────────────────────────────────────────────────────

export async function listPermissions(): Promise<PermissionInfo[]> {
	if (process.platform !== "darwin") {
		return PERMISSIONS.map<PermissionInfo>((id) => ({
			id,
			label: ENABLES[id].label,
			enables: ENABLES[id].enables,
			status: "not-applicable",
			detail: `${process.platform}: macOS-only TCC permission`,
		}));
	}
	const result: PermissionInfo[] = [];
	for (const id of PERMISSIONS) {
		const info: PermissionInfo = {
			id,
			label: ENABLES[id].label,
			enables: ENABLES[id].enables,
			status: "unknown",
			settingsUrl: `x-apple.systempreferences:com.apple.preference.security?${PANES[id]}`,
		};
		try {
			if (id === "screen-recording") {
				const { status, detail } = await probeScreenRecording();
				info.status = status;
				info.detail = detail;
			} else if (id === "accessibility") {
				const { status, detail } = await probeAccessibility();
				info.status = status;
				info.detail = detail;
			} else if (id === "automation") {
				const { status, detail } = await probeAutomation();
				info.status = status;
				info.detail = detail;
			} else if (id === "full-disk-access") {
				const { status, detail } = await probeFullDiskAccess();
				info.status = status;
				info.detail = detail;
			} else {
				info.status = "unknown";
				info.detail = "No reliable probe — open System Settings to check/grant.";
			}
		} catch (err) {
			info.detail = err instanceof Error ? err.message : String(err);
		}
		result.push(info);
	}
	return result;
}

export async function openPermissionPane(id: PermissionId): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error(`OS permission panes are macOS-specific (got ${process.platform})`);
	}
	const url = `x-apple.systempreferences:com.apple.preference.security?${PANES[id]}`;
	await new Promise<void>((resolve, reject) => {
		const child = spawn("open", [url], { stdio: "ignore", detached: true, shell: false });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
