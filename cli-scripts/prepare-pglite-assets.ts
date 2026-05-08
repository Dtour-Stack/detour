#!/usr/bin/env bun
/**
 * Copy PGlite runtime assets out of Bun's store path into a stable location
 * Electrobun's `build.copy` config can reference. The bundled `bun/index.js`
 * does relative `require()` for these files; without them PGlite init fails.
 *
 * We resolve the package via `import.meta.resolve` so we don't hard-code Bun's
 * .bun store path (which embeds version-pinned hashes).
 */
import { mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, fromFileUrl, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAY_ROOT = join(HERE, "..");
const OUT_DIR = join(TRAY_ROOT, "build-assets", "pglite");

const REQUIRED_FILES = [
	"pglite.data",
	"pglite.wasm",
	"initdb.wasm",
	"vector.tar.gz",
	"fuzzystrmatch.tar.gz",
];

async function main() {
	const pgliteEntry = await import.meta.resolve("@electric-sql/pglite");
	const pgliteEntryPath = fileURLToPath(pgliteEntry);
	// pgliteEntryPath looks like .../@electric-sql/pglite/dist/index.js
	const distDir = dirname(pgliteEntryPath);

	if (!existsSync(distDir)) {
		console.error(`[prepare-pglite] dist not found at ${distDir}`);
		process.exit(1);
	}

	mkdirSync(OUT_DIR, { recursive: true });

	const present = new Set(readdirSync(distDir));
	let copied = 0;
	for (const name of REQUIRED_FILES) {
		if (!present.has(name)) {
			console.warn(`[prepare-pglite] missing in pglite dist: ${name}`);
			continue;
		}
		copyFileSync(join(distDir, name), join(OUT_DIR, name));
		copied++;
	}
	console.log(`[prepare-pglite] copied ${copied}/${REQUIRED_FILES.length} files → ${OUT_DIR}`);
}

await main();
