/**
 * Agent-projects plugin — gives the agent a "scaffold + preview + deploy"
 * surface for two project shapes:
 *
 *   - "app"  → full carrot. carrot.json + worker.ts + web/index.html.
 *              Runs in a Bun.Worker with permission-scoped capabilities
 *              when previewed; deploys to ElizaOS Cloud as a hosted app.
 *
 *   - "page" → static frontend only. index.html + index.css + index.js.
 *              Sandboxed BrowserWindow preview, no worker; deploys as a
 *              static cloud app.
 *
 * Project tree on disk:
 *
 *   $DETOUR_AGENT_SANDBOX/projects/
 *     <slug>/
 *       project.json       ← detour metadata: { type, slug, name, description, createdAt, deployedAppId? }
 *       README.md          ← seeded with the user's description
 *       .git/              ← git init'd at scaffold time
 *       (app:)
 *         carrot.json
 *         worker.ts
 *         web/index.html
 *         web/index.css
 *         web/index.js
 *         tests/worker.test.ts
 *       (page:)
 *         index.html
 *         index.css
 *         index.js
 *         tests/page.test.ts
 *
 * Handoff model: AGENT_PROJECT_NEW scaffolds and returns a `nextSteps`
 * payload describing what to fill in. The same agent (which already has
 * FILE/BASH/EDIT from `@elizaos/plugin-coding-tools` on its runtime) does
 * the implementation in subsequent turns. We're not spawning a separate
 * PTY-based coding agent — that would require @elizaos/plugin-agent-
 * orchestrator, which is in the eliza submodule but not in detour's
 * basePlugins. Future upgrade if true sub-agent isolation is wanted.
 *
 * Preview windows use electrobun's `sandbox: true` + per-project
 * `partition` so a runaway page can't read the host's cookies and a
 * runaway worker can only nuke its own project tree.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserView, BrowserWindow, Screen } from "electrobun/bun";
import type { Action, ActionResult, Handler, IAgentRuntime, Plugin } from "@elizaos/core";
import {
	createAgentProject,
	importAgentProject,
	listProjectsCore,
	projectDir,
	publishProjectToGitHub,
	readProjectMeta,
	writeProjectMeta,
	type ProjectMeta,
} from "../../core/agent-projects-core";
import { getPreviewRegistry } from "../../core/preview-server-registry";
import { getBuildCoordinator } from "../../core/build-coordinator";

// ── Constants ──────────────────────────────────────────────────────────

const ELIZACLOUD_BASE = "https://www.elizacloud.ai/api/v1";
const APPS_URL = `${ELIZACLOUD_BASE}/apps`;

// ProjectType / ProjectMeta / projectDir / readProjectMeta / writeProjectMeta /
// listProjectsCore / createAgentProject all live in agent-projects-core.ts —
// imported above. The plugin's own scaffold paths used to live here; removed
// to keep one source of truth for what an agent project looks like on disk.

function ok(text: string, values?: Record<string, unknown>): ActionResult {
	return { success: true, text, ...(values ? { values: values as never } : {}) };
}

function fail(text: string): ActionResult {
	return { success: false, text };
}

async function emit(
	callback: ((r: { text: string; action: string }) => void | Promise<unknown>) | undefined,
	text: string,
	action: string,
): Promise<void> {
	if (!callback) return;
	try { await callback({ text, action }); } catch { /* best-effort */ }
}

function pickString(opts: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!opts) return undefined;
	for (const k of keys) {
		const v = opts[k];
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
	}
	return undefined;
}

function pickBool(opts: Record<string, unknown> | undefined, key: string, dflt: boolean): boolean {
	const v = opts?.[key];
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v === "true" || v === "1";
	return dflt;
}

function pickEnum<T extends string>(opts: Record<string, unknown> | undefined, key: string, allowed: readonly T[]): T | undefined {
	const v = opts?.[key];
	if (typeof v !== "string") return undefined;
	return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function caller(runtime: IAgentRuntime): string {
	return runtime.character?.name ? `agent:${runtime.character.name}` : "agent";
}

function previewPartition(slug: string): string {
	const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
	return `persist:detour-preview-${safeSlug}`;
}

function getApiKey(runtime: IAgentRuntime): string | null {
	const key = runtime.getSetting?.("ELIZAOS_CLOUD_API_KEY") ?? process.env.ELIZAOS_CLOUD_API_KEY;
	return typeof key === "string" && key.length > 0 ? key : null;
}

// Scaffolders + escapeHtml moved to src/bun/core/agent-projects-core.ts.
// The plugin used to inline them; one source of truth lives there now.
// The PROMOTE_TO_APP handler below writes its own minimal worker.ts +
// carrot.json directly (a targeted rewrite, not a full scaffold).


// ── AGENT_PROJECT_NEW ──────────────────────────────────────────────────

const newHandler: Handler = async (runtime, message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const name = pickString(opts, ["name"]);
	const description = pickString(opts, ["description"]);
	const type = pickEnum(opts, "type", ["app", "page"] as const);
	// `template` accepts the three built-ins plus any `electrobun:<name>`
	// passthrough. We validate the passthrough by string-shape here and let
	// createAgentProject error if the named electrobun template doesn't
	// actually exist on disk.
	const rawTemplate = pickString(opts, ["template"]);
	const template = rawTemplate && rawTemplate.startsWith("electrobun:")
		? (rawTemplate as `electrobun:${string}`)
		: pickEnum(opts, "template", ["carrot", "nextjs", "static"] as const);
	if (!name) return fail("AGENT_PROJECT_NEW requires `name`.");
	if (!description) return fail("AGENT_PROJECT_NEW requires `description` (1-2 sentences explaining what it does).");
	if (!type) return fail('AGENT_PROJECT_NEW requires `type`: "app" or "page".');

	// Anti-spam: one build at a time per room (+ short cooldown after). If
	// someone keeps asking while a build is running, tell them to chill instead
	// of spawning a second build.
	const roomId = typeof message?.roomId === "string" ? message.roomId : "";
	const coordinator = getBuildCoordinator();
	const claim = coordinator.tryStart(roomId, name);
	if (!claim.ok) {
		const chill = claim.reason === "busy"
			? `chill the fuck out — already building "${claim.label}" (${claim.secondsAgo}s in). one at a time. i'll ping when it's live.`
			: `just shipped "${claim.label}" ${claim.secondsAgo}s ago. give it a sec before the next one.`;
		await emit(callback, chill, "AGENT_PROJECT_NEW");
		return ok(chill, { caller: caller(runtime), rejected: true, reason: claim.reason });
	}

	let meta: ProjectMeta;
	try {
		meta = await createAgentProject({ name, description, type, template });
	} catch (err) {
		coordinator.finish(roomId); // release the lock on scaffold failure
		return fail(`Scaffold failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	coordinator.note(roomId);
	const slug = meta.slug;
	const dir = projectDir(slug);
	const usedTemplate = meta.template ?? (type === "app" ? "carrot" : "static");

	const nextSteps = (() => {
		if (type === "page") {
			return [
				`The scaffold is at ${dir}.`,
				"Use the FILE action (subaction=write/edit) to fill in:",
				"  - index.html: real markup",
				"  - index.css: layout/styling",
				"  - index.js: behavior",
				"Run the tests: BASH `cd <dir> && bun test`",
				`When done, call AGENT_PROJECT_PUBLIC_PREVIEW with slug="${slug}" to send a working ngrok URL, then AGENT_PROJECT_DEPLOY when ready.`,
			].join("\n");
		}
		if (usedTemplate === "nextjs") {
			return [
				`The scaffold is at ${dir} (Next 16 + React 19 + Tailwind v4).`,
				"Use the FILE action (subaction=write/edit) to fill in:",
				"  - app/page.tsx: main UI (Tailwind classes welcome)",
				"  - app/layout.tsx: shared layout / metadata",
				"  - app/globals.css: design tokens + global styles",
				"  - public/: static assets",
				"Install deps and validate: BASH `cd <dir> && bun install && bun run build`",
				`When done, call AGENT_PROJECT_PUBLIC_PREVIEW with slug="${slug}" to send a working ngrok URL, then AGENT_PROJECT_DEPLOY when ready.`,
			].join("\n");
		}
		if (typeof usedTemplate === "string" && usedTemplate.startsWith("electrobun:")) {
			const name = usedTemplate.slice("electrobun:".length);
			return [
				`The scaffold is at ${dir} (Electrobun template "${name}").`,
				"Use the FILE action to fill in src/ with real behavior — bun process logic + view code per the template's layout.",
				`Install deps: BASH \`cd ${dir} && bun install\``,
				`Run locally: BASH \`cd ${dir} && bun run dev\` (or \`electrobun dev\` if installed globally)`,
				`Build a distributable: BASH \`cd ${dir} && electrobun build\``,
				"For a real distributable, codesigning + notarization happens via electrobun.config.ts — leave the user's existing config alone unless asked.",
			].join("\n");
		}
		return [
			`The scaffold is at ${dir} (carrot template).`,
			"Use the FILE action (subaction=write/edit) to fill in:",
			"  - worker.ts: register handler functions for view → bun RPC",
			"  - web/index.html: real UI markup",
			"  - web/index.js: client.invoke(...) calls + DOM wiring",
			"  - web/index.css: layout/styling",
			"Run the tests: BASH `cd <dir> && bun test`",
			`When done, call AGENT_PROJECT_PUBLIC_PREVIEW with slug="${slug}" to send a working ngrok URL, then AGENT_PROJECT_DEPLOY when ready.`,
		].join("\n");
	})();

	const summary = `Scaffolded ${type} "${name}" at slug=${slug} using template=${usedTemplate}.\n\n${nextSteps}`;
	await emit(callback, summary, "AGENT_PROJECT_NEW");
	return ok(summary, {
		caller: caller(runtime),
		slug,
		type,
		template: usedTemplate,
		dir,
		nextSteps,
	});
};

export const agentProjectNewAction: Action = {
	name: "AGENT_PROJECT_NEW",
	similes: ["NEW_AGENT_PROJECT", "SCAFFOLD_PROJECT", "BUILD_APP", "BUILD_PAGE"],
	description:
		"Scaffold a new agent-built project from chat, Telegram, Discord, X, iMessage, the desktop app, or any connected channel. Required: `name`, `description`, `type` (\"app\"|\"page\"). Optional: `template`. Built-in templates: \"carrot\" (default for app — minimal worker.ts + web/, deploys as a hosted carrot), \"nextjs\" (Next 16 + React 19 + Tailwind v4, v0-style — for component-rich web UIs), \"static\" (default for page). Electrobun desktop-app templates: pass `template: \"electrobun:<name>\"` where <name> is one of the Electrobun starters (tray-app, react-tailwind-vite, notes-app, multitab-browser, photo-booth, multi-window, sqlite-crud, hello-world, vue, svelte, solid, vanilla-vite, tailwind-vanilla, wgpu, wgpu-babylon, wgpu-threejs, wgpu-mlp, angular). Use these when the user wants a real macOS/Win/Linux desktop app rather than a web page. Returns the slug + `nextSteps` with file-by-file guidance for filling in the scaffold via FILE/BASH/EDIT. Use when the user says \"build me an X\" — then AGENT_PROJECT_PUBLIC_PREVIEW for a shareable URL (web templates) or `bun run dev` for Electrobun templates.",
	validate: async () => true,
	handler: newHandler,
	examples: [],
	parameters: [
		{ name: "name", description: "Display name (1-100 chars).", required: true, schema: { type: "string" as const } },
		{ name: "description", description: "1-2 sentence description of what it does.", required: true, schema: { type: "string" as const } },
		{ name: "type", description: "\"app\" for backend-capable / cloud-hosted, \"page\" for static frontend.", required: true, schema: { type: "string" as const } },
		{ name: "template", description: "Optional. \"carrot\" or \"nextjs\" for app, \"static\" for page. Defaults: carrot/static.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── AGENT_PROJECT_IMPORT ───────────────────────────────────────────────

const importHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const dir = pickString(opts, ["dir", "path", "directory", "folder"]);
	const name = pickString(opts, ["name"]);
	const description = pickString(opts, ["description"]);
	if (!dir) return fail("AGENT_PROJECT_IMPORT requires `dir` (absolute path).");
	let meta: ProjectMeta;
	try {
		meta = await importAgentProject({ dir, name, description });
	} catch (err) {
		return fail(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	const summary = `Imported "${meta.name}" from ${dir} (slug=${meta.slug}, type=${meta.type}${meta.template ? `/${meta.template}` : ""}). You can now FILE/BASH/EDIT against it; treat ${dir} as the working dir for any commands.`;
	await emit(callback, summary, "AGENT_PROJECT_IMPORT");
	return ok(summary, {
		caller: caller(runtime),
		slug: meta.slug,
		dir,
		type: meta.type,
		template: meta.template,
	});
};

export const agentProjectImportAction: Action = {
	name: "AGENT_PROJECT_IMPORT",
	similes: ["IMPORT_PROJECT", "IMPORT_FOLDER", "REGISTER_PROJECT", "ADOPT_DIRECTORY"],
	description:
		"Register an existing on-disk directory as an agent project so you can FILE/BASH/EDIT inside it with full tooling. Required: `dir` (absolute path on the user's machine). Optional: `name`, `description`. Detects type/template from contents (carrot.json → app/carrot, package.json with next → app/nextjs, index.html → page/static). Writes a `project.json` sidecar inside the dir + symlinks it into the project registry. Use when the user says \"work on /Users/.../foo\" or \"import this repo\". Path can be ANY directory the user names — including their actual repos, not just the agent sandbox.",
	validate: async () => true,
	handler: importHandler,
	examples: [],
	parameters: [
		{ name: "dir", description: "Absolute directory path on disk to register as a project.", required: true, schema: { type: "string" as const } },
		{ name: "name", description: "Optional display name (defaults to dir basename).", required: false, schema: { type: "string" as const } },
		{ name: "description", description: "Optional 1-2 sentence description.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── AGENT_PROJECT_LIST ─────────────────────────────────────────────────

const listHandler: Handler = async (runtime, _message, _state, _options, callback) => {
	const projects = listProjectsCore();
	const summary = projects.length === 0
		? "No agent projects yet."
		: projects.map((p) => `• ${p.name} (slug=${p.slug}, type=${p.type})${p.deployedAppId ? ` — deployed: ${p.deployedAppId}` : ""}`).join("\n");
	await emit(callback, summary, "AGENT_PROJECT_LIST");
	return ok(`Found ${projects.length} project(s).`, { caller: caller(runtime), projects });
};

export const agentProjectListAction: Action = {
	name: "AGENT_PROJECT_LIST",
	similes: ["MY_AGENT_PROJECTS", "LIST_PROJECTS"],
	description:
		"List all agent-built projects on disk. Returns slug, name, type, description, deploy status. Call this BEFORE AGENT_PROJECT_NEW when the user references \"the X I built\" — the project may already exist.",
	validate: async () => true,
	handler: listHandler,
	examples: [],
	parameters: [],
} as Action;

// ── AGENT_PROJECT_OPEN ─────────────────────────────────────────────────

const openHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const slug = pickString(opts, ["slug"]);
	if (!slug) return fail("AGENT_PROJECT_OPEN requires `slug`.");
	const meta = readProjectMeta(slug);
	if (!meta) return fail(`No project found at slug=${slug}.`);

	const dir = projectDir(slug);
	const entryFile = meta.type === "app" ? "web/index.html" : "index.html";
	const entryPath = resolve(join(dir, entryFile));
	if (!existsSync(entryPath)) {
		return fail(`Entry file ${entryFile} not found in project ${slug}. Run AGENT_PROJECT_NEW first or check the scaffold.`);
	}

	const url = `file://${entryPath}`;
	const display = Screen.getPrimaryDisplay();
	const width = 720;
	const height = 540;
	const x = Math.round((display.bounds.width - width) / 2);
	const y = Math.round((display.bounds.height - height) / 2);

	try {
		const win = new BrowserWindow({
			title: `Preview — ${meta.name}`,
			url: null,
			html: null,
			renderer: "native",
			titleBarStyle: "default",
			transparent: false,
			passthrough: false,
			hidden: true,
			sandbox: true,
			navigationRules: null,
			frame: { x, y, width, height },
		});
		win.webview.remove();
		const previewView = new BrowserView({
			url,
			html: null,
			preload: null,
			viewsRoot: null,
			renderer: "native",
			partition: previewPartition(slug),
			frame: { x: 0, y: 0, width, height },
			windowId: win.id,
			navigationRules: null,
			sandbox: true,
		});
		win.webviewId = previewView.id;
		// `sandbox: true` disables RPC + blocks OOPIFs — sufficient
		// isolation for previewing untrusted agent-built content. We
		// additionally restrict navigation to the project dir; last
		// match wins, "^*" = block.
		try {
			previewView.setNavigationRules(["^*", `file://${dir}/*`]);
		} catch { /* best-effort */ }
		win.show();
	} catch (err) {
		return fail(`Failed to open preview window: ${err instanceof Error ? err.message : String(err)}`);
	}

	const summary = `Opened sandboxed preview for "${meta.name}" (${meta.type}) at ${url}.`;
	await emit(callback, summary, "AGENT_PROJECT_OPEN");
	return ok(summary, { caller: caller(runtime), slug, url, type: meta.type });
};

export const agentProjectOpenAction: Action = {
	name: "AGENT_PROJECT_OPEN",
	similes: ["PREVIEW_PROJECT", "SHOW_PROJECT"],
	description:
		"Open a sandboxed preview window for an agent-built project. Uses electrobun `sandbox: true` + per-project `partition` so the preview can't read host cookies and is navigation-restricted to the project dir. Required: `slug` (from AGENT_PROJECT_NEW or AGENT_PROJECT_LIST).",
	validate: async () => true,
	handler: openHandler,
	examples: [],
	parameters: [
		{ name: "slug", description: "Project slug.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── AGENT_PROJECT_PROMOTE_TO_APP ───────────────────────────────────────

const promoteHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const slug = pickString(opts, ["slug"]);
	if (!slug) return fail("AGENT_PROJECT_PROMOTE_TO_APP requires `slug`.");
	const meta = readProjectMeta(slug);
	if (!meta) return fail(`No project found at slug=${slug}.`);
	if (meta.type === "app") return fail(`Project ${slug} is already type=app.`);

	const dir = projectDir(slug);

	try {
		// Move the existing static files into web/ so they become the app's view.
		mkdirSync(join(dir, "web"), { recursive: true });
		for (const f of ["index.html", "index.css", "index.js"]) {
			const src = join(dir, f);
			const dst = join(dir, "web", f);
			if (existsSync(src) && !existsSync(dst)) renameSync(src, dst);
		}

		// Promote: write carrot.json + worker.ts. Don't overwrite an existing
		// worker.ts (in case the agent already started building one).
		const promotedMeta: ProjectMeta = { ...meta, type: "app", updatedAt: Date.now() };
		const carrotJson = {
			id: promotedMeta.slug,
			name: promotedMeta.name,
			version: "0.0.1",
			description: promotedMeta.description,
			mode: "window",
			permissions: {
				host: { windows: true, notifications: true, storage: true },
				bun: { read: true, write: true },
				isolation: "shared-worker",
			},
			view: { relativePath: "web/index.html", title: promotedMeta.name, width: 480, height: 600 },
			worker: { relativePath: "worker.ts" },
		};
		writeFileSync(join(dir, "carrot.json"), `${JSON.stringify(carrotJson, null, 2)}\n`);

		const workerPath = join(dir, "worker.ts");
		if (!existsSync(workerPath)) {
			writeFileSync(
				workerPath,
				`import { app } from "./carrot-runtime/bun";

void app.manifest.id;
`,
			);
		}

		writeProjectMeta(promotedMeta);
	} catch (err) {
		return fail(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	const summary = `Promoted "${meta.name}" from page → app. The static files are now under web/, and a worker.ts skeleton was added (kept existing if present). Fill in worker.ts to add backend behavior.`;
	await emit(callback, summary, "AGENT_PROJECT_PROMOTE_TO_APP");
	return ok(summary, { caller: caller(runtime), slug });
};

export const agentProjectPromoteAction: Action = {
	name: "AGENT_PROJECT_PROMOTE_TO_APP",
	similes: ["PROMOTE_PAGE", "CONVERT_PAGE_TO_APP"],
	description:
		"Convert a `page` project into an `app` project: moves the static files under `web/`, adds `carrot.json` + a worker.ts skeleton, and flips `type` in project.json. Use when the user wanted a static page but later asks for backend behavior. Required: `slug`.",
	validate: async () => true,
	handler: promoteHandler,
	examples: [],
	parameters: [
		{ name: "slug", description: "Project slug to promote.", required: true, schema: { type: "string" as const } },
	],
} as Action;

// ── AGENT_PROJECT_PREVIEW (real HTTP URL via portless) ─────────────────

const previewHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const slug = pickString(opts, ["slug"]);
	const publicRequested = pickBool(opts, "public", false) || pickBool(opts, "ngrok", false);
	if (!slug) return fail("AGENT_PROJECT_PREVIEW requires `slug`.");
	const meta = readProjectMeta(slug);
	if (!meta) return fail(`No project found at slug=${slug}.`);

	try {
		const reg = await getPreviewRegistry();
		const state = publicRequested ? await reg.startPublic(slug) : await reg.startStatic(slug);
		const summary = publicRequested && state.publicUrl
			? `Public preview live at ${state.publicUrl} (local=${state.url}, slug=${slug}, port=${state.port}, provider=ngrok). Send the publicUrl to the user.`
			: `Preview live at ${state.url} (slug=${slug}, port=${state.port}, kind=${state.kind}). The user can open this URL on this Mac; call AGENT_PROJECT_PUBLIC_PREVIEW for a shareable ngrok URL.`;
		await emit(callback, summary, "AGENT_PROJECT_PREVIEW");
		return ok(summary, {
			caller: caller(runtime),
			slug,
			url: state.url,
			port: state.port,
			...(state.publicUrl ? { publicUrl: state.publicUrl, publicUrlProvider: state.publicUrlProvider } : {}),
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const agentProjectPreviewAction: Action = {
	name: "AGENT_PROJECT_PREVIEW",
	similes: ["PREVIEW_URL", "SHARE_PREVIEW", "GET_PREVIEW_URL"],
	description:
		"Start a real HTTP preview for a project and return the local URL (`http://<slug>.localhost:4848/`). For static + carrot projects, starts Bun.serve; for nextjs projects, installs deps if needed and starts `bun run dev`. Required: `slug`. Optional `public`/`ngrok`: true starts ngrok too and returns `publicUrl`. For user-shareable live links, prefer AGENT_PROJECT_PUBLIC_PREVIEW.",
	validate: async () => true,
	handler: previewHandler,
	examples: [],
	parameters: [
		{ name: "slug", description: "Project slug.", required: true, schema: { type: "string" as const } },
		{ name: "public", description: "Optional. true to also start ngrok and return publicUrl.", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

const publicPreviewHandler: Handler = async (runtime, message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const slug = pickString(opts, ["slug"]);
	if (!slug) return fail("AGENT_PROJECT_PUBLIC_PREVIEW requires `slug`.");
	const meta = readProjectMeta(slug);
	if (!meta) return fail(`No project found at slug=${slug}.`);
	const roomId = typeof message?.roomId === "string" ? message.roomId : "";
	getBuildCoordinator().note(roomId); // build's still alive — refresh the lock
	try {
		const reg = await getPreviewRegistry();
		const state = await reg.startPublic(slug);
		if (!state.publicUrl) return fail(state.publicUrlError ?? "ngrok did not return a public URL.");
		const summary = `Public preview live at ${state.publicUrl} (local=${state.url}, slug=${slug}, port=${state.port}, provider=ngrok). Send this URL to the user.`;
		await emit(callback, summary, "AGENT_PROJECT_PUBLIC_PREVIEW");
		getBuildCoordinator().finish(roomId); // preview is live → build done, open cooldown
		return ok(summary, {
			caller: caller(runtime),
			slug,
			url: state.url,
			publicUrl: state.publicUrl,
			publicUrlProvider: state.publicUrlProvider,
			port: state.port,
			hostname: state.hostname,
		});
	} catch (err) {
		let localUrl: string | undefined;
		try {
			localUrl = (await getPreviewRegistry()).get(slug)?.url;
		} catch { /* ignore */ }
		const message = err instanceof Error ? err.message : String(err);
		return fail(localUrl ? `${message}. Local preview is live at ${localUrl}.` : message);
	}
};

export const agentProjectPublicPreviewAction: Action = {
	name: "AGENT_PROJECT_PUBLIC_PREVIEW",
	similes: ["PUBLIC_PREVIEW_URL", "NGROK_PREVIEW", "LIVE_PREVIEW_URL", "SEND_PREVIEW_URL", "SHARE_LIVE_PREVIEW"],
	description:
		"Start a project preview and an ngrok HTTPS tunnel, then return `publicUrl`. Required: `slug`. Use after building or editing an app when the user asks for a live preview, shareable URL, ngrok URL, or says to send a preview link from chat, Telegram, Discord, X, iMessage, the desktop app, or any connected channel. This is the final step for generated apps: build/test, start public preview, then reply in the originating channel with the ngrok `publicUrl`.",
	validate: async () => true,
	handler: publicPreviewHandler,
	examples: [],
	parameters: [
		{ name: "slug", description: "Project slug.", required: true, schema: { type: "string" as const } },
	],
} as Action;

const registerPreviewPortHandler: Handler = async (runtime, _m, _s, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const slug = pickString(opts, ["slug"]);
	const portRaw = opts?.port;
	const port = typeof portRaw === "number" ? portRaw : (typeof portRaw === "string" ? parseInt(portRaw, 10) : NaN);
	const publicRequested = pickBool(opts, "public", false) || pickBool(opts, "ngrok", false);
	if (!slug) return fail("AGENT_PROJECT_REGISTER_PREVIEW_PORT requires `slug`.");
	if (!Number.isFinite(port) || port <= 0 || port > 65535) return fail("AGENT_PROJECT_REGISTER_PREVIEW_PORT requires a valid `port` number.");
	try {
		const reg = await getPreviewRegistry();
		reg.registerExternalPort(slug, port);
		const state = publicRequested ? await reg.startPublic(slug) : reg.get(slug);
		if (!state) return fail(`Preview registry lost ${slug}.`);
		const summary = publicRequested && state.publicUrl
			? `Registered port ${port} for ${slug} → ${state.url}; public ngrok URL: ${state.publicUrl}. Send the publicUrl to the user.`
			: `Registered port ${port} for ${slug} → ${state.url}.`;
		await emit(callback, summary, "AGENT_PROJECT_REGISTER_PREVIEW_PORT");
		return ok(summary, {
			caller: caller(runtime),
			slug,
			url: state.url,
			port,
			...(state.publicUrl ? { publicUrl: state.publicUrl, publicUrlProvider: state.publicUrlProvider } : {}),
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const agentProjectRegisterPreviewPortAction: Action = {
	name: "AGENT_PROJECT_REGISTER_PREVIEW_PORT",
	similes: ["REGISTER_DEV_SERVER", "MAP_PORT_TO_URL", "REGISTER_NGROK_PREVIEW_PORT"],
	description:
		"Map a port the agent already has running (e.g. `bun dev` you started via BASH) to the project's local portless URL. Required: `slug`, `port`. Optional `public`/`ngrok`: true starts ngrok and returns `publicUrl`.",
	validate: async () => true,
	handler: registerPreviewPortHandler,
	examples: [],
	parameters: [
		{ name: "slug", description: "Project slug.", required: true, schema: { type: "string" as const } },
		{ name: "port", description: "Port number the dev server is listening on (e.g. 3000 for Next.js).", required: true, schema: { type: "number" as const } },
		{ name: "public", description: "Optional. true to also start ngrok and return publicUrl.", required: false, schema: { type: "boolean" as const } },
	],
} as Action;

// ── AGENT_PROJECT_PUBLISH_GITHUB ───────────────────────────────────────

const publishHandler: Handler = async (runtime, _message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const slug = pickString(opts, ["slug"]);
	const repoName = pickString(opts, ["repoName", "repo", "name"]);
	const description = pickString(opts, ["description"]);
	const isPrivate = pickBool(opts, "isPrivate", false) || pickBool(opts, "private", false);
	if (!slug) return fail("AGENT_PROJECT_PUBLISH_GITHUB requires `slug`.");
	const meta = readProjectMeta(slug);
	if (!meta) return fail(`No project found at slug=${slug}.`);

	const pat =
		(typeof runtime.getSetting === "function" ? runtime.getSetting("GITHUB_AGENT_PAT") : null)
		|| process.env.GITHUB_AGENT_PAT
		|| (typeof runtime.getSetting === "function" ? runtime.getSetting("GITHUB_TOKEN") : null)
		|| process.env.GITHUB_TOKEN;
	if (!pat || typeof pat !== "string") {
		return fail("No GITHUB_AGENT_PAT (or GITHUB_TOKEN) configured. Wire it in Messaging connections.");
	}

	try {
		const result = await publishProjectToGitHub({ slug, meta, repoName, isPrivate, description, pat });
		const summary = `Published "${meta.name}" to GitHub: ${result.htmlUrl} (clone: ${result.cloneUrl}). Repo is owned by @${result.owner}.`;
		await emit(callback, summary, "AGENT_PROJECT_PUBLISH_GITHUB");
		return ok(summary, {
			caller: caller(runtime),
			slug,
			htmlUrl: result.htmlUrl,
			cloneUrl: result.cloneUrl,
			owner: result.owner,
			name: result.name,
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const agentProjectPublishGitHubAction: Action = {
	name: "AGENT_PROJECT_PUBLISH_GITHUB",
	similes: ["PUBLISH_TO_GITHUB", "PUSH_TO_GITHUB", "MAKE_GITHUB_REPO", "CREATE_REPO"],
	description:
		"Create a new GitHub repo under the AGENT's identity (using GITHUB_AGENT_PAT) and push the project's git history to it. Required: `slug`. Optional: `repoName` (defaults to slug), `isPrivate` (default false), `description`. Returns the html_url + clone_url. Use when the user says 'publish this' or 'put it on GitHub' after they've reviewed a preview.",
	validate: async () => true,
	handler: publishHandler,
	examples: [],
	parameters: [
		{ name: "slug", description: "Project slug.", required: true, schema: { type: "string" as const } },
		{ name: "repoName", description: "Optional repo name. Defaults to slug.", required: false, schema: { type: "string" as const } },
		{ name: "isPrivate", description: "Create as private repo (default: false).", required: false, schema: { type: "boolean" as const } },
		{ name: "description", description: "Optional repo description.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── AGENT_PROJECT_DEPLOY ───────────────────────────────────────────────

const deployHandler: Handler = async (runtime, message, _state, options, callback) => {
	const opts = options as Record<string, unknown> | undefined;
	const slug = pickString(opts, ["slug"]);
	const appUrlOverride = pickString(opts, ["app_url", "appUrl"]);
	if (!slug) return fail("AGENT_PROJECT_DEPLOY requires `slug`.");
	const meta = readProjectMeta(slug);
	if (!meta) return fail(`No project found at slug=${slug}.`);
	const roomId = typeof message?.roomId === "string" ? message.roomId : "";

	const apiKey = getApiKey(runtime);
	if (!apiKey) return fail("Not signed in to ElizaOS Cloud. Have the user run Cloud → ElizaOS Cloud → Connect.");

	// We don't auto-host the artifact here — that requires a separate
	// upload pipeline. We register the app + return the cloud's app id.
	// The user (or a later action) uploads the actual bundle. This
	// matches the cloud-apps plugin's CLOUD_CREATE_APP shape.
	const appUrl = appUrlOverride ?? `https://${meta.slug}.example.elizacloud.ai`;

	try {
		const res = await fetch(APPS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: meta.name,
				app_url: appUrl,
				description: meta.description,
				skipGitHubRepo: true,
			}),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => res.statusText);
			return fail(`Cloud deploy failed: HTTP ${res.status}: ${body.slice(0, 240)}`);
		}
		const data = (await res.json()) as { app?: { id?: string; name?: string }; api_key?: string };
		const appId = data.app?.id ?? "";
		const updated: ProjectMeta = { ...meta, deployedAppId: appId, deployedAt: Date.now(), updatedAt: Date.now() };
		writeProjectMeta(updated);

		const summary = `Deployed "${meta.name}" to ElizaOS Cloud (id=${appId}). Bundle upload still needs to happen via the dashboard at /dashboard/apps/${appId}.`;
		await emit(callback, summary, "AGENT_PROJECT_DEPLOY");
		getBuildCoordinator().finish(roomId); // deployed → build done, open cooldown
		return ok(summary, {
			caller: caller(runtime),
			slug,
			appId,
			...(data.api_key ? { api_key_preview: `${data.api_key.slice(0, 8)}…` } : {}),
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
};

export const agentProjectDeployAction: Action = {
	name: "AGENT_PROJECT_DEPLOY",
	similes: ["DEPLOY_PROJECT", "PUBLISH_PROJECT"],
	description:
		"Register an agent-built project on ElizaOS Cloud. Required: `slug`. Optional: `app_url` (defaults to a placeholder). Saves the cloud-issued app id back into project.json so subsequent deploys can update in place. Note: bundle upload happens separately via the dashboard.",
	validate: async () => true,
	handler: deployHandler,
	examples: [],
	parameters: [
		{ name: "slug", description: "Project slug to deploy.", required: true, schema: { type: "string" as const } },
		{ name: "app_url", description: "Public URL the deployed app will run at.", required: false, schema: { type: "string" as const } },
	],
} as Action;

// ── Plugin export ──────────────────────────────────────────────────────

export const agentProjectsPlugin: Plugin = {
	name: "agent-projects",
	description:
		"Agent-driven project scaffolding + import: AGENT_PROJECT_NEW, AGENT_PROJECT_IMPORT, AGENT_PROJECT_LIST, AGENT_PROJECT_OPEN, AGENT_PROJECT_PREVIEW, AGENT_PROJECT_PUBLIC_PREVIEW (ngrok HTTPS URL), AGENT_PROJECT_PROMOTE_TO_APP, AGENT_PROJECT_DEPLOY. Scaffolded projects live under $DETOUR_AGENT_SANDBOX/projects/<slug>/; imported projects live wherever the user keeps their code (registered via symlink). After scaffolding/importing, the same agent fills in the implementation using FILE/BASH/EDIT from @elizaos/plugin-coding-tools — paths can be ANY directory the user names (including outside the sandbox), subject to the system blocklist + elevated-permissions toggle.",
	actions: [
		agentProjectNewAction,
		agentProjectImportAction,
		agentProjectListAction,
		agentProjectOpenAction,
		agentProjectPromoteAction,
		agentProjectDeployAction,
		agentProjectPreviewAction,
		agentProjectPublicPreviewAction,
		agentProjectRegisterPreviewPortAction,
		agentProjectPublishGitHubAction,
	],
};
