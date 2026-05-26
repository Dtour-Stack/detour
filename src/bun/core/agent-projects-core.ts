/**
 * Agent-projects core — shared scaffolders + metadata helpers used by
 * both the agent plugin (`src/bun/plugins/agent-projects/`) and the
 * agent-project RPC handler.
 *
 * Single source of truth for what an agent-built project looks like
 * on disk. Both entry paths (agent action + UI button) end up calling
 * `createAgentProject()` here.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProjectType = "app" | "page";

/**
 * Scaffold templates. `app` projects pick from `carrot` (default),
 * `nextjs` (Next.js + Tailwind v4, modeled on v0's starter), or
 * `electrobun:<name>` (any template under `~/Electrobun/templates/`).
 * `page` projects only have `static` for now. The template field is
 * persisted in project.json so subsequent operations (deploy, preview,
 * promote) can branch on framework specifics.
 *
 * `electrobun:*` lets the agent scaffold real desktop apps with the
 * same templates the Electrobun CLI ships: tray-app, react-tailwind-vite,
 * notes-app, multitab-browser, photo-booth, multi-window, etc.
 */
export type ProjectTemplate = "carrot" | "nextjs" | "static" | `electrobun:${string}`;

/**
 * Resolve the local Electrobun templates directory. Defaults to
 * `~/Electrobun/templates` (where the Electrobun monorepo ships them)
 * but overridable via `DETOUR_ELECTROBUN_TEMPLATES_DIR` so tests can
 * point at a fixture.
 */
export function electrobunTemplatesDir(): string {
	const override = process.env.DETOUR_ELECTROBUN_TEMPLATES_DIR;
	if (typeof override === "string" && override.length > 0) return override;
	return join(homedir(), "Electrobun", "templates");
}

/**
 * Enumerate available Electrobun template slugs (folder names). Returns
 * an empty array if the templates dir is missing — that's the normal
 * state when Electrobun isn't checked out alongside Detour.
 */
export function listElectrobunTemplates(): string[] {
	const dir = electrobunTemplatesDir();
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

export function isElectrobunTemplate(value: string): value is `electrobun:${string}` {
	return value.startsWith("electrobun:") && value.length > "electrobun:".length;
}

function electrobunTemplateName(value: `electrobun:${string}`): string {
	return value.slice("electrobun:".length);
}

export type ProjectMeta = {
	type: ProjectType;
	template?: ProjectTemplate;
	slug: string;
	name: string;
	description: string;
	createdAt: number;
	updatedAt: number;
	deployedAppId?: string;
	deployedAt?: number;
};

export function getProjectsRoot(): string {
	const sandbox = process.env.DETOUR_AGENT_SANDBOX;
	if (!sandbox) throw new Error("DETOUR_AGENT_SANDBOX env var not set — agent sandbox dir not initialized");
	const root = join(sandbox, "projects");
	mkdirSync(root, { recursive: true });
	return root;
}

export function projectDir(slug: string): string {
	return join(getProjectsRoot(), slug);
}

export function slugify(input: string): string {
	const out = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return out.length > 0 ? out : `project-${Date.now().toString(36)}`;
}

export function uniqueSlug(base: string): string {
	const root = getProjectsRoot();
	let candidate = base;
	let n = 2;
	while (existsSync(join(root, candidate))) {
		candidate = `${base}-${n++}`;
		if (n > 999) throw new Error("could not pick a unique slug after 999 attempts");
	}
	return candidate;
}

export function readProjectMeta(slug: string): ProjectMeta | null {
	const path = join(projectDir(slug), "project.json");
	if (!existsSync(path)) return null;
	try {
		const json = JSON.parse(readFileSync(path, "utf8")) as ProjectMeta;
		if (!json.slug || !json.type || !json.name) return null;
		return json;
	} catch {
		return null;
	}
}

export function writeProjectMeta(meta: ProjectMeta): void {
	writeFileSync(
		join(projectDir(meta.slug), "project.json"),
		`${JSON.stringify(meta, null, 2)}\n`,
	);
}

export function listProjectsCore(): ProjectMeta[] {
	const root = getProjectsRoot();
	if (!existsSync(root)) return [];
	const out: ProjectMeta[] = [];
	for (const entry of readdirSync(root)) {
		try {
			if (!statSync(join(root, entry)).isDirectory()) continue;
		} catch {
			continue;
		}
		const meta = readProjectMeta(entry);
		if (meta) out.push(meta);
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

async function gitInit(dir: string): Promise<void> {
	try {
		const initProc = Bun.spawn(["git", "init", "--quiet"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
		await initProc.exited;
		const addProc = Bun.spawn(["git", "add", "-A"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
		await addProc.exited;
		const commitProc = Bun.spawn(
			["git", "-c", "user.email=agent@detour.local", "-c", "user.name=Detour Agent", "commit", "--quiet", "-m", "scaffold: initial commit"],
			{ cwd: dir, stdout: "ignore", stderr: "ignore" },
		);
		await commitProc.exited;
	} catch {
		// Best-effort.
	}
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Standard Open Graph + Twitter Card meta block. Goes in every
 * scaffold's `<head>` so URLs unfurl in Slack / Discord / iMessage /
 * Telegram / X with the project name + description and the local
 * `og.svg` placeholder image. Agents (or users) can swap `og.svg`
 * for a real `og.png` (1200×630) without changing the meta.
 */
function ogMetaTags(args: { title: string; description: string; image?: string; type?: string }): string {
	const { title, description, image = "./og.svg", type = "website" } = args;
	const t = escapeHtml(title);
	const d = escapeHtml(description);
	const i = escapeHtml(image);
	return [
		`<meta property="og:title" content="${t}" />`,
		`<meta property="og:description" content="${d}" />`,
		`<meta property="og:image" content="${i}" />`,
		`<meta property="og:type" content="${type}" />`,
		`<meta name="twitter:card" content="summary_large_image" />`,
		`<meta name="twitter:title" content="${t}" />`,
		`<meta name="twitter:description" content="${d}" />`,
		`<meta name="twitter:image" content="${i}" />`,
	].join("\n");
}

/** Generate a 1200×630 SVG placeholder card with the project name +
 * description. Drop-in until the user supplies a real `og.png`. */
function ogPlaceholderSvg(title: string, description: string): string {
	const t = escapeHtml(title.slice(0, 60));
	const d = escapeHtml(description.slice(0, 140));
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#1a0033"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <text x="80" y="270" font-family="-apple-system, system-ui, sans-serif" font-size="64" font-weight="700" fill="#ffffff">${t}</text>
  <text x="80" y="350" font-family="-apple-system, system-ui, sans-serif" font-size="28" font-weight="400" fill="#aaaaaa">${d}</text>
  <text x="80" y="570" font-family="ui-monospace, Menlo, monospace" font-size="20" fill="#888888">detour · Dexploarer's elizaOS sandbox</text>
</svg>`;
}

function scaffoldApp(dir: string, meta: ProjectMeta): void {
	const slugSafe = meta.slug.replace(/[^a-zA-Z0-9_-]/g, "_");
	const carrotJson = {
		id: meta.slug,
		name: meta.name,
		version: "0.0.1",
		description: meta.description,
		mode: "window",
		permissions: {
			host: { windows: true, notifications: true, storage: true },
			bun: { read: true, write: true },
			isolation: "shared-worker",
		},
		view: { relativePath: "web/index.html", title: meta.name, width: 480, height: 600 },
		worker: { relativePath: "worker.ts" },
	};
	mkdirSync(join(dir, "web"), { recursive: true });
	mkdirSync(join(dir, "tests"), { recursive: true });
	writeFileSync(join(dir, "carrot.json"), `${JSON.stringify(carrotJson, null, 2)}\n`);
	writeFileSync(
		join(dir, "worker.ts"),
		`import { app, BrowserWindow } from "./carrot-runtime/bun";\n\n// Agent: implement the worker entrypoint here. The runtime gives you:\n//   - app.manifest         — the carrot.json contents\n//   - app.permissions      — granted permission set\n//   - app.statePath        — durable state dir for this project\n//   - BrowserWindow        — proxied window-creation API\n\nconsole.log("[${slugSafe}] worker boot. manifest:", app.manifest.id);\n`,
	);
	writeFileSync(
		join(dir, "web", "index.html"),
		`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${escapeHtml(meta.name)}</title>\n${ogMetaTags({ title: meta.name, description: meta.description })}\n<link rel="stylesheet" href="./index.css" />\n</head>\n<body>\n<main>\n<h1>${escapeHtml(meta.name)}</h1>\n<p>${escapeHtml(meta.description)}</p>\n<p class="hint">Replace this scaffold with the real UI.</p>\n</main>\n<script type="module" src="./index.js"></script>\n</body>\n</html>\n`,
	);
	writeFileSync(join(dir, "web", "og.svg"), ogPlaceholderSvg(meta.name, meta.description));
	writeFileSync(
		join(dir, "web", "index.css"),
		`:root { color-scheme: light dark; font-family: system-ui, sans-serif; }\nbody { margin: 0; padding: 1.5rem; }\nmain { max-width: 640px; margin: 0 auto; }\nh1 { margin-top: 0; }\n.hint { opacity: 0.6; font-size: 0.85rem; }\n`,
	);
	writeFileSync(
		join(dir, "web", "index.js"),
		`import { createCarrotClient } from "./carrot-runtime/view";\n\nconst client = createCarrotClient();\nclient.on("boot", (info) => {\n  console.log("[${slugSafe}] view boot. permissions:", info.permissions);\n});\n`,
	);
	writeFileSync(
		join(dir, "tests", "worker.test.ts"),
		`import { describe, expect, it } from "bun:test";\n\ndescribe("${slugSafe}", () => {\n  it("scaffold smoke test", () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n`,
	);
	writeFileSync(
		join(dir, "README.md"),
		`# ${meta.name}\n\n${meta.description}\n\nGenerated on ${new Date(meta.createdAt).toISOString()}.\n\nType: \`app\` (full carrot — worker.ts + web/ + cloud-deployable).\n`,
	);
}

/**
 * Next.js + Tailwind v4 scaffold modeled on v0-starter-template
 * (Next 16, React 19, Tailwind v4 PostCSS plugin). Drops the v0 logo
 * splash for our own copy. The agent fills in `app/page.tsx`.
 */
function scaffoldNextjs(dir: string, meta: ProjectMeta): void {
	const slugSafe = meta.slug.replace(/[^a-zA-Z0-9_-]/g, "_");
	mkdirSync(join(dir, "app"), { recursive: true });
	mkdirSync(join(dir, "public"), { recursive: true });
	mkdirSync(join(dir, "tests"), { recursive: true });

	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: meta.slug,
				version: "0.1.0",
				private: true,
				scripts: {
					dev: "next dev",
					build: "next build",
					start: "next start",
					lint: "eslint",
				},
				dependencies: {
					next: "16.0.8",
					react: "19.2.1",
					"react-dom": "19.2.1",
				},
				devDependencies: {
					"@tailwindcss/postcss": "^4",
					"@types/node": "^20",
					"@types/react": "^19",
					"@types/react-dom": "^19",
					eslint: "^9",
					"eslint-config-next": "16.0.8",
					tailwindcss: "^4",
					typescript: "^5",
				},
				packageManager: "bun@1.3.13",
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(
		join(dir, "next.config.ts"),
		`import type { NextConfig } from "next";\n\nconst config: NextConfig = {\n};\n\nexport default config;\n`,
	);

	writeFileSync(
		join(dir, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					lib: ["dom", "dom.iterable", "esnext"],
					allowJs: true,
					skipLibCheck: true,
					strict: true,
					noEmit: true,
					esModuleInterop: true,
					module: "esnext",
					moduleResolution: "bundler",
					resolveJsonModule: true,
					isolatedModules: true,
					jsx: "preserve",
					incremental: true,
					plugins: [{ name: "next" }],
					paths: { "@/*": ["./*"] },
				},
				include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
				exclude: ["node_modules"],
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(
		join(dir, "postcss.config.mjs"),
		`export default {\n  plugins: {\n    "@tailwindcss/postcss": {},\n  },\n};\n`,
	);

	writeFileSync(
		join(dir, "app", "globals.css"),
		`@import "tailwindcss";\n\n@theme {\n  --color-foreground: #000;\n  --color-background: #fff;\n}\n\n@media (prefers-color-scheme: dark) {\n  @theme {\n    --color-foreground: #fff;\n    --color-background: #000;\n  }\n}\n\nbody {\n  background: var(--color-background);\n  color: var(--color-foreground);\n}\n`,
	);

	writeFileSync(
		join(dir, "app", "layout.tsx"),
		`import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: ${JSON.stringify(meta.name)},\n  description: ${JSON.stringify(meta.description)},\n  openGraph: {\n    title: ${JSON.stringify(meta.name)},\n    description: ${JSON.stringify(meta.description)},\n    type: "website",\n    images: ["/og.svg"],\n  },\n  twitter: {\n    card: "summary_large_image",\n    title: ${JSON.stringify(meta.name)},\n    description: ${JSON.stringify(meta.description)},\n    images: ["/og.svg"],\n  },\n};\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
	);

	writeFileSync(
		join(dir, "app", "page.tsx"),
		`export default function Home() {\n  return (\n    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">\n      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white dark:bg-black sm:items-start">\n        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">\n          <h1 className="max-w-xs text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">\n            ${escapeHtml(meta.name)}\n          </h1>\n          <p className="max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">\n            ${escapeHtml(meta.description)}\n          </p>\n          <p className="max-w-md text-sm text-zinc-500">Replace this scaffold with the real app.</p>\n        </div>\n      </main>\n    </div>\n  );\n}\n`,
	);

	writeFileSync(
		join(dir, "next-env.d.ts"),
		`/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// NOTE: This file should not be edited\n// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.\n`,
	);

	writeFileSync(
		join(dir, ".gitignore"),
		`# next\n.next\nnext-env.d.ts\nnode_modules\n.env*.local\n.DS_Store\n*.tsbuildinfo\n`,
	);

	writeFileSync(
		join(dir, "tests", "smoke.test.ts"),
		`import { describe, expect, it } from "bun:test";\n\ndescribe("${slugSafe}", () => {\n  it("scaffold smoke test", () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n`,
	);

	writeFileSync(
		join(dir, "README.md"),
		`# ${meta.name}\n\n${meta.description}\n\nGenerated on ${new Date(meta.createdAt).toISOString()}.\n\nType: \`app\` · Template: \`nextjs\` (Next 16 + React 19 + Tailwind v4).\n\nRun:\n\n\`\`\`bash\nbun install\nbun dev\n\`\`\`\n`,
	);
	// Drop the OG card into public/ — Next.js serves it at /og.svg and
	// the layout.tsx metadata block above references it.
	writeFileSync(join(dir, "public", "og.svg"), ogPlaceholderSvg(meta.name, meta.description));
}

function scaffoldPage(dir: string, meta: ProjectMeta): void {
	const slugSafe = meta.slug.replace(/[^a-zA-Z0-9_-]/g, "_");
	mkdirSync(join(dir, "tests"), { recursive: true });
	writeFileSync(
		join(dir, "index.html"),
		`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${escapeHtml(meta.name)}</title>\n${ogMetaTags({ title: meta.name, description: meta.description })}\n<link rel="stylesheet" href="./index.css" />\n</head>\n<body>\n<main>\n<h1>${escapeHtml(meta.name)}</h1>\n<p>${escapeHtml(meta.description)}</p>\n<p class="hint">Replace this scaffold with the real page.</p>\n</main>\n<script type="module" src="./index.js"></script>\n</body>\n</html>\n`,
	);
	writeFileSync(join(dir, "og.svg"), ogPlaceholderSvg(meta.name, meta.description));
	writeFileSync(
		join(dir, "index.css"),
		`:root { color-scheme: light dark; font-family: system-ui, sans-serif; }\nbody { margin: 0; padding: 1.5rem; }\nmain { max-width: 720px; margin: 0 auto; }\nh1 { margin-top: 0; }\n.hint { opacity: 0.6; font-size: 0.85rem; }\n`,
	);
	writeFileSync(join(dir, "index.js"), `console.log("[${slugSafe}] page loaded.");\n`);
	writeFileSync(
		join(dir, "tests", "page.test.ts"),
		`import { describe, expect, it } from "bun:test";\n\ndescribe("${slugSafe}", () => {\n  it("scaffold smoke test", () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n`,
	);
	writeFileSync(
		join(dir, "README.md"),
		`# ${meta.name}\n\n${meta.description}\n\nGenerated on ${new Date(meta.createdAt).toISOString()}.\n\nType: \`page\` (static frontend — index.html + index.css + index.js).\n`,
	);
}

/**
 * Scaffold from an Electrobun template under `~/Electrobun/templates/`.
 * Copies the template tree as-is, then overlays a `README.md` describing
 * the project name + description. The template's own `package.json` /
 * `electrobun.config.ts` / source layout is preserved; the agent's
 * follow-up turn is responsible for filling in actual logic via FILE/EDIT.
 *
 * Throws when the template directory doesn't exist so the caller surfaces
 * a clear error instead of producing a blank scaffold.
 */
function scaffoldElectrobun(dir: string, meta: ProjectMeta, templateName: string): void {
	const src = join(electrobunTemplatesDir(), templateName);
	if (!existsSync(src) || !statSync(src).isDirectory()) {
		throw new Error(
			`electrobun template "${templateName}" not found at ${src} — run \`listElectrobunTemplates()\` to see what's installed.`,
		);
	}
	cpSync(src, dir, { recursive: true, errorOnExist: false });
	writeFileSync(
		join(dir, "README.md"),
		`# ${meta.name}\n\n${meta.description}\n\nGenerated on ${new Date(meta.createdAt).toISOString()} from Electrobun template \`${templateName}\`.\n\nNext steps:\n- \`cd ${dir} && bun install\`\n- \`bun run dev\` (or \`electrobun dev\` if installed globally) to launch.\n- Edit \`src/\` to fill in real behavior.\n`,
	);
}

/**
 * Create a new GitHub repo under the agent's PAT identity and push the
 * project's git history to it. Used by both the RPC handler and the
 * plugin action. Caller supplies the PAT —
 * we don't go to vault here so the helper stays unit-testable.
 */
export async function publishProjectToGitHub({
	slug,
	meta,
	repoName,
	isPrivate,
	description,
	pat,
}: {
	slug: string;
	meta: ProjectMeta;
	repoName?: string;
	isPrivate?: boolean;
	description?: string;
	pat: string;
}): Promise<{ htmlUrl: string; cloneUrl: string; owner: string; name: string }> {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const dir = projectDir(slug);
	if (!fs.existsSync(dir)) throw new Error(`project dir missing: ${dir}`);
	if (!pat) throw new Error("GitHub PAT is empty");

	const meRes = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${pat}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!meRes.ok) {
		const body = await meRes.text().catch(() => meRes.statusText);
		throw new Error(`GitHub auth failed (HTTP ${meRes.status}): ${body.slice(0, 240)}`);
	}
	const me = (await meRes.json()) as { login?: string };
	const owner = me.login;
	if (!owner) throw new Error("GitHub /user did not return a login");

	const sanitizedName = (repoName ?? meta.slug).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 100);
	if (!sanitizedName) throw new Error("repoName is empty after sanitization");

	const createRes = await fetch("https://api.github.com/user/repos", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${pat}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			name: sanitizedName,
			description: (description ?? meta.description).slice(0, 350),
			private: !!isPrivate,
			auto_init: false,
		}),
	});
	if (!createRes.ok) {
		const body = await createRes.text().catch(() => createRes.statusText);
		throw new Error(`Repo create failed (HTTP ${createRes.status}): ${body.slice(0, 240)}`);
	}
	const repo = (await createRes.json()) as { html_url?: string; clone_url?: string };
	const htmlUrl = repo.html_url ?? `https://github.com/${owner}/${sanitizedName}`;
	const cloneUrl = repo.clone_url ?? `https://github.com/${owner}/${sanitizedName}.git`;

	const pushUrl = cloneUrl.replace("https://", `https://x-access-token:${pat}@`);
	const runGit = async (args: string[]) => {
		const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(proc.stderr).text();
		const code = await proc.exited;
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim().slice(0, 200)}`);
	};

	if (!fs.existsSync(path.join(dir, ".git"))) {
		await runGit(["init", "--quiet"]);
		await runGit(["add", "-A"]);
		await runGit([
			"-c", "user.email=agent@detour.local",
			"-c", "user.name=Detour Agent",
			"commit", "--quiet", "-m", "scaffold: initial commit (publish prep)",
		]);
	}
	try {
		const r = Bun.spawn(["git", "remote", "remove", "origin"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
		await r.exited;
	} catch { /* ignore */ }
	await runGit(["remote", "add", "origin", pushUrl]);
	const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
	const branch = (await new Response(branchProc.stdout).text()).trim() || "main";
	await branchProc.exited;
	await runGit(["push", "-u", "origin", branch]);
	try { await runGit(["remote", "set-url", "origin", cloneUrl]); } catch { /* best-effort */ }

	try {
		const updated: ProjectMeta & { githubHtmlUrl?: string } = {
			...meta,
			updatedAt: Date.now(),
			githubHtmlUrl: htmlUrl,
		};
		fs.writeFileSync(path.join(dir, "project.json"), `${JSON.stringify(updated, null, 2)}\n`);
	} catch { /* meta write is non-fatal */ }

	return { htmlUrl, cloneUrl, owner, name: sanitizedName };
}

/** Detect the most likely project type/template from a dir's contents.
 * Used by the import flow when the user points at an existing repo. */
export function detectProjectKind(absDir: string): { type: ProjectType; template: ProjectTemplate } {
	if (existsSync(join(absDir, "carrot.json"))) return { type: "app", template: "carrot" };
	const pkgPath = join(absDir, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			if ("next" in deps) return { type: "app", template: "nextjs" };
			return { type: "app", template: "carrot" };
		} catch { /* fall through */ }
	}
	if (existsSync(join(absDir, "index.html"))) return { type: "page", template: "static" };
	// Default for an unknown dir — treat as a generic app project.
	return { type: "app", template: "carrot" };
}

/**
 * Register an existing on-disk directory as an agent project. Writes
 * a `project.json` sidecar into the source dir + creates a symlink at
 * `$DETOUR_AGENT_SANDBOX/projects/<slug>` pointing at the source so
 * every existing handler (file tree, git, read/write) operates on the
 * dir transparently. Does NOT git-init — respects whatever the source
 * dir already has.
 */
export async function importAgentProject({
	dir,
	name,
	description,
}: {
	dir: string;
	name?: string;
	description?: string;
}): Promise<ProjectMeta> {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const absDir = path.resolve(dir);
	if (!fs.existsSync(absDir)) throw new Error(`directory does not exist: ${absDir}`);
	const stat = fs.statSync(absDir);
	if (!stat.isDirectory()) throw new Error(`not a directory: ${absDir}`);

	const baseName = path.basename(absDir);
	const proposedName = (name ?? baseName).trim();
	if (proposedName.length === 0) throw new Error("name is required");

	// Pick a slug from the dir basename, ensure unique in projects/.
	const slug = uniqueSlug(slugify(proposedName));

	const detected = detectProjectKind(absDir);

	// Read existing project.json if present so we don't clobber the user's
	// own metadata; otherwise create one.
	const sidecarPath = path.join(absDir, "project.json");
	let meta: ProjectMeta;
	const now = Date.now();
	if (fs.existsSync(sidecarPath)) {
		try {
			const existing = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as Partial<ProjectMeta>;
			meta = {
				type: (existing.type === "app" || existing.type === "page") ? existing.type : detected.type,
				template: existing.template ?? detected.template,
				slug,
				name: existing.name ?? proposedName,
				description: existing.description ?? description ?? `Imported from ${absDir}`,
				createdAt: existing.createdAt ?? now,
				updatedAt: now,
				...(existing.deployedAppId ? { deployedAppId: existing.deployedAppId } : {}),
				...(existing.deployedAt ? { deployedAt: existing.deployedAt } : {}),
			};
		} catch {
			meta = {
				type: detected.type,
				template: detected.template,
				slug,
				name: proposedName,
				description: description?.trim() || `Imported from ${absDir}`,
				createdAt: now,
				updatedAt: now,
			};
		}
	} else {
		meta = {
			type: detected.type,
			template: detected.template,
			slug,
			name: proposedName,
			description: description?.trim() || `Imported from ${absDir}`,
			createdAt: now,
			updatedAt: now,
		};
	}

	// Write the sidecar AT the source dir. Skip if user explicitly wants
	// the dir untouched — for now, always write to keep the registry
	// idempotent (re-importing the same dir reuses the same sidecar).
	fs.writeFileSync(sidecarPath, `${JSON.stringify(meta, null, 2)}\n`);

	// Symlink into projects/<slug>. If a real dir exists at that path
	// (highly unlikely thanks to uniqueSlug), bail.
	const linkPath = path.join(getProjectsRoot(), slug);
	if (fs.existsSync(linkPath)) {
		throw new Error(`projects/${slug} already exists`);
	}
	fs.symlinkSync(absDir, linkPath, "dir");

	return meta;
}

/**
 * Scaffold a new agent project on disk. Called by both the agent
 * plugin's AGENT_PROJECT_NEW handler and the agentProjectCreate RPC.
 *
 * Returns the freshly written ProjectMeta. Throws on validation
 * errors and on filesystem failures (after attempting to clean up the
 * partially-written directory).
 */
export async function createAgentProject({
	name,
	description,
	type,
	template,
}: {
	name: string;
	description: string;
	type: ProjectType;
	template?: ProjectTemplate;
}): Promise<ProjectMeta> {
	if (name.trim().length === 0) throw new Error("name is required");
	if (description.trim().length === 0) throw new Error("description is required");
	if (type !== "app" && type !== "page") throw new Error('type must be "app" or "page"');
	// Default template per type. `app` defaults to `carrot` (existing
	// minimal scaffold). `page` only has `static`.
	const resolvedTemplate: ProjectTemplate =
		template ?? (type === "app" ? "carrot" : "static");
	if (type === "page" && resolvedTemplate !== "static") {
		throw new Error(`template "${resolvedTemplate}" is not valid for type=page`);
	}
	if (
		type === "app" &&
		resolvedTemplate !== "carrot" &&
		resolvedTemplate !== "nextjs" &&
		!isElectrobunTemplate(resolvedTemplate)
	) {
		throw new Error(`template "${resolvedTemplate}" is not valid for type=app`);
	}
	const slug = uniqueSlug(slugify(name));
	const dir = projectDir(slug);
	mkdirSync(dir, { recursive: true });
	const now = Date.now();
	const meta: ProjectMeta = {
		type,
		template: resolvedTemplate,
		slug,
		name: name.trim(),
		description: description.trim(),
		createdAt: now,
		updatedAt: now,
	};
	try {
		if (type === "page") scaffoldPage(dir, meta);
		else if (resolvedTemplate === "nextjs") scaffoldNextjs(dir, meta);
		else if (isElectrobunTemplate(resolvedTemplate))
			scaffoldElectrobun(dir, meta, electrobunTemplateName(resolvedTemplate));
		else scaffoldApp(dir, meta);
		writeProjectMeta(meta);
	} catch (err) {
		try { (await import("node:fs")).rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		throw err instanceof Error ? err : new Error(String(err));
	}
	await gitInit(dir);
	return meta;
}
