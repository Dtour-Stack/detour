import { deflateSync } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type {
	Action,
	ActionResult,
	Handler,
	HandlerCallback,
	Plugin,
} from "@elizaos/core";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type HandlerOptionsLike = Parameters<Handler>[3];
type HandlerMessage = Parameters<Handler>[1];

export type PetSummary = {
	id: string;
	displayName: string;
	description: string;
	directory: string;
	petJsonPath: string;
	spritesheetPath: string;
};

export type PetListResult = {
	pets: PetSummary[];
	errors: string[];
};

type PetRow = {
	state: string;
	row: number;
	frames: number;
	purpose: string;
};

type CopiedReference = {
	path: string;
	role: string;
	sourcePath: string;
};

type HatchWorker = {
	provider: "codex" | "claude";
	pid?: number;
	logPath: string;
	command: string;
	args: string[];
};

const CODEX_HOME_DEFAULT = join(homedir(), ".codex");
const ACTION_PET = "CODEX_PET";
const ACTION_HATCH = "CODEX_HATCH";
const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const SAFE_MARGIN_X = 18;
const SAFE_MARGIN_Y = 16;
const CHROMA_KEY = { hex: "#FF00FF", rgb: [255, 0, 255], name: "magenta", selection: "fallback" };

const ROWS: readonly PetRow[] = [
	{ state: "idle", row: 0, frames: 6, purpose: "neutral breathing/blinking loop" },
	{ state: "running-right", row: 1, frames: 8, purpose: "rightward locomotion loop" },
	{ state: "running-left", row: 2, frames: 8, purpose: "leftward locomotion loop" },
	{ state: "waving", row: 3, frames: 4, purpose: "greeting gesture with raised wave and return" },
	{ state: "jumping", row: 4, frames: 5, purpose: "anticipation, lift, peak, descent, settle" },
	{ state: "failed", row: 5, frames: 8, purpose: "sad, failed, or deflated reaction" },
	{ state: "waiting", row: 6, frames: 6, purpose: "patient waiting loop with small motion" },
	{ state: "running", row: 7, frames: 6, purpose: "generic in-place running loop" },
	{ state: "review", row: 8, frames: 6, purpose: "focused inspecting or review loop" },
];

const DIGITAL_PET_STYLE =
	"Codex digital pet sprite style: pixel-art-adjacent low-resolution mascot sprite, compact chibi proportions, chunky whole-body silhouette, thick dark 1-2 px outline, visible stepped/pixel edges, limited palette, flat cel shading with at most one small highlight and one shadow step, simple readable face, tiny limbs, and no detail that disappears at 192x208. Avoid polished illustration, painterly rendering, anime key art, 3D render, vector app-icon polish, glossy lighting, soft gradients, realistic fur or material texture, anti-aliased high-detail edges, and complex tiny accessories.";

const TRANSPARENCY_RULES = [
	"Prefer pose, expression, and silhouette changes over decorative effects.",
	"Effects are allowed only when they are state-relevant, opaque, hard-edged, pixel-style, fully inside the same frame slot, and physically touching or overlapping the pet silhouette.",
	"Allowed attached effects can include a tear touching the face, a small smoke puff touching the pet or prop, or tiny stars overlapping the pet during a failed/dizzy reaction.",
	"Do not draw detached effects: floating stars, loose sparkles, floating punctuation, floating icons, falling tear drops, separated smoke clouds, loose dust, disconnected outline bits, or stray pixels.",
	"Do not draw wave marks, motion arcs, speed lines, action streaks, afterimages, blur, smears, halos, glows, auras, floor patches, cast shadows, contact shadows, drop shadows, oval floor shadows, landing marks, or impact bursts.",
	"Do not include text, labels, frame numbers, visible grids, guide marks, speech bubbles, thought bubbles, UI panels, code snippets, scenery, checkerboard transparency, white backgrounds, or black backgrounds.",
	"Do not use the chroma-key color or chroma-key-adjacent colors in the pet, prop, effects, highlights, shadows, or outlines.",
	"Reject any pose that is cropped, overlaps another pose, crosses into a neighboring frame slot, or creates a separate disconnected component that is not attached to the pet.",
] as const;

const STATE_REQUIREMENTS: Record<string, readonly string[]> = {
	waving: [
		"Show the greeting through paw pose only: paw down, paw raised, paw tilted, paw returning.",
		"Do not draw wave marks, motion arcs, lines, sparkles, symbols, or floating effects around the paw.",
	],
	jumping: [
		"Show the jump through pose and vertical body position only: anticipation, lift, airborne peak, descent, settle.",
		"Do not draw ground shadows, contact shadows, drop shadows, oval shadows, landing marks, dust, smears, bounce pads, or motion marks under the pet.",
	],
	failed: [
		"Show failure through slumped pose, drooping ears/limbs, closed or sad eyes, and lower body position.",
		"Tears, small smoke puffs, or tiny stars are allowed only if attached to or overlapping the pet silhouette and kept inside the same frame slot.",
		"Do not draw red X marks, floating symbols, detached stars, separated smoke clouds, falling tear drops, dust, or other loose effects.",
	],
	review: [
		"Show review through lean, blink, narrowed eyes, head tilt, or paw position.",
		"Do not add magnifying glasses, papers, code, UI, punctuation, symbols, or other new props unless they already exist in the base pet identity.",
	],
	"running-right": [
		"Show locomotion through body, limb, and prop movement only.",
		"Do not draw speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.",
	],
	"running-left": [
		"Show locomotion through body, limb, and prop movement only.",
		"Do not draw speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.",
	],
	running: [
		"Show in-place running through body, limb, and prop movement only.",
		"Do not draw speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.",
	],
};

function codexHome(): string {
	const value = process.env.CODEX_HOME?.trim();
	return value ? resolve(value) : CODEX_HOME_DEFAULT;
}

function isJsonObject(value: Json): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string, path: string): JsonObject {
	const parsed: Json = JSON.parse(raw);
	if (!isJsonObject(parsed)) {
		throw new Error(`${path} is not a JSON object`);
	}
	return parsed;
}

function stringField(obj: JsonObject, key: string): string {
	const value = obj[key];
	return typeof value === "string" ? value.trim() : "";
}

function absoluteFrom(base: string, path: string): string {
	return isAbsolute(path) ? path : join(base, path);
}

function readPet(dir: string): PetSummary {
	const petJsonPath = join(dir, "pet.json");
	const pet = parseJsonObject(readFileSync(petJsonPath, "utf8"), petJsonPath);
	const id = stringField(pet, "id") || basename(dir);
	const displayName = stringField(pet, "displayName") || stringField(pet, "name") || id;
	const spritesheet = stringField(pet, "spritesheetPath") || "spritesheet.webp";
	return {
		id,
		displayName,
		description: stringField(pet, "description"),
		directory: dir,
		petJsonPath,
		spritesheetPath: absoluteFrom(dir, spritesheet),
	};
}

export function listCodexPets(): PetListResult {
	const petsRoot = join(codexHome(), "pets");
	if (!existsSync(petsRoot)) return { pets: [], errors: [] };
	const pets: PetSummary[] = [];
	const errors: string[] = [];
	for (const entry of readdirSync(petsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(petsRoot, entry.name);
		if (!existsSync(join(dir, "pet.json"))) continue;
		try {
			pets.push(readPet(dir));
		} catch (error) {
			errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	pets.sort((a, b) => a.displayName.localeCompare(b.displayName));
	return { pets, errors };
}

function optionString(options: HandlerOptionsLike, keys: readonly string[]): string {
	if (!options) return "";
	const parameters = options.parameters;
	if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
		for (const key of keys) {
			const parameterValue = parameters[key];
			if (typeof parameterValue === "string" && parameterValue.trim()) return parameterValue.trim();
		}
	}
	for (const key of keys) {
		const directValue = options[key];
		if (typeof directValue === "string" && directValue.trim()) return directValue.trim();
	}
	return "";
}

function optionBool(options: HandlerOptionsLike, keys: readonly string[], fallback: boolean): boolean {
	if (!options) return fallback;
	const parameters = options.parameters;
	if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
		for (const key of keys) {
			const parameterValue = parameters[key];
			if (typeof parameterValue === "boolean") return parameterValue;
			if (parameterValue === "true") return true;
			if (parameterValue === "false") return false;
		}
	}
	for (const key of keys) {
		const directValue = options[key];
		if (typeof directValue === "boolean") return directValue;
		if (directValue === "true") return true;
		if (directValue === "false") return false;
	}
	return fallback;
}

function messageText(message: HandlerMessage): string {
	const text = message.content.text;
	return typeof text === "string" ? text.trim() : "";
}

function commandTail(text: string, command: string): string {
	const pattern = new RegExp(`^\\s*${command}(?:\\s+|$)`, "i");
	return text.replace(pattern, "").trim();
}

function parseNamedConcept(raw: string): { concept: string; petName: string } {
	const match = raw.match(/\bnamed\s+(.+?)\s*$/i);
	if (!match) return { concept: raw, petName: "" };
	const petName = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
	const concept = raw.slice(0, match.index).trim();
	return { concept: concept || raw, petName };
}

async function emit(callback: HandlerCallback | undefined, text: string, actionName: string): Promise<void> {
	if (!callback) return;
	await callback({ text, action: actionName }, actionName);
}

function ok(text: string, values: JsonObject, data: JsonObject): ActionResult {
	return { success: true, text, values, data };
}

function fail(text: string, actionName: string): ActionResult {
	return { success: false, text, error: text, values: { actionName }, data: { actionName } };
}

function formatPet(pet: PetSummary): string {
	const description = pet.description ? ` - ${pet.description}` : "";
	return `${pet.displayName} (${pet.id})${description}\npet.json: ${pet.petJsonPath}\nspritesheet: ${pet.spritesheetPath}`;
}

function matchesPet(pet: PetSummary, query: string): boolean {
	const normalized = query.toLowerCase();
	return pet.id.toLowerCase() === normalized || pet.displayName.toLowerCase() === normalized;
}

const petHandler: Handler = async (_runtime, message, _state, options, callback) => {
	const query =
		optionString(options, ["pet", "petId", "name", "id"]) ||
		commandTail(messageText(message), "/pet");
	const result = listCodexPets();
	const selected = query ? result.pets.find((pet) => matchesPet(pet, query)) : undefined;
	if (query && !selected) {
		const text =
			result.pets.length === 0
				? `No Codex pets found in ${join(codexHome(), "pets")}.`
				: `No Codex pet matched "${query}". Installed pets: ${result.pets.map((pet) => pet.displayName).join(", ")}.`;
		await emit(callback, text, ACTION_PET);
		return fail(text, ACTION_PET);
	}
	if (selected) {
		const text = formatPet(selected);
		await emit(callback, text, ACTION_PET);
		return ok(text, { actionName: ACTION_PET, petCount: result.pets.length }, { actionName: ACTION_PET, pet: selected, errors: result.errors });
	}
	const lines =
		result.pets.length === 0
			? [`No Codex pets found in ${join(codexHome(), "pets")}.`]
			: [`Installed Codex pets:`, ...result.pets.map((pet) => `- ${pet.displayName} (${pet.id})`)];
	if (result.errors.length > 0) {
		lines.push("", "Pet read errors:", ...result.errors.map((error) => `- ${error}`));
	}
	const text = lines.join("\n");
	await emit(callback, text, ACTION_PET);
	return ok(text, { actionName: ACTION_PET, petCount: result.pets.length }, { actionName: ACTION_PET, pets: result.pets, errors: result.errors });
};

function slugify(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
	return slug || "pet";
}

function runDirectory(petName: string, outputDir: string): string {
	if (outputDir) {
		if (!isAbsolute(outputDir)) throw new Error("outputDir must be an absolute path");
		return outputDir;
	}
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
	return join(codexHome(), "hatch-runs", `${slugify(petName)}-${stamp}`);
}

function sentence(value: string): string {
	const trimmed = value.trim().replace(/\s+/g, " ");
	if (!trimmed) return "";
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function inferPetName(concept: string): string {
	const stopWords = new Set(["a", "an", "and", "app", "based", "codex", "digital", "for", "from", "in", "of", "on", "pet", "small", "the", "to", "with"]);
	const word = concept
		.match(/[a-zA-Z0-9]+/g)
		?.find((candidate) => !stopWords.has(candidate.toLowerCase()));
	if (!word) return "Pet";
	return `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function styleContract(styleNotes: string): string {
	return styleNotes ? `${DIGITAL_PET_STYLE} Additional user style notes: ${sentence(styleNotes)}` : DIGITAL_PET_STYLE;
}

function ensureReference(referencePath: string): void {
	if (!referencePath) return;
	if (!isAbsolute(referencePath)) throw new Error("referencePath must be an absolute path");
	if (!existsSync(referencePath)) throw new Error(`referencePath not found: ${referencePath}`);
}

function writeText(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${text.trimEnd()}\n`, "utf8");
}

function rel(path: string, root: string): string {
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function copyReferences(runDir: string, referencePath: string): CopiedReference[] {
	ensureReference(referencePath);
	if (!referencePath) return [];
	const referenceDir = join(runDir, "references");
	const suffix = extname(referencePath) || ".png";
	const copied = join(referenceDir, `reference-01${suffix}`);
	copyFileSync(referencePath, copied);
	return [{ path: rel(copied, runDir), role: "pet reference", sourcePath: referencePath }];
}

function crcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
}

const CRC_TABLE = crcTable();

function crc32(buffer: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buffer) {
		c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBuffer = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
	return Buffer.concat([length, typeBuffer, data, crc]);
}

function setPixel(pixels: Buffer, width: number, x: number, y: number, rgba: readonly number[]): void {
	if (x < 0 || y < 0 || x >= width) return;
	const index = (y * width + x) * 4;
	pixels[index] = rgba[0];
	pixels[index + 1] = rgba[1];
	pixels[index + 2] = rgba[2];
	pixels[index + 3] = rgba[3];
}

function drawLine(pixels: Buffer, width: number, x1: number, y1: number, x2: number, y2: number, rgba: readonly number[]): void {
	if (x1 === x2) {
		const start = Math.min(y1, y2);
		const end = Math.max(y1, y2);
		for (let y = start; y <= end; y += 1) setPixel(pixels, width, x1, y, rgba);
		return;
	}
	if (y1 === y2) {
		const start = Math.min(x1, x2);
		const end = Math.max(x1, x2);
		for (let x = start; x <= end; x += 1) setPixel(pixels, width, x, y1, rgba);
	}
}

function drawRect(pixels: Buffer, width: number, x: number, y: number, w: number, h: number, rgba: readonly number[]): void {
	drawLine(pixels, width, x, y, x + w - 1, y, rgba);
	drawLine(pixels, width, x, y + h - 1, x + w - 1, y + h - 1, rgba);
	drawLine(pixels, width, x, y, x, y + h - 1, rgba);
	drawLine(pixels, width, x + w - 1, y, x + w - 1, y + h - 1, rgba);
}

function writePng(path: string, width: number, height: number, pixels: Buffer): void {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const rawOffset = y * (width * 4 + 1);
		raw[rawOffset] = 0;
		pixels.copy(raw, rawOffset + 1, y * width * 4, (y + 1) * width * 4);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	writeFileSync(path, Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]));
}

function writeLayoutGuide(path: string, frames: number): void {
	const width = frames * CELL_WIDTH;
	const height = CELL_HEIGHT;
	const pixels = Buffer.alloc(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = 246;
		pixels[i + 1] = 248;
		pixels[i + 2] = 250;
		pixels[i + 3] = 255;
	}
	const frameLine = [30, 64, 175, 255] as const;
	const safeLine = [236, 72, 153, 255] as const;
	for (let frame = 0; frame < frames; frame += 1) {
		const x = frame * CELL_WIDTH;
		drawRect(pixels, width, x, 0, CELL_WIDTH, CELL_HEIGHT, frameLine);
		drawRect(
			pixels,
			width,
			x + SAFE_MARGIN_X,
			SAFE_MARGIN_Y,
			CELL_WIDTH - SAFE_MARGIN_X * 2,
			CELL_HEIGHT - SAFE_MARGIN_Y * 2,
			safeLine,
		);
		drawLine(pixels, width, x + Math.floor(CELL_WIDTH / 2), 0, x + Math.floor(CELL_WIDTH / 2), CELL_HEIGHT - 1, [148, 163, 184, 120]);
	}
	writePng(path, width, height, pixels);
}

function basePrompt(displayName: string, petNotes: string, styleNotes: string): string {
	const style = styleContract(styleNotes);
	return `Create a single clean reference sprite for a Codex app digital pet named ${displayName}.

Pet: ${petNotes}.
Style contract: ${style}

Use this prompt as an authoritative sprite-production spec. Do not expand it into a polished illustration, painterly character image, anime key art, 3D render, vector mascot, glossy app icon, realistic animal portrait, or marketing artwork.

Output one centered full-body pet sprite pose only, on a perfectly flat pure ${CHROMA_KEY.name} ${CHROMA_KEY.hex} chroma-key background. The pet must be fully visible, readable as a tiny digital pet, and suitable for animation into a 192x208 sprite cell. Do not include scenery, text, labels, borders, checkerboard transparency, detached effects, shadows, glows, or extra props not present in the reference unless explicitly requested. Do not use ${CHROMA_KEY.hex}, pure ${CHROMA_KEY.name}, or colors close to that chroma key in the pet, prop, highlights, or effects.`;
}

function rowPrompt(petId: string, petNotes: string, styleNotes: string, row: PetRow): string {
	const stateRequirements = STATE_REQUIREMENTS[row.state] ?? [];
	const stateText = stateRequirements.length === 0 ? "" : `\n\nState-specific requirements:\n${stateRequirements.map((rule) => `- ${rule}`).join("\n")}`;
	return `Create a single horizontal sprite strip for the Codex app digital pet \`${petId}\` in the state \`${row.state}\`.

Use the attached reference image(s) for pet identity and the attached base pet image as the canonical design. Use the attached layout guide image only for frame count, slot spacing, centering, and safe padding. Simplify any high-resolution reference details into the Codex digital pet sprite style. Do not simply copy the still reference pose. Generate distinct animation poses that create a readable cycle.

Identity lock:
- Do not redesign the pet. Only change pose/action for the \`${row.state}\` animation.
- Preserve the exact head shape, ear/horn/limb shape, face design, markings, palette, outline weight, body proportions, prop design, and overall silhouette from the canonical base pet.
- Keep every frame recognizably the same individual pet, not a related variant.
- If the pet has a prop or accessory, preserve its size, side, palette, and attachment style unless the row action requires a small pose-only adjustment.
- Prefer a subtler animation over any change that mutates the pet identity.

Output exactly ${row.frames} separate animation frames arranged left-to-right in one single row. Each frame must show the same pet: ${petNotes}.

Style contract: ${styleContract(styleNotes)}

Use this prompt as an authoritative sprite-production spec. Do not expand it into a polished illustration, painterly character image, anime key art, 3D render, vector mascot, glossy app icon, realistic animal portrait, or marketing artwork.

Animation action: ${row.purpose}.${stateText}

Transparency and artifact rules:
${TRANSPARENCY_RULES.map((rule) => `- ${rule}`).join("\n")}

Layout requirements:
- Exactly ${row.frames} full-body frames, left to right, in one horizontal row.
- The attached layout guide shows the ${row.frames} frame boxes and inner safe area for this row. Follow its slot count, spacing, centering, and padding.
- Do not reproduce the layout guide itself: no visible boxes, guide lines, center marks, labels, guide colors, or guide background may appear in the output.
- Treat the image as ${row.frames} equal-width invisible frame slots. Fill every slot: each requested slot must contain exactly one complete full-body pose.
- Spread the ${row.frames} poses evenly across the whole image width. Do not leave any requested slot blank or create large empty gaps between poses.
- Center one complete pose in each slot. No pose may cross into the neighboring slot.
- Use a perfectly flat pure ${CHROMA_KEY.name} ${CHROMA_KEY.hex} chroma-key background across the whole image.
- Do not draw visible grid lines, borders, labels, numbers, text, watermarks, or checkerboard transparency.
- Do not include scenery or a background environment.
- Keep the rendering sprite-like: chunky silhouette, dark pixel-style outline, limited palette, flat shading, minimal tiny detail.
- Do not use ${CHROMA_KEY.hex}, pure ${CHROMA_KEY.name}, or colors close to that chroma key in the pet, props, highlights, shadows, motion marks, dust, landing marks, or effects.
- Do not draw shadows, glows, smears, dust, or landing marks using darker/lighter versions of the chroma-key color.
- Keep every frame self-contained with safe padding. No pet body part should be clipped by the frame slot.
- Avoid motion blur. Use clear pose changes readable at 192x208.
- Preserve the same silhouette, face, proportions, palette, material, and props across every frame.`;
}

function prepareHatchRun(input: {
	petName: string;
	description: string;
	concept: string;
	styleNotes: string;
	referencePath: string;
	outputDir: string;
}): { runDir: string; jobCount: number } {
	const displayName = input.petName || inferPetName(input.concept);
	const petId = slugify(displayName);
	const petNotes = input.concept.trim();
	const description = sentence(input.description || input.concept);
	const runDir = runDirectory(displayName, input.outputDir);
	for (const dir of [
		join(runDir, "references"),
		join(runDir, "references", "layout-guides"),
		join(runDir, "prompts"),
		join(runDir, "prompts", "rows"),
		join(runDir, "decoded"),
		join(runDir, "qa"),
	]) {
		mkdirSync(dir, { recursive: true });
	}
	const references = copyReferences(runDir, input.referencePath);
	for (const row of ROWS) {
		writeLayoutGuide(join(runDir, "references", "layout-guides", `${row.state}.png`), row.frames);
		writeText(join(runDir, "prompts", "rows", `${row.state}.md`), rowPrompt(petId, petNotes, input.styleNotes, row));
	}
	writeText(join(runDir, "prompts", "base-pet.md"), basePrompt(displayName, petNotes, input.styleNotes));
	const referenceInputs = references.map((reference) => ({ path: reference.path, role: reference.role }));
	const jobs = [
		{
			id: "base",
			kind: "base-pet",
			status: "pending",
			prompt_file: "prompts/base-pet.md",
			input_images: referenceInputs,
			output_path: "decoded/base.png",
			depends_on: [],
			generation_skill: "$imagegen",
			requires_grounded_generation: referenceInputs.length > 0,
			allow_prompt_only_generation: referenceInputs.length === 0,
			recording_owner: "parent",
		},
		...ROWS.map((row) => {
			const extraInputs = row.state === "running-left"
				? [{ path: "decoded/running-right.png", role: "rightward gait reference for leftward row decision" }]
				: [];
			const dependsOn = row.state === "running-left" ? ["base", "running-right"] : ["base"];
			return {
				id: row.state,
				kind: "row-strip",
				status: "pending",
				prompt_file: `prompts/rows/${row.state}.md`,
				input_images: [
					...referenceInputs,
					{ path: `references/layout-guides/${row.state}.png`, role: `layout guide for ${row.frames} frame slots; use for spacing only, do not copy guide lines` },
					{ path: "references/canonical-base.png", role: "canonical identity reference" },
					{ path: "decoded/base.png", role: "approved base pet" },
					...extraInputs,
				],
				output_path: `decoded/${row.state}.png`,
				depends_on: dependsOn,
				generation_skill: "$imagegen",
				requires_grounded_generation: true,
				allow_prompt_only_generation: false,
				identity_reference_paths: ["references/canonical-base.png", "decoded/base.png"],
				parallelizable_after: dependsOn,
				mirror_policy: row.state === "running-left"
					? {
						may_derive_from: "running-right",
						derivation: "horizontal-mirror",
						requires_explicit_approval: true,
						fallback_generation_skill: "$imagegen",
					}
					: {},
				recording_owner: "parent",
			};
		}),
	];
	const createdAt = new Date().toISOString();
	writeText(join(runDir, "pet_request.json"), JSON.stringify({
		pet_id: petId,
		display_name: displayName,
		description,
		created_at: createdAt,
		atlas: {
			columns: 8,
			rows: 9,
			cell_width: CELL_WIDTH,
			cell_height: CELL_HEIGHT,
			width: 8 * CELL_WIDTH,
			height: 9 * CELL_HEIGHT,
		},
		rows: ROWS,
		layout_guides: ROWS.map((row) => ({
			state: row.state,
			path: `references/layout-guides/${row.state}.png`,
			width: row.frames * CELL_WIDTH,
			height: CELL_HEIGHT,
			frames: row.frames,
			cell_width: CELL_WIDTH,
			cell_height: CELL_HEIGHT,
			safe_margin_x: SAFE_MARGIN_X,
			safe_margin_y: SAFE_MARGIN_Y,
			usage: "layout guide input only; do not copy visible guide lines into generated sprite strips",
		})),
		references,
		chroma_key: CHROMA_KEY,
		pet_notes: petNotes,
		style_notes: input.styleNotes,
		house_style: DIGITAL_PET_STYLE,
		primary_generation_skill: "$imagegen",
	}, null, 2));
	writeText(join(runDir, "imagegen-jobs.json"), JSON.stringify({
		schema_version: 1,
		created_at: createdAt,
		run_dir: runDir,
		primary_generation_skill: "$imagegen",
		jobs,
	}, null, 2));
	return { runDir, jobCount: jobs.length };
}

function workspaceRoot(): string {
	const configured = process.env.DETOUR_WORKSPACE_ROOT || process.env.INIT_CWD;
	return configured && configured.trim().length > 0 ? resolve(configured) : process.cwd();
}

function executablePath(command: string): string | null {
	const checker = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(checker, [command], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const first = result.stdout.trim().split(/\r?\n/)[0];
	return first && first.length > 0 ? first : command;
}

function hatchWorkerTask(input: {
	runDir: string;
	petName: string;
	concept: string;
}): string {
	const skillPath = join(codexHome(), "skills", "hatch-pet", "SKILL.md");
	const packageDir = join(codexHome(), "pets", slugify(input.petName));
	return [
		`Use the hatch-pet skill at ${skillPath}.`,
		`Continue the existing Codex pet run at ${input.runDir}.`,
		`Complete the full spritesheet/package pipeline for "${input.petName}".`,
		`Concept: ${input.concept}`,
		"Use the run's imagegen-jobs.json and prompt files as the source of truth.",
		"Generate real visual assets through the available image generation path. Do not fabricate sprite rows with local scripts, SVG, canvas, or placeholder art.",
		"Record selected generated images with record_imagegen_result.py, finalize with finalize_pet_run.py, and package the pet.",
		"Use subagents for row-strip generation where the hatch-pet skill requires them.",
		`Before exiting, verify ${join(packageDir, "pet.json")} and ${join(packageDir, "spritesheet.webp")} exist. If image generation is unavailable, stop with a clear failure and leave the run ready to resume.`,
	].join("\n");
}

function hatchWorkerCommand(input: {
	task: string;
	cwd: string;
}): Omit<HatchWorker, "logPath" | "pid"> {
	const codex = executablePath("codex");
	if (codex) {
		return {
			provider: "codex",
			command: codex,
			args: ["exec", "--json", "--cd", input.cwd, "--dangerously-bypass-approvals-and-sandbox", input.task],
		};
	}
	const claude = executablePath("claude");
	if (!claude) throw new Error("neither codex nor claude is installed on PATH");
	return {
		provider: "claude",
		command: claude,
		args: ["--print", "--output-format", "stream-json", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", input.task],
	};
}

function startHatchWorker(input: {
	runDir: string;
	petName: string;
	concept: string;
}): HatchWorker {
	const cwd = workspaceRoot();
	const task = hatchWorkerTask(input);
	const command = hatchWorkerCommand({ task, cwd });
	const logPath = join(input.runDir, "hatch-worker.log");
	const stream = createWriteStream(logPath, { flags: "a" });
	let streamClosed = false;
	const writeLog = (text: string) => {
		if (!streamClosed) stream.write(text);
	};
	const closeLog = () => {
		if (streamClosed) return;
		streamClosed = true;
		stream.end();
	};
	writeLog(`[hatch-worker] ${new Date().toISOString()} provider=${command.provider}\n`);
	writeLog(`[hatch-worker] command=${command.command} ${command.args.slice(0, -1).join(" ")} <task>\n\n`);
	const child = spawn(command.command, command.args, {
		cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	child.stdout.pipe(stream, { end: false });
	child.stderr.pipe(stream, { end: false });
	child.on("error", (error) => {
		writeLog(`\n[hatch-worker] spawn error: ${error instanceof Error ? error.message : String(error)}\n`);
		closeLog();
	});
	child.on("close", (exitCode, signal) => {
		writeLog(`\n[hatch-worker] closed exit=${exitCode}${signal ? ` signal=${signal}` : ""}\n`);
		closeLog();
	});
	return { ...command, logPath, pid: child.pid };
}

const hatchHandler: Handler = async (_runtime, message, _state, options, callback) => {
	const tail = commandTail(messageText(message), "/hatch");
	const parsed = parseNamedConcept(tail);
	const petName =
		optionString(options, ["petName", "name", "displayName"]) ||
		optionString(options, ["pet", "petId"]) ||
		parsed.petName ||
		"Pet";
	const concept =
		optionString(options, ["concept", "description", "prompt", "petNotes", "notes"]) ||
		parsed.concept;
	if (!concept) {
		const text = "CODEX_HATCH needs a pet concept or description.";
		await emit(callback, text, ACTION_HATCH);
		return fail(text, ACTION_HATCH);
	}
	try {
		const description = optionString(options, ["description"]) || concept;
		const styleNotes = optionString(options, ["styleNotes", "style"]);
		const outputDir = optionString(options, ["outputDir", "runDir"]);
		const referencePath = optionString(options, ["referencePath", "reference", "imagePath"]);
		const { runDir, jobCount } = prepareHatchRun({
			petName,
			description,
			concept,
			styleNotes,
			referencePath,
			outputDir,
		});
		const prepareOnly = optionBool(options, ["prepareOnly", "manifestOnly"], false);
		const runPipeline = !prepareOnly && optionBool(options, ["runPipeline", "pipeline", "full"], true);
		const worker = runPipeline ? startHatchWorker({ runDir, petName, concept }) : null;
		const text = [
			`${worker ? "Started full Codex hatch pipeline" : "Prepared Codex hatch run"} for ${petName}.`,
			`run: ${runDir}`,
			`manifest: ${join(runDir, "imagegen-jobs.json")}`,
			`jobs: ${jobCount}`,
			...(worker ? [
				`worker: ${worker.provider}${worker.pid ? ` pid=${worker.pid}` : ""}`,
				`log: ${worker.logPath}`,
				`package target: ${join(codexHome(), "pets", slugify(petName))}`,
			] : []),
		].join("\n");
		await emit(callback, text, ACTION_HATCH);
		return ok(
			text,
			{ actionName: ACTION_HATCH, jobCount, pipelineStarted: Boolean(worker) },
			{
				actionName: ACTION_HATCH,
				runDir,
				jobCount,
				...(worker ? { worker: { provider: worker.provider, pid: worker.pid ?? null, logPath: worker.logPath } } : {}),
			},
		);
	} catch (error) {
		const text = `CODEX_HATCH failed: ${error instanceof Error ? error.message : String(error)}`;
		await emit(callback, text, ACTION_HATCH);
		return fail(text, ACTION_HATCH);
	}
};

export const codexPetAction: Action = {
	name: ACTION_PET,
	similes: ["PET", "/pet", "LIST_CODEX_PETS", "SHOW_CODEX_PETS", "INSPECT_CODEX_PET"],
	description: "List installed Codex pets or inspect a specific pet from the local Codex pets folder.",
	validate: async () => true,
	handler: petHandler,
	suppressPostActionContinuation: true,
	examples: [],
	parameters: [
		{
			name: "pet",
			description: "Optional Codex pet id or display name to inspect.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	contexts: ["general", "media"],
};

export const codexHatchAction: Action = {
	name: ACTION_HATCH,
	similes: ["HATCH", "/hatch", "HATCH_PET", "CODEX_HATCH_PET", "CREATE_CODEX_PET"],
	description:
		"Start the full Codex hatch-pet spritesheet pipeline from a pet concept, including run preparation, image jobs, final atlas, and package output.",
	validate: async () => true,
	handler: hatchHandler,
	suppressPostActionContinuation: true,
	examples: [],
	parameters: [
		{
			name: "concept",
			description: "Pet concept or stable visual description.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "petName",
			description: "Optional display name for the pet.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "referencePath",
			description: "Optional absolute path to a local reference image.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "outputDir",
			description: "Optional absolute path for the hatch run directory.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "styleNotes",
			description: "Optional pet style constraints.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	contexts: ["general", "media"],
};

export const codexPetsPlugin: Plugin = {
	name: "codex-pets",
	description: "Codex /pet and /hatch abilities for local pet inspection and full hatch pipeline runs.",
	actions: [codexPetAction, codexHatchAction],
};

export default codexPetsPlugin;
