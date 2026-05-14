#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const bundlePath = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
if (!bundlePath) {
	console.error("[post-wrap-icon] ELECTROBUN_WRAPPER_BUNDLE_PATH not set.");
	process.exit(1);
}

const source = join(import.meta.dir, "..", "build-assets", "app-icon", "icon.icns");
if (!existsSync(source)) {
	console.error(`[post-wrap-icon] missing ${source}`);
	process.exit(1);
}

const destination = join(bundlePath, "Contents", "Resources", "AppIcon.icns");
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`[post-wrap-icon] copied ${source} to ${destination}`);
