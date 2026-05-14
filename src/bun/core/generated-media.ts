import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GeneratedMediaItem, GeneratedMediaKind } from "../../shared/rpc/media";

type MediaInput = {
	kind: GeneratedMediaKind;
	provider: string;
	capability: string;
	title?: string;
	prompt?: string;
	model?: string;
	sourceUrl?: string;
};

type SaveBytesInput = MediaInput & {
	bytes: Uint8Array;
	contentType: string;
	extension?: string;
};

type SaveUrlInput = MediaInput & {
	url: string;
	contentType?: string;
};

type JsonManifest = {
	items: GeneratedMediaItem[];
};

const INDEX_FILE = "index.json";

export function generatedMediaRoot(): string {
	const configured = process.env.DETOUR_GENERATED_MEDIA_DIR;
	if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
	return join(homedir(), ".detour", "generated-media");
}

export function generatedMediaFileUrl(path: string): string {
	return pathToFileURL(path).toString();
}

export async function listGeneratedMedia(params: {
	kind?: GeneratedMediaKind;
	provider?: string;
	limit?: number;
} = {}): Promise<{ items: GeneratedMediaItem[]; root: string }> {
	const root = generatedMediaRoot();
	const manifest = await readManifest(root);
	const provider = params.provider?.trim().toLowerCase();
	const limit = Math.max(1, Math.min(500, Math.round(params.limit ?? 200)));
	const items = manifest.items
		.filter((item) => !params.kind || item.kind === params.kind)
		.filter((item) => !provider || item.provider.toLowerCase() === provider)
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, limit)
		.map((item) => ({ ...item, url: generatedMediaFileUrl(item.path) }));
	return { items, root };
}

export async function revealGeneratedMedia(id: string): Promise<void> {
	const root = generatedMediaRoot();
	const manifest = await readManifest(root);
	const item = manifest.items.find((entry) => entry.id === id);
	if (!item) throw new Error(`Generated media item not found: ${id}`);
	const proc = Bun.spawn({
		cmd: ["open", "-R", item.path],
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	(proc as { unref?: () => void }).unref?.();
}

export async function saveGeneratedMediaBytes(input: SaveBytesInput): Promise<GeneratedMediaItem> {
	const root = generatedMediaRoot();
	const dir = join(root, input.kind, safeSlug(input.provider));
	await mkdir(dir, { recursive: true });
	const ext = sanitizeExtension(input.extension ?? extensionForContentType(input.contentType, input.kind));
	const id = randomUUID();
	const fileName = `${Date.now()}-${safeSlug(input.title ?? input.prompt ?? input.capability)}-${id.slice(0, 8)}.${ext}`;
	const path = join(dir, fileName);
	await writeFile(path, input.bytes);
	const item = mediaItem(input, id, path, input.contentType, input.bytes.byteLength);
	await appendManifest(root, item);
	return item;
}

export async function saveGeneratedMediaUrl(input: SaveUrlInput): Promise<GeneratedMediaItem> {
	if (input.url.startsWith("data:")) {
		const decoded = decodeDataUrl(input.url);
		return saveGeneratedMediaBytes({
			...input,
			bytes: decoded.bytes,
			contentType: decoded.contentType,
			extension: extensionForContentType(decoded.contentType, input.kind),
			sourceUrl: input.sourceUrl ?? input.url.slice(0, 80),
		});
	}
	if (/^https?:\/\//i.test(input.url)) {
		const response = await fetch(input.url);
		if (!response.ok) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(`Could not download generated media: HTTP ${response.status}: ${text.slice(0, 240)}`);
		}
		const contentType = input.contentType ?? response.headers.get("content-type") ?? "application/octet-stream";
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength === 0) throw new Error("Generated media download was empty.");
		return saveGeneratedMediaBytes({
			...input,
			bytes,
			contentType,
			extension: extensionForUrl(input.url) ?? extensionForContentType(contentType, input.kind),
			sourceUrl: input.sourceUrl ?? input.url,
		});
	}
	const sourcePath = input.url.startsWith("file://") ? fileURLToPath(input.url) : resolve(expandHome(input.url));
	const sourceStat = await stat(sourcePath);
	if (!sourceStat.isFile()) throw new Error(`Generated media source is not a file: ${sourcePath}`);
	const root = generatedMediaRoot();
	const dir = join(root, input.kind, safeSlug(input.provider));
	await mkdir(dir, { recursive: true });
	const id = randomUUID();
	const ext = sanitizeExtension(extensionForUrl(sourcePath) ?? extensionForContentType(input.contentType, input.kind));
	const fileName = `${Date.now()}-${safeSlug(input.title ?? input.prompt ?? basename(sourcePath))}-${id.slice(0, 8)}.${ext}`;
	const path = join(dir, fileName);
	await copyFile(sourcePath, path);
	const contentType = input.contentType ?? contentTypeForExtension(ext, input.kind);
	const item = mediaItem(input, id, path, contentType, sourceStat.size);
	await appendManifest(root, item);
	return item;
}

export function extensionForContentType(contentType: string | undefined, kind: GeneratedMediaKind): string {
	const lower = contentType?.toLowerCase() ?? "";
	if (lower.includes("png")) return "png";
	if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
	if (lower.includes("webp")) return "webp";
	if (lower.includes("gif")) return "gif";
	if (lower.includes("mp4")) return "mp4";
	if (lower.includes("quicktime")) return "mov";
	if (lower.includes("webm")) return "webm";
	if (lower.includes("wav")) return "wav";
	if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
	if (lower.includes("ogg")) return "ogg";
	if (lower.includes("flac")) return "flac";
	if (kind === "image") return "png";
	if (kind === "video") return "mp4";
	return "mp3";
}

function mediaItem(
	input: MediaInput,
	id: string,
	path: string,
	contentType: string,
	bytes: number,
): GeneratedMediaItem {
	return {
		id,
		kind: input.kind,
		provider: input.provider,
		capability: input.capability,
		title: input.title ?? titleFor(input),
		path,
		url: generatedMediaFileUrl(path),
		contentType,
		bytes,
		createdAt: Date.now(),
		...(input.prompt ? { prompt: input.prompt } : {}),
		...(input.model ? { model: input.model } : {}),
		...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
	};
}

function titleFor(input: MediaInput): string {
	const base = input.prompt ?? input.capability;
	return `${input.provider} ${input.kind}: ${base.slice(0, 80)}`;
}

async function appendManifest(root: string, item: GeneratedMediaItem): Promise<void> {
	const manifest = await readManifest(root);
	const next = {
		items: [item, ...manifest.items.filter((entry) => entry.id !== item.id)].slice(0, 1_000),
	};
	await writeManifest(root, next);
}

async function readManifest(root: string): Promise<JsonManifest> {
	await mkdir(root, { recursive: true });
	const path = join(root, INDEX_FILE);
	if (!existsSync(path)) return { items: [] };
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as Partial<JsonManifest>;
		const items = Array.isArray(raw.items) ? raw.items.flatMap(normalizeItem) : [];
		return { items };
	} catch {
		return { items: [] };
	}
}

async function writeManifest(root: string, manifest: JsonManifest): Promise<void> {
	await mkdir(root, { recursive: true });
	const path = join(root, INDEX_FILE);
	const temp = join(root, `${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`);
	await writeFile(temp, JSON.stringify(manifest, null, 2));
	await rename(temp, path);
}

function normalizeItem(value: GeneratedMediaItem): GeneratedMediaItem[] {
	if (!value || typeof value !== "object") return [];
	if (!["image", "video", "audio"].includes(value.kind)) return [];
	if (!value.id || !value.path || !value.provider || !value.contentType) return [];
	return [{
		id: String(value.id),
		kind: value.kind,
		provider: String(value.provider),
		capability: String(value.capability ?? "generated"),
		title: String(value.title ?? basename(value.path)),
		path: String(value.path),
		url: generatedMediaFileUrl(String(value.path)),
		contentType: String(value.contentType),
		bytes: typeof value.bytes === "number" && Number.isFinite(value.bytes) ? value.bytes : 0,
		createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0,
		...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
		...(typeof value.model === "string" ? { model: value.model } : {}),
		...(typeof value.sourceUrl === "string" ? { sourceUrl: value.sourceUrl } : {}),
	}];
}

function decodeDataUrl(url: string): { bytes: Uint8Array; contentType: string } {
	const match = url.match(/^data:([^;,]+);base64,(.+)$/i);
	if (!match) throw new Error("Generated media data URL was not base64.");
	const contentType = match[1] ?? "application/octet-stream";
	const bytes = new Uint8Array(Buffer.from(match[2] ?? "", "base64"));
	if (bytes.byteLength === 0) throw new Error("Generated media data URL was empty.");
	return { bytes, contentType };
}

function extensionForUrl(url: string): string | undefined {
	const raw = /^https?:\/\//i.test(url) || url.startsWith("file://")
		? new URL(url).pathname
		: url;
	const ext = extname(raw).replace(/^\./, "").toLowerCase();
	return ext.length > 0 ? ext : undefined;
}

function contentTypeForExtension(extension: string, kind: GeneratedMediaKind): string {
	const ext = extension.toLowerCase();
	if (ext === "png") return "image/png";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "webp") return "image/webp";
	if (ext === "gif") return "image/gif";
	if (ext === "mp4") return "video/mp4";
	if (ext === "mov") return "video/quicktime";
	if (ext === "webm") return "video/webm";
	if (ext === "wav") return "audio/wav";
	if (ext === "mp3") return "audio/mpeg";
	if (ext === "ogg") return "audio/ogg";
	if (ext === "flac") return "audio/flac";
	if (kind === "image") return "image/png";
	if (kind === "video") return "video/mp4";
	return "audio/mpeg";
}

function safeSlug(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug || "media";
}

function sanitizeExtension(value: string): string {
	const clean = value.toLowerCase().replace(/[^a-z0-9]/g, "");
	return clean.length > 0 ? clean : "bin";
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}
