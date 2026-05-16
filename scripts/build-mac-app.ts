#!/usr/bin/env bun
/**
 * build-mac-app — assemble dist/Detour.app from the Swift launcher
 * (Swiftun) + the bun-runtime payload produced by bun run build:agent.
 *
 * No longer depends on electrobun. The Mac app is the shipping artifact;
 * apps/legacy-electrobun/ is the deprecated electrobun-based build.
 *
 * Output: ./dist/Detour.app
 *
 * Layout:
 *   Detour.app/
 *     Contents/
 *       Info.plist                     — bundle id ai.detour.app
 *       MacOS/
 *         Detour                       — Swiftun Swift binary
 *         bun                          — copied from dist-agent/bun
 *         mlx.metallib                 — MLX shader bundle
 *       Resources/
 *         Detour.sdef                  — AppleScript definition
 *         AppIcon.png                  — Detour Squirrel icon
 *         app/                         — bun runtime payload (eliza, plugins, knowledge)
 *
 * Prereqs:
 *   - bun run build:agent     (produces dist-agent/)
 *   - swift toolchain (compiles the Swiftun source)
 *
 * Codesign: ad-hoc only — for distribution rebuild via the canary/stable
 * pipeline which adds full notarization.
 */

import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SWIFTUN_DIR = join(REPO_ROOT, "build-assets", "swiftun-shell");
const SDEF_SRC = join(REPO_ROOT, "build-assets", "applescript-bridge", "Detour.sdef");
// New: consume the agent runtime bundle produced by bun run build:agent.
// Legacy DETOUR_ELECTROBUN_BUILD env var still honored for users who want
// to point at an electrobun-built payload (e.g. for the legacy app builds).
const AGENT_BUILD = process.env.DETOUR_AGENT_BUILD ?? join(REPO_ROOT, "dist-agent");
const LEGACY_ELECTROBUN_BUILD = process.env.DETOUR_ELECTROBUN_BUILD ??
	join(REPO_ROOT, "build", "dev-macos-arm64", "Detour-dev.app");
const DIST = join(REPO_ROOT, "dist");
const APP = join(DIST, "Detour.app");

function bail(msg: string): never {
	console.error(`[build-mac-app] ${msg}`);
	process.exit(1);
}

function ensure(path: string, label: string): void {
	if (!existsSync(path)) bail(`${label} missing: ${path}`);
}

// Source layout: prefer the new dist-agent/, fall back to the old
// electrobun-staged path if the user hasn't migrated yet.
let BUN_BIN_SRC: string;
let APP_PAYLOAD_SRC: string;
if (existsSync(join(AGENT_BUILD, "bun")) && existsSync(join(AGENT_BUILD, "app"))) {
	BUN_BIN_SRC = join(AGENT_BUILD, "bun");
	APP_PAYLOAD_SRC = join(AGENT_BUILD, "app");
	console.log(`[build-mac-app] using agent bundle: ${AGENT_BUILD}`);
} else if (existsSync(LEGACY_ELECTROBUN_BUILD)) {
	BUN_BIN_SRC = join(LEGACY_ELECTROBUN_BUILD, "Contents", "MacOS", "bun");
	APP_PAYLOAD_SRC = join(LEGACY_ELECTROBUN_BUILD, "Contents", "Resources", "app");
	console.log(`[build-mac-app] using LEGACY electrobun build: ${LEGACY_ELECTROBUN_BUILD}`);
	console.log(`[build-mac-app] migrate to: bun run build:agent && bun run build:mac`);
} else {
	bail(
		"No bun runtime payload found. Run `bun run build:agent` first, or set " +
		"DETOUR_AGENT_BUILD / DETOUR_ELECTROBUN_BUILD env var."
	);
}

ensure(BUN_BIN_SRC, "bun runtime binary");
ensure(APP_PAYLOAD_SRC, "agent app payload");
ensure(SDEF_SRC, "Detour.sdef source");

console.log("[build-mac-app] compiling Swift binary…");
execSync("swift build -c release", { cwd: SWIFTUN_DIR, stdio: "inherit" });
const SWIFTUN_BIN = join(SWIFTUN_DIR, ".build", "release", "Swiftun");
ensure(SWIFTUN_BIN, "compiled Swiftun binary");

console.log(`[build-mac-app] (re)building ${APP}`);
rmSync(APP, { recursive: true, force: true });
mkdirSync(join(APP, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(APP, "Contents", "Resources"), { recursive: true });

// The Swift binary keeps its build name "Swiftun" but is installed as
// "Detour" inside the bundle so CFBundleExecutable matches the app id.
cpSync(SWIFTUN_BIN, join(APP, "Contents", "MacOS", "Detour"));
chmodSync(join(APP, "Contents", "MacOS", "Detour"), 0o755);

cpSync(BUN_BIN_SRC, join(APP, "Contents", "MacOS", "bun"));
chmodSync(join(APP, "Contents", "MacOS", "bun"), 0o755);

cpSync(SDEF_SRC, join(APP, "Contents", "Resources", "Detour.sdef"));

// App icon (the Detour Squirrel). Copied into Resources/AppIcon.png
// so CFBundleIconFile resolves and NotificationManager can attach the
// same image to UNNotifications.
const SWIFTUN_RES = join(REPO_ROOT, "build-assets", "swiftun-shell", "Resources");
const ICON_SRC = join(SWIFTUN_RES, "AppIcon.png");
if (existsSync(ICON_SRC)) {
	cpSync(ICON_SRC, join(APP, "Contents", "Resources", "AppIcon.png"));
}

console.log("[build-mac-app] copying bun app payload…");
cpSync(APP_PAYLOAD_SRC, join(APP, "Contents", "Resources", "app"), { recursive: true });

// mlx.metallib — the Metal shader bundle MLX needs at runtime. The
// mlx-swift package itself doesn't ship one as a SwiftPM resource;
// it expects it colocated with the binary. We copy from Homebrew's
// `mlx` formula if present (matched against the linked dylib version),
// otherwise from the swift-build artifacts directory where the
// developer-shell setup placed it. Without this, every Apple-Silicon
// install crashes on the first MLX call.
const METALLIB_CANDIDATES = [
	"/opt/homebrew/lib/mlx.metallib",
	join(REPO_ROOT, "build-assets", "swiftun-shell", ".build", "arm64-apple-macosx", "release", "mlx.metallib"),
];
const METALLIB_DEST = join(APP, "Contents", "MacOS", "mlx.metallib");
let metallibCopied = false;
for (const src of METALLIB_CANDIDATES) {
	if (existsSync(src)) {
		// dereference: true follows the Homebrew symlink and copies the
		// real file. Without this we'd ship a symlink to a path that
		// won't exist on the destination machine.
		cpSync(src, METALLIB_DEST, { dereference: true });
		// Homebrew's mlx.metallib is read-only; codesign needs write
		// permission to attach signature data. chmod to 0o644.
		chmodSync(METALLIB_DEST, 0o644);
		console.log(`[build-mac-app] mlx.metallib ← ${src}`);
		metallibCopied = true;
		break;
	}
}
if (!metallibCopied) {
	console.warn(
		"[build-mac-app] WARNING: mlx.metallib not found in known locations; the shipped app will crash on first MLX call. " +
		"Install Homebrew's `mlx` formula (brew install mlx) or run `cp /opt/homebrew/lib/mlx.metallib " +
		METALLIB_DEST + "` after the build."
	);
}

// As of the consolidation: the Settings / Activity / Pensieve SwiftUI
// surfaces and the Chat / Browser / Gallery / Workspace WKWebView
// windows are all NSWindowControllers inside the single Detour binary.
// We no longer embed nine separate .app bundles — one app, one PID,
// one Dock entry. (DetourTray.app and DetourBridge.app likewise live
// inside the binary as TrayController + AppleScriptCommands.)

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>Detour</string>
	<key>CFBundleIdentifier</key>
	<string>ai.detour.app</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Detour</string>
	<key>CFBundleDisplayName</key>
	<string>Detour</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleSignature</key>
	<string>????</string>
	<key>CFBundleShortVersionString</key>
	<string>0.4.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>LSMultipleInstancesProhibited</key>
	<true/>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>NSAppleScriptEnabled</key>
	<true/>
	<key>OSAScriptingDefinition</key>
	<string>Detour.sdef</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<!-- Privacy entitlements for the omni-agent path: -->
	<!-- STT (SFSpeechRecognizer) — transcribe voice notes, podcast clips, audio attachments -->
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>Detour uses on-device speech recognition to transcribe audio you send to the agent (voice notes, podcast clips, meeting recordings).</string>
	<!-- Mic access if you grant streaming voice-to-agent later -->
	<key>NSMicrophoneUsageDescription</key>
	<string>Detour uses the microphone for voice input to the agent. All processing happens on your device.</string>
	<!-- Camera if vision-on-live-feed lands -->
	<key>NSCameraUsageDescription</key>
	<string>Detour uses the camera only when you explicitly attach a snapshot to the agent.</string>
	<!-- Apple Vision/Photos read for screenshot description -->
	<key>NSPhotoLibraryUsageDescription</key>
	<string>Detour reads photos when you explicitly attach an image to the agent for description.</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>Detour URL</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>detour</string>
			</array>
		</dict>
	</array>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSExceptionDomains</key>
		<dict>
			<key>localhost</key>
			<dict>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<true/>
				<key>NSIncludesSubdomains</key>
				<true/>
			</dict>
		</dict>
	</dict>
</dict>
</plist>
`;
writeFileSync(join(APP, "Contents", "Info.plist"), INFO_PLIST);
writeFileSync(join(APP, "Contents", "PkgInfo"), "APPL????");

console.log("[build-mac-app] ad-hoc codesigning bundle…");
try {
	execSync(`codesign --force --sign - --deep "${APP}"`, { stdio: "inherit" });
} catch (err) {
	console.warn("[build-mac-app] codesign failed (continuing):", err instanceof Error ? err.message : err);
}

// Force LaunchServices to re-register so `ai.detour.app` resolves to
// THIS bundle (rather than any stale Electrobun build that previously
// claimed the identifier). Best-effort — failure is non-fatal.
try {
	const lsregister =
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (existsSync(lsregister)) {
		execSync(`"${lsregister}" -f "${APP}"`, { stdio: "inherit" });
		console.log("[build-mac-app] re-registered with LaunchServices");
	}
} catch (err) {
	console.warn("[build-mac-app] lsregister failed:", err instanceof Error ? err.message : err);
}

console.log(`[build-mac-app] done: ${APP}`);
console.log("[build-mac-app] launch with: open dist/Detour.app");
