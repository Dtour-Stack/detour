#!/usr/bin/env bun
/**
 * postBuild hook — inject an App Transport Security exception for
 * `localhost` into the .app bundle's Info.plist so the embedded
 * WKWebView can load `http://*.localhost:<port>/` URLs.
 *
 * macOS WKWebView's default ATS rejects plain HTTP. Our portless
 * preview proxy is HTTP-only on a non-privileged port, so without an
 * exception the workspace's preview iframe can't load any URL the
 * preview server gives it.
 *
 * Scope: `localhost` only. We don't blanket-allow arbitrary HTTP —
 * users who need that can paste a broader exception themselves.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir) {
	console.error("[post-build-ats] ELECTROBUN_BUILD_DIR not set, skipping.");
	process.exit(0);
}

const appName = process.env.ELECTROBUN_APP_NAME ?? "Detour";
// In dev: <buildDir>/<App>-dev.app; in prod: <buildDir>/<App>.app
const candidates = [
	join(buildDir, `${appName}-dev.app/Contents/Info.plist`),
	join(buildDir, `${appName}.app/Contents/Info.plist`),
];
const plistPath = candidates.find((p) => existsSync(p));
if (!plistPath) {
	console.error(`[post-build-ats] Info.plist not found in any of: ${candidates.join(", ")}`);
	process.exit(0);
}

const original = readFileSync(plistPath, "utf8");
if (original.includes("NSAppTransportSecurity")) {
	console.log(`[post-build-ats] ${plistPath} already has ATS keys, skipping.`);
	process.exit(0);
}

const atsBlock = `	<key>NSAppTransportSecurity</key>
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
`;

// Inject right before </dict></plist>. The default Electrobun-generated
// plist uses tab indentation, matching atsBlock above.
const closingDictIdx = original.lastIndexOf("</dict>");
if (closingDictIdx === -1) {
	console.error("[post-build-ats] could not find </dict> in Info.plist; skipping.");
	process.exit(0);
}
const patched = original.slice(0, closingDictIdx) + atsBlock + original.slice(closingDictIdx);
writeFileSync(plistPath, patched, "utf8");
console.log(`[post-build-ats] injected ATS localhost exception into ${plistPath}`);

// Chained: ensure the runtime-loaded `coding-agent-adapters` package
// (used by pty-manager's worker for CLI adapter registration) and its
// pino dep tree make it into the .app. Runs in-process so the single
// `postBuild` hook covers both concerns. See post-build-pty-adapters.ts.
await import("./post-build-pty-adapters");

// Compile + embed DetourBridge.app — the Swift companion that gives
// Detour a real AppleScript surface. Best-effort; skips silently if
// swiftc is missing. See post-build-applescript-bridge.ts and
// docs/applescript.md.
await import("./post-build-applescript-bridge");

// Compile + embed DetourTray.app — the Swift companion that owns the
// menu-bar NSStatusItem with a rich native NSMenu (MeetingBar-style).
// Replaces Electrobun's basic tray. Best-effort; same skip behavior.
await import("./post-build-tray-bridge");

// Compile + embed DetourSettings.app — the SwiftUI Settings companion.
// The React Settings stays as fallback for tabs the SwiftUI surface
// doesn't cover yet.
await import("./post-build-settings-bridge");

// Compile + embed DetourActivity.app + DetourPensieve.app — per-surface
// SwiftUI windows. Each is read-mostly today and deep-links into the
// React shell for editing flows we haven't ported yet.
await import("./post-build-activity-bridge");
await import("./post-build-pensieve-bridge");

// Compile + embed the remaining surface companions. Today these are
// thin WKWebView shells pointing at Bun-served React HTML; the
// SwiftUI interior gets ported incrementally without touching the
// outer process model.
await import("./post-build-chat-bridge");
await import("./post-build-browser-bridge");
await import("./post-build-gallery-bridge");
await import("./post-build-workspace-bridge");
