#!/usr/bin/env bun
/**
 * Generate the icon set:
 *   - Tray icon: from `source-tray.png` (black silhouette w/ alpha) → 16x16
 *     and 32x32 PNGs as macOS template images.
 *   - App icon: from `source-app-icon.png` → .icns (macOS) + .png (cross-plat)
 *   - Web favicons: from source-tray.png → 16/32/180/192/512 + favicon.ico.
 *
 * Uses macOS-native `sips` and `iconutil` (no external dependencies).
 * favicon.ico is hand-emitted: ICO is just a header + PNG payloads.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAY_ROOT = join(HERE, "..");
const ASSETS = join(TRAY_ROOT, "build-assets");
const TRAY_OUT = join(ASSETS, "tray");
const APP_OUT = join(ASSETS, "app-icon");
const WEB_PUBLIC = join(TRAY_ROOT, "..", "web", "public");

const SOURCE_TRAY = join(ASSETS, "source-tray.png");
const SOURCE_APP = join(ASSETS, "source-app-icon.png");

function sips(args: string[]): void {
	execFileSync("sips", args, { stdio: "pipe" });
}

function resizePng(source: string, size: number, dest: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	sips(["-z", String(size), String(size), "-s", "format", "png", source, "--out", dest]);
}

function buildTrayIcons() {
	console.log("[icons] tray (template, transparent black)");
	rmSync(TRAY_OUT, { recursive: true, force: true });
	mkdirSync(TRAY_OUT, { recursive: true });
	resizePng(SOURCE_TRAY, 16, join(TRAY_OUT, "iconTemplate.png"));
	resizePng(SOURCE_TRAY, 32, join(TRAY_OUT, "iconTemplate@2x.png"));
	resizePng(SOURCE_TRAY, 64, join(TRAY_OUT, "iconTemplate@3x.png"));
}

function buildAppIcon() {
	console.log("[icons] app (.icns + .iconset for Electrobun)");
	rmSync(APP_OUT, { recursive: true, force: true });
	mkdirSync(APP_OUT, { recursive: true });
	// Electrobun's build.mac.icons points at an .iconset folder; iconutil
	// converts it to AppIcon.icns at bundle time. Leave the iconset in
	// place for that and ALSO emit a standalone icon.icns / icon.png for
	// dev-mode usage (BrowserWindow icon, README, etc.).
	const iconset = join(APP_OUT, "icon.iconset");
	mkdirSync(iconset, { recursive: true });
	const sizes: Array<[number, string]> = [
		[16, "icon_16x16.png"],
		[32, "icon_16x16@2x.png"],
		[32, "icon_32x32.png"],
		[64, "icon_32x32@2x.png"],
		[128, "icon_128x128.png"],
		[256, "icon_128x128@2x.png"],
		[256, "icon_256x256.png"],
		[512, "icon_256x256@2x.png"],
		[512, "icon_512x512.png"],
		[1024, "icon_512x512@2x.png"],
	];
	for (const [size, name] of sizes) {
		resizePng(SOURCE_APP, size, join(iconset, name));
	}
	execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(APP_OUT, "icon.icns")], { stdio: "pipe" });
	resizePng(SOURCE_APP, 512, join(APP_OUT, "icon.png"));
	// Keep iconset for Electrobun build pipeline.
}

function buildFavicons() {
	console.log("[icons] favicons (web/public)");
	mkdirSync(WEB_PUBLIC, { recursive: true });
	resizePng(SOURCE_TRAY, 16, join(WEB_PUBLIC, "favicon-16.png"));
	resizePng(SOURCE_TRAY, 32, join(WEB_PUBLIC, "favicon-32.png"));
	resizePng(SOURCE_TRAY, 180, join(WEB_PUBLIC, "apple-touch-icon.png"));
	resizePng(SOURCE_TRAY, 192, join(WEB_PUBLIC, "favicon-192.png"));
	resizePng(SOURCE_TRAY, 512, join(WEB_PUBLIC, "favicon-512.png"));
	// favicon.ico — hand-emit ICO container with the 16+32+48 PNGs embedded
	resizePng(SOURCE_TRAY, 48, join(WEB_PUBLIC, "favicon-48.png"));
	const png16 = readFileSync(join(WEB_PUBLIC, "favicon-16.png"));
	const png32 = readFileSync(join(WEB_PUBLIC, "favicon-32.png"));
	const png48 = readFileSync(join(WEB_PUBLIC, "favicon-48.png"));
	writeFileSync(join(WEB_PUBLIC, "favicon.ico"), buildIco([
		{ size: 16, png: png16 },
		{ size: 32, png: png32 },
		{ size: 48, png: png48 },
	]));
	rmSync(join(WEB_PUBLIC, "favicon-48.png"));
}

/**
 * Hand-emit a valid favicon.ico container.
 *
 * Layout: 6-byte ICONDIR + N×16-byte ICONDIRENTRY + N×PNG payloads.
 * Modern browsers accept embedded PNGs (the alternative is BMP-with-AND-mask
 * which is ancient and gnarly). Each entry stores width=0 / height=0 to
 * indicate 256 (max). We use the actual size since all our entries are ≤48.
 */
function buildIco(entries: Array<{ size: number; png: Buffer }>): Buffer {
	const HEADER_SIZE = 6;
	const ENTRY_SIZE = 16;
	const headers = Buffer.alloc(HEADER_SIZE + ENTRY_SIZE * entries.length);
	headers.writeUInt16LE(0, 0); // reserved
	headers.writeUInt16LE(1, 2); // type = icon
	headers.writeUInt16LE(entries.length, 4);
	let offset = HEADER_SIZE + ENTRY_SIZE * entries.length;
	const chunks: Buffer[] = [headers];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		const entryPos = HEADER_SIZE + ENTRY_SIZE * i;
		headers.writeUInt8(e.size === 256 ? 0 : e.size, entryPos);     // width
		headers.writeUInt8(e.size === 256 ? 0 : e.size, entryPos + 1); // height
		headers.writeUInt8(0, entryPos + 2); // colors in palette
		headers.writeUInt8(0, entryPos + 3); // reserved
		headers.writeUInt16LE(1, entryPos + 4); // color planes
		headers.writeUInt16LE(32, entryPos + 6); // bits per pixel
		headers.writeUInt32LE(e.png.length, entryPos + 8); // size of PNG data
		headers.writeUInt32LE(offset, entryPos + 12);
		chunks.push(e.png);
		offset += e.png.length;
	}
	return Buffer.concat(chunks);
}

if (!existsSync(SOURCE_TRAY)) {
	console.error(`[icons] missing ${SOURCE_TRAY}`);
	process.exit(1);
}
if (!existsSync(SOURCE_APP)) {
	console.error(`[icons] missing ${SOURCE_APP}`);
	process.exit(1);
}

buildTrayIcons();
buildAppIcon();
buildFavicons();

console.log("[icons] done");
