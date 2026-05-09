/**
 * Agent-projects workspace handlers — file tree / read / write / git
 * primitives backing the #workspace view. Auto-stage on save is the
 * default; commits are explicit (no auto-commit on save) so the user
 * can batch related edits.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Utils } from "electrobun/bun";
import type {
	AgentProjectFileNode,
	AgentProjectGitCommit,
	AgentProjectGitFileStatus,
	AgentProjectSummary,
	WorkspaceIDEAvailability,
	WorkspaceIDEId,
} from "../../../../shared/rpc/agent-projects";
import { createAgentProject, importAgentProject, publishProjectToGitHub } from "../../agent-projects-core";
import type { RpcDeps } from "../types";

/**
 * Directories the file-tree walker skips. These produce huge flat
 * trees of build artifacts that nobody wants to scroll through and
 * blow past RPC response budgets — we add Next.js's `.next`, Turbo's
 * `.turbo`, generic build caches (`.cache`, `.parcel-cache`),
 * coverage output, and IDE metadata.
 */
const SKIP_DIRS = new Set([
	".git",
	".github",
	".next",
	".turbo",
	".cache",
	".parcel-cache",
	".vercel",
	".idea",
	".vscode",
	".DS_Store",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".nyc_output",
]);

function projectsRoot(): string {
	const sandbox = process.env.DETOUR_AGENT_SANDBOX;
	if (!sandbox) throw new Error("DETOUR_AGENT_SANDBOX not set");
	return join(sandbox, "projects");
}

function projectDir(slug: string): string {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error(`invalid slug: ${slug}`);
	return join(projectsRoot(), slug);
}

function safeJoin(slug: string, relPath: string): string {
	const root = projectDir(slug);
	const full = resolve(root, relPath);
	const rootResolved = resolve(root);
	if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
		throw new Error(`path escapes project root: ${relPath}`);
	}
	return full;
}

function readMeta(slug: string): AgentProjectSummary | null {
	const path = join(projectDir(slug), "project.json");
	if (!existsSync(path)) return null;
	try {
		const j = JSON.parse(readFileSync(path, "utf8"));
		if (!j.slug || !j.type || !j.name) return null;
		return j as AgentProjectSummary;
	} catch {
		return null;
	}
}

/** Hard caps so a malformed import (or a monorepo with many sources)
 * can't blow past the RPC response budget or the iframe's render
 * budget. */
const MAX_TREE_DEPTH = 12;
const MAX_TREE_ENTRIES = 5000;

function buildTree(
	absDir: string,
	rootDir: string,
	depth = 0,
	counter: { count: number } = { count: 0 },
): AgentProjectFileNode {
	const rel = relative(rootDir, absDir).split(sep).join("/") || "";
	const name = rel === "" ? "/" : rel.split("/").pop()!;
	const node: AgentProjectFileNode = { name, path: rel, type: "dir", children: [] };
	if (depth > MAX_TREE_DEPTH || counter.count >= MAX_TREE_ENTRIES) return node;
	let entries: string[] = [];
	try { entries = readdirSync(absDir).sort(); } catch { return node; }
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		if (counter.count >= MAX_TREE_ENTRIES) break;
		const childAbs = join(absDir, entry);
		let s: ReturnType<typeof statSync>;
		try { s = statSync(childAbs); } catch { continue; }
		counter.count++;
		if (s.isDirectory()) {
			node.children!.push(buildTree(childAbs, rootDir, depth + 1, counter));
		} else if (s.isFile()) {
			const childRel = relative(rootDir, childAbs).split(sep).join("/");
			node.children!.push({ name: entry, path: childRel, type: "file", size: s.size });
		}
	}
	return node;
}

async function spawnGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

function parseStatus(porcelain: string): AgentProjectGitFileStatus[] {
	const out: AgentProjectGitFileStatus[] = [];
	for (const line of porcelain.split("\n")) {
		if (line.length < 3) continue;
		const xy = line.slice(0, 2);
		const path = line.slice(3);
		const x = xy[0];
		const y = xy[1];
		const staged = x !== " " && x !== "?";
		let status: AgentProjectGitFileStatus["status"] = "unchanged";
		if (xy === "??") status = "untracked";
		else if (x === "A" || y === "A") status = "added";
		else if (x === "D" || y === "D") status = "deleted";
		else if (x === "R" || y === "R") status = "renamed";
		else if (x === "M" || y === "M") status = "modified";
		out.push({ path, status, staged });
	}
	return out;
}

export function agentProjectsRequests(_deps: RpcDeps) {
	return {
		agentProjectCreate: async (
			{
				name,
				description,
				type,
				template,
			}: {
				name: string;
				description: string;
				type: "app" | "page";
				template?: "carrot" | "nextjs" | "static";
			},
		): Promise<{ project: AgentProjectSummary }> => {
			const meta = await createAgentProject({ name, description, type, template });
			return { project: meta };
		},

		agentProjectImport: async (
			{ dir: explicitDir, name, description }: { dir?: string; name?: string; description?: string },
		) => {
			// If caller provided a dir, skip the picker — used by the
			// AGENT_PROJECT_IMPORT action so Discord/X/chat can import
			// without a UI gesture. Otherwise open the native folder picker.
			let dir = explicitDir?.trim();
			if (!dir) {
				let dirs: string[] = [];
				try {
					dirs = await Utils.openFileDialog({
						canChooseFiles: false,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
					});
				} catch (err) {
					return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
				}
				dir = dirs.find((d) => d.length > 0);
			}
			if (!dir) return { ok: false as const, cancelled: true as const };
			try {
				const meta = await importAgentProject({ dir, name, description });
				return { ok: true as const, project: meta };
			} catch (err) {
				return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
			}
		},

		agentProjectList: async (_params: Record<string, never>): Promise<{ projects: AgentProjectSummary[] }> => {
			const root = projectsRoot();
			if (!existsSync(root)) return { projects: [] };
			const projects: AgentProjectSummary[] = [];
			for (const entry of readdirSync(root)) {
				// Skip non-directories (e.g. .DS_Store) and anything whose name
				// can't be a valid slug — projectDir() validates strictly and
				// would otherwise throw on dotfiles, breaking the whole list.
				try {
					if (!statSync(join(root, entry)).isDirectory()) continue;
				} catch {
					continue;
				}
				try {
					const meta = readMeta(entry);
					if (meta) projects.push(meta);
				} catch {
					// readMeta → projectDir throws on invalid slug; harmless,
					// just means the dir isn't a proper agent-project.
				}
			}
			projects.sort((a, b) => b.updatedAt - a.updatedAt);
			return { projects };
		},

		agentProjectListFiles: async ({ slug }: { slug: string }): Promise<{ tree: AgentProjectFileNode; dir: string }> => {
			const dir = projectDir(slug);
			if (!existsSync(dir)) throw new Error(`project not found: ${slug}`);
			return { tree: buildTree(dir, dir), dir };
		},

		agentProjectReadFile: async ({ slug, path }: { slug: string; path: string }): Promise<{ content: string; size: number }> => {
			const abs = safeJoin(slug, path);
			if (!existsSync(abs)) throw new Error(`file not found: ${path}`);
			const s = statSync(abs);
			if (!s.isFile()) throw new Error(`not a file: ${path}`);
			if (s.size > 4 * 1024 * 1024) throw new Error(`file too large: ${path} (${s.size} bytes)`);
			const content = readFileSync(abs, "utf8");
			return { content, size: s.size };
		},

		agentProjectWriteFile: async (
			{ slug, path, content, autoStage = true }: { slug: string; path: string; content: string; autoStage?: boolean },
		): Promise<{ ok: true; staged: boolean }> => {
			const abs = safeJoin(slug, path);
			writeFileSync(abs, content, "utf8");
			let staged = false;
			if (autoStage) {
				try {
					const r = await spawnGit(projectDir(slug), ["add", "--", path]);
					staged = r.exitCode === 0;
				} catch { /* best-effort */ }
			}
			return { ok: true, staged };
		},

		agentProjectCreateFile: async (
			{ slug, path, content = "", overwrite = false }: { slug: string; path: string; content?: string; overwrite?: boolean },
		): Promise<{ ok: true; path: string }> => {
			const abs = safeJoin(slug, path);
			if (existsSync(abs) && !overwrite) {
				throw new Error(`file already exists: ${path} (pass overwrite:true to replace)`);
			}
			// Ensure parent dir exists.
			const fs = await import("node:fs");
			const parent = abs.slice(0, abs.lastIndexOf(sep));
			if (parent && parent !== abs) {
				try { fs.mkdirSync(parent, { recursive: true }); } catch { /* ignore */ }
			}
			writeFileSync(abs, content, "utf8");
			return { ok: true, path };
		},

		agentProjectCreateFolder: async ({ slug, path }: { slug: string; path: string }): Promise<{ ok: true; path: string }> => {
			const abs = safeJoin(slug, path);
			if (existsSync(abs)) {
				const fs = await import("node:fs");
				if (!fs.statSync(abs).isDirectory()) throw new Error(`a non-directory entry already exists at ${path}`);
				return { ok: true, path };
			}
			const fs = await import("node:fs");
			fs.mkdirSync(abs, { recursive: true });
			return { ok: true, path };
		},

		agentProjectRenameEntry: async (
			{ slug, oldPath, newPath }: { slug: string; oldPath: string; newPath: string },
		): Promise<{ ok: true; path: string }> => {
			const oldAbs = safeJoin(slug, oldPath);
			const newAbs = safeJoin(slug, newPath);
			if (!existsSync(oldAbs)) throw new Error(`source does not exist: ${oldPath}`);
			if (existsSync(newAbs)) throw new Error(`destination already exists: ${newPath}`);
			const fs = await import("node:fs");
			const parent = newAbs.slice(0, newAbs.lastIndexOf(sep));
			if (parent && parent !== newAbs) {
				try { fs.mkdirSync(parent, { recursive: true }); } catch { /* ignore */ }
			}
			fs.renameSync(oldAbs, newAbs);
			return { ok: true, path: newPath };
		},

		agentProjectDeleteEntry: async ({ slug, path }: { slug: string; path: string }): Promise<{ ok: true }> => {
			const abs = safeJoin(slug, path);
			if (!existsSync(abs)) return { ok: true }; // idempotent
			const fs = await import("node:fs");
			const stat = fs.statSync(abs);
			if (stat.isDirectory()) {
				fs.rmSync(abs, { recursive: true, force: true });
			} else {
				fs.unlinkSync(abs);
			}
			return { ok: true };
		},

		agentProjectGitStatus: async ({ slug }: { slug: string }): Promise<{ files: AgentProjectGitFileStatus[]; branch: string | null }> => {
			const dir = projectDir(slug);
			const status = await spawnGit(dir, ["status", "--porcelain", "-uall"]);
			const branchRes = await spawnGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
			const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : null;
			return { files: parseStatus(status.stdout), branch };
		},

		agentProjectGitDiff: async (
			{ slug, path, staged = false }: { slug: string; path: string; staged?: boolean },
		): Promise<{ diff: string }> => {
			const args = staged
				? ["diff", "--cached", "--no-color", "--", path]
				: ["diff", "--no-color", "--", path];
			const r = await spawnGit(projectDir(slug), args);
			if (r.exitCode !== 0 && r.stderr) throw new Error(r.stderr.trim());
			return { diff: r.stdout };
		},

		agentProjectGitCommit: async ({ slug, message }: { slug: string; message: string }): Promise<{ sha: string }> => {
			const dir = projectDir(slug);
			const trimmed = message.trim();
			if (trimmed.length === 0) throw new Error("commit message required");
			const args = [
				"-c", "user.email=workspace@detour.local",
				"-c", "user.name=Detour Workspace",
				"commit", "-m", trimmed,
			];
			const r = await spawnGit(dir, args);
			if (r.exitCode !== 0) {
				throw new Error(r.stderr.trim() || r.stdout.trim() || `git commit exited ${r.exitCode}`);
			}
			const sha = await spawnGit(dir, ["rev-parse", "HEAD"]);
			return { sha: sha.stdout.trim() };
		},

		agentProjectGitLog: async (
			{ slug, limit = 30 }: { slug: string; limit?: number },
		): Promise<{ commits: AgentProjectGitCommit[] }> => {
			const dir = projectDir(slug);
			const r = await spawnGit(dir, ["log", `-n${limit}`, "--pretty=format:%H%x09%an%x09%at%x09%s"]);
			if (r.exitCode !== 0) return { commits: [] };
			const commits: AgentProjectGitCommit[] = [];
			for (const line of r.stdout.split("\n")) {
				if (!line) continue;
				const [sha, author, ts, ...rest] = line.split("\t");
				commits.push({
					sha,
					author,
					timestamp: Number(ts) || 0,
					subject: rest.join("\t"),
				});
			}
			return { commits };
		},

		agentProjectOpenInFinder: async ({ slug }: { slug: string }): Promise<{ ok: true }> => {
			let dir: string;
			try {
				dir = projectDir(slug);
			} catch (err) {
				console.warn("[agent-projects] reveal: invalid slug", slug, err instanceof Error ? err.message : err);
				throw err;
			}
			if (!existsSync(dir)) {
				console.warn("[agent-projects] reveal: project dir missing", { slug, dir });
				throw new Error(`project not found on disk: ${slug} (looked at ${dir})`);
			}
			const opened = Utils.openPath(dir);
			console.log("[agent-projects] reveal", { slug, dir, opened });
			if (!opened) {
				throw new Error(`Utils.openPath returned false for ${dir} — Finder may have rejected the path`);
			}
			return { ok: true };
		},

		// ── Real HTTP previews via portless ────────────────────────────

		agentProjectStartPreview: async ({ slug }: { slug: string }) => {
			const state = await _deps.previewServers.startStatic(slug);
			return { ok: true as const, url: state.url, port: state.port, hostname: state.hostname };
		},

		agentProjectStopPreview: async ({ slug }: { slug: string }) => {
			await _deps.previewServers.stop(slug);
			return { ok: true as const };
		},

		agentProjectRegisterPreviewPort: async ({ slug, port }: { slug: string; port: number }) => {
			const state = _deps.previewServers.registerExternalPort(slug, port);
			return { ok: true as const, url: state.url, hostname: state.hostname };
		},

		agentProjectListPreviews: async (_p: Record<string, never>) => {
			return {
				previews: _deps.previewServers.list().map((s) => ({
					slug: s.slug,
					url: s.url,
					port: s.port,
					hostname: s.hostname,
					kind: s.kind,
					startedAt: s.startedAt,
				})),
			};
		},

		// ── GitHub publish (uses GITHUB_AGENT_PAT) ─────────────────────

		agentProjectPublishGitHub: async (
			{ slug, repoName, isPrivate, description }: { slug: string; repoName?: string; isPrivate?: boolean; description?: string },
		) => {
			const meta = readMeta(slug);
			if (!meta) throw new Error(`project not found: ${slug}`);
			const v = await _deps.vault.vault();
			const pat =
				(await v.has("GITHUB_AGENT_PAT") ? await v.get("GITHUB_AGENT_PAT") : "")
				|| (await v.has("GITHUB_TOKEN") ? await v.get("GITHUB_TOKEN") : "");
			if (!pat) {
				throw new Error("No GITHUB_AGENT_PAT (or GITHUB_TOKEN) configured. Wire it in Settings → Channels → GitHub → Agent identity.");
			}
			const result = await publishProjectToGitHub({ slug, meta, repoName, isPrivate, description, pat });
			return { ok: true as const, ...result };
		},

		// Settings UI calls this to open the Workspace window. The kernel
		// listens on the broadcast bus for `uiOpenWorkspace` (see
		// kernel/app.ts:registerWindow listener) and emits the
		// `ui:open-workspace` event that workspaceFeature handles.
		workspaceOpen: async (_params: Record<string, never>): Promise<{ ok: true }> => {
			_deps.broadcaster.broadcast("uiOpenWorkspace", {});
			return { ok: true };
		},

		workspaceDetectIDEs: async (_params: Record<string, never>): Promise<{ ides: WorkspaceIDEAvailability[] }> => {
			return { ides: await detectIDEs() };
		},

		workspaceLaunchInIDE: async (
			{ slug, ide }: { slug: string; ide: WorkspaceIDEId },
		): Promise<{ ok: true; method: "url-scheme" | "cli" | "open-app" }> => {
			const dir = projectDir(slug);
			if (!existsSync(dir)) throw new Error(`project not found: ${slug}`);
			const method = await launchIDE(dir, ide);
			return { ok: true, method };
		},
	};
}

// ── External IDE detection + launch ────────────────────────────────────

const IDE_LABELS: Record<WorkspaceIDEId, string> = {
	vscode: "VS Code",
	cursor: "Cursor",
	windsurf: "Windsurf",
};

const IDE_CLI_NAMES: Record<WorkspaceIDEId, string[]> = {
	vscode: ["code"],
	cursor: ["cursor"],
	windsurf: ["windsurf"],
};

const IDE_APP_NAMES: Record<WorkspaceIDEId, string[]> = {
	vscode: ["Visual Studio Code"],
	cursor: ["Cursor"],
	windsurf: ["Windsurf"],
};

async function which(name: string): Promise<string | null> {
	try {
		const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return null;
		const path = out.trim();
		return path.length > 0 ? path : null;
	} catch {
		return null;
	}
}

async function macAppExists(appName: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	const candidates = [
		`/Applications/${appName}.app`,
		`${process.env.HOME}/Applications/${appName}.app`,
	];
	return candidates.some((p) => existsSync(p));
}

async function detectIDE(id: WorkspaceIDEId): Promise<WorkspaceIDEAvailability> {
	for (const cli of IDE_CLI_NAMES[id]) {
		const found = await which(cli);
		if (found) return { id, label: IDE_LABELS[id], installed: true, method: "cli" };
	}
	for (const app of IDE_APP_NAMES[id]) {
		if (await macAppExists(app)) return { id, label: IDE_LABELS[id], installed: true, method: "open-app" };
	}
	// Fallback: assume the URL scheme handler may exist (browsers often
	// can't tell us — Utils.openExternal will silently no-op if not).
	return { id, label: IDE_LABELS[id], installed: false, method: null };
}

async function detectIDEs(): Promise<WorkspaceIDEAvailability[]> {
	return Promise.all((["vscode", "cursor", "windsurf"] as WorkspaceIDEId[]).map(detectIDE));
}

async function launchIDE(dir: string, ide: WorkspaceIDEId): Promise<"url-scheme" | "cli" | "open-app"> {
	// Prefer CLI: gives the IDE a clean path argv and works headless.
	for (const cli of IDE_CLI_NAMES[ide]) {
		const found = await which(cli);
		if (found) {
			const proc = Bun.spawn([found, dir], { stdout: "ignore", stderr: "ignore" });
			(proc as unknown as { unref?: () => void }).unref?.();
			return "cli";
		}
	}
	// macOS fallback: `open -a "<App>" <dir>`.
	if (process.platform === "darwin") {
		for (const app of IDE_APP_NAMES[ide]) {
			if (await macAppExists(app)) {
				const proc = Bun.spawn(["open", "-a", app, dir], { stdout: "ignore", stderr: "ignore" });
				(proc as unknown as { unref?: () => void }).unref?.();
				return "open-app";
			}
		}
	}
	// Last-resort URL scheme. Most editors register one (vscode://, cursor://,
	// windsurf://). If the scheme isn't registered the OS just no-ops.
	const url = `${ide}://file/${encodeURI(dir)}`;
	Utils.openExternal(url);
	return "url-scheme";
}
