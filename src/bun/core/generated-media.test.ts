import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGeneratedMedia, saveGeneratedMediaUrl } from "./generated-media";

let root = "";
let previousRoot: string | undefined;

beforeEach(async () => {
	previousRoot = process.env.DETOUR_GENERATED_MEDIA_DIR;
	root = await mkdtemp(join(tmpdir(), "detour-media-test-"));
	process.env.DETOUR_GENERATED_MEDIA_DIR = root;
});

afterEach(async () => {
	if (previousRoot === undefined) delete process.env.DETOUR_GENERATED_MEDIA_DIR;
	else process.env.DETOUR_GENERATED_MEDIA_DIR = previousRoot;
	await rm(root, { recursive: true, force: true });
});

test("stores data URL media in the generated media index", async () => {
	const item = await saveGeneratedMediaUrl({
		kind: "image",
		provider: "test",
		capability: "image-generation",
		url: "data:image/png;base64,aGVsbG8=",
		prompt: "hello",
	});
	const list = await listGeneratedMedia({ kind: "image" });

	expect(item.path.startsWith(root)).toBe(true);
	expect(item.url.startsWith("file://")).toBe(true);
	expect(list.items).toHaveLength(1);
	expect(list.items[0]?.id).toBe(item.id);
	expect(list.items[0]?.prompt).toBe("hello");
});
