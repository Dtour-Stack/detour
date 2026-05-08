#!/usr/bin/env bun
/**
 * Download llama.cpp's prebuilt macOS arm64 release archive and extract the
 * pieces we ship: `llama-server` (OpenAI-compat embeddings + completion HTTP
 * surface) plus the dylibs it loads via @rpath. Cached to a local manifest so
 * we don't redownload between builds.
 *
 * Output: packages/tray/build-assets/llama/
 *   ├── manifest.json        # { tag, downloadedAt, files[] }
 *   ├── llama-server         # the binary (~9 MB)
 *   └── *.dylib              # libllama, libggml*, libmtmd (~12 MB)
 *
 * Why prebuilt instead of building from source:
 *   - llama.cpp's macOS-arm64 release archive (~8 MB) ships everything we
 *     need with Metal + KleidiAI accelerated kernels already enabled.
 *   - Compiling from source per-machine would add ~3-5 minutes to first
 *     build and require CMake. The carrots-style Zig build is even more
 *     setup. We accept upstream's prebuilt artifacts at a pinned tag.
 *
 * Pinning: edit LLAMA_TAG to bump. Manifest tracks tag — we redownload only
 * when the tag changes.
 */

import { execSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LLAMA_TAG = "b9033"; // pinned; bump deliberately

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAY_ROOT = join(HERE, "..");
const OUT_DIR = join(TRAY_ROOT, "build-assets", "llama");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");

interface Manifest {
	readonly tag: string;
	readonly downloadedAt: string;
	readonly files: readonly string[];
}

function platformAssetName(): string {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "darwin" && arch === "arm64") return `llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`;
	if (platform === "darwin" && arch === "x64") return `llama-${LLAMA_TAG}-bin-macos-x64.tar.gz`;
	if (platform === "linux" && arch === "arm64") return `llama-${LLAMA_TAG}-bin-ubuntu-arm64.tar.gz`;
	if (platform === "win32" && arch === "arm64") return `llama-${LLAMA_TAG}-bin-win-cpu-arm64.zip`;
	throw new Error(`No prebuilt llama.cpp for ${platform}/${arch} at tag ${LLAMA_TAG}`);
}

function readManifest(): Manifest | null {
	if (!existsSync(MANIFEST_PATH)) return null;
	try {
		return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const existing = readManifest();
	if (existing?.tag === LLAMA_TAG && existsSync(join(OUT_DIR, "llama-server"))) {
		console.log(`[prepare-llama] up-to-date at ${LLAMA_TAG}`);
		return;
	}
	const assetName = platformAssetName();
	downloadAndExtract(assetName);
	flattenArchiveRoot();
	const { kept, dropped } = trimBundle();
	const finalFiles = finalAssetFiles();
	markExecutable(finalFiles);
	writeManifest(finalFiles);
	const totalBytes = finalFiles.reduce((sum, name) => sum + statSync(join(OUT_DIR, name)).size, 0);
	const mb = (totalBytes / (1024 * 1024)).toFixed(1);
	console.log(`[prepare-llama] kept ${kept}, dropped ${dropped}, total ${mb} MB at tag ${LLAMA_TAG}`);
}

function downloadAndExtract(assetName: string): void {
	const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${assetName}`;
	console.log(`[prepare-llama] downloading ${url}`);
	rmSync(OUT_DIR, { recursive: true, force: true });
	mkdirSync(OUT_DIR, { recursive: true });
	const tmpFile = join(OUT_DIR, assetName);
	execSync(`curl -fsSL "${url}" -o "${tmpFile}"`, { stdio: "inherit" });
	console.log("[prepare-llama] extracting");
	execSync(assetName.endsWith(".zip") ? `unzip -q "${tmpFile}" -d "${OUT_DIR}"` : `tar -xzf "${tmpFile}" -C "${OUT_DIR}"`, { stdio: "inherit" });
	rmSync(tmpFile);
}

function flattenArchiveRoot(): void {
	const root = join(OUT_DIR, `llama-${LLAMA_TAG}`);
	if (!existsSync(root)) return;
	for (const name of readdirSync(root)) {
		execSync(`mv "${join(root, name)}" "${join(OUT_DIR, name)}"`, { stdio: "pipe" });
	}
	rmSync(root, { recursive: true, force: true });
}

function trimBundle(): { kept: number; dropped: number } {
	const keep = new Set<string>(["llama-server", "LICENSE"]);
	let kept = 0;
	let dropped = 0;
	for (const name of readdirSync(OUT_DIR)) {
		if (keep.has(name) || nativeLibrary(name)) kept += 1;
		else if (name !== "manifest.json") {
			rmSync(join(OUT_DIR, name), { recursive: true, force: true });
			dropped += 1;
		}
	}
	return { kept, dropped };
}

function nativeLibrary(name: string): boolean {
	return name.endsWith(".dylib") || name.endsWith(".so") || name.endsWith(".dll");
}

function finalAssetFiles(): string[] {
	return readdirSync(OUT_DIR).filter((name) => name !== "manifest.json");
}

function markExecutable(files: string[]): void {
	for (const name of files) {
		const fp = join(OUT_DIR, name);
		const s = statSync(fp);
		if (s.isFile() && (name === "llama-server" || name.endsWith(".dylib") || name.endsWith(".so"))) {
			chmodSync(fp, 0o755);
		}
	}
}

function writeManifest(files: string[]): void {
	const manifest: Manifest = {
		tag: LLAMA_TAG,
		downloadedAt: new Date().toISOString(),
		files: files.sort(),
	};
	writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

await main();
